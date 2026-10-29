/**
 * Per-device check-in on the receiving tenant after a move.
 *
 * The migrations API reports a device "succeeded" within seconds, with the ID
 * it has on the receiving tenant (newId). Sophos registers a record under that
 * ID at once, offline, with lastSeenAt equal to registeredAt. The device itself
 * only arrives when it next checks in, which took 23 to 25 minutes on both moves
 * measured on 26/09/2026; lastSeenAt then moves past registeredAt.
 *
 * Sophos records no check-in time. While a device is online its lastSeenAt is
 * the time of the request (measured 27/09/2026), so the lastSeenAt the tool
 * reads when it first finds the device checked in is the time of that check,
 * not of the check-in. The tool therefore also keeps the last check that
 * found the device still waiting: the check-in came between the two.
 *
 * Records are matched by newId only, never by hostname: the receiving tenant
 * can hold older offline records with the same hostname (a device that moved
 * away and back leaves one behind).
 */

import type { TenantContext } from "../sophos/tenant-context.js";
import { listAllEndpoints } from "../sophos/api/endpoints.js";
import type { MigrationEndpointStatus } from "../sophos/api/migrations.js";
import type { DeviceCheckIn, LocalMigrationJob, TamperReading } from "./migration-store.js";

/** A receiving-tenant endpoint record, as far as check-in needs it. */
export interface ReceivedRecord {
  id: string;
  hostname?: string;
  lastSeenAt?: string;
  registeredAt?: string;
  tamperProtectionEnabled?: boolean;
  tamperProtectionSupported?: boolean | null;
}

/**
 * A record's tamper protection, as read at `readAt`. Linux has none: Sophos
 * says false, or null. A record that leaves the field out is unknown.
 */
export function tamperReading(record: Pick<ReceivedRecord, "tamperProtectionEnabled" | "tamperProtectionSupported">, readAt: string): TamperReading {
  return {
    enabled: typeof record.tamperProtectionEnabled === "boolean" ? record.tamperProtectionEnabled : null,
    supported: record.tamperProtectionSupported === undefined ? null : record.tamperProtectionSupported === true,
    readAt,
  };
}

/**
 * How far lastSeenAt must pass the registration to count as a check-in.
 * Registration sets the two equal; the margin absorbs clock noise, and a real
 * check-in comes many minutes later.
 */
export const CHECK_IN_MARGIN_MS = 60_000;

/** IDs per endpoint list call. */
const ID_BATCH = 100;

const SUCCEEDED = new Set(["complete", "completed", "succeeded", "migrated"]);
const FAILED = new Set(["failed", "error"]);

/**
 * One device's check-in state. `moved` is its entry in the migration job,
 * `records` are receiving-tenant endpoint records (only the one whose ID is the
 * device's newId is used), `previous` is the state saved by the last poll.
 */
export function checkInFor(
  moved: MigrationEndpointStatus | undefined,
  records: ReceivedRecord[],
  previous?: DeviceCheckIn,
  /** When the records were read; a record read still waiting sets stillWaitingAt to this. */
  readAt?: string,
): DeviceCheckIn {
  if (previous?.state === "checked-in") return previous;
  // Without the job's answer (the call failed, or Sophos no longer returns an
  // expired job), a device already handed over is still looked up by its new ID.
  if (!moved && previous?.state === "waiting" && previous.newId) {
    moved = { id: "", status: "succeeded", newId: previous.newId, migratedAt: previous.handedOverAt };
  }
  if (!moved) return previous ?? { state: "not-moved" };
  const status = (moved.status ?? "").toLowerCase();
  if (FAILED.has(status)) return { state: "move-failed" };
  if (!SUCCEEDED.has(status)) return { state: "not-moved" };

  const newId = moved.newId ?? previous?.newId;
  const handedOverAt = moved.migratedAt ?? previous?.handedOverAt;
  const stillWaitingAt = previous?.stillWaitingAt;
  const waiting: DeviceCheckIn = { state: "waiting", newId, handedOverAt, ...(stillWaitingAt ? { stillWaitingAt } : {}) };
  const record = newId ? records.find((r) => r.id === newId) : undefined;
  if (!record?.lastSeenAt) return waiting;
  const registered = Date.parse(record.registeredAt ?? handedOverAt ?? "");
  const seen = Date.parse(record.lastSeenAt);
  if (!Number.isFinite(registered) || !Number.isFinite(seen) || seen - registered <= CHECK_IN_MARGIN_MS) {
    // Read, and not checked in yet: the check-in comes after this read.
    return readAt ? { ...waiting, stillWaitingAt: readAt } : waiting;
  }
  return {
    state: "checked-in",
    newId,
    handedOverAt,
    checkedInAt: record.lastSeenAt,
    ...(stillWaitingAt ? { stillWaitingAt } : {}),
    // The receiving tenant's tamper protection on the device as it arrived, when the record says.
    ...(record.tamperProtectionEnabled !== undefined || record.tamperProtectionSupported !== undefined
      ? { tamperProtection: tamperReading(record, readAt ?? record.lastSeenAt) }
      : {}),
  };
}

/**
 * How far apart the last check that found a device waiting and the first
 * that found it checked in can be for the second to stand as its check-in
 * time. The job page checks every 30 seconds while devices wait.
 */
export const CHECK_IN_EXACT_MS = 2 * 60_000;

/**
 * A checked-in device's check-in time, as far as the tool knows it: after
 * `after` (the last check that found it waiting, or the handover) and by
 * `at`. `exact` is true when the two are close enough for `at` to stand as
 * the check-in time; otherwise `at` is only when the tool first saw it.
 */
export function checkInWindow(c: DeviceCheckIn): { at: string; after?: string; exact: boolean } | null {
  if (c.state !== "checked-in" || !c.checkedInAt) return null;
  const after = c.stillWaitingAt ?? c.handedOverAt;
  const gap = Date.parse(c.checkedInAt) - Date.parse(after ?? "");
  return { at: c.checkedInAt, ...(after ? { after } : {}), exact: Number.isFinite(gap) && gap <= CHECK_IN_EXACT_MS };
}

/**
 * Check-in state for every device in a job. The receiving side's job entries
 * carry newId; the sending side's fill any device the receiving side did not
 * return. Only devices handed over and not yet checked in are looked up, by ID.
 */
/**
 * One entry per device from both sides of a job. The receiving side's entries
 * carry newId; the sending side's fill any device the receiving side did not
 * return.
 */
export function mergeEndpointStatuses(
  receiving: MigrationEndpointStatus[] | null | undefined,
  sending: MigrationEndpointStatus[] | null | undefined,
): Map<string, MigrationEndpointStatus> {
  const byId = new Map<string, MigrationEndpointStatus>();
  for (const e of receiving ?? []) byId.set(e.id, e);
  for (const e of sending ?? []) {
    const known = byId.get(e.id);
    byId.set(e.id, known ? { ...e, ...known, newId: known.newId ?? e.newId, migratedAt: known.migratedAt ?? e.migratedAt } : e);
  }
  return byId;
}

export async function refreshCheckIns(
  job: LocalMigrationJob,
  receiving: MigrationEndpointStatus[] | null,
  sending: MigrationEndpointStatus[] | null,
  to: TenantContext,
): Promise<{ checkIns: Record<string, DeviceCheckIn>; error?: string }> {
  const byId = mergeEndpointStatuses(receiving, sending);

  const previous = job.checkIns ?? {};
  const wanted = new Set<string>();
  for (const id of job.endpointIds) {
    const draft = checkInFor(byId.get(id), [], previous[id]);
    if (draft.state === "waiting" && draft.newId) wanted.add(draft.newId);
  }

  const records: ReceivedRecord[] = [];
  let error: string | undefined;
  const ids = [...wanted];
  // Taken before the lookup, so a device read as waiting had not checked in by then.
  const readAt = new Date().toISOString();
  try {
    for (let i = 0; i < ids.length; i += ID_BATCH) {
      records.push(...(await listAllEndpoints(to.client, to.tenantId, { ids: ids.slice(i, i + ID_BATCH) })));
    }
  } catch (err) {
    error = `Check-in lookup on the receiving tenant failed: ${err instanceof Error ? err.message : String(err)}`;
  }

  const checkIns: Record<string, DeviceCheckIn> = {};
  for (const id of job.endpointIds) checkIns[id] = checkInFor(byId.get(id), records, previous[id], error ? undefined : readAt);
  return { checkIns, error };
}

/** True while a handed-over device has not checked in on the receiving tenant. */
export function awaitingCheckIn(job: Pick<LocalMigrationJob, "checkIns">): boolean {
  return Object.values(job.checkIns ?? {}).some((c) => c.state === "waiting");
}
