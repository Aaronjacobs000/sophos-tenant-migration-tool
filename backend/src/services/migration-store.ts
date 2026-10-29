/**
 * Local persistence for device-migration jobs. Each entry tracks the
 * IDs of the source and destination Sophos migration jobs plus a snapshot
 * of the last polled state, so the UI can resume monitoring after restart.
 *
 * Stored as a single JSON file at data/migration-jobs.json, with a copy in
 * data/migration-jobs.auto-backup.json that a jobs file cut off by a crash is
 * recovered from (see writeAll). The copy's name keeps it apart from a manual
 * backup, which the tool would otherwise overwrite on its next save.
 *
 * File operations retry on EBUSY / EPERM / EACCES: OneDrive (and other
 * cloud-sync tools) and antivirus briefly lock files, which causes transient
 * failures on Windows (see safe-files.ts).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getState } from "../state.js";
import { log } from "../log.js";
import { isLock, readWithBackup, saveWithBackup, type ReadFrom } from "./safe-files.js";
import type { SophosMigrationJob } from "../sophos/types/migration.js";

/** The wait before the first retry on a locked file. Tests shorten it. */
export { setRetryDelay } from "./safe-files.js";

const SECTION = "migration-store";

export interface EndpointGroupRef {
  id?: string;
  name: string;
}

/** A device's tamper protection as its endpoint record showed it. */
export interface TamperState {
  /** tamperProtectionEnabled, or null when the record did not say. */
  enabled: boolean | null;
  /** tamperProtectionSupported: false (or null) on devices without it, such as Linux. */
  supported: boolean | null;
}

/** Tamper protection on the receiving tenant, and when the tool read it. */
export interface TamperReading extends TamperState {
  readAt: string;
}

/** The receiving tenant's global tamper protection setting, and when the tool read it. */
export interface TamperGlobalReading {
  enabled: boolean;
  readAt: string;
}

/**
 * Where a device is on the receiving tenant. Sophos hands a device over within
 * seconds, but the device only moves when it next checks in, under its new ID.
 */
export interface DeviceCheckIn {
  state: "not-moved" | "move-failed" | "waiting" | "checked-in";
  /** The device's ID on the receiving tenant, from the migration job. */
  newId?: string;
  /** When Sophos reported the device moved (migratedAt). */
  handedOverAt?: string;
  /**
   * The device's last-seen time when the tool first found it checked in. The
   * device had checked in by then. Sophos records no check-in time, and an
   * online device's last-seen time is the time of the check, so this is when
   * the tool first saw it checked in.
   */
  checkedInAt?: string;
  /**
   * The last check that read the device's new record and found it had not
   * checked in yet. The check-in came after this and by checkedInAt.
   */
  stillWaitingAt?: string;
  /** Tamper protection on the new record when the check found the device checked in. */
  tamperProtection?: TamperReading;
}

/**
 * A tenant a job ran against, recorded when the job is created (or when
 * credentials are attached to an older job), so the job keeps checking the
 * same tenants after the tool is pointed at another pair.
 */
export interface JobTenant {
  tenantId: string;
  /** Display name at the time: the label, or the tenant name in partner mode. */
  name: string | null;
  /** Regional data host, for example https://api-eu02.central.sophos.com. */
  apiHost: string;
  region: string | null;
}

/**
 * References into the encrypted job credential store (job-credentials.ts).
 * No secret is kept in the job itself. In partner mode both sides refer to
 * the same partner credential.
 */
export interface JobCredentialRefs {
  mode: "direct" | "partner";
  source: string;
  dest: string;
  storedAt: string;
}

/**
 * How the last check of a job went. A failed check never replaces the saved
 * snapshots or check-ins; it only changes this.
 */
export interface JobMonitor {
  /**
   * ok: both tenants answered. rejected: Sophos refused the credentials
   * (deleted, rotated or no longer allowed). no-credentials: nothing to check
   * with. not-found: an older job with no recorded tenants was not found on the
   * tenants the tool points at. error: any other failure, retried.
   */
  state: "ok" | "rejected" | "no-credentials" | "not-found" | "error";
  /** Where the credentials for the last check came from. */
  via?: "stored" | "current";
  message?: string;
  /** Last check that reached both tenants. */
  lastOkAt?: string;
  lastTriedAt?: string;
}

/**
 * Job status, from the devices: requested once Sophos has accepted the job,
 * in-progress once one device has checked in on the receiving tenant,
 * completed once all have. A job where every device has arrived or failed
 * ends completed-with-failures (some arrived) or failed (none did).
 */
export type JobStatus =
  | "requested"
  | "in-progress"
  | "completed"
  | "completed-with-failures"
  | "failed"
  | "cancelled";

export interface LocalMigrationJob {
  localJobId: string;
  jobName: string;
  createdAt: string;
  /** "source-to-dest" or "dest-to-source" */
  direction: string;
  sourceMigrationId: string;
  destMigrationId: string;
  endpointIds: string[];
  endpointHostnames: Record<string, string>;
  /**
   * The group each device was in on the sending tenant when the job was
   * created (null for no group). Absent on jobs created before 0.2.0.
   */
  endpointGroups?: Record<string, EndpointGroupRef | null>;
  /**
   * Each device's tamper protection on the sending tenant when the job was
   * created, from the pre-flight's reads. Absent on jobs created before 0.5.0.
   */
  endpointTamperProtection?: Record<string, TamperState>;
  /** Check-in on the receiving tenant, by the device's ID on the sending tenant. */
  checkIns?: Record<string, DeviceCheckIn>;
  /**
   * The latest read of each arrived device's tamper protection on the
   * receiving tenant by a job page action (preview or run), by the device's ID
   * on the sending tenant. The job check never writes it, so a check running
   * at the same time can't undo it.
   */
  arrivalTamper?: Record<string, TamperReading>;
  /**
   * The receiving tenant's global tamper protection, from the latest job page
   * action that could read it. While it is off, a device can't be turned on.
   */
  receivingTamperGlobal?: TamperGlobalReading;
  /**
   * Notes from starting the job, shown on the job page: a trigger Sophos
   * answered unclearly that a read-back found started says so here.
   */
  startNotes?: string[];
  /**
   * Derived from the devices on every check (job-progress.ts). Jobs saved by
   * earlier versions may hold "complete", "in-progress" or "partially-complete",
   * which meant the handover only; they are recomputed when read.
   */
  status: JobStatus | "complete" | "partially-complete";
  sourceSnapshot: SophosMigrationJob | null;
  destSnapshot: SophosMigrationJob | null;
  /** The tenants the job ran against. Absent on jobs created by earlier builds. */
  tenants?: { source: JobTenant; dest: JobTenant };
  /** Stored credentials for checking the job later. Absent when none are stored. */
  credentials?: JobCredentialRefs;
  monitor?: JobMonitor;
  lastPolledAt?: string;
  lastError?: string;
}

/**
 * The receiver job's handshake token is a secret, needed only for the sender
 * trigger. It is never stored, and both tenants return it on every job GET, so
 * it is dropped from the API snapshots too. Jobs saved by earlier versions
 * (field fromToken) lose it on the next read and write.
 */
function withoutTokens(job: LocalMigrationJob): LocalMigrationJob {
  const { fromToken: _legacy, ...rest } = job as LocalMigrationJob & { fromToken?: string };
  return { ...rest, sourceSnapshot: snapshotWithoutToken(rest.sourceSnapshot), destSnapshot: snapshotWithoutToken(rest.destSnapshot) };
}

function snapshotWithoutToken(snap: SophosMigrationJob | null | undefined): SophosMigrationJob | null {
  if (!snap) return null;
  const { token: _token, fromToken: _fromToken, ...rest } = snap;
  return rest;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Run one read or save at a time, so a read never meets a save half done. A
 * call that fails fails alone: the next one still runs.
 */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

function jobsFile(): string {
  return path.join(getState().repoRoot, "data", "migration-jobs.json");
}

function backupFile(): string {
  return path.join(getState().repoRoot, "data", "migration-jobs.auto-backup.json");
}

function parseJobs(raw: string): LocalMigrationJob[] {
  const jobs = JSON.parse(raw) as unknown;
  if (!Array.isArray(jobs)) throw new Error("not a list of jobs");
  return (jobs as LocalMigrationJob[]).map(withoutTokens);
}

function readProblem(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  return code ? `can't be opened (${code})` : `is damaged (${err instanceof Error ? err.message : String(err)})`;
}

let recoveryLogged = false;

/**
 * The saved jobs. When the jobs file is missing or can't be read (cut off by a
 * crash mid-save, or held by another program), they come from the backup,
 * which holds the last save or a newer one. With neither, reading fails, so a
 * save never writes over jobs it could not read.
 */
async function readAll(): Promise<{ jobs: LocalMigrationJob[]; from: ReadFrom }> {
  const read = await readWithBackup(jobsFile(), backupFile(), parseJobs, SECTION);
  if (read.from === "file") {
    recoveryLogged = false;
    return { jobs: read.value, from: "file" };
  }
  const problem = read.fileError === undefined ? null : readProblem(read.fileError);
  if (read.from === "none") {
    const backupProblem = read.backupError === undefined ? null : readProblem(read.backupError);
    if (!problem && !backupProblem) return { jobs: [], from: "none" };
    throw new Error(
      `The migration jobs can't be read: data/migration-jobs.json ${problem ?? "is missing"}, ` +
        `and ${backupProblem ? `the backup ${backupProblem}` : "there is no backup"}.`,
    );
  }
  if (!recoveryLogged) {
    recoveryLogged = true;
    log.emit("warn", SECTION, `data/migration-jobs.json ${problem ?? "is missing"}, so the ${read.value.length} jobs in data/migration-jobs.auto-backup.json were used. The next save rewrites it.`);
  }
  return { jobs: read.value, from: "backup" };
}

/** Save the jobs and their backup (see saveWithBackup in safe-files.ts). */
async function writeAll(jobs: LocalMigrationJob[], from: ReadFrom): Promise<void> {
  const text = JSON.stringify(jobs, null, 2);
  try {
    await fs.mkdir(path.dirname(jobsFile()), { recursive: true });
  } catch (err) {
    throw saveError(err, "data");
  }
  await saveWithBackup(jobsFile(), backupFile(), text, from, { section: SECTION, failed: (err, file) => saveError(err, path.basename(file)) });
}

/** An error that says the jobs were not saved, and for a lock, what usually holds the file. */
function saveError(err: unknown, name: string): Error {
  const reason = isLock(err)
    ? `data/${name} stayed locked (${(err as NodeJS.ErrnoException).code}), usually by OneDrive or antivirus. Try again`
    : err instanceof Error ? err.message : String(err);
  return new Error(`Couldn't save the migration jobs: ${reason}.`, { cause: err });
}

export async function listJobs(): Promise<LocalMigrationJob[]> {
  return serial(async () => (await readAll()).jobs);
}

export async function getJob(localJobId: string): Promise<LocalMigrationJob | null> {
  return serial(async () => (await readAll()).jobs.find((j) => j.localJobId === localJobId) ?? null);
}

export async function createJob(
  init: Omit<LocalMigrationJob, "localJobId" | "createdAt" | "status" | "sourceSnapshot" | "destSnapshot">,
): Promise<LocalMigrationJob> {
  const job: LocalMigrationJob = withoutTokens({
    localJobId: randomUUID(),
    createdAt: new Date().toISOString(),
    status: "requested",
    sourceSnapshot: null,
    destSnapshot: null,
    ...init,
  });

  await serial(async () => {
    const { jobs, from } = await readAll();
    jobs.unshift(job);
    await writeAll(jobs, from);
  });
  return job;
}

export async function updateJob(
  localJobId: string,
  patch: Partial<LocalMigrationJob>,
): Promise<LocalMigrationJob | null> {
  return serial(async () => {
    const { jobs, from } = await readAll();
    const idx = jobs.findIndex((j) => j.localJobId === localJobId);
    if (idx < 0) return null;
    jobs[idx] = withoutTokens({ ...jobs[idx]!, ...patch });
    await writeAll(jobs, from);
    return jobs[idx]!;
  });
}

export async function deleteJob(localJobId: string): Promise<void> {
  await serial(async () => {
    const { jobs, from } = await readAll();
    const filtered = jobs.filter((j) => j.localJobId !== localJobId);
    await writeAll(filtered, from);
  });
}
