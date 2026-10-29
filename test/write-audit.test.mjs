// Every API route that writes to a tenant leaves an entry in data/audit.log
// for that tenant, whether Sophos accepts the write or refuses it. The routes
// are read from the routers server.ts mounts, so a new write route fails here
// until it is listed below: with a request that makes it write, or as a route
// that writes nothing to a tenant. Before 26/09/2026 the generic create, clone
// and PATCH routes wrote with no entry.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { setRetryDelay } = await import("../backend/dist/services/safe-files.js");
const { getRingBuffer } = await import("../backend/dist/log.js");
const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
setRetryDelay(1);
setReadBackDelays([0, 0, 0]);

// The routers in the order server.ts mounts them.
const serverSource = await readFile(new URL("../backend/src/server.ts", import.meta.url), "utf8");
const mounted = [...serverSource.matchAll(/app\.use\("\/api", (\w+)\)/g)].map((m) => m[1]);
const routesDir = new URL("../backend/dist/routes/", import.meta.url);
const exported = {};
for (const file of (await readdir(routesDir)).filter((f) => f.endsWith(".js"))) {
  Object.assign(exported, await import(new URL(file, routesDir)));
}
const routers = mounted.map((name) => exported[name]);
const http = await startHttp(routers);
after(() => http.close());

const writeRoutes = routers.flatMap((r) =>
  r.stack.filter((l) => l.route).flatMap((l) =>
    Object.keys(l.route.methods).filter((m) => m !== "get").map((m) => `${m.toUpperCase()} ${l.route.path}`)));

// ---- a fake Sophos that each route can write to ----

const DEVICE = "00000000-0000-4000-8000-000000000001";
const recent = new Date(Date.now() - 60e3).toISOString();
let refuse = () => false;
for (const tenant of [SRC, DST]) {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    fake.on(tenant, method, /.*/, (req) => {
      if (refuse(tenant, method, req.path)) return { status: 400, body: { error: "BadRequest", message: "refused by the test" } };
      if (method === "DELETE") return { status: 204 };
      if (req.path === "/endpoint/v1/migrations") return { status: 201, body: { id: "job-1", token: "handshake", mode: "receiving" } };
      if (req.path.startsWith("/endpoint/v1/migrations/")) return { body: { id: "job-1", mode: "sending" } };
      return { status: method === "POST" ? 201 : 200, body: { id: fake.nextId("new"), ...(req.body && typeof req.body === "object" ? req.body : {}) } };
    });
  }
  fake.on(tenant, "GET", "/endpoint/v1/settings/migration", () => ({ body: { enabled: true, expiresAt: "2099-01-01T00:00:00Z" } }));
  fake.on(tenant, "GET", /^\/endpoint\/v1\/migrations\/[^/]+\/endpoints$/, (req) =>
    page([{ id: DEVICE, status: "succeeded", ...(tenant === DST ? { newId: "new-device" } : {}) }], req.query));
}
const srcPolicy = { id: "p-1", name: "Servers", type: "threat-protection", enabled: true, priority: 1, settings: { "endpoint.threat-protection.amsi.enabled": { value: true } } };
fake.on(SRC, "GET", "/endpoint/v1/policies", (req) => page([srcPolicy], req.query));
fake.on(SRC, "GET", "/endpoint/v1/policies/p-1", () => ({ body: srcPolicy }));
fake.on(SRC, "GET", "/endpoint/v1/endpoint-groups/g-1", () => ({ body: { id: "g-1", name: "Sales", type: "computer" } }));
fake.on(SRC, "GET", "/common/v1/directory/user-groups", (req) => page([{ id: "u-1", name: "IT admins" }], req.query));
fake.on(SRC, "GET", "/endpoint/v1/settings/exclusions/scanning", (req) => page([{ id: "e-1", type: "path", value: "C:\\temp\\", scanMode: "onDemandAndOnAccess" }], req.query));
fake.on(SRC, "GET", "/web-filters/v1/site-lists", (req) => page([{ id: "sl-1", name: "Partners", numberOfSites: 1 }], req.query));
fake.on(SRC, "GET", "/web-filters/v1/site-lists/sl-1/sites", (req) => page([{ id: "s-1", site: "partner.example.test" }], req.query));
fake.on(SRC, "GET", `/endpoint/v1/endpoints/${DEVICE}`, () => ({ body: { id: DEVICE, hostname: "WIN10", type: "computer", lastSeenAt: recent, group: { id: "sg-fin", name: "Finance" } } }));
fake.on(DST, "GET", "/web-filters/v1/site-lists", (req) => page([{ id: "dl-1", name: "Old list", numberOfSites: 1 }], req.query));
fake.on(DST, "GET", "/endpoint/v1/endpoint-groups", (req) => page([{ id: "dg-fin", name: "Finance", type: "computer" }], req.query));
fake.on(DST, "GET", "/endpoint/v1/endpoint-groups/dg-fin/endpoints", () => ({ body: { items: [], pages: { size: 500 } } }));
// The moved device's record on the receiving tenant, for the tamper protection and scan actions.
fake.on(DST, "GET", "/endpoint/v1/endpoints/new-device", () => ({ body: { id: "new-device", hostname: "WIN10", tamperProtectionEnabled: false, tamperProtectionSupported: true } }));

/** The job, with its device checked in on the receiving tenant. */
async function seedArrivedJob() {
  await seedJob({ checkIns: { [DEVICE]: { state: "checked-in", newId: "new-device", checkedInAt: recent } } });
}

async function seedJob(extra = {}) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "migration-jobs.json"), JSON.stringify([{
    localJobId: "local-1", jobName: "wave 1", createdAt: new Date().toISOString(), direction: "source-to-dest",
    sourceMigrationId: "job-1", destMigrationId: "job-1", fromToken: "x",
    endpointIds: [DEVICE], endpointHostnames: { [DEVICE]: "WIN10" },
    endpointGroups: { [DEVICE]: { id: "sg-fin", name: "Finance" } },
    status: "complete", sourceSnapshot: null, destSnapshot: null,
    ...extra,
  }]));
}

// Routes that write to a tenant, each with a request that makes it write.
const WRITES = {
  "POST /:side/policies": ["post", "/api/dest/policies", { name: "Servers", type: "threat-protection", settings: {} }],
  "POST /:side/policies/:id/clone": ["post", "/api/dest/policies/p-9/clone", { name: "Servers copy" }],
  "PATCH /:side/policies/:id": ["patch", "/api/dest/policies/p-9", { enabled: false }],
  "DELETE /:side/policies/:id": ["del", "/api/dest/policies/p-9"],
  "POST /:side/groups": ["post", "/api/dest/groups", { name: "Sales", type: "computer" }],
  "DELETE /:side/groups/:id": ["del", "/api/dest/groups/g-9"],
  "POST /:side/user-groups": ["post", "/api/dest/user-groups", { name: "IT admins" }],
  "DELETE /:side/user-groups/:id": ["del", "/api/dest/user-groups/u-9"],
  "POST /:side/exclusions/scanning": ["post", "/api/dest/exclusions/scanning", { type: "path", value: "C:\\temp\\", scanMode: "onDemandAndOnAccess" }],
  "POST /:side/exclusions/allowed-items": ["post", "/api/dest/exclusions/allowed-items", { type: "sha256", properties: { sha256: "a".repeat(64) }, comment: "test" }],
  "POST /:side/exclusions/blocked-items": ["post", "/api/dest/exclusions/blocked-items", { type: "sha256", properties: { sha256: "b".repeat(64) }, comment: "test" }],
  "DELETE /:side/exclusions/scanning/:id": ["del", "/api/dest/exclusions/scanning/e-9"],
  "DELETE /:side/exclusions/allowed-items/:id": ["del", "/api/dest/exclusions/allowed-items/e-9"],
  "DELETE /:side/exclusions/blocked-items/:id": ["del", "/api/dest/exclusions/blocked-items/e-9"],
  "POST /:side/web-filters/delete": ["post", "/api/dest/web-filters/delete", { siteListIds: ["dl-1"] }],
  "POST /migrate/web-filters": ["post", "/api/migrate/web-filters", { siteListIds: ["sl-1"] }],
  "POST /migrate/policies": ["post", "/api/migrate/policies", { policyIds: ["p-1"] }],
  "POST /migrate/groups": ["post", "/api/migrate/groups", { groupIds: ["g-1"] }],
  "POST /migrate/user-groups": ["post", "/api/migrate/user-groups", { userGroupIds: ["u-1"] }],
  "POST /migrate/exclusions": ["post", "/api/migrate/exclusions", { selections: { scanning: ["e-1"] } }],
  "POST /migrate/devices": ["post", "/api/migrate/devices", { jobName: "wave 1", endpointIds: [DEVICE] }],
  "POST /migrate/devices/jobs/:id/group-membership": ["post", "/api/migrate/devices/jobs/local-1/group-membership", { dryRun: false }, seedJob],
  "POST /migrate/devices/jobs/:id/tamper-protection": ["post", "/api/migrate/devices/jobs/local-1/tamper-protection", { dryRun: false, turnOn: true, newPasswords: true, scope: "all" }, seedArrivedJob],
  "POST /migrate/devices/jobs/:id/scan": ["post", "/api/migrate/devices/jobs/local-1/scan", { dryRun: false }, seedArrivedJob],
};

// Routes that write nothing to a tenant, with a request to show it, or null
// where running it would change this test's own setup.
const LOCAL = {
  "PUT /credentials": null, // rewrites the tool's .env
  "POST /credentials/test": ["post", "/api/credentials/test", { mode: "direct", side: "source", clientId: SRC.clientId, clientSecret: SRC.secret }],
  "DELETE /logs": ["del", "/api/logs"],
  "POST /preload/start": ["post", "/api/preload/start", {}],
  "POST /preload/refresh/:section/:side": ["post", "/api/preload/refresh/policies/dest", {}],
  "POST /checks/licenses": ["post", "/api/checks/licenses", { endpointIds: [DEVICE] }],
  "POST /checks/tamper-protection": ["post", "/api/checks/tamper-protection", { endpointIds: [DEVICE] }],
  "POST /migrate/devices/jobs/:id/credentials": ["post", "/api/migrate/devices/jobs/local-1/credentials", { use: "current" }, seedJob],
  "POST /migrate/devices/jobs/:id/credentials/remove": ["post", "/api/migrate/devices/jobs/local-1/credentials/remove", {}, seedJob],
};

async function send([method, url, body, setup]) {
  if (setup) await setup();
  const auditBefore = (await readAudit(root)).length;
  fake.reset();
  const res = await http[method](url, body);
  return { res, writes: fake.writes(), entries: (await readAudit(root)).slice(auditBefore) };
}

const tenantIds = (list) => [...new Set(list)].sort();
const tenantOfWrite = (w) => (w.tenant === "src" ? SRC.tenantId : DST.tenantId);

test("every write route is listed here, once", () => {
  assert.ok(writeRoutes.length > 20, "the routes were read from the real routers");
  const listed = [...Object.keys(WRITES), ...Object.keys(LOCAL)];
  assert.deepEqual([...writeRoutes].sort(), [...listed].sort());
});

test("a write Sophos accepts is audited for each tenant written to", async () => {
  refuse = () => false;
  for (const [route, request] of Object.entries(WRITES)) {
    const { res, writes, entries } = await send(request);
    assert.ok(writes.length > 0, `${route} wrote to a tenant (status ${res.status} ${res.text.slice(0, 200)})`);
    assert.deepEqual(tenantIds(entries.map((e) => e.tenantId)), tenantIds(writes.map(tenantOfWrite)), `${route} audits each tenant it wrote to`);
    assert.ok(entries.some((e) => e.ok), `${route} audits the write as done`);
  }
});

test("a write Sophos refuses is audited with the error", async () => {
  refuse = () => true;
  for (const [route, request] of Object.entries(WRITES)) {
    const { writes, entries } = await send(request);
    assert.ok(writes.length > 0, `${route} tried to write`);
    assert.deepEqual(tenantIds(entries.map((e) => e.tenantId)), tenantIds(writes.map(tenantOfWrite)), `${route} audits each tenant it tried to write to`);
    assert.ok(entries.some((e) => e.ok === false && /400/.test(e.error)), `${route} audits the refusal`);
  }
  refuse = () => false;
});

test("a refused sender trigger is audited, and no DELETE is sent for the receiving job, since Sophos has none", async () => {
  refuse = (tenant, method) => tenant === SRC && method === "PUT";
  const { res, writes, entries } = await send(WRITES["POST /migrate/devices"]);
  refuse = () => false;
  assert.notEqual(res.status, 201);
  assert.deepEqual(entries.map((e) => [e.tenantId, e.action, e.resource, e.ok]), [
    [DST.tenantId, "create", "migration-receiver", true],
    [SRC.tenantId, "create", "migration-sender", false],
  ]);
  assert.deepEqual(writes.map((w) => `${w.tenant} ${w.method}`), ["dst POST", "src PUT"]);
});

test("the generic routes record what they wrote", async () => {
  refuse = () => false;
  const created = await send(WRITES["POST /:side/policies"]);
  const cloned = await send(WRITES["POST /:side/policies/:id/clone"]);
  const patched = await send(WRITES["PATCH /:side/policies/:id"]);
  const pick = ({ entries: [e] }) => [e.side, e.action, e.resource, e.resourceId, e.detail];
  assert.deepEqual(pick(created), ["dest", "create", "policy", created.res.body.id, { name: "Servers", type: "threat-protection" }]);
  assert.deepEqual(pick(cloned), ["dest", "clone", "policy", cloned.res.body.id, { sourceId: "p-9", name: "Servers copy" }]);
  assert.deepEqual(pick(patched), ["dest", "update", "policy", "p-9", { fields: ["enabled"], settings: [] }]);
});

test("the routes listed as local write nothing to a tenant", async () => {
  for (const [route, request] of Object.entries(LOCAL)) {
    if (!request) continue;
    const { writes } = await send(request);
    assert.deepEqual(writes.map((w) => `${w.method} ${w.path}`), [], route);
  }
});

test("a failed audit write fails that entry only, and the next entry is written", async () => {
  const { audit } = await import("../backend/dist/services/audit-log.js");
  const appendFile = fsp.appendFile;
  fsp.appendFile = async () => { throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); };
  try {
    await assert.rejects(audit({ side: "dest", tenantId: DST.tenantId, action: "create", resource: "while-locked", ok: true }), /EBUSY/);
  } finally {
    fsp.appendFile = appendFile;
  }
  await audit({ side: "dest", tenantId: DST.tenantId, action: "create", resource: "after-lock", ok: true });
  const resources = (await readAudit(root)).map((e) => e.resource);
  assert.ok(resources.includes("after-lock"));
  assert.ok(!resources.includes("while-locked"));
});

// Appends retry while OneDrive or antivirus holds data/audit.log. An entry that still can't be written doesn't turn
// a write Sophos made into an error: the route returns Sophos's result with a warning, and the entry goes to the
// tool's log. Before 26/09/2026 a failed append made the route report the write as failed, and a device move then
// deleted the receiving job its sender trigger had already used.
const auditFile = path.join(root, "data", "audit.log");
const lockAudit = (times) => {
  let calls = 0;
  fsp.appendFile = async (file, ...rest) => {
    if (path.resolve(String(file)) === auditFile && calls++ < times) throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${file}'`), { code: "EBUSY" });
    return appendFile(file, ...rest);
  };
  return () => calls;
};
const { appendFile } = fsp;
after(() => { fsp.appendFile = appendFile; });
const { audit } = await import("../backend/dist/services/audit-log.js");

test("a lock on the audit log that clears within the retries: the entry is written and there is no warning", async () => {
  refuse = () => false;
  const calls = lockAudit(2);
  let sent;
  try {
    sent = await send(WRITES["POST /:side/policies"]);
  } finally {
    fsp.appendFile = appendFile;
  }
  assert.equal(calls(), 3, "appended on the third try");
  assert.equal(sent.res.status, 201);
  assert.deepEqual(sent.entries.map((e) => [e.action, e.resource, e.resourceId, e.ok]), [["create", "policy", sent.res.body.id, true]]);
  assert.equal(sent.res.headers["x-audit-warning"], undefined);
  assert.ok(getRingBuffer().some((e) => e.section === "audit" && /append audit\.log: EBUSY, retry 1\/5/.test(e.message)));
});

test("once a lock outlasts the retries, the next entries try once each, and full retries return once one is written", async () => {
  const calls = lockAudit(Infinity);
  const entry = (resource) => audit({ side: "dest", tenantId: DST.tenantId, action: "create", resource, ok: true });
  try {
    await assert.rejects(() => entry("locked-1"), { code: "EBUSY" });
    assert.equal(calls(), 6, "the first entry waits out the five retries");
    for (let i = 2; i <= 5; i++) await assert.rejects(() => entry(`locked-${i}`), { code: "EBUSY" });
    assert.equal(calls(), 10, "the next four try once each, so a bulk copy is not slowed per item");
  } finally {
    fsp.appendFile = appendFile;
  }
  await entry("unlocked-1");
  const resources = (await readAudit(root)).map((e) => e.resource);
  assert.ok(resources.includes("unlocked-1"), "written on its one try once the file is free");
  assert.ok(!resources.some((r) => /^locked-/.test(r)));
  // Written once: the next lock gets the full retries again.
  const again = lockAudit(2);
  try {
    await entry("unlocked-2");
  } finally {
    fsp.appendFile = appendFile;
  }
  assert.equal(again(), 3);
  assert.ok((await readAudit(root)).some((e) => e.resource === "unlocked-2"));
});

test("an audit entry that can't be written leaves the write's result as it is, with a warning, and the entry in the tool's log", async () => {
  refuse = () => false;
  const before = await readFile(auditFile, "utf8");
  const logStart = getRingBuffer().length;
  lockAudit(Infinity);
  const sent = {};
  try {
    for (const route of ["POST /:side/policies", "DELETE /:side/policies/:id", "POST /migrate/policies", "POST /migrate/devices"]) {
      sent[route] = await send(WRITES[route]);
    }
  } finally {
    fsp.appendFile = appendFile;
  }
  assert.equal(await readFile(auditFile, "utf8"), before, "the audit log is as it was");

  const created = sent["POST /:side/policies"].res;
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^new-/, "Sophos's result");
  assert.match(created.headers["x-audit-warning"], /^The audit entry for this change couldn't be written to data\/audit\.log \(EBUSY\), usually because OneDrive or antivirus held the file\. The change itself is unaffected/);
  assert.equal(sent["DELETE /:side/policies/:id"].res.status, 204);
  assert.match(sent["DELETE /:side/policies/:id"].res.headers["x-audit-warning"], /couldn't be written/);
  const copied = sent["POST /migrate/policies"].res;
  assert.equal(copied.status, 200);
  assert.ok(JSON.stringify(copied.body).includes('"ok":true') && !copied.text.includes("EBUSY"), "the copy is reported as done");
  assert.match(copied.headers["x-audit-warning"], /couldn't be written/);

  // A device move carries on past the receiving job's entry, and the receiving job is not deleted.
  const moved = sent["POST /migrate/devices"];
  assert.equal(moved.res.status, 201, moved.res.text.slice(0, 200));
  assert.deepEqual(moved.writes.map((w) => w.method).sort(), ["POST", "PUT"]);
  assert.match(moved.res.headers["x-audit-warning"], /^2 audit entries for these changes couldn't be written/);

  const lines = getRingBuffer().slice(logStart).filter((e) => e.section === "audit" && e.level === "error");
  assert.equal(lines.length, 5, "one line per entry");
  assert.match(lines[0].message, /^Couldn't write an audit entry to data\/audit\.log \(EBUSY\): create policy new-\S+ on the dest tenant, done\./);
  assert.equal(lines[0].detail.entry.tenantId, DST.tenantId);

  await audit({ side: "dest", tenantId: DST.tenantId, action: "create", resource: "after-audit-lock", ok: true });
  assert.ok((await readAudit(root)).some((e) => e.resource === "after-audit-lock"), "the next entry is written");
});

test("a write Sophos refuses still reports Sophos's error when its audit entry can't be written", async () => {
  refuse = () => true;
  lockAudit(Infinity);
  let sent;
  try {
    sent = await send(WRITES["POST /:side/policies"]);
  } finally {
    fsp.appendFile = appendFile;
    refuse = () => false;
  }
  assert.notEqual(sent.res.status, 201);
  assert.match(sent.res.text, /400|refused by the test/);
  assert.doesNotMatch(sent.res.text, /EBUSY/);
  assert.match(sent.res.headers["x-audit-warning"], /couldn't be written/);
});
