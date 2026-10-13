// Check-in after a move: Sophos says "succeeded" at the handover, the device arrives minutes later under its new ID.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { checkInFor, checkInWindow, awaitingCheckIn, CHECK_IN_MARGIN_MS, CHECK_IN_EXACT_MS } = await import("../backend/dist/services/device-check-in.js");
const { jobProgress } = await import("../backend/dist/services/job-progress.js");
const { pollJob } = await import("../backend/dist/services/device-migrator.js");
const { getJob } = await import("../backend/dist/services/migration-store.js");

const OLD = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-00000000000a";
const STALE = "00000000-0000-4000-8000-00000000000b";
// Two hours ago, so every time below (up to 90 minutes on) is past, and the job is inside its 14 days.
const T0 = Date.now() - 2 * 60 * 60e3;
const at = (min) => new Date(T0 + min * 60e3).toISOString();

// Shapes measured on 26/09/2026: the new record is registered at the handover with lastSeenAt equal to
// registeredAt; the stale record is the same hostname left behind by an earlier move.
const handedOver = { id: OLD, status: "succeeded", newId: NEW, migratedAt: at(0.1) };
const registered = { id: NEW, hostname: "WIN10", registeredAt: at(0.08), lastSeenAt: at(0.08) };
const stale = { id: STALE, hostname: "WIN10", registeredAt: at(-60 * 24 * 50), lastSeenAt: at(1) };

test("waiting: handed over, the new record has not been seen since it was registered", () => {
  assert.deepEqual(checkInFor(handedOver, [registered]), { state: "waiting", newId: NEW, handedOverAt: at(0.1) });
  assert.equal(checkInFor(handedOver, []).state, "waiting", "no record yet");
  assert.equal(checkInFor(handedOver, [{ ...registered, lastSeenAt: new Date(Date.parse(registered.registeredAt) + CHECK_IN_MARGIN_MS / 2).toISOString() }]).state, "waiting", "inside the margin");
});

test("checked in: the new record's last-seen time passes its registration", () => {
  const seen = { ...registered, lastSeenAt: at(24.8) };
  assert.deepEqual(checkInFor(handedOver, [seen]), { state: "checked-in", newId: NEW, handedOverAt: at(0.1), checkedInAt: at(24.8) });
});

test("a stale record with the same hostname is never matched", () => {
  // The stale record was seen after the handover (another device, or a clock), but it is not the new ID.
  assert.equal(checkInFor(handedOver, [stale]).state, "waiting");
  assert.equal(checkInFor(handedOver, [stale, registered]).state, "waiting");
  const c = checkInFor(handedOver, [stale, { ...registered, lastSeenAt: at(25) }]);
  assert.equal(c.state, "checked-in");
  assert.equal(c.newId, NEW);
  assert.equal(c.checkedInAt, at(25));
});

test("a read that finds the record still waiting is kept, so the check-in is known to come after it", () => {
  // Read at 10 minutes and still waiting: the tool knows the device had not checked in by then.
  const w = checkInFor(handedOver, [registered], undefined, at(10));
  assert.deepEqual(w, { state: "waiting", newId: NEW, handedOverAt: at(0.1), stillWaitingAt: at(10) });
  // A later read that does not return the record (or a failed lookup, which passes no read time) keeps it.
  assert.equal(checkInFor(handedOver, [], w, at(11)).stillWaitingAt, at(10));
  assert.equal(checkInFor(handedOver, [registered], w).stillWaitingAt, at(10));
  // Still waiting at 24.5, checked in by 24.8: both are kept.
  const w2 = checkInFor(handedOver, [registered], w, at(24.5));
  const c = checkInFor(handedOver, [{ ...registered, lastSeenAt: at(24.8) }], w2, at(24.8));
  assert.deepEqual(c, { state: "checked-in", newId: NEW, handedOverAt: at(0.1), checkedInAt: at(24.8), stillWaitingAt: at(24.5) });
});

test("the check-in time stands when the tool saw the device waiting shortly before, and is only first seen otherwise", () => {
  const arrived = (stillWaitingAt, checkedInAt) => ({ state: "checked-in", newId: NEW, handedOverAt: at(0.1), checkedInAt, ...(stillWaitingAt ? { stillWaitingAt } : {}) });
  // The job page was open: waiting at 24.3, checked in at 24.8.
  assert.deepEqual(checkInWindow(arrived(at(24.3), at(24.8))), { at: at(24.8), after: at(24.3), exact: true });
  assert.equal(checkInWindow(arrived(at(22.8), at(24.8))).exact, true, "two minutes apart");
  assert.equal(checkInWindow(arrived(at(22.7), at(24.8))).exact, false, "just over two minutes");
  assert.equal(CHECK_IN_EXACT_MS, 120_000);
  // Seen 27/09 11:49 after the last check at 26/09 16:30 (the 27/09 live test): only when the tool first saw it.
  const late = arrived("2026-09-26T06:30:00.000Z", "2026-09-27T01:49:43.994Z");
  assert.deepEqual(checkInWindow(late), { at: "2026-09-27T01:49:43.994Z", after: "2026-09-26T06:30:00.000Z", exact: false });
  // Never seen waiting: the handover is the lower bound.
  assert.deepEqual(checkInWindow(arrived(undefined, at(1))), { at: at(1), after: at(0.1), exact: true });
  assert.equal(checkInWindow(arrived(undefined, at(24.8))).exact, false);
  assert.equal(checkInWindow({ state: "waiting", newId: NEW }), null);
});

test("the job's progress says, per device, whether its check-in time stands or is only first seen", () => {
  const job = (checkIn) => ({
    localJobId: "p", jobName: "p", createdAt: at(0), direction: "source-to-dest", sourceMigrationId: "j", destMigrationId: "j",
    endpointIds: [OLD], endpointHostnames: { [OLD]: "WIN10" }, status: "in-progress", sourceSnapshot: null, destSnapshot: null,
    checkIns: { [OLD]: checkIn },
  });
  const [open] = jobProgress(job({ state: "checked-in", newId: NEW, handedOverAt: at(0.1), checkedInAt: at(24.8), stillWaitingAt: at(24.3) }), Date.parse(at(30))).devices;
  assert.equal(open.state, "arrived");
  assert.equal(open.checkedInAt, at(24.8));
  assert.equal(open.checkedInAfter, at(24.3));
  assert.equal(open.checkInTimeExact, true);
  const [closed] = jobProgress(job({ state: "checked-in", newId: NEW, handedOverAt: at(0.1), checkedInAt: at(24.8) }), Date.parse(at(30))).devices;
  assert.equal(closed.checkedInAfter, at(0.1));
  assert.equal(closed.checkInTimeExact, false, "saved by an earlier build, or the page was not open");
});

test("not handed over, failed, and a saved check-in that later polls do not move", () => {
  assert.deepEqual(checkInFor({ id: OLD, status: "pending" }, [registered]), { state: "not-moved" });
  assert.deepEqual(checkInFor({ id: OLD, status: "failed" }, []), { state: "move-failed" });
  assert.deepEqual(checkInFor(undefined, []), { state: "not-moved" });
  const first = { state: "checked-in", newId: NEW, handedOverAt: at(0.1), checkedInAt: at(24.8) };
  assert.equal(checkInFor(handedOver, [{ ...registered, lastSeenAt: at(90) }], first), first);
  assert.equal(checkInFor(undefined, [], first), first, "a failed poll keeps what was known");
});

// --- through pollJob against the fake API ---

let jobEndpoints = [];
let destRecords = [];
for (const tenant of [SRC, DST]) {
  fake.on(tenant, "GET", /^\/endpoint\/v1\/migrations\/job-1$/, () => ({ body: { id: "job-1", mode: tenant === DST ? "receiving" : "sending" } }));
  // Only the receiving side returns newId (measured 26/09/2026).
  fake.on(tenant, "GET", /^\/endpoint\/v1\/migrations\/job-1\/endpoints$/, (req) => page(tenant === DST ? jobEndpoints : jobEndpoints.map(({ newId, ...rest }) => rest), req.query));
}
// Ignores the ids filter on purpose, so the stale same-name record is always in the answer.
fake.on(DST, "GET", "/endpoint/v1/endpoints", () => ({ body: { items: destRecords, pages: {} } }));

async function seedJob(extra = {}) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "migration-jobs.json"), JSON.stringify([{
    localJobId: "local-1", jobName: "move", createdAt: at(0), direction: "source-to-dest",
    sourceMigrationId: "job-1", destMigrationId: "job-1", endpointIds: [OLD], endpointHostnames: { [OLD]: "WIN10" },
    status: "in-progress", sourceSnapshot: null, destSnapshot: null, ...extra,
  }], null, 2));
}
const endpointLookups = () => fake.calls.filter((c) => c.path === "/endpoint/v1/endpoints");

test("the job stays open, waiting for check-in, after the API reports the handover", async () => {
  await seedJob();
  jobEndpoints = [handedOver];
  destRecords = [stale, registered];
  fake.reset();
  const before = Date.now();
  const job = await pollJob("local-1");
  assert.equal(job.status, "requested", "handed over is not arrived: the job stays requested until a device checks in");
  const { stillWaitingAt, ...waiting } = job.checkIns[OLD];
  assert.deepEqual(waiting, { state: "waiting", newId: NEW, handedOverAt: at(0.1) });
  assert.ok(Date.parse(stillWaitingAt) >= before - 1000 && Date.parse(stillWaitingAt) <= Date.now(), "the time of this check's read");
  assert.equal(awaitingCheckIn(job), true, "the live stream keeps polling");
  const [lookup] = endpointLookups();
  assert.equal(lookup.tenant, "dst", "the receiving tenant is read");
  assert.equal(lookup.query.ids, NEW, "by the new ID");
  assert.equal(lookup.query.hostnameContains, undefined, "never by hostname");
});

test("the check-in is recorded once, with its time and the new ID, and not looked up again", async () => {
  destRecords = [stale, { ...registered, lastSeenAt: at(24.8) }];
  const stillWaitingAt = (await getJob("local-1")).checkIns[OLD].stillWaitingAt;
  const job = await pollJob("local-1");
  assert.deepEqual(job.checkIns[OLD], { state: "checked-in", newId: NEW, handedOverAt: at(0.1), checkedInAt: at(24.8), stillWaitingAt });
  assert.equal(awaitingCheckIn(job), false);
  assert.deepEqual((await getJob("local-1")).checkIns, job.checkIns, "saved with the job");

  destRecords = [stale, { ...registered, lastSeenAt: at(60) }];
  fake.reset();
  const later = await pollJob("local-1");
  assert.equal(later.checkIns[OLD].checkedInAt, at(24.8));
  assert.equal(endpointLookups().length, 0);
});

test("a move back reads the source tenant, which is then the receiving side", async () => {
  await seedJob({ direction: "dest-to-source" });
  // On a move back DST is the sending side and SRC the receiving one.
  fake.on(SRC, "GET", /^\/endpoint\/v1\/migrations\/job-1$/, () => ({ body: { id: "job-1", mode: "receiving" } }));
  fake.on(DST, "GET", /^\/endpoint\/v1\/migrations\/job-1$/, () => ({ body: { id: "job-1", mode: "sending" } }));
  // Receiving is now SRC: it returns newId, DST (sending) does not.
  fake.on(SRC, "GET", /^\/endpoint\/v1\/migrations\/job-1\/endpoints$/, (req) => page(jobEndpoints, req.query));
  fake.on(DST, "GET", /^\/endpoint\/v1\/migrations\/job-1\/endpoints$/, (req) => page(jobEndpoints.map(({ newId, ...rest }) => rest), req.query));
  fake.on(SRC, "GET", "/endpoint/v1/endpoints", () => ({ body: { items: [registered], pages: {} } }));
  fake.reset();
  const job = await pollJob("local-1");
  assert.equal(job.checkIns[OLD].state, "waiting");
  assert.deepEqual(endpointLookups().map((c) => c.tenant), ["src"]);
});

test("the job page shows each device's check-in and does not call a waiting job complete", async () => {
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  // One row per device from the server's progress, which counts a device arrived only once it has checked in.
  assert.match(js, /job\.progress\.devices/);
  assert.match(js, /Waiting for check-in/);
  assert.match(js, /first seen checked in/);
  assert.doesNotMatch(js, /checked in by \$\{/, "no bare time that reads as the check-in when the tool was not watching");
  assert.match(js, /setHtml\("job-status", statusTag\(job\.status/);
});

test("the job page labels a check-in time it only first saw as first seen, and gives the window on hover", async () => {
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  const src = js.slice(js.indexOf("function checkInTime"), js.indexOf("function renderDetails"));
  const checkInTime = new Function("formatWhen", "esc", "escAttr", `${src}; return checkInTime;`)((iso) => `T(${iso})`, String, String);
  assert.equal(
    checkInTime({ checkedInAt: "b", checkedInAfter: "a", checkInTimeExact: true }),
    `<span class="lane-time" title="Sophos does not record when a device checks in. The tool saw it waiting at T(a) and checked in at T(b).">checked in T(b)</span>`,
  );
  assert.equal(
    checkInTime({ checkedInAt: "b", checkedInAfter: "a", checkInTimeExact: false }),
    `<span class="lane-time" title="Sophos does not record when a device checks in, and the tool was not checking at the time. It checked in after T(a) and by T(b).">first seen checked in T(b)</span>`,
  );
  assert.match(checkInTime({ checkedInAt: "b", checkInTimeExact: false }), /It checked in by T\(b\)\.">first seen checked in T\(b\)</);
});
