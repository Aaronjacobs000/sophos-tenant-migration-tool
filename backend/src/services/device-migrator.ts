/**
 * Two-tenant device migration orchestration.
 *
 * Workflow (matches Sophos docs):
 *   1. Preflight: read each selected source endpoint, reject any that
 *      haven't checked in within the last 14 days.
 *   2. POST receiver job on DESTINATION → returns job id + handshake token.
 *   3. PUT sender trigger on SOURCE using the SAME job id + token.
 *      (This is NOT a second POST; it triggers the existing job.)
 *   4. Persist the job ID to data/migration-jobs.json, with the group each
 *      device was in on the sending tenant (read in step 1), so the job page
 *      can put moved devices back into same-named groups afterwards.
 *   5. UI subscribes via SSE to /api/migrate/devices/jobs/:id/stream.
 */

import { requireContext } from "../state.js";
import {
  getEndpoint,
} from "../sophos/api/endpoints.js";
import {
  createReceiverJob,
  triggerSenderJob,
  getMigrationJob,
  listMigrationJobEndpoints,
  MAX_ENDPOINTS_PER_JOB,
} from "../sophos/api/migrations.js";
import {
  createJob,
  getJob,
  listJobs,
  updateJob,
  type EndpointGroupRef,
  type LocalMigrationJob,
} from "./migration-store.js";
import { auditOrWarn } from "./audit-log.js";
import { foundNote, isUnclearWrite, notFound, readBack } from "./write-check.js";
import { checkMigrationWindow, formatDate } from "./migration-window.js";
import { refreshCheckIns } from "./device-check-in.js";
import { jobProgress, JOB_LIFETIME_MS } from "./job-progress.js";
import {
  contextsForJob,
  forgetJobContexts,
  isNotFound,
  isRejection,
  JobAccessError,
  releaseCredentials,
  storeCurrentCredentials,
  tenantOf,
  withTenantNames,
} from "./job-access.js";
import { log, maskSecrets, registerSecret } from "../log.js";
import { SophosHttpError } from "../sophos/client/sophos-client.js";
import type { SophosEndpoint } from "../sophos/types/sophos.js";
import type { SophosMigrationJob } from "../sophos/types/migration.js";
import type { JobCredentialRefs, JobMonitor } from "./migration-store.js";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/** Added to an unclear answer during a start: where to look before starting again. */
const JOBS_PAGE_NOTE = "The Migrations page lists the jobs on both tenants, including ones this tool did not save.";

export type MigrationDirection = "source-to-dest" | "dest-to-source";

export interface StartMigrationRequest {
  jobName: string;
  endpointIds: string[];
  /** Direction: default "source-to-dest". Set "dest-to-source" to reverse. */
  direction?: MigrationDirection;
  dryRun?: boolean;
}

export interface PreflightFailure {
  endpointId: string;
  hostname?: string;
  reason: string;
}

export interface StartMigrationResult {
  preflightFailures: PreflightFailure[];
  /**
   * Set when either tenant has Device Migration turned off or expired. Both
   * tenants must allow it, and a receiving tenant accepts a receiver job
   * whatever the sending tenant's setting (measured 25/09/2026), leaving a
   * job the API cannot delete, so nothing is created.
   */
  settingFailure?: string;
  /** Set when more devices are selected than Sophos takes in one job. Nothing is read or sent. */
  deviceLimitFailure?: string;
  /** Present in dry-run mode: the plan we would execute. */
  plan?: {
    sourceTenantId: string;
    sourceApiHost: string;
    destTenantId: string;
    destApiHost: string;
    receiverBody: { fromTenant: string; endpoints: string[] };
    senderTrigger: { method: string; endpoints: string[]; token: string };
    /** Groups the devices are in on the sending tenant, recorded with the job. */
    groups: Array<{ name: string; count: number }>;
    /** Devices in no group. */
    ungrouped: number;
  };
  /** Present in real run: the persisted local job. */
  job?: LocalMigrationJob;
}

export async function startMigration(
  req: StartMigrationRequest,
): Promise<StartMigrationResult> {
  const direction: MigrationDirection = req.direction ?? "source-to-dest";

  // "from" is the side that owns the devices (sender).
  // "to" is the side receiving the devices (receiver).
  const from = requireContext(direction === "source-to-dest" ? "source" : "dest");
  const to = requireContext(direction === "source-to-dest" ? "dest" : "source");

  if (!req.jobName?.trim()) throw new Error("jobName is required");
  if (!Array.isArray(req.endpointIds) || req.endpointIds.length === 0) {
    throw new Error("endpointIds[] is required");
  }

  // Sanitise: strip any accidental prefixes (e.g. "source::uuid") and
  // validate that every ID looks like a UUID before we send them to Sophos.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const cleanIds = req.endpointIds.map((id) => {
    // Strip "source::" or "dest::" prefix if accidentally passed through
    const stripped = id.replace(/^(source|dest)::/, "").trim();
    return stripped;
  });
  const invalidIds = cleanIds.filter((id) => !UUID_RE.test(id));
  if (invalidIds.length > 0) {
    throw new Error(
      `${invalidIds.length} endpoint ID(s) are not valid UUIDs: ${invalidIds.slice(0, 3).join(", ")}${invalidIds.length > 3 ? "…" : ""}`,
    );
  }
  // Replace req.endpointIds with the cleaned version
  req.endpointIds = cleanIds;

  // Sophos takes at most 1000 devices in one job (API reference), so a larger
  // selection is refused before any call, not after reading every device.
  if (cleanIds.length > MAX_ENDPOINTS_PER_JOB) {
    return {
      preflightFailures: [],
      deviceLimitFailure: `${cleanIds.length} devices are selected, and Sophos accepts at most ${MAX_ENDPOINTS_PER_JOB} in one migration job through its API, so nothing was sent. Start a move for each batch of ${MAX_ENDPOINTS_PER_JOB} or fewer.`,
    };
  }

  // Step 0: both tenants must allow device migration (Sophos help, "Device
  // migration", Sep 2026). A setting that cannot be read does not block.
  const window = await checkMigrationWindow(direction);
  const closed = [window.sending, window.receiving].filter((c) => c.status === "off" || c.status === "closed");
  if (closed.length > 0) {
    const names = closed.map((c) => `${c.tenantName || c.side} (the ${c.role} tenant): ${c.message}`);
    return {
      preflightFailures: [],
      settingFailure: `Device migration is not allowed. ${names.join(" ")} Both tenants must allow it: in Sophos Fusion, go to Global Settings > Device Migration and turn on Allow device migration.`,
    };
  }

  // Step 1: preflight, load each endpoint from the "from" side
  const preflightFailures: PreflightFailure[] = [];
  const acceptedEndpoints: SophosEndpoint[] = [];
  for (const id of req.endpointIds) {
    let ep: SophosEndpoint;
    try {
      ep = await getEndpoint(from.client, from.tenantId, id);
    } catch (err) {
      preflightFailures.push({
        endpointId: id,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    if (!ep.lastSeenAt || Date.now() - new Date(ep.lastSeenAt).getTime() > FOURTEEN_DAYS_MS) {
      preflightFailures.push({
        endpointId: id,
        hostname: ep.hostname,
        reason: "outside the 14-day check-in window",
      });
      continue;
    }
    acceptedEndpoints.push(ep);
  }

  if (preflightFailures.length > 0) return { preflightFailures };

  const endpointIds = acceptedEndpoints.map((e) => e.id);
  const endpointGroups = groupSnapshot(acceptedEndpoints);

  if (req.dryRun) {
    return {
      preflightFailures: [],
      plan: {
        sourceTenantId: from.tenantId,
        sourceApiHost: from.summary.apiHost,
        destTenantId: to.tenantId,
        destApiHost: to.summary.apiHost,
        receiverBody: {
          fromTenant: from.tenantId,
          endpoints: endpointIds,
        },
        senderTrigger: {
          method: "PUT /endpoint/v1/migrations/{receiverJobId}",
          endpoints: endpointIds,
          token: "<would be returned by receiver job>",
        },
        ...summariseGroups(endpointGroups),
      },
    };
  }

  // Step 2: POST receiver job on the destination tenant.
  // fromTenant = the sending tenant (where endpoints currently live).
  const receiverBody = {
    fromTenant: from.tenantId,
    endpoints: endpointIds,
  };
  log.emit("info", "migration", `Creating receiver job on ${to.label} (${to.tenantId})`, {
    side: to.label as "source" | "dest",
    detail: { body: receiverBody },
  });
  let receiver: Awaited<ReturnType<typeof createReceiverJob>>;
  try {
    receiver = await createReceiverJob(to.client, to.tenantId, receiverBody);
  } catch (caught) {
    // Without the handshake token an unclear receiving job can't be used, so it is reported, not read back.
    const err = isUnclearWrite(caught) ? new Error(`${caught.message} ${JOBS_PAGE_NOTE}`, { cause: caught }) : caught;
    await auditOrWarn({
      side: to.label,
      tenantId: to.tenantId,
      action: "create",
      resource: "migration-receiver",
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      detail: { jobName: req.jobName, direction },
    });
    throw err;
  }
  log.emit("info", "migration", `Receiver job created: id=${receiver.id}, mode=${(receiver as any).mode}`, {
    side: to.label as "source" | "dest",
    detail: { response: receiver },
  });
  const handshakeToken = (receiver as any).token ?? receiver.fromToken;
  if (!handshakeToken) {
    throw new Error("Receiver job did not return a handshake token");
  }
  registerSecret(handshakeToken);
  await auditOrWarn({
    side: to.label,
    tenantId: to.tenantId,
    action: "create",
    resource: "migration-receiver",
    resourceId: receiver.id,
    ok: true,
    detail: { jobName: req.jobName, direction },
  });

  // Step 3: PUT sender trigger on the source tenant.
  // Uses the SAME job ID from the receiver. Body is just { token, endpoints }.
  const senderBody = {
    token: handshakeToken,
    endpoints: endpointIds,
  };
  log.emit("info", "migration", `Triggering sender on ${from.label} (${from.tenantId}), jobId=${receiver.id}`, {
    side: from.label as "source" | "dest",
    detail: { jobId: receiver.id, endpointCount: endpointIds.length },
  });
  let sender;
  let senderNote: string | undefined;
  try {
    try {
      sender = await triggerSenderJob(from.client, from.tenantId, receiver.id, senderBody);
    } catch (err) {
      if (!isUnclearWrite(err)) throw err;
      // Sophos gave no clear answer. The sending tenant knows the job only
      // once the trigger has gone through, so read the job back there.
      // Only a job the sending tenant reports as sending counts.
      let seen = "no such job there";
      const found = await readBack(async () => {
        // A 404 is a read that worked: the sending tenant does not know the job.
        const job = await getMigrationJob(from.client, from.tenantId, receiver.id).catch((e: unknown) => {
          if (isNotFound(e instanceof Error ? e.message : String(e))) return null;
          throw e;
        });
        const mode = String(job?.mode ?? job?.type ?? "");
        if (job && /^send/i.test(mode)) return job;
        seen = job ? `the job there, but not marked as sending (mode: ${mode || "not reported"})` : "no such job there";
        return undefined;
      });
      if (!found.value) {
        const sendingName = tenantOf(from).name;
        const receivingName = tenantOf(to).name;
        const miss = notFound(err, {
          where: `migration job ${receiver.id} on the sending tenant${sendingName ? ` ${sendingName}` : ""}`,
          found: seen,
          advice: `Nothing was saved in this tool. The receiving job on ${receivingName ?? "the receiving tenant"} was left in place in case the move started, and expires by itself after 14 days. In a few minutes, open the Migrations page, which lists the jobs on both tenants: if job ${receiver.id.slice(0, 8)} shows as sending, the move started; if not, start the move again.`,
          check: "the Migrations page",
        }, found.unread);
        throw new Error(found.unread ? `${miss.message} ${JOBS_PAGE_NOTE}` : miss.message, { cause: err });
      }
      sender = found.value;
      const sendingName = tenantOf(from).name;
      senderNote = foundNote(err, "the move", `on the sending tenant${sendingName ? ` ${sendingName}` : ""}`);
      log.emit("warn", "migration", `Sender trigger: ${senderNote}.`, { side: from.label as "source" | "dest" });
    }
    log.emit("info", "migration", `Sender triggered: id=${sender.id}, mode=${(sender as any).mode}`, {
      side: from.label as "source" | "dest",
      detail: { response: sender },
    });
    await auditOrWarn({
      side: from.label,
      tenantId: from.tenantId,
      action: "create",
      resource: "migration-sender",
      resourceId: sender.id,
      ok: true,
      detail: {
        jobName: req.jobName,
        direction,
        endpointCount: acceptedEndpoints.length,
        receiverId: receiver.id,
        ...(senderNote ? { note: senderNote } : {}),
      },
    });
  } catch (err) {
    if (!sender) {
      await auditOrWarn({
        side: from.label,
        tenantId: from.tenantId,
        action: "create",
        resource: "migration-sender",
        resourceId: receiver.id,
        ok: false,
        error: maskSecrets(err instanceof Error ? err.message : String(err)),
        detail: { jobName: req.jobName, direction, receiverId: receiver.id },
      });
    }
    // The API cannot delete a migration job, so the receiving job stays either
    // way. After a clear failure the move did not start: say so, and when the
    // job expires. An unclear trigger already says what to check.
    if (!sender && !isUnclearWrite((err as Error).cause ?? err)) {
      throw receivingJobLeft(err, receiver, tenantOf(to).name);
    }
    throw err;
  }

  // Step 4: persist locally, with the tenants the job ran against and the
  // credentials to check it with later (encrypted, see job-credentials.ts), so
  // it keeps checking these tenants after the tool is pointed elsewhere.
  // The migration job ID is shared across both tenants (same ID).
  const sourceCtx = direction === "source-to-dest" ? from : to;
  const destCtx = direction === "source-to-dest" ? to : from;
  let credentials: JobCredentialRefs | undefined;
  try {
    credentials = (await storeCurrentCredentials()) ?? undefined;
  } catch (err) {
    log.emit("warn", "migration", `Credentials could not be stored with the job, so it can only be checked while the tool points at these tenants: ${maskSecrets(err instanceof Error ? err.message : String(err))}`);
  }
  let job: LocalMigrationJob;
  try {
    job = await createJob({
      jobName: req.jobName,
      sourceMigrationId: sender.id,
      destMigrationId: receiver.id,
      endpointIds: acceptedEndpoints.map((e) => e.id),
      endpointHostnames: Object.fromEntries(
        acceptedEndpoints.map((e) => [e.id, e.hostname ?? ""]),
      ),
      endpointGroups,
      direction,
      tenants: { source: tenantOf(sourceCtx), dest: tenantOf(destCtx) },
      credentials,
      // Shown on the job page, where the user lands after starting the move.
      ...(senderNote ? { startNotes: [senderNote] } : {}),
    });
  } finally {
    releaseCredentials(credentials);
  }

  return { preflightFailures: [], job };
}

/**
 * A trigger that failed clearly, with what became of the receiving job. Keeps
 * the status Sophos answered with, so the route passes it on as before.
 */
function receivingJobLeft(err: unknown, receiver: SophosMigrationJob, receivingName: string | null | undefined): Error {
  const expiresAt = Date.parse(receiver.expiresAt ?? "");
  const when = Number.isFinite(expiresAt)
    ? `on ${formatDate(new Date(expiresAt))}`
    : `${JOB_LIFETIME_MS / 86_400_000} days after it was created`;
  const reason = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
  const message = `${reason}. The move did not start. The receiving job ${receiver.id} on ${receivingName ?? "the receiving tenant"} stays in place until it expires ${when}, because the Sophos API cannot delete a migration job.`;
  return err instanceof SophosHttpError ? new SophosHttpError(message, err.status) : new Error(message, { cause: err });
}

const inFlight = new Map<string, Promise<LocalMigrationJob | null>>();

/**
 * Check a job on both of its tenants and save the result. Concurrent callers
 * (the job page stream, the Migrations list) share one check. With
 * minAgeMs, a job checked more recently than that is returned as saved.
 */
export async function pollJob(
  localJobId: string,
  opts: { minAgeMs?: number } = {},
): Promise<LocalMigrationJob | null> {
  const running = inFlight.get(localJobId);
  if (running) return running;
  if (opts.minAgeMs) {
    const saved = await getJob(localJobId);
    if (!saved) return null;
    const last = Date.parse(saved.monitor?.lastTriedAt ?? saved.lastPolledAt ?? "");
    if (Number.isFinite(last) && Date.now() - last < opts.minAgeMs) return saved;
  }
  const p = pollOnce(localJobId).finally(() => inFlight.delete(localJobId));
  inFlight.set(localJobId, p);
  return p;
}

/**
 * One check. A failed call never replaces what was saved: the snapshots and
 * check-ins stay as the last successful check left them, and only the monitor
 * state says what went wrong.
 */
async function pollOnce(localJobId: string): Promise<LocalMigrationJob | null> {
  const job = await getJob(localJobId);
  if (!job) return null;
  const now = new Date().toISOString();
  const monitorFail = (state: JobMonitor["state"], message: string, via?: JobMonitor["via"]): JobMonitor => ({
    ...job.monitor,
    state,
    via: via ?? job.monitor?.via,
    message: maskSecrets(message),
    lastTriedAt: now,
  });

  let ctx;
  try {
    ctx = await contextsForJob(job);
  } catch (err) {
    const problem = err instanceof JobAccessError ? err.problem : "error";
    const message = err instanceof Error ? err.message : String(err);
    return updateJob(localJobId, { monitor: monitorFail(problem, message), lastPolledAt: now });
  }
  const { source: src, dest: dst } = ctx;

  const [srcJob, dstJob, srcEndpoints, dstEndpoints] = await Promise.all([
    safe(() => getMigrationJob(src.client, src.tenantId, job.sourceMigrationId)),
    safe(() => getMigrationJob(dst.client, dst.tenantId, job.destMigrationId)),
    safe(() => listMigrationJobEndpoints(src.client, src.tenantId, job.sourceMigrationId)),
    safe(() => listMigrationJobEndpoints(dst.client, dst.tenantId, job.destMigrationId)),
  ]);
  const errors = [srcJob, dstJob, srcEndpoints, dstEndpoints].map((r) => r.error).filter((e): e is string => !!e);

  const rejected = errors.find(isRejection);
  if (rejected) {
    if (ctx.via === "stored") forgetJobContexts(job);
    return updateJob(localJobId, { monitor: monitorFail("rejected", rejected, ctx.via), lastPolledAt: now });
  }

  // An older job with no recorded tenants is only checked with the current
  // connection when both tenants know this migration job; otherwise the tool
  // points at another pair and the answers would be about nothing.
  let tenants = job.tenants;
  if (ctx.unverified) {
    if (isNotFound(srcJob.error) || isNotFound(dstJob.error)) {
      return updateJob(localJobId, {
        monitor: monitorFail("not-found", "This job was not found on the tenants the tool points at now, so it was not checked. Attach the credentials it ran with.", "current"),
        lastPolledAt: now,
      });
    }
    if (!srcJob.value || !dstJob.value) {
      return updateJob(localJobId, { monitor: monitorFail("error", errors[0] ?? "No answer from Sophos.", "current"), lastPolledAt: now });
    }
    const sendingMode = String((job.direction === "dest-to-source" ? dstJob.value : srcJob.value).mode ?? "").toLowerCase();
    if (sendingMode && sendingMode !== "sending") {
      return updateJob(localJobId, {
        monitor: monitorFail("not-found", "The tool's source and destination are the other way round from when this job ran, so it was not checked. Attach the credentials it ran with.", "current"),
        lastPolledAt: now,
      });
    }
    tenants = { source: tenantOf(src), dest: tenantOf(dst) };
  }

  const snapshot = (
    fresh: SophosMigrationJob | null,
    endpoints: unknown[] | null,
    saved: SophosMigrationJob | null,
  ): SophosMigrationJob | null => {
    const savedDetails = (saved as { endpointDetails?: unknown[] } | null)?.endpointDetails;
    if (!fresh && !endpoints) return saved;
    // Stash per-endpoint statuses on the snapshot for the UI (not part of the upstream type).
    return { ...(saved ?? {}), ...(fresh ?? {}), endpointDetails: endpoints ?? savedDetails ?? [] } as SophosMigrationJob;
  };

  // Handover is not arrival: each device moves when it next checks in.
  const receivingIsSource = job.direction === "dest-to-source";
  const checkIn = await refreshCheckIns(
    job,
    receivingIsSource ? srcEndpoints.value : dstEndpoints.value,
    receivingIsSource ? dstEndpoints.value : srcEndpoints.value,
    receivingIsSource ? src : dst,
  );
  if (checkIn.error && isRejection(checkIn.error)) {
    if (ctx.via === "stored") forgetJobContexts(job);
    return updateJob(localJobId, { monitor: monitorFail("rejected", checkIn.error, ctx.via), lastPolledAt: now });
  }

  const next: LocalMigrationJob = {
    ...job,
    tenants,
    sourceSnapshot: snapshot(srcJob.value, srcEndpoints.value, job.sourceSnapshot),
    destSnapshot: snapshot(dstJob.value, dstEndpoints.value, job.destSnapshot),
    checkIns: checkIn.checkIns,
  };
  const problem = errors[0] ?? checkIn.error;
  // Jobs from earlier builds, and credentials entered by hand, recorded no tenant names.
  if (!problem && tenants) tenants = withTenantNames(tenants, [src, dst], await listJobs());
  const monitor: JobMonitor = problem
    ? monitorFail("error", problem, ctx.via)
    : { state: "ok", via: ctx.via, lastOkAt: now, lastTriedAt: now };

  return updateJob(localJobId, {
    tenants,
    sourceSnapshot: next.sourceSnapshot,
    destSnapshot: next.destSnapshot,
    checkIns: next.checkIns,
    status: jobProgress(next).status,
    monitor,
    lastPolledAt: now,
    lastError: problem ? maskSecrets(problem) : undefined,
  });
}

/**
 * The group each device is in, from the endpoint records the preflight
 * already read, so the job keeps the group each device was in when it moved.
 */
function groupSnapshot(endpoints: SophosEndpoint[]): Record<string, EndpointGroupRef | null> {
  const out: Record<string, EndpointGroupRef | null> = {};
  for (const ep of endpoints) {
    const group = (ep as SophosEndpoint & { group?: { id?: string; name?: string } }).group;
    out[ep.id] = group?.name ? { id: group.id, name: group.name } : null;
  }
  return out;
}

function summariseGroups(snapshot: Record<string, EndpointGroupRef | null>) {
  const counts = new Map<string, number>();
  let ungrouped = 0;
  for (const g of Object.values(snapshot)) {
    if (g?.name) counts.set(g.name, (counts.get(g.name) ?? 0) + 1);
    else ungrouped++;
  }
  const groups = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { groups, ungrouped };
}

interface SafeResult<T> {
  value: T | null;
  error?: string;
}
async function safe<T>(fn: () => Promise<T>): Promise<SafeResult<T>> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}
