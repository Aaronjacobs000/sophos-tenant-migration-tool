// Tamper protection and scans on devices that have arrived, run from the job page (0.5.0).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, endpointActions, SRC, DST } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { tamperProtectionAction, scanArrivedDevices } = await import("../backend/dist/services/arrival-actions.js");
const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
const { getJob } = await import("../backend/dist/services/migration-store.js");
const { publicJob } = await import("../backend/dist/services/job-view.js");
const { migrateDevicesRouter } = await import("../backend/dist/routes/migrate-devices.js");
const { getRingBuffer } = await import("../backend/dist/log.js");
setReadBackDelays([0, 0, 0]);
const http = await startHttp([migrateDevicesRouter]);
after(() => http.close());

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const newId = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const recent = new Date(Date.now() - 60e3).toISOString();

/**
 * A job of `n` devices: device i checked in on the receiving tenant as newId(i),
 * except those listed in `waiting`. `atSource` gives each device's tamper
 * protection at the source (true, false, or "none" for a device without it).
 */
async function seed({ n = 4, waiting = [], atSource = () => true, direction = "source-to-dest", recorded = true } = {}) {
  const ids = Array.from({ length: n }, (_, i) => uuid(i + 1));
  const job = {
    localJobId: "local-1", jobName: "wave 1", createdAt: new Date().toISOString(), direction,
    sourceMigrationId: "job-1", destMigrationId: "job-1",
    endpointIds: ids,
    endpointHostnames: Object.fromEntries(ids.map((id, i) => [id, `PC-${i + 1}`])),
    ...(recorded ? {
      endpointTamperProtection: Object.fromEntries(ids.map((id, i) => {
        const v = atSource(i + 1);
        return [id, v === "none" ? { enabled: false, supported: false } : { enabled: v, supported: true }];
      })),
    } : {}),
    checkIns: Object.fromEntries(ids.map((id, i) => [id, waiting.includes(i + 1)
      ? { state: "waiting", newId: newId(i + 1) }
      : { state: "checked-in", newId: newId(i + 1), checkedInAt: recent }])),
    status: "in-progress", sourceSnapshot: null, destSnapshot: null,
  };
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "migration-jobs.json"), JSON.stringify([job], null, 2));
  return ids;
}

/** Receiving-tenant records for devices 1..n: off unless `on` lists it; `linux` lists devices without tamper protection. */
function records(n, { on = [], linux = [] } = {}) {
  return Array.from({ length: n }, (_, i) => ({
    id: newId(i + 1),
    hostname: `PC-${i + 1}`,
    tamperProtectionEnabled: linux.includes(i + 1) ? false : on.includes(i + 1),
    tamperProtectionSupported: !linux.includes(i + 1),
  }));
}

const tpWrites = () => fake.writes().filter((w) => w.path === "/endpoint/v1/endpoints/tamper-protection");
const scanWrites = () => fake.writes().filter((w) => w.path === "/endpoint/v1/endpoints/scans");
const by = (res, n) => res.rows.find((r) => r.endpointId === uuid(n));
const ALL = { turnOn: true, newPasswords: true, scope: "all" };

test("preview: each arrived device's tamper protection, what would change, and why others are left; nothing is written", async () => {
  await seed({ n: 5, waiting: [5], atSource: (i) => (i === 3 ? "none" : i !== 2) });
  const ctl = endpointActions(fake, DST, records(5, { on: [4], linux: [3] }));
  fake.reset();
  const auditBefore = (await readAudit(root)).length;
  const res = await tamperProtectionAction("local-1", { dryRun: true, ...ALL });
  assert.deepEqual(fake.writes(), []);
  assert.equal((await readAudit(root)).length, auditBefore);
  assert.equal(res.dryRun, true);
  assert.equal(res.receivingSide, "dest");
  assert.equal(res.globalEnabled, true);
  assert.equal(res.sourceRecorded, true);
  assert.deepEqual([by(res, 1).status, by(res, 1).changes, by(res, 1).before, by(res, 1).atSource], ["will-change", ["turn-on", "new-password"], false, true]);
  assert.deepEqual([by(res, 2).status, by(res, 2).atSource], ["will-change", false]);
  assert.equal(by(res, 3).status, "not-supported");
  assert.deepEqual([by(res, 4).status, by(res, 4).changes], ["will-change", ["new-password"]], "already on: only a new password");
  assert.deepEqual([by(res, 5).status, by(res, 5).message], ["not-arrived", "handed over, still waiting to check in"]);
  assert.equal(res.counts["will-change"], 3);
  assert.deepEqual(ctl.tamperCalls, []);
  // The read is kept with the job, so the job page shows each device's state.
  const job = await getJob("local-1");
  assert.equal(job.arrivalTamper[uuid(1)].enabled, false);
  assert.equal(job.arrivalTamper[uuid(4)].enabled, true);
  assert.equal(job.arrivalTamper[uuid(5)], undefined);
});

test("turn on only skips devices already on; 'only those on at the source' leaves the rest out", async () => {
  await seed({ n: 3, atSource: (i) => i !== 2 });
  endpointActions(fake, DST, records(3, { on: [3] }));
  const onOnly = await tamperProtectionAction("local-1", { dryRun: true, turnOn: true, newPasswords: false, scope: "all" });
  assert.deepEqual(onOnly.rows.map((r) => r.status), ["will-change", "will-change", "already-on"]);
  const wasOn = await tamperProtectionAction("local-1", { dryRun: true, ...ALL, scope: "was-on" });
  assert.deepEqual(wasOn.rows.map((r) => [r.status, r.message ?? ""]), [["will-change", ""], ["out-of-scope", "off at the source"], ["will-change", ""]]);

  await seed({ n: 1, recorded: false });
  const older = await tamperProtectionAction("local-1", { dryRun: true, ...ALL, scope: "was-on" });
  assert.equal(older.sourceRecorded, false);
  assert.deepEqual([older.rows[0].status, older.rows[0].message], ["out-of-scope", "not recorded at the source"]);
});

test("apply: 200 devices a call, both changes in one body, read back, audited, and no password anywhere", async () => {
  await seed({ n: 250 });
  const ctl = endpointActions(fake, DST, records(250));
  fake.reset();
  const auditBefore = (await readAudit(root)).length;
  const res = await tamperProtectionAction("local-1", { dryRun: false, ...ALL });
  const writes = tpWrites();
  assert.deepEqual(writes.map((w) => w.body.ids.length), [200, 50]);
  for (const w of writes) {
    assert.equal(w.tenant, "dst");
    assert.equal(w.body.enabled, true);
    assert.equal(w.body.regeneratePassword, true);
  }
  assert.equal(res.counts.changed, 250);
  assert.ok(res.rows.every((r) => r.after === true && r.passwordChanged === true));
  const entries = (await readAudit(root)).slice(auditBefore);
  assert.deepEqual(entries.map((e) => [e.side, e.tenantId, e.action, e.resource, e.ok]), [
    ["dest", DST.tenantId, "update", "endpoint-tamper-protection", true],
    ["dest", DST.tenantId, "update", "endpoint-tamper-protection", true],
  ]);
  assert.equal(entries[0].detail.ids.length, 200);
  const anyPassword = [...ctl.passwords.values()].flatMap((p) => [p.password, ...p.previousPasswords.map((x) => x.password)]);
  const text = JSON.stringify(res) + JSON.stringify(entries) + JSON.stringify(getRingBuffer?.() ?? []) + (await readFile(path.join(root, "data", "migration-jobs.json"), "utf8"));
  for (const pw of anyPassword) assert.ok(!text.includes(pw), "a password never leaves the tool's call");
  // The job page sees the new state.
  const view = publicJob(await getJob("local-1"));
  assert.equal(view.progress.devices[0].tamperProtection.arrived, true);
});

test("apply: Sophos refuses some devices, and a 202 one device never applies", async () => {
  await seed({ n: 4 });
  const ctl = endpointActions(fake, DST, records(4));
  ctl.records.delete(newId(4));
  ctl.refuse.set(newId(2), "conflict");
  ctl.neverApply.add(newId(3));
  // Device 4's record went before the preview, so it is not sent at all.
  fake.reset();
  const res = await tamperProtectionAction("local-1", { dryRun: false, turnOn: true, newPasswords: false, scope: "all" });
  assert.deepEqual(tpWrites().map((w) => w.body), [{ ids: [newId(1), newId(2), newId(3)], enabled: true }], "no regeneratePassword when not asked for");
  assert.equal(by(res, 1).status, "changed");
  assert.deepEqual([by(res, 2).status, by(res, 2).message], ["failed", "conflict: refused by the test (conflict)"]);
  assert.equal(by(res, 3).status, "requested");
  assert.match(by(res, 3).message, /^Sophos accepted it, but tamper protection still reads off\. Sophos can take a while to show a change/);
  assert.equal(by(res, 4).status, "not-found");
});

test("with the tenant's global setting off: turn on is not offered or sent, new passwords still are, and the job keeps the setting", async () => {
  await seed({ n: 2 });
  const ctl = endpointActions(fake, DST, records(2, { on: [2] }));
  ctl.global.enabled = false;
  fake.reset();
  const onOnly = await tamperProtectionAction("local-1", { dryRun: true, turnOn: true, newPasswords: false, scope: "all" });
  assert.equal(onOnly.globalEnabled, false);
  assert.match(onOnly.notes[0], /^Tamper protection is off for the whole receiving tenant Test Destination, so a device can't be turned on until it is turned on there in Sophos Fusion under Global Settings > Tamper Protection\. The API can only read this setting\.$/);
  assert.deepEqual([by(onOnly, 1).status, by(onOnly, 1).changes, by(onOnly, 1).message], ["cant-turn-on", [], "tamper protection is off for the whole tenant"]);
  assert.equal(by(onOnly, 2).status, "already-on");
  assert.equal(onOnly.counts["will-change"], 0, "nothing for Apply to send");
  assert.equal(onOnly.counts["cant-turn-on"], 1);
  const job = await getJob("local-1");
  assert.equal(job.receivingTamperGlobal.enabled, false, "the job keeps the receiving tenant's setting for its alert");
  assert.equal(publicJob(job).receivingTamperGlobal.enabled, false);

  const both = await tamperProtectionAction("local-1", { dryRun: true, ...ALL });
  assert.deepEqual([by(both, 1).status, by(both, 1).changes, by(both, 1).message], ["will-change", ["new-password"], "can't turn on: tamper protection is off for the whole tenant"]);
  assert.deepEqual([by(both, 2).status, by(both, 2).changes], ["will-change", ["new-password"]]);

  const res = await tamperProtectionAction("local-1", { dryRun: false, ...ALL });
  assert.deepEqual(tpWrites().map((w) => w.body), [{ ids: [newId(1), newId(2)], regeneratePassword: true }], "enabled is not sent");
  assert.deepEqual(res.rows.map((r) => [r.status, r.passwordChanged]), [["changed", true], ["changed", true]]);
  assert.equal(by(res, 1).after, false);

  ctl.global.enabled = true;
  await tamperProtectionAction("local-1", { dryRun: true, turnOn: true, newPasswords: false, scope: "all" });
  assert.equal((await getJob("local-1")).receivingTamperGlobal.enabled, true, "a later read replaces it");
});

test("apply: an unclear answer is never sent again; the read-back decides", async () => {
  await seed({ n: 2 });
  const ctl = endpointActions(fake, DST, records(2));
  ctl.answer = { apply: true, response: { status: 500, body: { error: "InternalError" } } };
  fake.reset();
  const done = await tamperProtectionAction("local-1", { dryRun: false, ...ALL });
  assert.equal(tpWrites().length, 1, "sent once");
  assert.deepEqual(done.rows.map((r) => r.status), ["changed", "changed"]);
  assert.match(done.rows[0].message, /^Sophos answered 500, but a read-back found the change on the device's record, so the change was made$/);

  await seed({ n: 1 });
  const ctl2 = endpointActions(fake, DST, records(1));
  ctl2.answer = { status: 500, body: { error: "InternalError" } };
  fake.reset();
  const missed = await tamperProtectionAction("local-1", { dryRun: false, ...ALL });
  assert.equal(tpWrites().length, 1, "sent once");
  assert.equal(missed.rows[0].status, "failed");
  assert.match(missed.rows[0].message, /^Sophos API error 500: InternalError, and tamper protection still reads off; the read-back did not show a new password\. Sophos can take a while to show a change, so this does not prove it failed\. Preview again in a minute: turning tamper protection on again is safe, and each new password request makes another new password\.$/);
});

test("new passwords only: devices with tamper protection off stay off", async () => {
  await seed({ n: 2 });
  const ctl = endpointActions(fake, DST, records(2, { on: [2] }));
  fake.reset();
  const res = await tamperProtectionAction("local-1", { dryRun: false, turnOn: false, newPasswords: true, scope: "all" });
  assert.deepEqual(tpWrites().map((w) => w.body), [{ ids: [newId(1), newId(2)], regeneratePassword: true }]);
  assert.equal(ctl.records.get(newId(1)).tamperProtectionEnabled, false);
  assert.deepEqual(res.rows.map((r) => [r.status, r.passwordChanged]), [["changed", true], ["changed", true]]);
});

test("a move back acts on the source tenant, which received the devices", async () => {
  await seed({ n: 1, direction: "dest-to-source" });
  endpointActions(fake, DST, []);
  const ctl = endpointActions(fake, SRC, records(1));
  fake.reset();
  const res = await tamperProtectionAction("local-1", { dryRun: false, ...ALL });
  assert.equal(res.receivingSide, "source");
  assert.deepEqual(tpWrites().map((w) => w.tenant), ["src"]);
  assert.equal(ctl.records.get(newId(1)).tamperProtectionEnabled, true);
  const entries = (await readAudit(root)).filter((e) => e.resource === "endpoint-tamper-protection");
  assert.equal(entries.at(-1).tenantId, SRC.tenantId);
});

test("scan: preview lists the arrived devices; a scan asks 500 at a time, reports refusals, and is audited", async () => {
  await seed({ n: 601, waiting: [601] });
  const ctl = endpointActions(fake, DST, records(600));
  ctl.records.delete(newId(7));
  fake.reset();
  const dry = await scanArrivedDevices("local-1", { dryRun: true });
  assert.deepEqual(fake.writes(), []);
  assert.equal(dry.counts["will-scan"], 599);
  assert.equal(by(dry, 7).status, "not-found");
  assert.equal(by(dry, 601).status, "not-arrived");

  ctl.refuse.set(newId(3), "notSupported");
  fake.reset();
  const auditBefore = (await readAudit(root)).length;
  const res = await scanArrivedDevices("local-1", { dryRun: false });
  assert.deepEqual(scanWrites().map((w) => w.body.ids.length), [500, 99]);
  assert.equal(res.counts.requested, 598);
  assert.deepEqual([by(res, 3).status, by(res, 3).message], ["failed", "notSupported: refused by the test (notSupported)"]);
  assert.ok(by(res, 1).requestedAt);
  const entries = (await readAudit(root)).slice(auditBefore);
  assert.deepEqual(entries.map((e) => [e.action, e.resource, e.ok]), [["create", "endpoint-scan", false], ["create", "endpoint-scan", true]]);
});

test("scan: an unclear answer is not sent again, and says where a scan shows", async () => {
  await seed({ n: 1 });
  const ctl = endpointActions(fake, DST, records(1));
  ctl.answer = { status: 502, body: { error: "BadGateway" } };
  fake.reset();
  const res = await scanArrivedDevices("local-1", { dryRun: false });
  assert.equal(scanWrites().length, 1);
  assert.equal(res.rows[0].status, "failed");
  assert.match(res.rows[0].message, /The scan may still have been requested, and the API can't show it: a scan that runs shows as an event on the device in Sophos Fusion\. Check there before scanning again\.$/);
});

test("the routes need JSON with dryRun and each option stated, and answer 404 for a job that isn't there", async () => {
  await seed({ n: 1 });
  endpointActions(fake, DST, records(1));
  fake.reset();
  const TP = "/api/migrate/devices/jobs/local-1/tamper-protection";
  const SCAN = "/api/migrate/devices/jobs/local-1/scan";
  for (const p of [TP, SCAN]) {
    assert.equal((await http.form(p, "dryRun=false&turnOn=true&newPasswords=true")).status, 415, p);
    assert.equal((await http.text(p, '{"dryRun":false}')).status, 415, p);
    assert.equal((await http.bare(p)).status, 415, p);
  }
  for (const body of [{}, { dryRun: false }, { dryRun: false, turnOn: true }, { dryRun: "false", turnOn: true, newPasswords: true }, { dryRun: false, turnOn: false, newPasswords: false }, { dryRun: false, turnOn: true, newPasswords: true, scope: "some" }]) {
    assert.equal((await http.post(TP, body)).status, 400, JSON.stringify(body));
  }
  for (const body of [{}, { dryRun: "false" }, { dryRun: null }]) assert.equal((await http.post(SCAN, body)).status, 400, JSON.stringify(body));
  assert.deepEqual(fake.writes(), []);
  assert.equal((await http.post("/api/migrate/devices/jobs/nope/tamper-protection", { dryRun: true, ...ALL })).status, 404);
  assert.equal((await http.post("/api/migrate/devices/jobs/nope/scan", { dryRun: true })).status, 404);

  const preview = await http.post(TP, { dryRun: true, ...ALL });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.counts["will-change"], 1);
  const scan = await http.post(SCAN, { dryRun: false });
  assert.equal(scan.status, 200);
  assert.equal(scan.body.counts.requested, 1);
});
