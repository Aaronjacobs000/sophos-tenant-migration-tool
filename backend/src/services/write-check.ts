/**
 * What happened to a write Sophos gave no clear answer to.
 *
 * Sophos can answer 500 to a create and still make the object (seen live on
 * the detection profile API, 26/09/2026), so the API client never sends a
 * write twice (sophos-client.ts): it throws UnclearWriteError. The copies
 * then read the destination back, a few times to get past read lag, and
 * report what they find: made, with a note saying how Sophos answered, or not
 * found, saying where the tool looked and what it found there. A miss is not
 * proof, because Sophos can take a while to show a write, so the advice is
 * to wait before trying again, not to check a place the tool already read.
 */

import { UnclearWriteError } from "../sophos/client/sophos-client.js";

export { UnclearWriteError };

/** The waits before each read-back, in milliseconds: reads at about 1, 4 and 10 s. */
let delaysMs = [1000, 3000, 6000];

/**
 * The waits for a policy's read-back: reads at about 1, 4, 10, 18 and 26 s.
 * Sophos can take up to about 22 s to list a new policy (measured 13/10/2026),
 * while GET by ID finds it at once.
 */
let policyDelaysMs = [1000, 3000, 6000, 8000, 8000];

/** Tests shorten the waits. The policy waits follow unless given. */
export function setReadBackDelays(ms: number[], policyMs: number[] = ms): void {
  delaysMs = ms;
  policyDelaysMs = policyMs;
}

/** The waits for a read-back that looks in the policy list. */
export function policyReadBackDelays(): number[] {
  return policyDelaysMs;
}

export function isUnclearWrite(err: unknown): err is UnclearWriteError {
  return err instanceof UnclearWriteError;
}

/** What a read-back found, or, when no read worked, why. */
export interface ReadBack<T> {
  value?: T;
  /** Set when every read failed, so nothing was read at all. */
  unread?: string;
}

/**
 * Reads back until find() returns something, waiting before each read. A
 * read that fails counts as a miss, and when every read fails the result
 * says why, so "not found" is never claimed for a destination nobody read.
 */
export async function readBack<T>(
  find: () => Promise<T | null | undefined>,
  delays: number[] = delaysMs,
): Promise<ReadBack<T>> {
  let read = false;
  let lastError: unknown;
  for (const ms of delays) {
    await new Promise((r) => setTimeout(r, ms));
    try {
      const found = await find();
      read = true;
      if (found !== null && found !== undefined) return { value: found };
    } catch (err) {
      // A failed read is a miss; the next one may work.
      lastError = err;
    }
  }
  return read ? {} : { unread: lastError instanceof Error ? lastError.message : String(lastError) };
}

/** How Sophos answered, for a note: "answered 500" or "gave no answer". */
function answered(err: UnclearWriteError): string {
  return err.status ? `Sophos answered ${err.status}` : "Sophos gave no clear answer";
}

/** The note on a write Sophos answered unclearly and a read-back found done. */
export function foundNote(err: UnclearWriteError, what = "it", where = "on the destination"): string {
  return `${answered(err)}, but a read-back found ${what} ${where}, so the change was made`;
}

/** Said with every miss: Sophos can be slow to show a write, so not finding it proves nothing. */
export const READ_LAG_CAVEAT = "Sophos can take a while to show a change, so this does not prove it failed.";

/**
 * The advice after a create a read-back did not find. Every copy skips what
 * is already on the destination, so trying again after a wait is safe.
 */
export const CREATE_RETRY_ADVICE = "Wait a minute or two, then try again: anything on the destination by then is skipped as already there.";

/** Where a read-back looked and what it found, for the message when it finds nothing. */
export interface ReadBackMiss {
  /** What the tool read, for example "the destination's endpoint groups". */
  where: string;
  /** What it found there, for example 'no group named "Finance"'. */
  found: string;
  /** What to do next, given that the tool has already looked. Defaults to CREATE_RETRY_ADVICE. */
  advice?: string;
  /** What to check by hand when no read worked. Defaults to "the destination". */
  check?: string;
}

/** "three times over about 10 seconds", from the waits. */
function readsSaid(delays: number[]): string {
  const n = delays.length;
  const times = n === 1 ? "once" : n === 2 ? "twice" : n === 3 ? "three times" : `${n} times`;
  const seconds = Math.round(delays.reduce((a, b) => a + b, 0) / 1000);
  return seconds >= 1 ? `${times} over about ${seconds} seconds` : times;
}

/**
 * The error for an unclear write a read-back did not find, or could not
 * read (unread): still unclear. It says where the tool looked and what it
 * found, that a miss is not proof, and what to do next; or, when nothing
 * could be read, what to check by hand.
 */
export function notFound(err: UnclearWriteError, miss: ReadBackMiss, unread?: string, delays: number[] = delaysMs): UnclearWriteError {
  const reason = err.reason.replace(/\.$/, "");
  if (unread) {
    return new UnclearWriteError(
      `${reason}. A read-back could not read ${miss.where} (${unread.replace(/\.$/, "")})`,
      err.method,
      err.status,
      `The change may still have gone through: check ${miss.check ?? "the destination"} before trying again.`,
    );
  }
  return new UnclearWriteError(
    `${reason}. The tool read ${miss.where} ${readsSaid(delays)} and found ${miss.found}`,
    err.method,
    err.status,
    `${READ_LAG_CAVEAT} ${miss.advice ?? CREATE_RETRY_ADVICE}`,
  );
}

/**
 * Why an item was not sent: an earlier create in the same run, for an item
 * with the same name (or value), got no clear answer, so this one could make
 * a duplicate.
 */
export function earlierUnclear(same = "name"): string {
  return `not sent: an earlier create in this run with the same ${same} got no clear answer from Sophos, so this one could make a duplicate. Wait a minute or two, then try again: anything on the destination by then is skipped as already there`;
}

/**
 * Runs a create. When Sophos gives no clear answer, reads the destination
 * back with find(): the object and a note when it is there, else an
 * UnclearWriteError that says where the tool looked and what it found.
 */
export async function createChecked<T>(
  create: () => Promise<T>,
  find: () => Promise<T | null | undefined>,
  what: string,
  miss: ReadBackMiss,
  delays: number[] = delaysMs,
): Promise<{ value: T; note?: string }> {
  try {
    return { value: await create() };
  } catch (err) {
    if (!isUnclearWrite(err)) throw err;
    const found = await readBack(find, delays);
    if (found.value !== undefined) return { value: found.value, note: foundNote(err, what) };
    throw notFound(err, miss, found.unread, delays);
  }
}
