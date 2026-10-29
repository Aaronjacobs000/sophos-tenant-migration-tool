/**
 * Job status and progress, worked out from each device.
 *
 * A device is requested until Sophos hands it over, then waits until it checks
 * in on the receiving tenant under its new ID (device-check-in.ts). Sophos
 * hands over in seconds; the check-in took 23 to 25 minutes in testing and can
 * take much longer for a laptop that is switched off, so a long wait is shown
 * as a wait, never as a failure. A device fails only when Sophos says so, or
 * when the migration job expires (14 days) before the device checked in.
 *
 * The job is requested until one device has arrived, in progress until all
 * have, then completed. When every device has either arrived or failed, it
 * ends completed with failures (some arrived) or failed (none did).
 */

import { checkInFor, checkInWindow, mergeEndpointStatuses } from "./device-check-in.js";
import type { JobStatus, LocalMigrationJob, TamperReading, TamperState } from "./migration-store.js";
import type { MigrationEndpointStatus } from "../sophos/api/migrations.js";

export type DeviceState = "requested" | "waiting" | "arrived" | "failed" | "expired";

export interface DeviceProgress {
  id: string;
  hostname: string;
  state: DeviceState;
  newId?: string;
  handedOverAt?: string;
  /** When the tool first saw the device checked in; the check-in came by then. */
  checkedInAt?: string;
  /** The check-in came after this: the last check that found the device waiting, or the handover. */
  checkedInAfter?: string;
  /**
   * True when checkedInAt is within a couple of checks of the check-in, so it
   * stands as the check-in time; false when the tool was not checking at the
   * time and checkedInAt is only when it first saw the device checked in.
   */
  checkInTimeExact?: boolean;
  /** Why Sophos failed the device, when it said. */
  reason?: string;
  /** The device's group on the sending tenant when the job was created. */
  group?: string | null;
  /** Tamper protection on the sending tenant when the job was created, and on the receiving tenant once it arrived. */
  tamperProtection?: DeviceTamper;
}

export interface DeviceTamper {
  /** On the sending tenant when the job was created; undefined for jobs from before 0.5.0. */
  atSource?: boolean | null;
  /** On the receiving tenant, from the latest read of the arrived device; undefined until then. */
  arrived?: boolean | null;
  /** False for a device without tamper protection, such as Linux. */
  supported?: boolean | null;
  /** When `arrived` was read. */
  readAt?: string;
  /** On at the source, off on the receiving tenant. */
  lost: boolean;
}

export interface JobProgress {
  status: JobStatus;
  total: number;
  arrived: number;
  waiting: number;
  requested: number;
  failed: number;
  expired: number;
  /** Share of devices that have arrived, 0 to 100. Only 100 when all have. */
  percent: number;
  /** No device is still requested or waiting, so nothing more will change. */
  finished: boolean;
  /** When the migration job expires: devices that have not checked in by then do not move. */
  expiresAt: string;
  /** Earliest handover among devices still waiting for check-in. */
  oldestWaitSince?: string;
  /** Arrived devices that had tamper protection on at the source and have it off now. */
  tamperLost: number;
  devices: DeviceProgress[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const JOB_LIFETIME_MS = 14 * DAY_MS;

type SnapshotWithDetails = { endpointDetails?: MigrationEndpointStatus[]; expiresAt?: string } | null | undefined;

function details(snap: unknown): MigrationEndpointStatus[] {
  return ((snap as SnapshotWithDetails)?.endpointDetails ?? []) as MigrationEndpointStatus[];
}

export function jobExpiresAt(job: Pick<LocalMigrationJob, "createdAt" | "sourceSnapshot" | "destSnapshot">): string {
  const fromApi = (job.sourceSnapshot as SnapshotWithDetails)?.expiresAt ?? (job.destSnapshot as SnapshotWithDetails)?.expiresAt;
  if (fromApi && Number.isFinite(Date.parse(fromApi))) return new Date(Date.parse(fromApi)).toISOString();
  return new Date(Date.parse(job.createdAt) + JOB_LIFETIME_MS).toISOString();
}

export function jobProgress(job: LocalMigrationJob, now: number = Date.now()): JobProgress {
  const receivingIsSource = job.direction === "dest-to-source";
  const moved = mergeEndpointStatuses(
    details(receivingIsSource ? job.sourceSnapshot : job.destSnapshot),
    details(receivingIsSource ? job.destSnapshot : job.sourceSnapshot),
  );
  const expiresAt = jobExpiresAt(job);
  const expired = now > Date.parse(expiresAt);

  const devices: DeviceProgress[] = job.endpointIds.map((id) => {
    const entry = moved.get(id);
    // Jobs never checked since check-in tracking began have no saved check-in; the snapshot still says whether Sophos handed the device over.
    const c = job.checkIns?.[id] ?? checkInFor(entry, []);
    const atSource = job.endpointTamperProtection?.[id];
    const base = {
      id,
      hostname: job.endpointHostnames?.[id] || id,
      newId: c.newId,
      handedOverAt: c.handedOverAt,
      group: job.endpointGroups ? (job.endpointGroups[id]?.name ?? null) : undefined,
      ...(atSource ? { tamperProtection: { atSource: atSource.enabled, supported: atSource.supported, lost: false } } : {}),
    };
    switch (c.state) {
      case "checked-in": {
        const w = checkInWindow(c);
        return {
          ...base,
          state: "arrived",
          checkedInAt: c.checkedInAt,
          ...(w?.after ? { checkedInAfter: w.after } : {}),
          checkInTimeExact: w?.exact ?? false,
          ...arrivedTamper(atSource, latestReading(c.tamperProtection, job.arrivalTamper?.[id])),
        };
      }
      case "move-failed":
        return { ...base, state: "failed", reason: entry?.reason ?? (entry as { errorMessage?: string } | undefined)?.errorMessage };
      case "waiting":
        return { ...base, state: expired ? "expired" : "waiting" };
      default:
        return { ...base, state: expired ? "expired" : "requested" };
    }
  });

  const count = (s: DeviceState) => devices.filter((d) => d.state === s).length;
  const total = devices.length;
  const arrived = count("arrived");
  const waiting = count("waiting");
  const requested = count("requested");
  const failed = count("failed");
  const expiredCount = count("expired");
  const finished = total > 0 && waiting === 0 && requested === 0;

  let status: JobStatus;
  if (job.status === "cancelled") status = "cancelled";
  else if (finished) status = arrived === total ? "completed" : arrived > 0 ? "completed-with-failures" : "failed";
  else status = arrived > 0 ? "in-progress" : "requested";

  const waits = devices.filter((d) => d.state === "waiting" && d.handedOverAt).map((d) => d.handedOverAt!).sort();
  const tamperLost = devices.filter((d) => d.tamperProtection?.lost).length;

  return {
    status,
    total,
    arrived,
    waiting,
    requested,
    failed,
    expired: expiredCount,
    percent: total === 0 ? 0 : arrived === total ? 100 : Math.floor((arrived / total) * 100),
    finished: finished || status === "cancelled",
    expiresAt,
    oldestWaitSince: waits[0],
    tamperLost,
    devices,
  };
}

/** The newer of two readings of an arrived device's tamper protection. */
function latestReading(a: TamperReading | undefined, b: TamperReading | undefined): TamperReading | undefined {
  if (!a || !b) return a ?? b;
  return Date.parse(b.readAt) >= Date.parse(a.readAt) ? b : a;
}

/** An arrived device's tamper protection: the source state, the latest reading, and whether it was lost. */
function arrivedTamper(atSource: TamperState | undefined, reading: TamperReading | undefined): { tamperProtection?: DeviceTamper } {
  if (!atSource && !reading) return {};
  return {
    tamperProtection: {
      ...(atSource ? { atSource: atSource.enabled } : {}),
      supported: reading?.supported ?? atSource?.supported ?? null,
      ...(reading ? { arrived: reading.enabled, readAt: reading.readAt } : {}),
      lost: atSource?.enabled === true && reading?.enabled === false,
    },
  };
}

/**
 * How long until the live stream checks a job again, or null once it has
 * finished. Quick while Sophos is handing devices over (seconds), slower while
 * they wait to check in (minutes), and slow when the credentials were refused,
 * so a deleted credential is not retried every few seconds for hours.
 */
export function nextCheckDelayMs(job: LocalMigrationJob, progress: JobProgress = jobProgress(job)): number | null {
  if (progress.finished) return null;
  const state = job.monitor?.state;
  if (state === "rejected" || state === "no-credentials" || state === "not-found") return 5 * 60_000;
  if (state === "error") return 60_000;
  if (progress.requested > 0) return 10_000;
  return 30_000;
}
