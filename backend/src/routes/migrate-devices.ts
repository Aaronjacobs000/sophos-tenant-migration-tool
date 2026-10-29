/**
 * Routes for the two-tenant device migration flow.
 *   POST   /api/migrate/devices                          start a job
 *   GET    /api/migrate/devices/jobs                     list local jobs
 *   GET    /api/migrate/devices/jobs/all                 merged local + API jobs
 *   GET    /api/migrate/devices/jobs/:id                 single job detail (checks it first)
 *   GET    /api/migrate/devices/jobs/:id/stream          SSE live updates
 *   POST   /api/migrate/devices/jobs/:id/credentials     attach credentials to a job
 *   POST   /api/migrate/devices/jobs/:id/credentials/remove  remove them
 *   POST   /api/migrate/devices/jobs/:id/group-membership  put moved devices
 *          back into same-named groups ({ dryRun: true } or { dryRun: false }),
 *          or the groups picked in choices ({ [endpointId]: groupId or null })
 *   POST   /api/migrate/devices/jobs/:id/tamper-protection  turn tamper
 *          protection on and make new passwords on arrived devices
 *          ({ dryRun, turnOn, newPasswords, scope: "all" or "was-on" })
 *   POST   /api/migrate/devices/jobs/:id/scan             scan arrived devices ({ dryRun })
 *
 * Jobs are checked with their own tenants and stored credentials
 * (services/job-access.ts), so only starting a job needs the tool's current
 * connection. Every job leaves through publicJob, which drops the credential
 * references.
 */

import { Router, type Response } from "express";
import { requireConfigured } from "../middleware/require-configured.js";
import { jsonOnly } from "../middleware/json-body.js";
import {
  startMigration,
  pollJob,
} from "../services/device-migrator.js";
import { listJobs, getJob } from "../services/migration-store.js";
import { restoreGroupMembership, JobNotFoundError } from "../services/group-membership.js";
import { scanArrivedDevices, tamperProtectionAction } from "../services/arrival-actions.js";
import { attachCredentials, removeCredentials, nameUnnamedTenants, AttachError, JobAccessError } from "../services/job-access.js";
import { nextCheckDelayMs } from "../services/job-progress.js";
import { publicJob, type PublicJob } from "../services/job-view.js";
import { listMigrationJobs } from "../sophos/api/migrations.js";
import { currentContexts } from "../state.js";
import { maskSecrets } from "../log.js";
import type { SophosMigrationJob } from "../sophos/types/migration.js";
import type { LocalMigrationJob } from "../services/migration-store.js";

export const migrateDevicesRouter = Router();

/** Least time between background checks a list request can start for one job. */
const LIST_REFRESH_MS = 30_000;

/**
 * Start checks for unfinished jobs without holding up the list. The Migrations
 * page refreshes itself, so it shows the results on its next load.
 */
function refreshInBackground(jobs: LocalMigrationJob[]): void {
  for (const job of jobs) {
    const view = publicJob(job);
    const delay = nextCheckDelayMs(job, view.progress);
    if (delay === null) continue;
    pollJob(job.localJobId, { minAgeMs: Math.max(delay, LIST_REFRESH_MS) }).catch(() => {});
  }
}

migrateDevicesRouter.post("/migrate/devices", requireConfigured, async (req, res, next) => {
  try {
    const ids = Array.isArray(req.body?.endpointIds) ? req.body.endpointIds : [];
    const jobName = String(req.body?.jobName ?? "").trim();
    const dryRun = req.query?.dryRun === "true" || req.body?.dryRun === true;
    const direction = req.body?.direction === "dest-to-source" ? "dest-to-source" : "source-to-dest";
    if (!ids.length || !jobName) {
      res.status(400).json({
        error: "bad_request",
        message: "endpointIds[] and jobName are required",
      });
      return;
    }
    const result = await startMigration({
      jobName,
      endpointIds: ids,
      direction,
      dryRun,
    });
    if (result.deviceLimitFailure) {
      res.status(400).json({ error: "too_many_devices", message: result.deviceLimitFailure });
      return;
    }
    if (result.settingFailure) {
      res.status(400).json({ error: "migration_not_allowed", message: result.settingFailure });
      return;
    }
    if (result.preflightFailures.length > 0) {
      res.status(400).json({
        error: "preflight_failed",
        preflightFailures: result.preflightFailures,
      });
      return;
    }
    if (result.plan) {
      res.json({ ok: true, dryRun: true, plan: result.plan });
      return;
    }
    res.status(201).json({ ok: true, job: result.job ? publicJob(result.job) : undefined });
  } catch (err) {
    next(err);
  }
});

migrateDevicesRouter.get("/migrate/devices/jobs", async (_req, res, next) => {
  try {
    const jobs = await nameUnnamedTenants(await listJobs());
    refreshInBackground(jobs);
    res.json({ items: jobs.map((j) => publicJob(j)) });
  } catch (err) {
    next(err);
  }
});

/**
 * Merged view: local jobs + all migration jobs from both tenants' APIs.
 * API-only jobs (triggered outside this tool) are included so users can
 * see the full picture of what's been requested across any platform.
 */
migrateDevicesRouter.get("/migrate/devices/jobs/all", async (_req, res, next) => {
  try {
    // Jobs started elsewhere are read from the tenants the tool points at now.
    const { source: src, dest: dst } = currentContexts();
    const none = async (): Promise<SophosMigrationJob[]> => [];

    const [localJobs, srcApiJobs, dstApiJobs] = await Promise.all([
      listJobs().then(nameUnnamedTenants),
      src ? listMigrationJobs(src.client, src.tenantId).catch(none) : none(),
      dst ? listMigrationJobs(dst.client, dst.tenantId).catch(none) : none(),
    ]);
    refreshInBackground(localJobs);

    // Index local jobs by their upstream Sophos migration IDs for correlation
    const localBySourceId = new Map<string, LocalMigrationJob>();
    const localByDestId = new Map<string, LocalMigrationJob>();
    for (const lj of localJobs) {
      localBySourceId.set(lj.sourceMigrationId, lj);
      localByDestId.set(lj.destMigrationId, lj);
    }

    // Track which API job IDs are already covered by a local job
    const coveredApiIds = new Set<string>();
    const merged: MergedMigrationJob[] = [];

    // 1. Start with all local jobs; they get full detail
    for (const lj of localJobs) {
      coveredApiIds.add(lj.sourceMigrationId);
      coveredApiIds.add(lj.destMigrationId);
      const view = publicJob(lj);
      merged.push({
        origin: "local",
        localJobId: lj.localJobId,
        jobName: lj.jobName,
        status: view.status,
        direction: lj.direction,
        endpointCount: lj.endpointIds.length,
        createdAt: lj.createdAt,
        sourceMigrationId: lj.sourceMigrationId,
        destMigrationId: lj.destMigrationId,
        lastPolledAt: lj.lastPolledAt,
        progress: view.progress,
        tenants: view.tenants,
        monitor: view.monitor,
        credentials: view.credentials,
      });
    }

    // 2. API-only jobs from both tenants. Sophos gives both tenants the same
    // job ID, so a job on both is listed once, by its sending side when there
    // is one: the sending tenant knows the job only once the move has started.
    const apiOnly = new Map<string, MergedMigrationJob>();
    const sending = (j: MergedMigrationJob) => /^send/i.test(j.apiJobMode ?? "");
    const addApiJobs = (jobs: SophosMigrationJob[], tenant: "source" | "dest", name: string | null | undefined) => {
      for (const aj of jobs) {
        if (coveredApiIds.has(aj.id)) continue;
        const entry = apiJobToMerged(aj, tenant, name);
        const known = apiOnly.get(aj.id);
        if (!known || (!sending(known) && sending(entry))) apiOnly.set(aj.id, entry);
      }
    };
    addApiJobs(srcApiJobs, "source", src?.summary.displayName);
    addApiJobs(dstApiJobs, "dest", dst?.summary.displayName);
    merged.push(...apiOnly.values());

    // Sort newest first
    merged.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

    res.json({ items: merged, checkedAt: new Date().toISOString() });
  } catch (err) {
    next(err);
  }
});

/** How many jobs are saved, for the setup wizard's link to them. Reads the file only: no check, no save. */
migrateDevicesRouter.get("/migrate/devices/jobs/count", async (_req, res, next) => {
  try {
    res.json({ count: (await listJobs()).length });
  } catch (err) {
    next(err);
  }
});

migrateDevicesRouter.get("/migrate/devices/jobs/:id", async (req, res, next) => {
  try {
    const job = await getJob(req.params.id!);
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Check once on detail load so the saved state is up to date. A failed
    // check is recorded on the job and never replaces what was saved.
    const updated = await pollJob(req.params.id!).catch(() => job);
    res.json(publicJob(updated ?? job));
  } catch (err) {
    next(err);
  }
});

/**
 * Attach credentials to a job: { use: "current" } for the tool's current
 * connection, or { use: "direct", sending: {clientId, clientSecret},
 * receiving: {...} }. They are checked against the job's tenants (two GETs)
 * before anything is stored. The response never carries them back.
 */
migrateDevicesRouter.post("/migrate/devices/jobs/:id/credentials", jsonOnly, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (body.use !== "direct" && body.use !== "current") {
      res.status(400).json({ error: "bad_request", message: 'use must be "current" or "direct"' });
      return;
    }
    const input = body.use === "direct"
      ? { use: "direct" as const, sending: cred(body.sending), receiving: cred(body.receiving) }
      : { use: "current" as const };
    const job = await attachCredentials(req.params.id!, input);
    res.json(publicJob(job));
  } catch (err) {
    if (err instanceof AttachError) {
      if (err.message === "not_found") res.status(404).json({ error: "not_found" });
      else res.status(400).json({ error: "attach_failed", message: maskSecrets(err.message) });
      return;
    }
    next(err);
  }
});

migrateDevicesRouter.post("/migrate/devices/jobs/:id/credentials/remove", jsonOnly, async (req, res, next) => {
  try {
    const job = await removeCredentials(req.params.id!);
    if (!job) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(publicJob(job));
  } catch (err) {
    next(err);
  }
});

/**
 * The caller must say whether this is a dry run, in JSON, so a post from
 * another site (or one that leaves dryRun out) never adds devices to groups.
 * choices, when sent, maps a device's ID on the sending tenant to the
 * destination group to add it to, or to null to leave it out.
 */
migrateDevicesRouter.post("/migrate/devices/jobs/:id/group-membership", jsonOnly, async (req, res, next) => {
  try {
    if (typeof req.body?.dryRun !== "boolean") {
      res.status(400).json({ error: "bad_request", message: "dryRun (true or false) is required" });
      return;
    }
    const choices = req.body.choices ?? {};
    const valid = choices && typeof choices === "object" && !Array.isArray(choices) &&
      Object.values(choices).every((v) => v === null || (typeof v === "string" && v.length > 0));
    if (!valid) {
      res.status(400).json({ error: "bad_request", message: "choices must map device IDs to a group ID or null" });
      return;
    }
    const dryRun = req.query?.dryRun === "true" || req.body.dryRun === true;
    res.json(await restoreGroupMembership(req.params.id!, { dryRun, choices }));
  } catch (err) {
    if (err instanceof JobNotFoundError) {
      res.status(404).json({ error: "not_found", message: err.message });
      return;
    }
    if (err instanceof JobAccessError) {
      res.status(409).json({ error: `job_${err.problem}`, message: maskSecrets(err.message) });
      return;
    }
    next(err);
  }
});

/** The answer for a job that isn't there, or whose tenants can't be reached, from an action route. */
function actionError(err: unknown, res: Response): boolean {
  if (err instanceof JobNotFoundError) {
    res.status(404).json({ error: "not_found", message: err.message });
    return true;
  }
  if (err instanceof JobAccessError) {
    res.status(409).json({ error: `job_${err.problem}`, message: maskSecrets(err.message) });
    return true;
  }
  return false;
}

/**
 * Tamper protection on the devices that have arrived. As with group
 * membership, dryRun must be stated in JSON, and so must each option, so a
 * post from another site, or one that leaves them out, changes nothing.
 */
migrateDevicesRouter.post("/migrate/devices/jobs/:id/tamper-protection", jsonOnly, async (req, res, next) => {
  try {
    const b = req.body ?? {};
    if (typeof b.dryRun !== "boolean" || typeof b.turnOn !== "boolean" || typeof b.newPasswords !== "boolean") {
      res.status(400).json({ error: "bad_request", message: "dryRun, turnOn and newPasswords (true or false) are required" });
      return;
    }
    if (!b.turnOn && !b.newPasswords) {
      res.status(400).json({ error: "bad_request", message: "turnOn or newPasswords must be true" });
      return;
    }
    const scope = b.scope ?? "all";
    if (scope !== "all" && scope !== "was-on") {
      res.status(400).json({ error: "bad_request", message: 'scope must be "all" or "was-on"' });
      return;
    }
    res.json(await tamperProtectionAction(req.params.id!, { dryRun: b.dryRun, turnOn: b.turnOn, newPasswords: b.newPasswords, scope }));
  } catch (err) {
    if (!actionError(err, res)) next(err);
  }
});

/** A scan on the devices that have arrived. dryRun must be stated in JSON. */
migrateDevicesRouter.post("/migrate/devices/jobs/:id/scan", jsonOnly, async (req, res, next) => {
  try {
    if (typeof req.body?.dryRun !== "boolean") {
      res.status(400).json({ error: "bad_request", message: "dryRun (true or false) is required" });
      return;
    }
    res.json(await scanArrivedDevices(req.params.id!, { dryRun: req.body.dryRun }));
  } catch (err) {
    if (!actionError(err, res)) next(err);
  }
});

/**
 * Live updates for one job. Each status event carries the job and when the
 * next check is due. The interval follows the job (nextCheckDelayMs): quick
 * during the handover, slower while devices wait to check in, slow when the
 * credentials were refused. The stream ends once the job has finished, and
 * stops the moment the browser goes away.
 */
migrateDevicesRouter.get("/migrate/devices/jobs/:id/stream", async (req, res) => {
  const jobId = req.params.id!;
  let job;
  try {
    job = await getJob(jobId);
  } catch (err) {
    res.status(500).json({
      error: "store_read_failed",
      message: maskSecrets(err instanceof Error ? err.message : String(err)),
    });
    return;
  }
  if (!job) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();

  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  const send = (event: string, data: unknown) => {
    if (closed) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  const end = () => {
    closed = true;
    if (timer) clearTimeout(timer);
    res.end();
  };
  const withNext = (view: PublicJob, delay: number | null) => ({
    ...view,
    nextCheckAt: delay === null ? null : new Date(Date.now() + delay).toISOString(),
  });

  const FIRST_CHECK_MS = 1500;
  send("status", withNext(publicJob(job), FIRST_CHECK_MS));

  const tick = async () => {
    timer = undefined;
    if (closed) return;
    let updated: LocalMigrationJob | null;
    try {
      // Shares a check already running for this job, and skips one made in the last few seconds.
      updated = await pollJob(jobId, { minAgeMs: 5_000 });
    } catch (err) {
      send("error", { message: maskSecrets(err instanceof Error ? err.message : String(err)) });
      updated = await getJob(jobId).catch(() => null);
    }
    if (closed) return;
    if (!updated) {
      send("done", { reason: "job_deleted" });
      end();
      return;
    }
    const view = publicJob(updated);
    const delay = nextCheckDelayMs(updated, view.progress);
    send("status", withNext(view, delay));
    if (delay === null) {
      send("done", { status: view.status });
      end();
      return;
    }
    timer = setTimeout(tick, delay);
  };

  timer = setTimeout(tick, FIRST_CHECK_MS);

  req.on("close", () => {
    closed = true;
    if (timer) clearTimeout(timer);
  });
});

function cred(v: unknown): { clientId: string; clientSecret: string } {
  const o = (v ?? {}) as Record<string, unknown>;
  return {
    clientId: typeof o.clientId === "string" ? o.clientId : "",
    clientSecret: typeof o.clientSecret === "string" ? o.clientSecret : "",
  };
}

// --- Merged job type used by the /all endpoint ---

export interface MergedMigrationJob {
  /** "local" = created by this tool; "api" = discovered from the Sophos API */
  origin: "local" | "api";
  localJobId?: string;
  jobName: string;
  status: string;
  direction?: string;
  endpointCount?: number;
  createdAt?: string;
  sourceMigrationId?: string;
  destMigrationId?: string;
  lastPolledAt?: string;
  /** Local jobs: progress, tenants, how the last check went, and whether credentials are stored. */
  progress?: PublicJob["progress"];
  tenants?: PublicJob["tenants"];
  monitor?: PublicJob["monitor"];
  credentials?: PublicJob["credentials"];
  /** For API-only jobs: which tenant ("source" or "dest") reported this job */
  apiTenant?: string;
  /** For API-only jobs: the display name of the tenant */
  apiTenantName?: string | null;
  /** For API-only jobs: the Sophos migration ID */
  apiMigrationId?: string;
  /** For API-only jobs: sender or receiver */
  apiJobMode?: string;
}

function apiJobToMerged(
  aj: SophosMigrationJob,
  tenant: "source" | "dest",
  tenantName: string | null | undefined,
): MergedMigrationJob {
  return {
    origin: "api",
    jobName: aj.name || `API job ${aj.id.slice(0, 8)}`,
    status: aj.status ?? "unknown",
    endpointCount: aj.endpointCounts?.total ?? undefined,
    createdAt: aj.createdAt,
    apiTenant: tenant,
    apiTenantName: tenantName ?? null,
    apiMigrationId: aj.id,
    apiJobMode: aj.mode ?? aj.type ?? undefined,
  };
}
