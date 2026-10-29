// With no connection at all, a job with stored credentials is still listed, checked, streamed and can have
// credentials attached or removed. Only the routes that use the connection refuse. Before 26/09/2026 a guard
// on /migrate in migrate-config.ts refused every job route with 409 unconfigured.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root, state } = await bootApp(fake);

// The routers in the order server.ts mounts them, so a guard on a shared path is caught.
const serverSource = await readFile(new URL("../backend/src/server.ts", import.meta.url), "utf8");
const mounted = [...serverSource.matchAll(/app\.use\("\/api", (\w+)\)/g)].map((m) => m[1]);
const routesDir = new URL("../backend/dist/routes/", import.meta.url);
const exported = {};
for (const file of (await readdir(routesDir)).filter((f) => f.endsWith(".js"))) {
  Object.assign(exported, await import(new URL(file, routesDir)));
}
const http = await startHttp(mounted.map((name) => exported[name]));
after(() => http.close());

const DEVICE = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-00000000000a";
const handover = new Date(Date.now() - 5 * 60e3).toISOString();
fake.on(SRC, "GET", `/endpoint/v1/endpoints/${DEVICE}`, () => ({ body: { id: DEVICE, hostname: "FIN-LT-01", type: "computer", lastSeenAt: new Date(Date.now() - 60e3).toISOString(), group: { id: "g1", name: "Finance" } } }));
for (const t of [SRC, DST]) fake.on(t, "GET", "/endpoint/v1/settings/migration", () => ({ body: { enabled: true, expiresAt: "2099-01-01T00:00:00Z" } }));
fake.on(DST, "POST", "/endpoint/v1/migrations", () => ({ status: 201, body: { id: "job-1", token: "handshake-token-value", mode: "receiving" } }));
fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "sending" } }));
fake.on(SRC, "GET", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "sending" } }));
fake.on(DST, "GET", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "receiving" } }));
fake.on(SRC, "GET", "/endpoint/v1/migrations/job-1/endpoints", (req) => page([{ id: DEVICE, status: "succeeded", migratedAt: handover }], req.query));
fake.on(DST, "GET", "/endpoint/v1/migrations/job-1/endpoints", (req) => page([{ id: DEVICE, status: "succeeded", newId: NEW, migratedAt: handover }], req.query));
fake.on(DST, "GET", "/endpoint/v1/endpoints", () => ({ body: { items: [{ id: NEW, hostname: "FIN-LT-01", registeredAt: handover, lastSeenAt: handover }], pages: {} } }));
fake.on(DST, "GET", "/endpoint/v1/endpoint-groups", (req) => page([{ id: "dg-fin", name: "Finance", type: "computer" }], req.query));
fake.on(DST, "GET", "/endpoint/v1/endpoint-groups/dg-fin/endpoints", () => ({ body: { items: [], pages: { size: 500 } } }));

const jobsFile = path.join(root, "data", "migration-jobs.json");

// One job started while connected, which stores its credentials, and a copy of it with none stored.
const started = await http.post("/api/migrate/devices", { jobName: "Finance laptops, wave 1", endpointIds: [DEVICE] });
assert.equal(started.status, 201);
const jobId = started.body.job.localJobId;
assert.equal(started.body.job.credentials.stored, true);
const jobs = JSON.parse(await readFile(jobsFile, "utf8"));
const { credentials: _dropped, ...bare } = jobs.find((j) => j.localJobId === jobId);
await writeFile(jobsFile, JSON.stringify([...jobs, { ...bare, localJobId: "no-creds", jobName: "Finance laptops, wave 2", monitor: undefined }], null, 2));

// Now remove the tool's connection.
await writeFile(path.join(root, ".env"), "CREDENTIAL_MODE=direct\n");
await state.rebuildContexts();
assert.equal(state.getState().status, "unconfigured");
fake.reset();

test("the job count for the setup wizard answers with no connection, and checks nothing", async () => {
  const res = await http.get("/api/migrate/devices/jobs/count");
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.deepEqual(res.body, { count: 2 });
  assert.deepEqual(fake.calls, []);
});

test("the job list answers with no connection", async () => {
  for (const url of ["/api/migrate/devices/jobs", "/api/migrate/devices/jobs/all"]) {
    const res = await http.get(url);
    assert.equal(res.status, 200, `${url} answered ${res.status} ${res.text.slice(0, 200)}`);
    const ids = res.body.items.map((j) => j.localJobId);
    assert.ok(ids.includes(jobId) && ids.includes("no-creds"), url);
  }
});

test("a job page, its stream and its group membership preview answer with stored credentials and no connection", async () => {
  const res = await http.get(`/api/migrate/devices/jobs/${jobId}`);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.equal(res.body.monitor.state, "ok", "checked with the job's own credentials");
  assert.equal(res.body.monitor.via, "stored");

  const [first] = await http.events(`/api/migrate/devices/jobs/${jobId}/stream`, 1);
  assert.equal(first.event, "status");
  assert.equal(first.data.localJobId, jobId);

  const membership = await http.post(`/api/migrate/devices/jobs/${jobId}/group-membership`, { dryRun: true });
  assert.equal(membership.status, 200, membership.text.slice(0, 200));
  assert.equal(membership.body.counts["will-add"], 1);
});

test("a job with no stored credentials and no connection shows can't check, not 409", async () => {
  const res = await http.get("/api/migrate/devices/jobs/no-creds");
  assert.equal(res.status, 200, res.text.slice(0, 200));
  assert.equal(res.body.monitor.state, "no-credentials");
  assert.match(res.body.monitor.message, /not connected/);
});

test("credentials can be attached and removed with no connection; using the current one says there is none", async () => {
  const current = await http.post("/api/migrate/devices/jobs/no-creds/credentials", { use: "current" });
  assert.equal(current.status, 400);
  assert.match(current.body.message, /not connected/);

  const attached = await http.post("/api/migrate/devices/jobs/no-creds/credentials", {
    use: "direct",
    sending: { clientId: SRC.clientId, clientSecret: SRC.secret },
    receiving: { clientId: DST.clientId, clientSecret: DST.secret },
  });
  assert.equal(attached.status, 200, attached.text.slice(0, 200));
  assert.equal(attached.body.credentials.stored, true);
  assert.equal((await http.get("/api/migrate/devices/jobs/no-creds")).body.monitor.state, "ok");

  const removed = await http.post("/api/migrate/devices/jobs/no-creds/credentials/remove", {});
  assert.equal(removed.status, 200);
  assert.equal(removed.body.credentials.stored, false);
});

test("the routes that need the connection still refuse with 409 unconfigured, before calling Sophos", async () => {
  fake.reset();
  for (const [method, url, body] of [
    ["post", "/api/migrate/policies", { policyIds: ["p-1"] }],
    ["post", "/api/migrate/groups", { groupIds: ["g-1"] }],
    ["post", "/api/migrate/user-groups", { userGroupIds: ["u-1"] }],
    ["post", "/api/migrate/exclusions", { selections: { scanning: ["e-1"] } }],
    ["post", "/api/migrate/web-filters", { siteListIds: ["sl-1"] }],
    ["post", "/api/migrate/devices", { jobName: "wave 3", endpointIds: [DEVICE] }],
    ["get", "/api/checks/migration-window"],
    ["post", "/api/checks/licenses", { endpointIds: [DEVICE] }],
    ["post", "/api/checks/known-issues", { endpointIds: [DEVICE] }],
  ]) {
    const res = await http[method](url, body);
    assert.equal(res.status, 409, `${url} answered ${res.status}`);
    assert.deepEqual(res.body, { error: "unconfigured" }, url);
  }
  assert.deepEqual(fake.writes(), []);
});
