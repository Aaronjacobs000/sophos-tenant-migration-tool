// Each job keeps its tenants and its credentials (encrypted), keeps checking them after the tool is pointed
// elsewhere, never returns a secret, and shows rejected credentials without losing what it last saw.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, SRC, DST, OTHER, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root, state } = await bootApp(fake);
const FOURTH = fake.addTenant({ tenantId: "66666666-6666-4666-8666-666666666666", clientId: "fourth-client", secret: "fourth-secret", host: "https://api-four.test.sophos.com" });
const { migrateDevicesRouter } = await import("../backend/dist/routes/migrate-devices.js");
const { logsRouter } = await import("../backend/dist/routes/logs.js");
const { resetKeyCache, keyFilePath } = await import("../backend/dist/services/job-credentials.js");
const { clearJobContextCache } = await import("../backend/dist/services/job-access.js");
const http = await startHttp([migrateDevicesRouter, logsRouter]);
after(() => http.close());

const DEVICE = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-00000000000a";
const recent = new Date(Date.now() - 60e3).toISOString();
const handover = new Date(Date.now() - 5 * 60e3).toISOString();
const open = { enabled: true, expiresAt: "2099-01-01T00:00:00Z" };

fake.on(SRC, "GET", `/endpoint/v1/endpoints/${DEVICE}`, () => ({ body: { id: DEVICE, hostname: "FIN-LT-01", type: "computer", lastSeenAt: recent, group: { id: "g1", name: "Finance" } } }));
for (const t of [SRC, DST]) fake.on(t, "GET", "/endpoint/v1/settings/migration", () => ({ body: open }));
fake.on(DST, "POST", "/endpoint/v1/migrations", () => ({ status: 201, body: { id: "job-1", token: "handshake-token-value", mode: "receiving" } }));
fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "sending" } }));
fake.on(SRC, "GET", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "sending" } }));
fake.on(DST, "GET", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "receiving" } }));
let entry = { id: DEVICE, status: "succeeded", newId: NEW, migratedAt: handover };
fake.on(SRC, "GET", "/endpoint/v1/migrations/job-1/endpoints", (req) => page([{ id: entry.id, status: entry.status, migratedAt: entry.migratedAt }], req.query));
fake.on(DST, "GET", "/endpoint/v1/migrations/job-1/endpoints", (req) => page([entry], req.query));
let record = { id: NEW, hostname: "FIN-LT-01", registeredAt: handover, lastSeenAt: handover };
fake.on(DST, "GET", "/endpoint/v1/endpoints", () => ({ body: { items: [record], pages: {} } }));
// The other pair knows nothing about job-1.
for (const t of [OTHER, FOURTH]) fake.on(t, "GET", /^\/endpoint\/v1\/migrations\/job-1(\/endpoints)?$/, () => ({ status: 404, body: { error: "NotFound", message: "not found" } }));

const SECRETS = [SRC.secret, DST.secret];
const CLIENT_IDS = [SRC.clientId, DST.clientId];
const ACCESS_TOKENS = ["tok-src", "tok-dst"];
const count = (text, values) => values.reduce((n, v) => n + text.split(v).length - 1, 0);
const vaultFile = () => path.join(root, "data", "job-credentials.json");
const tenantCalls = () => fake.calls.filter((c) => c.kind === "tenant").map((c) => c.tenant);

async function pointToolAt(source, dest) {
  await state.saveDirectCredentials({
    source: { clientId: source.clientId, clientSecret: source.secret, label: `Label ${source.clientId}` },
    dest: { clientId: dest.clientId, clientSecret: dest.secret, label: `Label ${dest.clientId}` },
  });
}

let jobId;

test("a new job records its tenants and stores its credentials encrypted, with the key outside the repo", async () => {
  const res = await http.post("/api/migrate/devices", { jobName: "Finance laptops, wave 1", endpointIds: [DEVICE] });
  assert.equal(res.status, 201);
  const job = res.body.job;
  jobId = job.localJobId;
  assert.deepEqual(job.credentials.stored, true);
  assert.equal(job.credentials.mode, "direct");
  assert.equal(job.tenants.source.tenantId, SRC.tenantId);
  assert.equal(job.tenants.dest.tenantId, DST.tenantId);
  assert.equal(job.tenants.source.name, "Test Source");

  const vault = await readFile(vaultFile(), "utf8");
  assert.equal(JSON.parse(vault).entries.length, 2);
  assert.equal(count(vault, [...SECRETS, ...CLIENT_IDS]), 0, "no secret or client ID in plain text");
  assert.equal(count(await readFile(path.join(root, "data", "migration-jobs.json"), "utf8"), [...SECRETS, ...CLIENT_IDS]), 0);
  assert.equal((await stat(vaultFile())).mode & 0o777, 0o600);
  assert.equal((await stat(keyFilePath())).mode & 0o777, 0o600);
  assert.ok(!keyFilePath().startsWith(path.join(root, "data")), "the key is not kept next to the vault");
});

test("no API response, stream event or log line carries a secret, a client ID or a credential reference", async () => {
  const entryIds = JSON.parse(await readFile(vaultFile(), "utf8")).entries.map((e) => e.id);
  const outputs = [
    (await http.get("/api/migrate/devices/jobs")).text,
    (await http.get("/api/migrate/devices/jobs/all")).text,
    (await http.get(`/api/migrate/devices/jobs/${jobId}`)).text,
    (await http.post(`/api/migrate/devices/jobs/${jobId}/credentials`, { use: "current" })).text,
    (await http.events(`/api/migrate/devices/jobs/${jobId}/stream`, 1)).map((e) => e.raw).join("\n"),
    (await http.get("/api/logs")).text,
  ];
  for (const out of outputs) {
    assert.equal(count(out, SECRETS), 0);
    assert.equal(count(out, CLIENT_IDS), 0);
    assert.equal(count(out, ACCESS_TOKENS), 0);
    assert.equal(count(out, entryIds), 0);
  }
  const detail = JSON.parse(outputs[2]);
  assert.deepEqual(Object.keys(detail.credentials).sort(), ["mode", "storedAt", "stored"].sort());
});

test("a job keeps checking its own tenants after the tool is pointed at another pair", async () => {
  await pointToolAt(OTHER, FOURTH);
  assert.equal(state.getState().source.tenantId, OTHER.tenantId);
  fake.reset();
  const res = await http.get(`/api/migrate/devices/jobs/${jobId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.monitor.state, "ok");
  assert.equal(res.body.monitor.via, "stored");
  assert.equal(res.body.status, "requested", "handed over, waiting for check-in");
  assert.deepEqual([...new Set(tenantCalls())].sort(), ["dst", "src"], "only the job's tenants were read");

  // Group membership is read from the job's tenants too, never the pair the tool points at.
  fake.reset();
  const membership = await http.post(`/api/migrate/devices/jobs/${jobId}/group-membership`, { dryRun: true });
  assert.equal(membership.status, 200);
  assert.ok(!tenantCalls().includes("oth") && !tenantCalls().includes(FOURTH.tenantId));
});

let beforeReject;

test("rejected credentials show as rejected, keep the last snapshot and its time, and back off", async () => {
  beforeReject = (await http.get(`/api/migrate/devices/jobs/${jobId}`)).body;
  assert.equal(beforeReject.monitor.state, "ok");
  fake.revoke(SRC);
  for (let i = 0; i < 2; i++) {
    // The first check fails on the cached sign-in, the second signs in again and is refused.
    const res = await http.get(`/api/migrate/devices/jobs/${jobId}`);
    assert.equal(res.body.monitor.state, "rejected");
    assert.equal(res.body.monitor.lastOkAt, beforeReject.monitor.lastOkAt);
    assert.deepEqual(res.body.sourceSnapshot, beforeReject.sourceSnapshot);
    assert.deepEqual(res.body.destSnapshot, beforeReject.destSnapshot);
    assert.deepEqual(res.body.checkIns, beforeReject.checkIns);
    assert.deepEqual(res.body.progress.devices, beforeReject.progress.devices);
    assert.equal(count(res.text, SECRETS), 0);
  }
  const list = (await http.get("/api/migrate/devices/jobs/all")).body.items.find((j) => j.localJobId === jobId);
  assert.equal(list.monitor.state, "rejected");
  assert.equal(list.progress.waiting, 1);
  const [first] = await http.events(`/api/migrate/devices/jobs/${jobId}/stream`, 1);
  assert.equal(first.data.monitor.state, "rejected");
});

test("once the credentials work again the job is checked again, and a check-in completes it", async () => {
  fake.restore(SRC);
  record = { ...record, lastSeenAt: new Date(Date.parse(handover) + 24 * 60e3).toISOString() };
  const res = await http.get(`/api/migrate/devices/jobs/${jobId}`);
  assert.equal(res.body.monitor.state, "ok");
  assert.equal(res.body.status, "completed");
  assert.equal(res.body.progress.percent, 100);
  assert.equal(res.body.progress.devices[0].newId, NEW);
  const [first, second] = await http.events(`/api/migrate/devices/jobs/${jobId}/stream`, 2);
  assert.equal(first.event, "status");
  assert.equal(first.data.nextCheckAt !== undefined, true);
  assert.ok(["status", "done"].includes(second.event));
});

test("a failed call keeps the saved snapshot", async () => {
  const before = (await http.get(`/api/migrate/devices/jobs/${jobId}`)).body;
  fake.on(DST, "GET", "/endpoint/v1/migrations/job-1/endpoints", () => ({ status: 500, body: { error: "ServerError" } }));
  fake.on(DST, "GET", "/endpoint/v1/migrations/job-1", () => ({ status: 500, body: { error: "ServerError" } }));
  const res = await http.get(`/api/migrate/devices/jobs/${jobId}`);
  assert.equal(res.body.monitor.state, "error");
  assert.deepEqual(res.body.destSnapshot, before.destSnapshot);
  assert.equal(res.body.status, "completed");
  fake.on(DST, "GET", "/endpoint/v1/migrations/job-1/endpoints", (req) => page([entry], req.query));
  fake.on(DST, "GET", "/endpoint/v1/migrations/job-1", () => ({ body: { id: "job-1", mode: "receiving" } }));
});

test("stored credentials can be removed; the job then says so instead of checking another pair", async () => {
  const res = await http.post(`/api/migrate/devices/jobs/${jobId}/credentials/remove`);
  assert.equal(res.status, 200);
  assert.equal(res.body.credentials.stored, false);
  assert.equal(JSON.parse(await readFile(vaultFile(), "utf8")).entries.length, 0, "no job uses them, so they are deleted");
  fake.reset();
  const after = (await http.get(`/api/migrate/devices/jobs/${jobId}`)).body;
  assert.equal(after.monitor.state, "no-credentials");
  assert.deepEqual(tenantCalls(), [], "nothing was asked of the tenants the tool points at now");
  assert.equal(after.status, "completed", "the saved state is kept");
});

test("the credential routes refuse a form post, so another site can't attach or remove credentials", async () => {
  for (const path_ of [`/api/migrate/devices/jobs/${jobId}/credentials`, `/api/migrate/devices/jobs/${jobId}/credentials/remove`]) {
    const res = await http.form(path_, "use=current");
    assert.equal(res.status, 415);
  }
  const noChoice = await http.post(`/api/migrate/devices/jobs/${jobId}/credentials`, {});
  assert.equal(noChoice.status, 400);
});

test("credentials attach only when they open the job's tenants and both tenants know the job", async () => {
  const wrongPair = await http.post(`/api/migrate/devices/jobs/${jobId}/credentials`, { use: "current" });
  assert.equal(wrongPair.status, 400);
  assert.match(wrongPair.body.message, /this job ran on/);

  const badSecret = await http.post(`/api/migrate/devices/jobs/${jobId}/credentials`, {
    use: "direct",
    sending: { clientId: SRC.clientId, clientSecret: "wrong-secret-value" },
    receiving: { clientId: DST.clientId, clientSecret: DST.secret },
  });
  assert.equal(badSecret.status, 400);
  assert.equal(count(badSecret.text, ["wrong-secret-value", DST.secret]), 0);
  assert.equal(JSON.parse(await readFile(vaultFile(), "utf8")).entries.length, 0, "nothing stored");

  const good = await http.post(`/api/migrate/devices/jobs/${jobId}/credentials`, {
    use: "direct",
    sending: { clientId: SRC.clientId, clientSecret: SRC.secret },
    receiving: { clientId: DST.clientId, clientSecret: DST.secret },
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.credentials.stored, true);
  assert.equal(count(good.text, SECRETS), 0);
  assert.equal((await http.get(`/api/migrate/devices/jobs/${jobId}`)).body.monitor.state, "ok");
});

test("without the key the stored credentials can't be read: shown as not stored, snapshot kept", async () => {
  const keyBackup = await readFile(keyFilePath());
  await rm(keyFilePath());
  resetKeyCache();
  clearJobContextCache();
  const res = (await http.get(`/api/migrate/devices/jobs/${jobId}`)).body;
  assert.equal(res.monitor.state, "no-credentials");
  assert.match(res.monitor.message, /key/);
  assert.equal(res.status, "completed");
  await writeFile(keyFilePath(), keyBackup, { mode: 0o600 });
  resetKeyCache();
});

test("an older job with no recorded tenants is not checked against a pair that doesn't know it", async () => {
  const jobs = JSON.parse(await readFile(path.join(root, "data", "migration-jobs.json"), "utf8"));
  const legacy = {
    localJobId: "legacy-1", jobName: "Pilot", createdAt: handover, direction: "source-to-dest",
    sourceMigrationId: "job-1", destMigrationId: "job-1", endpointIds: [DEVICE], endpointHostnames: { [DEVICE]: "FIN-LT-01" },
    status: "complete", sourceSnapshot: { id: "job-1", mode: "sending", endpointDetails: [{ id: DEVICE, status: "succeeded", migratedAt: handover }] },
    destSnapshot: { id: "job-1", mode: "receiving", endpointDetails: [entry] },
  };
  await writeFile(path.join(root, "data", "migration-jobs.json"), JSON.stringify([...jobs, legacy], null, 2));
  const res = (await http.get("/api/migrate/devices/jobs/legacy-1")).body;
  assert.equal(res.monitor.state, "not-found");
  assert.deepEqual(res.destSnapshot, legacy.destSnapshot, "the saved snapshot is not wiped");
  assert.equal(res.tenants, undefined, "the other pair is not recorded as the job's tenants");
  assert.equal(res.status, "requested");

  // Pointed back at the pair that knows the job, it is checked and its tenants are recorded.
  await pointToolAt(SRC, DST);
  const back = (await http.get("/api/migrate/devices/jobs/legacy-1")).body;
  assert.equal(back.monitor.state, "ok");
  assert.equal(back.monitor.via, "current");
  assert.equal(back.tenants.dest.tenantId, DST.tenantId);
  assert.equal(back.credentials.stored, false);
});

test("partner credentials: one encrypted entry for both tenants, and the job keeps its tenants after a repoint", async () => {
  const PARTNER = fake.addTenant({ tenantId: "77777777-7777-4777-8777-777777777777", clientId: "ptn-client", secret: "ptn-secret-value", host: "https://unused.test.sophos.com", idType: "partner" });
  fake.onGlobal("GET", "/partner/v1/tenants", () => ({ body: {
    items: [SRC, DST, OTHER, FOURTH].map((t, i) => ({ id: t.tenantId, name: `Customer ${i + 1}`, apiHost: t.host, dataRegion: "eu02", dataGeography: "EU" })),
    pages: { current: 1, size: 100, total: 1, maxSize: 100 },
  } }));
  await state.savePartnerCredentials({ clientId: PARTNER.clientId, clientSecret: PARTNER.secret, sourceTenantId: SRC.tenantId, destTenantId: DST.tenantId });
  assert.equal(state.getState().mode, "partner");

  const res = await http.post("/api/migrate/devices", { jobName: "Partner wave", endpointIds: [DEVICE] });
  assert.equal(res.status, 201);
  const job = res.body.job;
  assert.equal(job.credentials.mode, "partner");
  assert.equal(job.tenants.source.name, "Customer 1");
  const stored = JSON.parse(await readFile(path.join(root, "data", "migration-jobs.json"), "utf8")).find((j) => j.localJobId === job.localJobId);
  assert.equal(stored.credentials.source, stored.credentials.dest, "one partner entry serves both tenants");
  assert.equal(count(await readFile(vaultFile(), "utf8"), [PARTNER.secret, PARTNER.clientId]), 0);

  // The partner now points the tool at two other customers; the job still reads its own.
  await state.savePartnerCredentials({ clientId: PARTNER.clientId, clientSecret: PARTNER.secret, sourceTenantId: OTHER.tenantId, destTenantId: FOURTH.tenantId });
  fake.reset();
  const polled = (await http.get(`/api/migrate/devices/jobs/${job.localJobId}`)).body;
  assert.equal(polled.monitor.state, "ok");
  assert.equal(polled.monitor.via, "stored");
  assert.deepEqual([...new Set(tenantCalls())].sort(), ["dst", "src"]);
  assert.equal(count(JSON.stringify(polled), [PARTNER.secret, PARTNER.clientId]), 0);
});

test("reading a stored credential while others are saved never gets half the file", async () => {
  const { putCredential, getCredential } = await import("../backend/dist/services/job-credentials.js");
  const cred = (i) => ({ clientId: `race-client-${i}`, clientSecret: `race-secret-value-${i}` });
  const ids = [];
  for (let i = 0; i < 30; i++) ids.push(await putCredential("tenant", cred(i)));
  let saving = true;
  const saves = (async () => {
    try {
      for (let round = 0; round < 100; round++) await putCredential("tenant", cred(round % 30));
    } finally {
      saving = false;
    }
  })();
  const readers = [0, 1, 2, 3].map(async (k) => {
    let n = 0;
    while (saving) {
      const i = (n + k) % 30;
      assert.equal((await getCredential(ids[i]))?.clientId, cred(i).clientId, `read ${n}`);
      n++;
    }
    return n;
  });
  const counts = await Promise.all([saves, ...readers]);
  assert.ok(counts.slice(1).every((n) => n > 0));
});
