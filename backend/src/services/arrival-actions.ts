/**
 * Actions on devices that have arrived on the receiving tenant. The user runs
 * them from the job page; nothing runs on its own when a device arrives.
 *
 * Tamper protection. A moved device takes the receiving tenant's tamper
 * protection (on 26/09/2026 a device went from off to on, then off again), so
 * this can turn it on and make new passwords:
 *   POST /endpoint/v1/endpoints/tamper-protection
 *     { ids, enabled: true, regeneratePassword: true }, at most 200 IDs a call
 * Only devices that have checked in, and that have tamper protection, are
 * sent. The records are read back (GET /endpoints?ids=), and each new
 * password through the device's own tamper protection read, which shows when
 * its password last changed. A password is never read out or kept. A device
 * can't be turned on while the tenant's global setting is off, and the API
 * can only read that setting, so then turning on is neither offered nor sent;
 * new passwords still are. A move itself gives each device a new password
 * from the receiving tenant (seen 29/10/2026), so new passwords are for
 * changing it again.
 *
 * Scan. POST /endpoint/v1/endpoints/scans { ids }, at most 500 IDs a call.
 * Sophos only says a scan was requested; a scan that runs shows as an event
 * on the device.
 *
 * A request Sophos answers unclearly is never sent again (sophos-client.ts).
 * For tamper protection the read-back says what happened; a scan can't be
 * read back, so it says where to look. Every request is audited, and both
 * directions work: the receiving tenant is whichever side the job moved to.
 */

import { auditOrWarn } from "./audit-log.js";
import { foundNote, isUnclearWrite, readBackDelays, READ_LAG_CAVEAT, UnclearWriteError } from "./write-check.js";
import { verifiedContextsForJob } from "./job-access.js";
import { getJob, updateJob, type LocalMigrationJob, type TamperGlobalReading, type TamperReading } from "./migration-store.js";
import { tamperReading } from "./device-check-in.js";
import { JobNotFoundError } from "./group-membership.js";
import { maskSecrets } from "../log.js";
import { getEndpointsByIds } from "../sophos/api/endpoints.js";
import {
  getGlobalTamperProtection,
  MAX_IDS_PER_TAMPER_REQUEST,
  readTamperPasswordState,
  requestTamperProtection,
  type BulkEndpointResponse,
} from "../sophos/api/tamper-protection.js";
import { MAX_IDS_PER_SCAN_REQUEST, requestScans } from "../sophos/api/scans.js";
import type { TenantContext, TenantLabel } from "../sophos/tenant-context.js";
import type { SophosEndpoint } from "../sophos/types/sophos.js";

export { JobNotFoundError };

/** Which arrived devices an action covers: all of them, or those that had tamper protection on at the source. */
export type TamperScope = "all" | "was-on";

export interface TamperActionRequest {
  dryRun: boolean;
  /** Turn tamper protection on where it is off. */
  turnOn: boolean;
  /** Make a new tamper protection password for each device. */
  newPasswords: boolean;
  scope: TamperScope;
}

export type TamperChange = "turn-on" | "new-password";

export type TamperRowStatus =
  | "will-change"
  | "changed"
  | "requested"
  | "failed"
  | "already-on"
  | "cant-turn-on"
  | "not-supported"
  | "out-of-scope"
  | "not-arrived"
  | "not-found";

export const TAMPER_STATUSES: TamperRowStatus[] = [
  "will-change", "changed", "requested", "failed", "already-on", "cant-turn-on", "not-supported", "out-of-scope", "not-arrived", "not-found",
];

export interface TamperRow {
  endpointId: string;
  hostname: string;
  newId: string | null;
  /** On at the sending tenant when the job was created; undefined for jobs from before 0.5.0. */
  atSource?: boolean | null;
  /** On the receiving tenant, read before the action. */
  before: boolean | null;
  /** On the receiving tenant, read back after the action. */
  after?: boolean | null;
  /** A read-back found the password changed after the request. */
  passwordChanged?: boolean;
  /** What was (or, in a preview, would be) asked for. */
  changes: TamperChange[];
  status: TamperRowStatus;
  message?: string;
}

export interface TamperActionResult {
  localJobId: string;
  dryRun: boolean;
  receivingSide: TenantLabel;
  receivingName: string | null;
  /** The receiving tenant's global tamper protection; null when it could not be read. */
  globalEnabled: boolean | null;
  /** Whether the job recorded each device's tamper protection at the source (jobs from 0.5.0 on). */
  sourceRecorded: boolean;
  options: { turnOn: boolean; newPasswords: boolean; scope: TamperScope };
  rows: TamperRow[];
  counts: Record<TamperRowStatus, number>;
  notes: string[];
}

export type ScanRowStatus = "will-scan" | "requested" | "failed" | "not-arrived" | "not-found";
export const SCAN_STATUSES: ScanRowStatus[] = ["will-scan", "requested", "failed", "not-arrived", "not-found"];

export interface ScanRow {
  endpointId: string;
  hostname: string;
  newId: string | null;
  status: ScanRowStatus;
  requestedAt?: string;
  message?: string;
}

export interface ScanResult {
  localJobId: string;
  dryRun: boolean;
  receivingSide: TenantLabel;
  receivingName: string | null;
  rows: ScanRow[];
  counts: Record<ScanRowStatus, number>;
}

/**
 * Margin for comparing Sophos's clock with this computer's: a password whose
 * last change is no earlier than this before the request was changed by it.
 * Measured 29/10/2026: invalidatedAt was 0.2 s before the request's requestedAt.
 */
const CLOCK_MARGIN_MS = 2 * 60_000;

/** Per-device password reads run this many at a time. */
const PASSWORD_READS_AT_ONCE = 4;

interface Receiving {
  job: LocalMigrationJob;
  side: TenantLabel;
  ctx: TenantContext;
  name: string | null;
  on: string;
}

async function receivingFor(localJobId: string): Promise<Receiving> {
  const job = await getJob(localJobId);
  if (!job) throw new JobNotFoundError(`migration job ${localJobId} not found`);
  const side: TenantLabel = job.direction === "dest-to-source" ? "source" : "dest";
  // The job's own tenants, whatever the tool points at now.
  const contexts = await verifiedContextsForJob(job);
  const ctx = contexts[side];
  const name = job.tenants?.[side]?.name || ctx.summary.displayName || ctx.summary.tenantName || null;
  return { job, side, ctx, name, on: name ? `on ${name}` : "on the receiving tenant" };
}

/** The device's new ID when it has checked in on the receiving tenant, or why it can't be acted on yet. */
function arrival(job: LocalMigrationJob, id: string): { newId: string } | { reason: string } {
  const c = job.checkIns?.[id];
  if (c?.state === "checked-in" && c.newId) return { newId: c.newId };
  if (c?.state === "waiting") return { reason: "handed over, still waiting to check in" };
  if (c?.state === "move-failed") return { reason: "the move failed" };
  return { reason: "not handed over yet" };
}

/** The new records of the arrived devices, by ID, and the reason for any batch that could not be read. */
async function readRecords(ctx: TenantContext, ids: string[]): Promise<{ byId: Map<string, SophosEndpoint>; unread: Map<string, string> }> {
  const read = ids.length ? await getEndpointsByIds(ctx.client, ctx.tenantId, ids) : { records: [], failed: [] };
  const byId = new Map(read.records.map((r) => [r.id.toLowerCase(), r]));
  const unread = new Map(read.failed.flatMap((f) => f.ids.map((id) => [id.toLowerCase(), f.error] as const)));
  return { byId, unread };
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function errMsg(err: unknown): string {
  return maskSecrets(err instanceof Error ? err.message : String(err));
}

/** Why Sophos refused one device in a bulk answer. */
function deviceError(e: NonNullable<BulkEndpointResponse["errors"]>[number]): string {
  const code = e.errorCode ?? "error";
  return e.errorMessage ? `${code}: ${e.errorMessage}` : code;
}

/** Save what the tool just read of each device's tamper protection, and of the tenant's, for the job page. */
async function saveReadings(localJobId: string, readings: Record<string, TamperReading>, global: TamperGlobalReading | null): Promise<void> {
  if (!Object.keys(readings).length && !global) return;
  const job = await getJob(localJobId);
  if (!job) return;
  await updateJob(localJobId, {
    ...(Object.keys(readings).length ? { arrivalTamper: { ...(job.arrivalTamper ?? {}), ...readings } } : {}),
    ...(global ? { receivingTamperGlobal: global } : {}),
  });
}

async function inPool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// Tamper protection
// ---------------------------------------------------------------------------

export async function tamperProtectionAction(localJobId: string, req: TamperActionRequest): Promise<TamperActionResult> {
  const { job, side, ctx, name, on } = await receivingFor(localJobId);
  const options = { turnOn: req.turnOn, newPasswords: req.newPasswords, scope: req.scope };
  const sourceRecorded = !!job.endpointTamperProtection;

  const arrived = new Map<string, string>();
  for (const id of job.endpointIds) {
    const a = arrival(job, id);
    if ("newId" in a) arrived.set(id, a.newId);
  }

  const readAt = new Date().toISOString();
  const [records, global] = await Promise.all([
    readRecords(ctx, [...arrived.values()]),
    getGlobalTamperProtection(ctx.client, ctx.tenantId).then(
      (g) => ({ enabled: typeof g.enabled === "boolean" ? g.enabled : null, error: undefined as string | undefined }),
      (err: unknown) => ({ enabled: null, error: errMsg(err) }),
    ),
  ]);
  const globalEnabled = global.enabled;
  // Turning on has no effect while the tenant's global setting is off, so it is not offered or sent.
  const turnOn = req.turnOn && globalEnabled !== false;
  const cantTurnOn = "tamper protection is off for the whole tenant";

  const readings: Record<string, TamperReading> = {};
  const rows: TamperRow[] = job.endpointIds.map((id) => {
    const hostname = job.endpointHostnames?.[id] || id;
    const atSource = job.endpointTamperProtection ? job.endpointTamperProtection[id]?.enabled ?? null : undefined;
    const base = { endpointId: id, hostname, newId: arrived.get(id) ?? null, ...(atSource !== undefined ? { atSource } : {}), before: null, changes: [] as TamperChange[] };
    const a = arrival(job, id);
    if ("reason" in a) return { ...base, status: "not-arrived", message: a.reason };
    const record = records.byId.get(a.newId.toLowerCase());
    if (!record) {
      const unread = records.unread.get(a.newId.toLowerCase());
      return unread
        ? { ...base, status: "failed", message: `could not read the new record: ${unread}` }
        : { ...base, status: "not-found", message: `the new record is not ${on}; it may have been deleted` };
    }
    const tp = tamperReading(record as SophosEndpoint & { tamperProtectionSupported?: boolean | null }, readAt);
    readings[id] = tp;
    const row = { ...base, before: tp.enabled };
    if (tp.supported === false) return { ...row, status: "not-supported", message: "this device has no tamper protection, as on Linux" };
    if (req.scope === "was-on" && atSource !== true) {
      return { ...row, status: "out-of-scope", message: atSource === false ? "off at the source" : "not recorded at the source" };
    }
    const changes: TamperChange[] = [];
    const blocked = req.turnOn && !turnOn && tp.enabled !== true;
    if (turnOn && tp.enabled !== true) changes.push("turn-on");
    if (req.newPasswords) changes.push("new-password");
    if (!changes.length) {
      return blocked ? { ...row, status: "cant-turn-on", message: cantTurnOn } : { ...row, status: "already-on", message: "already on, so nothing is sent" };
    }
    return { ...row, changes, status: "will-change", ...(blocked ? { message: `can't turn on: ${cantTurnOn}` } : {}) };
  });

  const notes: string[] = [];
  const tenant = name ? ` ${name}` : "";
  if (globalEnabled === false && req.turnOn) {
    notes.push(
      `Tamper protection is off for the whole receiving tenant${tenant}, so a device can't be turned on until it is turned on there in Sophos Fusion under Global Settings > Tamper Protection. The API can only read this setting.`,
    );
  } else if (globalEnabled === null) {
    notes.push(`The receiving tenant's global tamper protection setting could not be read${global.error ? `: ${global.error}` : "."}`);
  }

  const toSend = rows.filter((r) => r.status === "will-change");
  if (!req.dryRun && toSend.length) {
    const sending = { ...req, turnOn };
    const sent = await sendTamper(job, side, ctx, sending, toSend);
    // Read back what Sophos made of it: the records for tamper protection, the
    // device's own read for each new password.
    const afterAt = await readBackTamper(ctx, sending, sent);
    for (const r of toSend) {
      if (r.after !== undefined) readings[r.endpointId] = { enabled: r.after, supported: readings[r.endpointId]?.supported ?? true, readAt: afterAt };
      settle(r, sent.get(r)!.answer);
    }
  }

  await saveReadings(localJobId, readings, globalEnabled === null ? null : { enabled: globalEnabled, readAt });
  const counts = Object.fromEntries(TAMPER_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length])) as Record<TamperRowStatus, number>;
  return { localJobId, dryRun: req.dryRun, receivingSide: side, receivingName: name, globalEnabled, sourceRecorded, options, rows, counts, notes };
}

/** How Sophos answered a device's part of the request, and when it was sent; the read-back settles it. */
type Answer = { kind: "accepted" } | { kind: "refused"; message: string } | { kind: "unclear"; error: UnclearWriteError };
type Sent = Map<TamperRow, { answer: Answer; at: number }>;

async function sendTamper(job: LocalMigrationJob, side: TenantLabel, ctx: TenantContext, req: TamperActionRequest, rows: TamperRow[]): Promise<Sent> {
  const sent: Sent = new Map();
  for (const batch of chunks(rows, MAX_IDS_PER_TAMPER_REQUEST)) {
    const ids = batch.map((r) => r.newId!);
    const body = { ids, ...(req.turnOn ? { enabled: true } : {}), ...(req.newPasswords ? { regeneratePassword: true } : {}) };
    const at = Date.now();
    let res: BulkEndpointResponse | undefined;
    let failure: unknown;
    try {
      res = await requestTamperProtection(ctx.client, ctx.tenantId, body);
    } catch (err) {
      failure = err;
    }
    const refused = new Map((res?.errors ?? []).map((e) => [e.id.toLowerCase(), deviceError(e)]));
    const accepted = new Set((res?.items ?? []).map((i) => i.id.toLowerCase()));
    for (const r of batch) {
      const key = r.newId!.toLowerCase();
      let answer: Answer;
      if (failure) answer = isUnclearWrite(failure) ? { kind: "unclear", error: failure } : { kind: "refused", message: errMsg(failure) };
      else if (refused.has(key)) answer = { kind: "refused", message: refused.get(key)! };
      else if (accepted.has(key)) answer = { kind: "accepted" };
      // Sophos said nothing about this device: the read-back decides.
      else answer = { kind: "unclear", error: new UnclearWriteError("Sophos's answer did not mention this device", "POST") };
      sent.set(r, { answer, at });
    }
    await auditOrWarn({
      side,
      tenantId: ctx.tenantId,
      action: "update",
      resource: "endpoint-tamper-protection",
      ok: !failure && refused.size === 0,
      ...(failure ? { error: errMsg(failure) } : refused.size ? { error: `${refused.size} device(s) refused` } : {}),
      detail: {
        localJobId: job.localJobId,
        ids,
        enabled: body.enabled ?? null,
        regeneratePassword: body.regeneratePassword ?? false,
        requested: [...accepted],
        errors: res?.errors ?? null,
      },
    });
  }
  return sent;
}

/**
 * Reads back every device that was sent: the records, until each device asked
 * to turn on reads on or the waits run out, then each new password once.
 * Returns when the records were last read.
 */
async function readBackTamper(ctx: TenantContext, req: TamperActionRequest, sent: Sent): Promise<string> {
  const toCheck = [...sent].filter(([, s]) => s.answer.kind !== "refused").map(([r]) => r);
  let lastAt = new Date().toISOString();
  if (!toCheck.length) return lastAt;
  for (const ms of readBackDelays()) {
    await new Promise((res) => setTimeout(res, ms));
    lastAt = new Date().toISOString();
    try {
      const { byId } = await readRecords(ctx, toCheck.map((r) => r.newId!));
      for (const r of toCheck) {
        const rec = byId.get(r.newId!.toLowerCase());
        if (rec) r.after = tamperReading(rec as SophosEndpoint & { tamperProtectionSupported?: boolean | null }, lastAt).enabled;
      }
    } catch {
      // A failed read is a miss; the next one may work.
    }
    if (!req.turnOn || toCheck.every((r) => r.after === true)) break;
  }
  if (req.newPasswords) {
    await inPool(toCheck, PASSWORD_READS_AT_ONCE, async (r) => {
      try {
        const state = await readTamperPasswordState(ctx.client, ctx.tenantId, r.newId!);
        const changed = Date.parse(state.passwordChangedAt ?? "");
        r.passwordChanged = Number.isFinite(changed) && changed >= sent.get(r)!.at - CLOCK_MARGIN_MS;
      } catch {
        // Left unknown: the row says the read-back did not show it.
      }
    });
  }
  return lastAt;
}

/** The row's final status, from Sophos's answer and the read-back. */
function settle(r: TamperRow, answer: Answer): void {
  if (answer.kind === "refused") {
    r.status = "failed";
    r.message = answer.message;
    return;
  }
  const missing: string[] = [];
  if (r.changes.includes("turn-on") && r.after !== true) {
    missing.push(`tamper protection still reads ${r.after === false ? "off" : "unknown"}`);
  }
  if (r.changes.includes("new-password") && r.passwordChanged !== true) {
    missing.push("the read-back did not show a new password");
  }
  if (!missing.length) {
    r.status = "changed";
    if (answer.kind === "unclear") r.message = foundNote(answer.error, "the change", "on the device's record");
    return;
  }
  if (answer.kind === "accepted") {
    r.status = "requested";
    r.message = `Sophos accepted it, but ${missing.join("; ")}. ${READ_LAG_CAVEAT}`;
    return;
  }
  r.status = "failed";
  r.message =
    `${answer.error.reason.replace(/\.$/, "")}, and ${missing.join("; ")}. ${READ_LAG_CAVEAT} ` +
    "Preview again in a minute: turning tamper protection on again is safe, and each new password request makes another new password.";
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export async function scanArrivedDevices(localJobId: string, req: { dryRun: boolean }): Promise<ScanResult> {
  const { job, side, ctx, name, on } = await receivingFor(localJobId);
  const arrived = new Map<string, string>();
  for (const id of job.endpointIds) {
    const a = arrival(job, id);
    if ("newId" in a) arrived.set(id, a.newId);
  }
  const records = await readRecords(ctx, [...arrived.values()]);
  const rows: ScanRow[] = job.endpointIds.map((id) => {
    const hostname = job.endpointHostnames?.[id] || id;
    const a = arrival(job, id);
    if ("reason" in a) return { endpointId: id, hostname, newId: null, status: "not-arrived", message: a.reason };
    const base = { endpointId: id, hostname, newId: a.newId };
    if (records.byId.has(a.newId.toLowerCase())) return { ...base, status: "will-scan" };
    const unread = records.unread.get(a.newId.toLowerCase());
    return unread
      ? { ...base, status: "failed", message: `could not read the new record: ${unread}` }
      : { ...base, status: "not-found", message: `the new record is not ${on}; it may have been deleted` };
  });

  if (!req.dryRun) {
    for (const batch of chunks(rows.filter((r) => r.status === "will-scan"), MAX_IDS_PER_SCAN_REQUEST)) {
      const ids = batch.map((r) => r.newId!);
      let res: BulkEndpointResponse | undefined;
      let failure: unknown;
      try {
        res = await requestScans(ctx.client, ctx.tenantId, ids);
      } catch (err) {
        failure = err;
      }
      const refused = new Map((res?.errors ?? []).map((e) => [e.id.toLowerCase(), deviceError(e)]));
      const accepted = new Map((res?.items ?? []).map((i) => [i.id.toLowerCase(), i.requestedAt]));
      for (const r of batch) {
        const key = r.newId!.toLowerCase();
        if (failure) {
          r.status = "failed";
          r.message = isUnclearWrite(failure)
            ? `${failure.reason.replace(/\.$/, "")}. The scan may still have been requested, and the API can't show it: a scan that runs shows as an event on the device in Sophos Fusion. Check there before scanning again.`
            : errMsg(failure);
        } else if (refused.has(key)) {
          r.status = "failed";
          r.message = refused.get(key);
        } else if (accepted.has(key)) {
          r.status = "requested";
          const at = accepted.get(key);
          if (at) r.requestedAt = at;
        } else {
          r.status = "failed";
          r.message = "Sophos's answer did not mention this device. A scan that runs shows as an event on the device in Sophos Fusion.";
        }
      }
      await auditOrWarn({
        side,
        tenantId: ctx.tenantId,
        action: "create",
        resource: "endpoint-scan",
        ok: !failure && refused.size === 0,
        ...(failure ? { error: errMsg(failure) } : refused.size ? { error: `${refused.size} device(s) refused` } : {}),
        detail: { localJobId: job.localJobId, ids, requested: [...accepted.keys()], errors: res?.errors ?? null },
      });
    }
  }

  const counts = Object.fromEntries(SCAN_STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length])) as Record<ScanRowStatus, number>;
  return { localJobId, dryRun: req.dryRun, receivingSide: side, receivingName: name, rows, counts };
}
