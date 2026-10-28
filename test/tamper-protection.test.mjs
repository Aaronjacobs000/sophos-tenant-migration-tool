// Tamper protection before and after a move (0.5.0): the pre-flight card, the state recorded with the job,
// the state each device arrives with, and the job page's flag for a device that arrived without it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFakeSophos, endpointActions, SRC, DST } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { checksRouter } = await import("../backend/dist/routes/checks.js");
const { tamperWarnings } = await import("../backend/dist/services/tamper-check.js");
const { startMigration } = await import("../backend/dist/services/device-migrator.js");
const { checkInFor } = await import("../backend/dist/services/device-check-in.js");
const { jobProgress } = await import("../backend/dist/services/job-progress.js");
const http = await startHttp([checksRouter]);
after(() => http.close());

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const recent = new Date(Date.now() - 60e3).toISOString();
const sending = endpointActions(fake, SRC, [
  { id: uuid(1), hostname: "PC-1", type: "computer", lastSeenAt: recent, tamperProtectionEnabled: true },
  { id: uuid(2), hostname: "PC-2", type: "computer", lastSeenAt: recent, tamperProtectionEnabled: true },
  { id: uuid(3), hostname: "PC-3", type: "computer", lastSeenAt: recent, tamperProtectionEnabled: false },
  // As measured on Linux: supported false, enabled false or left out.
  { id: uuid(4), hostname: "LNX-1", type: "server", lastSeenAt: recent, tamperProtectionEnabled: false, tamperProtectionSupported: false },
]);
const receiving = endpointActions(fake, DST, []);
fake.on(SRC, "GET", "/endpoint/v1/settings/migration", () => ({ body: { enabled: true } }));
fake.on(DST, "GET", "/endpoint/v1/settings/migration", () => ({ body: { enabled: true } }));
fake.on(DST, "POST", "/endpoint/v1/migrations", () => ({ status: 201, body: { id: "job-1", token: "job-1-token", mode: "receiving" } }));
fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "sending" } }));

test("pre-flight: counts the selected devices with tamper protection on and warns when the receiving tenant has it off, reading only", async () => {
  receiving.global.enabled = false;
  sending.global.enabled = true;
  fake.reset();
  const res = await http.post("/api/checks/tamper-protection", { endpointIds: [uuid(1), uuid(2), uuid(3), uuid(4), uuid(9), uuid(1).toUpperCase()], direction: "source-to-dest" });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.selected, { total: 5, on: 2, off: 1, unsupported: 1, unknown: 1 });
  assert.deepEqual([res.body.sending.side, res.body.sending.enabled, res.body.receiving.side, res.body.receiving.enabled], ["source", true, "dest", false]);
  assert.equal(res.body.warnings[0], "Tamper protection is off for the whole receiving tenant (Test Destination), so moved devices will arrive without it, including the 2 selected devices that have it on now. Turn it on there in Sophos Fusion under Global Settings > Tamper Protection; the API can only read this setting.");
  assert.equal(res.body.warnings[1], "1 selected device could not be read, so it is not counted.");
  assert.deepEqual(fake.writes(), []);
  const reads = fake.calls.filter((c) => c.kind === "tenant" && c.path.startsWith("/endpoint/v1/endpoints"));
  assert.deepEqual(reads.map((c) => [c.tenant, c.query.ids.split(",").length]), [["src", 5]], "one read for the selection");
});

test("pre-flight: a move back reads the destination as the sending side; no warning when the receiving tenant has it on", async () => {
  receiving.global.enabled = true;
  sending.global.enabled = true;
  const res = await http.post("/api/checks/tamper-protection", { endpointIds: [], direction: "dest-to-source" });
  assert.equal(res.body.sending.side, "dest");
  assert.equal(res.body.receiving.side, "source");
  assert.deepEqual(res.body.warnings, []);
  assert.deepEqual(res.body.selected, { total: 0, on: 0, off: 0, unsupported: 0, unknown: 0 });
});

test("pre-flight warnings: an unreadable setting says so; none of the text uses a dash", () => {
  const unread = tamperWarnings({ side: "dest", role: "receiving", tenantName: null, enabled: null, error: "Sophos API error 403: Forbidden" }, { total: 1, on: 1, off: 0, unsupported: 0, unknown: 0 });
  assert.deepEqual(unread, ["The receiving tenant's tamper protection setting could not be read: Sophos API error 403: Forbidden"]);
  const off = tamperWarnings({ side: "dest", role: "receiving", tenantName: "APJ", enabled: false }, { total: 1, on: 1, off: 0, unsupported: 0, unknown: 0 });
  assert.match(off[0], /including the 1 selected device that has it on now/);
  for (const w of [...unread, ...off]) assert.doesNotMatch(w, /[\u2013\u2014]/);
});

test("a move records each device's tamper protection at the source from the pre-flight read, and the dry run shows the counts", async () => {
  fake.reset();
  const dry = await startMigration({ jobName: "t", endpointIds: [uuid(1), uuid(3), uuid(4)], dryRun: true });
  assert.deepEqual(dry.plan.tamperProtection, { on: 1, off: 1, unsupported: 1 });
  const real = await startMigration({ jobName: "t", endpointIds: [uuid(1), uuid(3), uuid(4)] });
  assert.deepEqual(real.job.endpointTamperProtection, {
    [uuid(1)]: { enabled: true, supported: true },
    [uuid(3)]: { enabled: false, supported: true },
    [uuid(4)]: { enabled: false, supported: false },
  });
  const reads = fake.calls.filter((c) => c.kind === "tenant" && c.method === "GET" && c.path.startsWith("/endpoint/v1/endpoints"));
  assert.equal(reads.length, 2, "no reads beyond the pre-flight's, one for the dry run and one for the real run");
});

test("check-in keeps the receiving tenant's tamper protection; the job flags a device that had it on and arrived without it", () => {
  const T = (m) => new Date(Date.parse("2026-10-29T00:00:00Z") + m * 60e3).toISOString();
  const moved = { id: uuid(1), status: "succeeded", newId: "n1", migratedAt: T(0) };
  const c = checkInFor(moved, [{ id: "n1", registeredAt: T(0), lastSeenAt: T(24), tamperProtectionEnabled: false, tamperProtectionSupported: true }], undefined, T(24.5));
  assert.deepEqual(c.tamperProtection, { enabled: false, supported: true, readAt: T(24.5) });

  const job = {
    localJobId: "x", jobName: "x", createdAt: T(0), direction: "source-to-dest", sourceMigrationId: "j", destMigrationId: "j",
    endpointIds: [uuid(1), uuid(2), uuid(3)], endpointHostnames: {}, status: "in-progress", sourceSnapshot: null, destSnapshot: null,
    endpointTamperProtection: { [uuid(1)]: { enabled: true, supported: true }, [uuid(2)]: { enabled: false, supported: true }, [uuid(3)]: { enabled: true, supported: true } },
    checkIns: {
      [uuid(1)]: c,
      [uuid(2)]: { ...c, tamperProtection: { enabled: false, supported: true, readAt: T(24.5) } },
      [uuid(3)]: { state: "waiting", newId: "n3" },
    },
  };
  const p = jobProgress(job, Date.parse(T(30)));
  assert.equal(p.tamperLost, 1);
  assert.deepEqual(p.devices[0].tamperProtection, { atSource: true, supported: true, arrived: false, readAt: T(24.5), lost: true });
  assert.equal(p.devices[1].tamperProtection.lost, false, "off at the source too");
  assert.deepEqual(p.devices[2].tamperProtection, { atSource: true, supported: true, lost: false }, "not arrived yet");

  // A later read from the job page's tamper protection card wins over the check-in's.
  const fixed = jobProgress({ ...job, arrivalTamper: { [uuid(1)]: { enabled: true, supported: true, readAt: T(40) } } }, Date.parse(T(45)));
  assert.equal(fixed.tamperLost, 0);
  assert.equal(fixed.devices[0].tamperProtection.arrived, true);
  const older = jobProgress({ ...job, arrivalTamper: { [uuid(1)]: { enabled: true, supported: true, readAt: T(1) } } }, Date.parse(T(45)));
  assert.equal(older.devices[0].tamperProtection.arrived, false, "an older reading does not");
});

test("the job page shows tamper protection in each lane, flags one lost, and offers the action", async () => {
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  const src = js.slice(js.indexOf("function tamperBit"), js.indexOf("function laneRow"));
  const tamperBit = new Function("formatWhen", "escAttr", `${src}; return tamperBit;`)((iso) => `T(${iso})`, String);
  const d = { tamperProtection: { atSource: true, arrived: false, supported: true, readAt: "r", lost: true } };
  assert.equal(tamperBit(d, "from"), ` · <span class="tp-bit" title="Tamper protection at the source when the job was created: on">TP on</span>`);
  assert.equal(tamperBit(d, "to"), ` · <span class="tp-bit is-lost" title="Tamper protection on the receiving tenant: off, read T(r). It was on at the source.">TP off</span>`);
  assert.equal(tamperBit({ tamperProtection: { atSource: false, supported: false, lost: false } }, "from"), "", "nothing for a device without it");
  assert.equal(tamperBit({}, "to"), "", "nothing for a job from before 0.5.0");
  assert.match(js, /arrived without tamper protection/);
  assert.match(js, /btn\("goto-tamper", "Go to tamper protection", true\)/);
  const html = await readFile(new URL("../frontend/migrate-job-detail.html", import.meta.url), "utf8");
  for (const id of ["tamper-card", "tamper-preview", "tamper-apply", "tamper-turn-on", "tamper-new-passwords", "tamper-scope", "scan-card", "scan-preview", "scan-apply"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /<button id="tamper-preview"[^>]*>Preview<\/button>/);
  assert.match(html, /id="tamper-new-passwords" data-tamper-option checked/, "new passwords is on by default");
});

test("the job page's tamper protection choices default to both on, are remembered per job, and Apply sends what the preview showed", async () => {
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  const src = js.slice(js.indexOf("const TAMPER_DEFAULTS"), js.indexOf("function showTamperOptions"));
  const store = new Map();
  const localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const make = (id) => new Function("state", "localStorage", `${src}; return tamperOptions;`)({ id }, localStorage);
  assert.deepEqual(make("job-a")(), { turnOn: true, newPasswords: true, scope: "all" });
  store.set("tamperOptions:job-a", JSON.stringify({ turnOn: true, newPasswords: false, scope: "was-on" }));
  assert.deepEqual(make("job-a")(), { turnOn: true, newPasswords: false, scope: "was-on" });
  assert.deepEqual(make("job-b")(), { turnOn: true, newPasswords: true, scope: "all" }, "another job keeps the defaults");
  const blocked = new Function("state", "localStorage", `${src}; return tamperOptions;`)({ id: "job-a" }, { getItem: () => { throw new Error("blocked"); } });
  assert.deepEqual(blocked(), { turnOn: true, newPasswords: true, scope: "all" }, "blocked storage falls back to the defaults");

  // Every post states dryRun as a boolean, and Apply uses the options of the preview it confirmed.
  assert.match(js, /\/tamper-protection`, \{ dryRun, \.\.\.options \}\)/);
  assert.match(js, /\/tamper-protection`, \{ dryRun: false, turnOn: o\.turnOn, newPasswords: o\.newPasswords, scope: o\.scope \}\)/);
  assert.match(js, /\/scan`, \{ dryRun \}\)/);
  assert.match(js, /document\.getElementById\("tamper-apply"\)\.disabled = !res\.dryRun \|\| willChange === 0;/);
  // A finished job's stream has stopped, so the lanes are redrawn from the job after each read or change.
  for (const fn of ["async function loadTamper", "async function applyTamper"]) {
    const body = js.slice(js.indexOf(fn), js.indexOf("\n}\n", js.indexOf(fn)));
    assert.match(body, /refreshJob\(\);/, fn);
  }
});

test("the Start migration page has the tamper protection card, which says no tamper protection change is needed to move", async () => {
  const html = await readFile(new URL("../frontend/migrate.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../frontend/js/page-migrate.js", import.meta.url), "utf8");
  assert.match(html, /id="tamper-card"/);
  assert.match(js, /api\.post\("\/api\/checks\/tamper-protection", \{ endpointIds: ids, direction \}\)/);
  assert.match(js, /You don't need to turn off tamper protection to move devices\./);
});

test("Help and the README say tamper protection can stay on for a move, and how to handle a failed move", async () => {
  const help = await readFile(new URL("../frontend/help.html", import.meta.url), "utf8");
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  for (const text of [help, readme]) {
    assert.ok(text.includes("You don't need to turn off tamper protection to move devices."));
    assert.match(text, /--registeronly/);
    assert.match(text, /turn tamper protection back on/i);
  }
});
