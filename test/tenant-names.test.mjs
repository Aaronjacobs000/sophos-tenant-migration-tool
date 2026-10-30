// Jobs saved without tenant names (earlier builds, or credentials entered by hand) get them from what the
// tool already knows, matched by tenant ID: on attach, on the next check, and on the Migrations list for
// finished jobs, which are no longer checked. A recorded name is never replaced, and none is invented.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, SRC, DST, OTHER, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root, state } = await bootApp(fake);
const FOURTH = fake.addTenant({ tenantId: "66666666-6666-4666-8666-666666666666", clientId: "fourth-client", secret: "fourth-secret", host: "https://api-four.test.sophos.com" });
const FIFTH = fake.addTenant({ tenantId: "88888888-8888-4888-8888-888888888888", clientId: "fifth-client", secret: "fifth-secret", host: "https://api-five.test.sophos.com" });
const SIXTH = fake.addTenant({ tenantId: "99999999-9999-4999-8999-999999999999", clientId: "sixth-client", secret: "sixth-secret", host: "https://api-six.test.sophos.com" });
const { migrateDevicesRouter } = await import("../backend/dist/routes/migrate-devices.js");
const http = await startHttp([migrateDevicesRouter]);
after(() => http.close());

const DEVICE = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-00000000000a";
const recent = new Date(Date.now() - 60e3).toISOString();
const handover = new Date(Date.now() - 60 * 60e3).toISOString();
const arrived = new Date(Date.parse(handover) + 24 * 60e3).toISOString();

fake.on(SRC, "GET", `/endpoint/v1/endpoints/${DEVICE}`, () => ({ body: { id: DEVICE, hostname: "FIN-LT-01", type: "computer", lastSeenAt: recent } }));
for (const t of [SRC, DST]) fake.on(t, "GET", "/endpoint/v1/settings/migration", () => ({ body: { enabled: true, expiresAt: "2099-01-01T00:00:00Z" } }));
let seq = 0;
fake.on(DST, "POST", "/endpoint/v1/migrations", () => ({ status: 201, body: { id: `job-${++seq}`, token: "handshake-token-value", mode: "receiving" } }));
fake.on(SRC, "PUT", /^\/endpoint\/v1\/migrations\/job-\d+$/, (req) => ({ body: { id: req.path.split("/").pop(), mode: "sending" } }));
const entry = { id: DEVICE, status: "succeeded", newId: NEW, migratedAt: handover };
// Every job's device has handed over and checked in, so each job completes on its first check.
for (const [sending, receiving] of [[SRC, DST], [FIFTH, SIXTH]]) {
  fake.on(sending, "GET", /^\/endpoint\/v1\/migrations\/job-\d+$/, (req) => ({ body: { id: req.path.split("/").pop(), mode: "sending" } }));
  fake.on(receiving, "GET", /^\/endpoint\/v1\/migrations\/job-\d+$/, (req) => ({ body: { id: req.path.split("/").pop(), mode: "receiving" } }));
  fake.on(sending, "GET", /^\/endpoint\/v1\/migrations\/job-\d+\/endpoints$/, (req) => page([{ id: DEVICE, status: "succeeded", migratedAt: handover }], req.query));
  fake.on(receiving, "GET", /^\/endpoint\/v1\/migrations\/job-\d+\/endpoints$/, (req) => page([entry], req.query));
  fake.on(receiving, "GET", "/endpoint/v1/endpoints", () => ({ body: { items: [{ id: NEW, hostname: "FIN-LT-01", registeredAt: handover, lastSeenAt: arrived }], pages: {} } }));
}

const jobsFile = path.join(root, "data", "migration-jobs.json");
const saved = async (id) => JSON.parse(await readFile(jobsFile, "utf8")).find((j) => j.localJobId === id);
const names = (job) => [job.tenants?.source.name ?? null, job.tenants?.dest.name ?? null];
const jobCalls = () => fake.calls.filter((c) => c.kind === "tenant" && /^\/endpoint\/v1\/migrations\/job-/.test(c.path));

/** Rewrite saved jobs, as an earlier build or a hand-entered attach would have left them. */
async function edit(id, change) {
  const jobs = JSON.parse(await readFile(jobsFile, "utf8"));
  const i = jobs.findIndex((j) => j.localJobId === id);
  jobs[i] = change(jobs[i]);
  await writeFile(jobsFile, JSON.stringify(jobs, null, 2));
}
const withoutNames = (j) => ({ ...j, tenants: { source: { ...j.tenants.source, name: null }, dest: { ...j.tenants.dest, name: null } } });

async function startJob(name) {
  const res = await http.post("/api/migrate/devices", { jobName: name, endpointIds: [DEVICE] });
  assert.equal(res.status, 201);
  return res.body.job.localJobId;
}

async function pointToolAt(source, dest, labels = [`Label ${source.clientId}`, `Label ${dest.clientId}`]) {
  await state.saveDirectCredentials({
    source: { clientId: source.clientId, clientSecret: source.secret, label: labels[0] },
    dest: { clientId: dest.clientId, clientSecret: dest.secret, label: labels[1] },
  });
}

let named;
let unnamed;

test("a job with stored credentials but no tenant names gets them on its next check, from the tool's labels", async () => {
  named = await startJob("Finance laptops, wave 1");
  unnamed = await startJob("Finance laptops, wave 2");
  assert.deepEqual(names(await saved(unnamed)), ["Test Source", "Test Destination"]);
  await edit(unnamed, withoutNames);
  assert.deepEqual(names(await saved(unnamed)), [null, null]);

  const res = (await http.get(`/api/migrate/devices/jobs/${unnamed}`)).body;
  assert.equal(res.monitor.state, "ok");
  assert.equal(res.monitor.via, "stored");
  assert.deepEqual(names(res), ["Test Source", "Test Destination"]);
  assert.deepEqual(names(await saved(unnamed)), ["Test Source", "Test Destination"], "the names are saved");
  assert.equal(res.tenants.source.tenantId, SRC.tenantId, "the tenant IDs are unchanged");
});

test("the Migrations list names a finished job's tenants without asking Sophos about the job", async () => {
  assert.equal((await http.get(`/api/migrate/devices/jobs/${named}`)).body.status, "completed");
  await edit(named, withoutNames);
  fake.reset();
  const all = (await http.get("/api/migrate/devices/jobs/all")).body.items.find((j) => j.localJobId === named);
  assert.deepEqual(names(all), ["Test Source", "Test Destination"]);
  assert.deepEqual(jobCalls(), [], "a finished job is not checked; the names come from the tool's labels");

  await edit(named, withoutNames);
  const list = (await http.get("/api/migrate/devices/jobs")).body.items.find((j) => j.localJobId === named);
  assert.deepEqual(names(list), ["Test Source", "Test Destination"]);
  assert.deepEqual(names(await saved(named)), ["Test Source", "Test Destination"]);
});

test("a recorded name is never replaced by a newer label", async () => {
  await edit(named, (j) => ({ ...j, tenants: { ...j.tenants, source: { ...j.tenants.source, name: "Name at the time" } } }));
  await pointToolAt(SRC, DST, ["Renamed source", "Renamed destination"]);
  await http.get("/api/migrate/devices/jobs/all");
  const res = (await http.get(`/api/migrate/devices/jobs/${named}`)).body;
  assert.equal(res.monitor.state, "ok");
  assert.deepEqual(names(res), ["Name at the time", "Test Destination"]);
});

test("with the tool pointed elsewhere, a name comes from another job that recorded the same tenant", async () => {
  await pointToolAt(OTHER, FOURTH);
  await edit(unnamed, withoutNames);
  const res = (await http.get(`/api/migrate/devices/jobs/${unnamed}`)).body;
  assert.equal(res.monitor.via, "stored");
  assert.deepEqual(names(res), ["Name at the time", "Test Destination"]);
});

test("attaching credentials to a job saved without tenants records their names", async () => {
  await pointToolAt(SRC, DST, ["Test Source", "Test Destination"]);
  const jobs = JSON.parse(await readFile(jobsFile, "utf8"));
  const legacy = {
    localJobId: "legacy-1", jobName: "Pilot", createdAt: handover, direction: "source-to-dest",
    sourceMigrationId: "job-1", destMigrationId: "job-1", endpointIds: [DEVICE], endpointHostnames: { [DEVICE]: "FIN-LT-01" },
    status: "complete", sourceSnapshot: null, destSnapshot: null,
  };
  await writeFile(jobsFile, JSON.stringify([...jobs, legacy], null, 2));
  const res = await http.post("/api/migrate/devices/jobs/legacy-1/credentials", {
    use: "direct",
    sending: { clientId: SRC.clientId, clientSecret: SRC.secret },
    receiving: { clientId: DST.clientId, clientSecret: DST.secret },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.credentials.stored, true);
  assert.equal(res.body.tenants.source.tenantId, SRC.tenantId);
  assert.deepEqual(names(res.body), ["Test Source", "Test Destination"]);
});

test("a tenant no label or job names keeps no name, and none is invented", async () => {
  const jobs = JSON.parse(await readFile(jobsFile, "utf8"));
  const stranger = {
    localJobId: "legacy-2", jobName: "Another customer", createdAt: handover, direction: "source-to-dest",
    sourceMigrationId: "job-77", destMigrationId: "job-77", endpointIds: [DEVICE], endpointHostnames: { [DEVICE]: "FIN-LT-01" },
    status: "complete", sourceSnapshot: null, destSnapshot: null,
  };
  await writeFile(jobsFile, JSON.stringify([...jobs, stranger], null, 2));
  const res = await http.post("/api/migrate/devices/jobs/legacy-2/credentials", {
    use: "direct",
    sending: { clientId: FIFTH.clientId, clientSecret: FIFTH.secret },
    receiving: { clientId: SIXTH.clientId, clientSecret: SIXTH.secret },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.tenants.source.tenantId, FIFTH.tenantId);
  assert.deepEqual(names(res.body), [null, null]);
  const checked = (await http.get("/api/migrate/devices/jobs/legacy-2")).body;
  assert.equal(checked.monitor.state, "ok");
  assert.deepEqual(names(checked), [null, null]);
});

test("partner credentials: a job's missing names come from the partner's tenant list", async () => {
  const PARTNER = fake.addTenant({ tenantId: "77777777-7777-4777-8777-777777777777", clientId: "ptn-client", secret: "ptn-secret-value", host: "https://unused.test.sophos.com", idType: "partner" });
  fake.onGlobal("GET", "/partner/v1/tenants", () => ({ body: {
    items: [SRC, DST, OTHER, FOURTH].map((t, i) => ({ id: t.tenantId, name: `Customer ${i + 1}`, apiHost: t.host, dataRegion: "eu02", dataGeography: "EU" })),
    pages: { current: 1, size: 100, total: 1, maxSize: 100 },
  } }));
  await state.savePartnerCredentials({ clientId: PARTNER.clientId, clientSecret: PARTNER.secret, sourceTenantId: SRC.tenantId, destTenantId: DST.tenantId });
  const id = await startJob("Partner wave");
  assert.deepEqual(names(await saved(id)), ["Customer 1", "Customer 2"]);
  // Repointed at two other customers, the job's own tenants are still in the partner's list.
  await state.savePartnerCredentials({ clientId: PARTNER.clientId, clientSecret: PARTNER.secret, sourceTenantId: OTHER.tenantId, destTenantId: FOURTH.tenantId });
  await edit(id, withoutNames);
  const res = (await http.get(`/api/migrate/devices/jobs/${id}`)).body;
  assert.equal(res.monitor.via, "stored");
  assert.deepEqual(names(res), ["Customer 1", "Customer 2"]);
});
