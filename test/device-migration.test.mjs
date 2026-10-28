// Device moves: both tenants must allow migration, there is no cancel or delete, because Sophos has none,
// and a job takes at most 1000 devices.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST } from "./helpers/fake-sophos.mjs";
import { readFile } from "node:fs/promises";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const migrator = await import("../backend/dist/services/device-migrator.js");
const { startMigration } = migrator;
const { migrateDevicesRouter } = await import("../backend/dist/routes/migrate-devices.js");
const migrationsApi = await import("../backend/dist/sophos/api/migrations.js");

const DEVICE = "00000000-0000-4000-8000-000000000001";
const recent = new Date(Date.now() - 60e3).toISOString();
fake.on(SRC, "GET", `/endpoint/v1/endpoints/${DEVICE}`, () => ({ body: { id: DEVICE, hostname: "WIN10", type: "computer", lastSeenAt: recent } }));

const setting = { src: { enabled: true, expiresAt: "2099-01-01T00:00:00Z" }, dst: { enabled: true, expiresAt: "2099-01-01T00:00:00Z" } };
fake.on(SRC, "GET", "/endpoint/v1/settings/migration", () => ({ body: setting.src }));
fake.on(DST, "GET", "/endpoint/v1/settings/migration", () => ({ body: setting.dst }));
fake.on(DST, "POST", "/endpoint/v1/migrations", () => ({ status: 201, body: { id: "job-1", token: "job-1-token", mode: "receiving" } }));
fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "sending" } }));

const migrationWrites = () => fake.writes().filter((w) => w.path.startsWith("/endpoint/v1/migrations"));

test("a start is refused, with no job created, when the receiving tenant has migration off", async () => {
  setting.src.enabled = true;
  setting.dst.enabled = false;
  for (const dryRun of [true, false]) {
    fake.reset();
    const res = await startMigration({ jobName: "t", endpointIds: [DEVICE], dryRun });
    assert.match(res.settingFailure ?? "", /Test Destination \(the receiving tenant\): Device migration is turned off/);
    assert.equal(res.plan, undefined);
    assert.equal(res.job, undefined);
    assert.equal(migrationWrites().length, 0);
  }
});

test("the start route reports migration turned off as migration_not_allowed, which the page keys its fix on", async () => {
  const { startHttp } = await import("./helpers/http.mjs");
  const http = await startHttp([migrateDevicesRouter]);
  try {
    setting.src = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };
    setting.dst = { enabled: false };
    fake.reset();
    const res = await http.post("/api/migrate/devices", { jobName: "t", endpointIds: [DEVICE] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "migration_not_allowed");
    assert.match(res.body.message, /Test Destination \(the receiving tenant\): Device migration is turned off/);
    assert.equal(migrationWrites().length, 0);
  } finally {
    setting.dst = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };
    await http.close();
  }
});

test("the start page shows the Device Migration fix only for migration_not_allowed, and any other error as it is", async () => {
  const js = await readFile(new URL("../frontend/js/page-migrate.js", import.meta.url), "utf8");
  const src = js.slice(js.indexOf("function migrationErrorHint"), js.indexOf("boot();"));
  const hint = new Function(`${src}; return migrationErrorHint;`)();
  const FIX = /turn on <strong>Allow device migration<\/strong>/;

  const off = "Device migration is not allowed. Test Destination (the receiving tenant): Device migration is turned off. Both tenants must allow it.";
  const shown = hint({ message: off, body: { error: "migration_not_allowed", message: off } }, "Migration start failed");
  assert.match(shown, FIX);
  assert.match(shown, /on each tenant named above/);
  assert.doesNotMatch(shown, /on the <strong>sending<\/strong> tenant/, "the tenant that has it off may be the receiving one");

  // A 403 during the trigger read-back mentions both "403" and "migration": shown as it is, escaped, with no fix.
  const readBack = "Sophos API error 500: InternalError. A read-back could not read migration job job-9 on the sending tenant Test Source (Sophos API error 403: Forbidden - no read). The change may still have gone through: check the Migrations page before trying again. The Migrations page lists the jobs on both tenants, including ones this tool did not save.";
  assert.equal(hint({ message: readBack, body: { error: "internal_error", message: readBack } }, "x"), readBack);
  const refused = "Sophos API error 403: Forbidden - not allowed to create a migration <job>";
  assert.equal(hint({ message: refused, body: { error: "internal_error" } }, "x"), "Sophos API error 403: Forbidden - not allowed to create a migration &lt;job&gt;");
  assert.equal(hint({ message: "Device migration is not enabled for this tenant" }, "x"), "Device migration is not enabled for this tenant", "only the server's code, not the wording, brings the fix");

  // The tenant mismatch hint stays, and an error with no message falls back.
  assert.match(hint({ message: "fromTenant must not match the current tenant" }, "x"), /appear to be the same tenant/);
  assert.equal(hint({}, "Dry run failed"), "Dry run failed");
});

test("a start is refused when the sending tenant's window has closed", async () => {
  setting.src = { enabled: true, expiresAt: "2020-01-01T00:00:00Z" };
  setting.dst = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };
  fake.reset();
  const res = await startMigration({ jobName: "t", endpointIds: [DEVICE] });
  assert.match(res.settingFailure ?? "", /Test Source \(the sending tenant\): The migration window closed/);
  assert.equal(migrationWrites().length, 0);
});

test("with both tenants open the receiver job and the sender trigger are sent", async () => {
  setting.src = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };
  fake.reset();
  const res = await startMigration({ jobName: "t", endpointIds: [DEVICE] });
  assert.equal(res.settingFailure, undefined);
  assert.ok(res.job);
  assert.deepEqual(migrationWrites().map((w) => `${w.tenant} ${w.method}`), ["dst POST", "src PUT"]);
});

test("no route or service can cancel or delete a job", () => {
  // The migrations API has no cancel or delete (DELETE answered 404 on 25/09/2026).
  const routes = migrateDevicesRouter.stack.filter((l) => l.route).map((l) => Object.keys(l.route.methods).map((m) => `${m} ${l.route.path}`)).flat();
  assert.ok(routes.includes("post /migrate/devices"), "the router is the real one");
  assert.deepEqual(routes.filter((r) => r.startsWith("delete")), []);
  assert.equal(migrator.cancelJob, undefined);
  assert.equal(migrationsApi.deleteMigrationJob, undefined, "the API reference lists no DELETE for migrations");
});

test("the job page has no Cancel button and says a move can't be cancelled", async () => {
  const html = await readFile(new URL("../frontend/migrate-job-detail.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  assert.doesNotMatch(html, /cancel-btn|Cancel migration/);
  assert.match(html, /can't be cancelled/);
  assert.doesNotMatch(js, /api\.del\(|cancel-btn/);
});

// A trigger that fails with a clear answer: no DELETE (Sophos has none), and the error says the receiving job stays.
const EXPIRES = "2026-11-12T03:04:05.678Z";
const receiving = (extra = {}) => () => ({ status: 201, body: { id: "job-1", token: "job-1-token", mode: "receiving", createdAt: "2026-10-29T03:04:05.678Z", ...extra } });
const restoreJobRoutes = () => {
  fake.on(DST, "POST", "/endpoint/v1/migrations", () => ({ status: 201, body: { id: "job-1", token: "job-1-token", mode: "receiving" } }));
  fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "sending" } }));
};
const deletes = () => fake.calls.filter((c) => c.method === "DELETE");
const LEFT = "The move did not start. The receiving job job-1 on Test Destination stays in place until it expires";

test("a trigger Sophos refuses sends no DELETE, and says the receiving job stays until it expires", async () => {
  setting.src = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };
  setting.dst = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };
  fake.on(DST, "POST", "/endpoint/v1/migrations", receiving({ expiresAt: EXPIRES }));
  fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", () => ({ status: 400, body: { error: "BadRequest", message: "Invalid token" } }));
  try {
    fake.reset();
    const auditBefore = (await readAudit(root)).length;
    const err = await startMigration({ jobName: "refused trigger", endpointIds: [DEVICE] }).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.equal(err.message, `Sophos API error 400: BadRequest - Invalid token. ${LEFT} on 2026-11-12 03:04 UTC, because the Sophos API cannot delete a migration job.`);
    assert.equal(err.status, 400, "the status Sophos answered with is kept");
    assert.deepEqual(migrationWrites().map((w) => `${w.tenant} ${w.method}`), ["dst POST", "src PUT"]);
    assert.deepEqual(deletes(), []);
    const added = (await readAudit(root)).slice(auditBefore);
    assert.deepEqual(added.map((e) => `${e.action} ${e.resource} ${e.ok}`), ["create migration-receiver true", "create migration-sender false"]);
    assert.equal(added[1].error, "Sophos API error 400: BadRequest - Invalid token", "the audit keeps what Sophos said");
  } finally {
    restoreJobRoutes();
  }
});

test("a refused trigger answers the page with Sophos's status and the receiving job note", async () => {
  const { startHttp } = await import("./helpers/http.mjs");
  const http = await startHttp([migrateDevicesRouter]);
  fake.on(DST, "POST", "/endpoint/v1/migrations", receiving({ expiresAt: EXPIRES }));
  fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", () => ({ status: 403, body: { error: "Forbidden", message: "not allowed" } }));
  try {
    fake.reset();
    const res = await http.post("/api/migrate/devices", { jobName: "refused trigger", endpointIds: [DEVICE] });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, "sophos_error");
    assert.match(res.body.message, /^Sophos API error 403: Forbidden - not allowed\. The move did not start\. The receiving job job-1 on Test Destination stays in place until it expires on 2026-11-12 03:04 UTC/);
    assert.deepEqual(deletes(), []);
  } finally {
    restoreJobRoutes();
    await http.close();
  }
});

test("a trigger that never reached Sophos says the same, and gives 14 days when the job has no expiry", async () => {
  fake.on(DST, "POST", "/endpoint/v1/migrations", receiving());
  fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); });
  try {
    fake.reset();
    const err = await startMigration({ jobName: "unsent trigger", endpointIds: [DEVICE] }).catch((e) => e);
    assert.equal(err.message, `Sophos API request failed: fetch failed (ECONNREFUSED). ${LEFT} 14 days after it was created, because the Sophos API cannot delete a migration job.`);
    assert.deepEqual(migrationWrites().map((w) => `${w.tenant} ${w.method}`), ["dst POST", "src PUT"]);
    assert.deepEqual(deletes(), []);
  } finally {
    restoreJobRoutes();
  }
});

test("a trigger answered 500 keeps its own advice, with no DELETE and no 'did not start'", async () => {
  fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", () => ({ status: 500, body: { error: "InternalError" } }));
  fake.on(SRC, "GET", "/endpoint/v1/migrations/job-1", () => ({ status: 404, body: { error: "NotFound", message: "no such job" } }));
  const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
  setReadBackDelays([0, 0, 0]);
  try {
    fake.reset();
    const err = await startMigration({ jobName: "unclear trigger", endpointIds: [DEVICE] }).catch((e) => e);
    assert.match(err.message, /left in place in case the move started, and expires by itself 14 days after it was created\./);
    assert.doesNotMatch(err.message, /did not start/);
    assert.deepEqual(deletes(), []);
  } finally {
    setReadBackDelays([1000, 3000, 6000]);
    restoreJobRoutes();
  }
});

test("a trigger with no clear answer, a 500 or a dropped connection, gives the receiving job's expiresAt", async () => {
  const answers = {
    "a 500": () => ({ status: 500, body: { error: "InternalError" } }),
    "a dropped connection": () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); },
  };
  fake.on(SRC, "GET", "/endpoint/v1/migrations/job-1", () => ({ status: 404, body: { error: "NotFound", message: "no such job" } }));
  fake.on(DST, "POST", "/endpoint/v1/migrations", receiving({ expiresAt: EXPIRES }));
  const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
  setReadBackDelays([0, 0, 0]);
  try {
    for (const [what, answer] of Object.entries(answers)) {
      fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", answer);
      fake.reset();
      const err = await startMigration({ jobName: "unclear trigger", endpointIds: [DEVICE] }).catch((e) => e);
      assert.ok(err.message.includes("The receiving job on Test Destination was left in place in case the move started, and expires by itself on 2026-11-12 03:04 UTC. In a few minutes, open the Migrations page"), `${what}: ${err.message}`);
      assert.doesNotMatch(err.message, /14 days|did not start/, what);
      assert.deepEqual(migrationWrites().map((w) => `${w.tenant} ${w.method}`), ["dst POST", "src PUT"], what);
      assert.deepEqual(deletes(), [], what);
    }
  } finally {
    setReadBackDelays([1000, 3000, 6000]);
    restoreJobRoutes();
  }
});

// A receiving job that comes back with no handshake token can't be triggered, and Sophos has no DELETE, so it stays.
test("a receiving job with no handshake token sends no trigger and no DELETE, and says the job stays until it expires", async () => {
  try {
    for (const [extra, when] of [[{ expiresAt: EXPIRES }, "on 2026-11-12 03:04 UTC"], [{}, "14 days after it was created"]]) {
      fake.on(DST, "POST", "/endpoint/v1/migrations", receiving({ token: undefined, ...extra }));
      fake.reset();
      const err = await startMigration({ jobName: "no token", endpointIds: [DEVICE] }).catch((e) => e);
      assert.ok(err instanceof Error);
      assert.equal(err.message, `Receiver job did not return a handshake token. ${LEFT} ${when}, because the Sophos API cannot delete a migration job.`);
      assert.deepEqual(migrationWrites().map((w) => `${w.tenant} ${w.method}`), ["dst POST"], "no trigger is sent");
      assert.deepEqual(deletes(), []);
    }
  } finally {
    restoreJobRoutes();
  }
});

test("the start route gives the page the no-token note as it is", async () => {
  const { startHttp } = await import("./helpers/http.mjs");
  const http = await startHttp([migrateDevicesRouter]);
  fake.on(DST, "POST", "/endpoint/v1/migrations", receiving({ token: undefined, expiresAt: EXPIRES }));
  try {
    fake.reset();
    const res = await http.post("/api/migrate/devices", { jobName: "no token", endpointIds: [DEVICE] });
    assert.equal(res.status, 500);
    assert.equal(res.body.message, `Receiver job did not return a handshake token. ${LEFT} on 2026-11-12 03:04 UTC, because the Sophos API cannot delete a migration job.`);
    const js = await readFile(new URL("../frontend/js/page-migrate.js", import.meta.url), "utf8");
    const hint = new Function(`${js.slice(js.indexOf("function migrationErrorHint"), js.indexOf("boot();"))}; return migrationErrorHint;`)();
    assert.equal(hint({ message: res.body.message, body: res.body }, "x"), res.body.message);
    assert.deepEqual(deletes(), []);
  } finally {
    restoreJobRoutes();
    await http.close();
  }
});

test("a receiving job with no handshake token is audited as created, the same as one with a token, and the error still comes", async () => {
  const { startHttp } = await import("./helpers/http.mjs");
  const http = await startHttp([migrateDevicesRouter]);
  const start = async () => {
    const before = (await readAudit(root)).length;
    fake.reset();
    const res = await http.post("/api/migrate/devices", { jobName: "audited", endpointIds: [DEVICE] });
    return { res, added: (await readAudit(root)).slice(before) };
  };
  const shape = ({ id, ts, ...entry }) => entry;
  try {
    const withToken = await start();
    assert.equal(withToken.res.status, 201);
    const expected = { side: "dest", tenantId: DST.tenantId, action: "create", resource: "migration-receiver", resourceId: "job-1", ok: true, detail: { jobName: "audited", direction: "source-to-dest" } };
    assert.deepEqual(shape(withToken.added.find((e) => e.resource === "migration-receiver")), expected);
    assert.doesNotMatch(JSON.stringify(withToken.added), /job-1-token/, "the audit log holds no token");

    fake.on(DST, "POST", "/endpoint/v1/migrations", receiving({ token: undefined, expiresAt: EXPIRES }));
    const noToken = await start();
    assert.equal(noToken.res.status, 500);
    assert.equal(noToken.res.body.message, `Receiver job did not return a handshake token. ${LEFT} on 2026-11-12 03:04 UTC, because the Sophos API cannot delete a migration job.`);
    assert.deepEqual(noToken.added.map(shape), [expected]);
    assert.deepEqual(migrationWrites().map((w) => `${w.tenant} ${w.method}`), ["dst POST"], "no trigger is sent");
  } finally {
    restoreJobRoutes();
    await http.close();
  }
});

// The API reference: the POST and PUT bodies' endpoints "Must contain 1-1000 items".
const many = (n) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-1${String(i).padStart(11, "0")}`);
fake.on(SRC, "GET", /^\/endpoint\/v1\/endpoints\/00000000-0000-4000-8000-1\d{11}$/, (req) => ({ body: { id: req.path.split("/").pop(), hostname: "BULK", type: "computer", lastSeenAt: recent } }));

test("a move of more than 1000 devices is refused before anything is read or sent", async () => {
  for (const dryRun of [true, false]) {
    fake.reset();
    const res = await startMigration({ jobName: "too many", endpointIds: many(1001), dryRun });
    assert.equal(res.deviceLimitFailure, "1001 devices are selected, and Sophos accepts at most 1000 in one migration job through its API, so nothing was sent. Start a move for each batch of 1000 or fewer.");
    assert.equal(res.plan, undefined);
    assert.equal(res.job, undefined);
    assert.deepEqual(fake.calls.filter((c) => c.kind === "tenant"), [], "no call to either tenant");
  }
});

test("the start route refuses more than 1000 devices as too_many_devices, and the page shows the message as it is", async () => {
  const { startHttp } = await import("./helpers/http.mjs");
  const http = await startHttp([migrateDevicesRouter]);
  try {
    fake.reset();
    const res = await http.post("/api/migrate/devices", { jobName: "too many", endpointIds: many(2500) });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "too_many_devices");
    assert.match(res.body.message, /^2500 devices are selected, and Sophos accepts at most 1000 in one migration job/);
    assert.deepEqual(fake.calls.filter((c) => c.kind === "tenant"), []);
    const js = await readFile(new URL("../frontend/js/page-migrate.js", import.meta.url), "utf8");
    const hint = new Function(`${js.slice(js.indexOf("function migrationErrorHint"), js.indexOf("boot();"))}; return migrationErrorHint;`)();
    assert.equal(hint({ message: res.body.message, body: res.body }, "x"), res.body.message);
  } finally {
    await http.close();
  }
});

test("a move of exactly 1000 devices goes ahead", async () => {
  fake.reset();
  const res = await startMigration({ jobName: "at the limit", endpointIds: many(1000), dryRun: true });
  assert.equal(res.deviceLimitFailure, undefined);
  assert.equal(res.plan.receiverBody.endpoints.length, 1000);
});

// The same device listed more than once is read, counted and sent once.
const MAC = "abcdef01-2345-4678-89ab-cdef01234567";
fake.on(SRC, "GET", `/endpoint/v1/endpoints/${MAC}`, () => ({ body: { id: MAC, hostname: "MAC1", type: "computer", lastSeenAt: recent } }));

test("a device listed more than once is read once and sent once", async () => {
  fake.reset();
  const res = await startMigration({ jobName: "repeats", endpointIds: [DEVICE, MAC, DEVICE, `source::${DEVICE}`, MAC.toUpperCase(), ` ${MAC} `] });
  assert.ok(res.job);
  assert.deepEqual(res.job.endpointIds, [DEVICE, MAC]);
  const reads = fake.calls.filter((c) => c.kind === "tenant" && c.method === "GET" && c.path.startsWith("/endpoint/v1/endpoints/"));
  assert.deepEqual(reads.map((c) => c.path.split("/").pop()), [DEVICE, MAC], "each device is read once");
  const writes = migrationWrites();
  assert.deepEqual(writes.map((w) => `${w.tenant} ${w.method}`), ["dst POST", "src PUT"]);
  assert.deepEqual(writes[0].body.endpoints, [DEVICE, MAC]);
  assert.deepEqual(writes[1].body.endpoints, [DEVICE, MAC]);
});

test("repeats do not count towards the 1000 limit, and the limit message counts each device once", async () => {
  fake.reset();
  const atLimit = await startMigration({ jobName: "repeats at the limit", endpointIds: [...many(1000), ...many(200)], dryRun: true });
  assert.equal(atLimit.deviceLimitFailure, undefined);
  assert.equal(atLimit.plan.receiverBody.endpoints.length, 1000);
  assert.equal(atLimit.plan.senderTrigger.endpoints.length, 1000);

  const { startHttp } = await import("./helpers/http.mjs");
  const http = await startHttp([migrateDevicesRouter]);
  try {
    fake.reset();
    const res = await http.post("/api/migrate/devices", { jobName: "repeats over the limit", endpointIds: [...many(1001), ...many(1001)] });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, "too_many_devices");
    assert.equal(res.body.message, "1001 devices are selected, and Sophos accepts at most 1000 in one migration job through its API, so nothing was sent. Start a move for each batch of 1000 or fewer.");
    assert.deepEqual(fake.calls.filter((c) => c.kind === "tenant"), [], "no call to either tenant");
  } finally {
    await http.close();
  }
});
