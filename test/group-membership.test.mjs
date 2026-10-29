// API #4: group membership after a move, using the newId the migration job returns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { startMigration } = await import("../backend/dist/services/device-migrator.js");
const { restoreGroupMembership } = await import("../backend/dist/services/group-membership.js");
const { getJob } = await import("../backend/dist/services/migration-store.js");

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const recent = new Date(Date.now() - 3600e3).toISOString();

// Source devices and their groups.
const srcEndpoints = {
  [uuid(1)]: { id: uuid(1), hostname: "LT-1", type: "computer", lastSeenAt: recent, group: { id: "sg-fin", name: "Finance" } },
  [uuid(2)]: { id: uuid(2), hostname: "LT-2", type: "computer", lastSeenAt: recent, group: { id: "sg-fin", name: "Finance" } },
  [uuid(3)]: { id: uuid(3), hostname: "SRV-1", type: "server", lastSeenAt: recent, group: { id: "sg-sql", name: "SQL" } },
  [uuid(4)]: { id: uuid(4), hostname: "LT-4", type: "computer", lastSeenAt: recent },
  [uuid(5)]: { id: uuid(5), hostname: "LT-5", type: "computer", lastSeenAt: recent, group: { id: "sg-dev", name: "Developers" } },
};
fake.on(SRC, "GET", /^\/endpoint\/v1\/endpoints\/[^/]+$/, (req) => {
  const ep = srcEndpoints[req.path.split("/").pop()];
  return ep ? { body: ep } : { status: 404, body: { error: "NotFound", message: "endpoint not found" } };
});

// Migration job endpoints: status and newId per device.
let jobEndpoints = [];
for (const tenant of [SRC, DST]) {
  fake.on(tenant, "GET", /^\/endpoint\/v1\/migrations\/[^/]+\/endpoints$/, (req) => page(tenant === DST ? jobEndpoints : jobEndpoints.map(({ newId, ...rest }) => rest), req.query));
}
fake.on(DST, "POST", "/endpoint/v1/migrations", (req) => ({ status: 201, body: { id: "job-1", token: "handshake", mode: "receiving", endpoints: req.body.endpoints } }));
fake.on(SRC, "PUT", /^\/endpoint\/v1\/migrations\/[^/]+$/, () => ({ body: { id: "job-1", mode: "sending" } }));

// Destination groups and members.
let destGroups = [];
let destMembers = {};
let addBehaviour = () => null;
fake.on(DST, "GET", "/endpoint/v1/endpoint-groups", (req) => page(destGroups, req.query));
fake.on(DST, "GET", /^\/endpoint\/v1\/endpoint-groups\/[^/]+\/endpoints$/, (req) => ({ body: { items: (destMembers[req.path.split("/")[4]] ?? []).map((id) => ({ id })), pages: { size: 500 } } }));
fake.on(DST, "POST", /^\/endpoint\/v1\/endpoint-groups\/[^/]+\/endpoints$/, (req) => {
  const groupId = req.path.split("/")[4];
  const custom = addBehaviour(groupId, req.body.ids);
  if (custom) return custom;
  destMembers[groupId] = [...(destMembers[groupId] ?? []), ...req.body.ids];
  return { status: 201, body: { addedEndpoints: req.body.ids.map((id) => ({ id })), errors: {} } };
});

async function writeJobs(jobs) {
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "migration-jobs.json"), JSON.stringify(jobs, null, 2));
}

function baseJob(extra = {}) {
  return {
    localJobId: "local-1", jobName: "wave 1", createdAt: new Date().toISOString(), direction: "source-to-dest",
    sourceMigrationId: "job-1", destMigrationId: "job-1", fromToken: "x",
    endpointIds: [uuid(1), uuid(2), uuid(3), uuid(4), uuid(5)],
    endpointHostnames: Object.fromEntries(Object.values(srcEndpoints).map((e) => [e.id, e.hostname])),
    endpointGroups: {
      [uuid(1)]: { id: "sg-fin", name: "Finance" },
      [uuid(2)]: { id: "sg-fin", name: "Finance" },
      [uuid(3)]: { id: "sg-sql", name: "SQL" },
      [uuid(4)]: null,
      [uuid(5)]: { id: "sg-dev", name: "Developers" },
    },
    status: "complete", sourceSnapshot: null, destSnapshot: null,
    ...extra,
  };
}

function seedMoved() {
  jobEndpoints = [
    { id: uuid(1), status: "succeeded", newId: "new-1" },
    { id: uuid(2), status: "succeeded", newId: "new-2" },
    { id: uuid(3), status: "succeeded", newId: "new-3" },
    { id: uuid(4), status: "succeeded", newId: "new-4" },
    { id: uuid(5), status: "pending" },
  ];
  destGroups = [{ id: "dg-fin", name: "FINANCE", type: "computer" }];
  destMembers = { "dg-fin": ["new-2"] };
  addBehaviour = () => null;
}

test("job start records each device's group from the preflight reads; dry run plans without writes", async () => {
  fake.reset();
  const dry = await startMigration({ jobName: "wave 1", endpointIds: [uuid(1), uuid(2), uuid(4)], dryRun: true });
  assert.equal(fake.writes().length, 0);
  assert.deepEqual(dry.plan.groups, [{ name: "Finance", count: 2 }]);
  assert.equal(dry.plan.ungrouped, 1);

  const real = await startMigration({ jobName: "wave 1", endpointIds: [uuid(1), uuid(4)] });
  const stored = await getJob(real.job.localJobId);
  assert.deepEqual(stored.endpointGroups, { [uuid(1)]: { id: "sg-fin", name: "Finance" }, [uuid(4)]: null });
  const srcGets = fake.calls.filter((c) => c.tenant === "src" && c.method === "GET" && c.path.startsWith("/endpoint/v1/endpoints"));
  assert.deepEqual(srcGets.map((c) => c.query.ids), [[uuid(1), uuid(2), uuid(4)].join(","), [uuid(1), uuid(4)].join(",")], "no reads beyond the preflight's, one call for the dry run and one for the real run");
});

test("dry run: plans additions by name, skips members and reports gaps, writes nothing", async () => {
  seedMoved();
  await writeJobs([baseJob()]);
  fake.reset();
  const before = (await readAudit(root)).length;
  const res = await restoreGroupMembership("local-1", { dryRun: true });
  assert.equal(fake.writes().length, 0);
  assert.equal((await readAudit(root)).length, before);
  const by = (n) => res.rows.find((r) => r.endpointId === uuid(n));
  assert.equal(by(1).status, "will-add");
  assert.equal(by(1).destGroupId, "dg-fin", "group names match without case");
  assert.equal(by(2).status, "already-member");
  assert.equal(by(3).status, "group-missing");
  assert.equal(by(4).status, "no-group");
  assert.equal(by(5).status, "not-moved");
  assert.deepEqual(res.groups, [{ name: "FINANCE", destGroupId: "dg-fin", ids: ["new-1"], ok: null }]);
  assert.deepEqual(res.destGroups, [{ id: "dg-fin", name: "FINANCE", type: "computer" }], "the picker's list");
  assert.match(by(3).message, /no group named "SQL" here; pick one, or mirror it on the Groups page/);
  assert.match(by(4).message, /in no group on the sending tenant; pick one to add it/);
});

test("picked groups: a device goes to the group picked for it, one in no group can be placed, and null leaves one out", async () => {
  seedMoved();
  // new-2 is not in FINANCE yet, so without the null pick it would be added there.
  destMembers = {};
  destGroups.push({ id: "dg-child", name: "Child", type: "computer" }, { id: "dg-srv", name: "Servers", type: "server" });
  await writeJobs([baseJob()]);
  // uuid(1) was in Finance and goes to Child; uuid(4) was in no group; uuid(2) is left out; uuid(3) keeps the default.
  const choices = { [uuid(1)]: "dg-child", [uuid(4)]: "dg-child", [uuid(2)]: null };
  fake.reset();
  const dry = await restoreGroupMembership("local-1", { dryRun: true, choices });
  assert.equal(fake.writes().length, 0);
  const by = (res, n) => res.rows.find((r) => r.endpointId === uuid(n));
  assert.equal(by(dry, 1).status, "will-add");
  assert.equal(by(dry, 1).destGroupId, "dg-child");
  assert.equal(by(dry, 4).status, "will-add");
  assert.equal(by(dry, 4).destGroupId, "dg-child");
  assert.equal(by(dry, 2).status, "left-out");
  assert.equal(by(dry, 3).status, "group-missing", "no pick and no same-name group");
  assert.equal(dry.counts["left-out"], 1);
  assert.deepEqual(dry.groups, [{ name: "Child", destGroupId: "dg-child", ids: ["new-1", "new-4"], ok: null }]);
  assert.deepEqual(dry.destGroups.map((g) => g.name), ["Child", "FINANCE", "Servers"], "sorted by name");

  fake.reset();
  const before = (await readAudit(root)).length;
  const real = await restoreGroupMembership("local-1", { dryRun: false, choices });
  const posts = fake.writes();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/endpoint/v1/endpoint-groups/dg-child/endpoints");
  assert.deepEqual(posts[0].body, { ids: ["new-1", "new-4"] });
  assert.ok(!JSON.stringify(fake.calls).includes("new-2"), "the device left out gets no request");
  const noPicks = await restoreGroupMembership("local-1", { dryRun: true });
  assert.equal(by(noPicks, 2).status, "will-add", "without the null pick it would have been added");
  assert.equal(by(real, 1).status, "added");
  assert.equal(by(real, 4).status, "added");
  const entries = (await readAudit(root)).slice(before);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].detail.group, "Child");
});

test("a picked group that is not on the destination is reported, and nothing is written", async () => {
  seedMoved();
  await writeJobs([baseJob()]);
  fake.reset();
  const res = await restoreGroupMembership("local-1", { dryRun: false, choices: { [uuid(1)]: "dg-gone" } });
  const r1 = res.rows.find((r) => r.endpointId === uuid(1));
  assert.equal(r1.status, "group-missing");
  assert.match(r1.message, /the group picked is no longer on the destination/);
  assert.equal(fake.writes().length, 0);
});

test("the route passes the picks through and refuses a malformed one", async () => {
  const { startHttp } = await import("./helpers/http.mjs");
  const { migrateDevicesRouter } = await import("../backend/dist/routes/migrate-devices.js");
  const http = await startHttp([migrateDevicesRouter]);
  try {
    seedMoved();
    destGroups.push({ id: "dg-child", name: "Child", type: "computer" });
    await writeJobs([baseJob()]);
    const url = "/api/migrate/devices/jobs/local-1/group-membership";
    for (const choices of [[uuid(1)], { [uuid(1)]: 5 }, { [uuid(1)]: "" }, "dg-child"]) {
      const bad = await http.post(url, { dryRun: true, choices });
      assert.equal(bad.status, 400, JSON.stringify(choices));
      assert.match(bad.body.message, /choices must map device IDs to a group ID or null/);
    }
    const ok = await http.post(url, { dryRun: true, choices: { [uuid(4)]: "dg-child", [uuid(1)]: null } });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.rows.find((r) => r.endpointId === uuid(4)).status, "will-add");
    assert.equal(ok.body.rows.find((r) => r.endpointId === uuid(1)).status, "left-out");
    const none = await http.post(url, { dryRun: true });
    assert.equal(none.body.rows.find((r) => r.endpointId === uuid(4)).status, "no-group", "no picks: the same-name match only");
  } finally {
    http.close();
  }
});

test("the job page picks a group per row and sends the picks with each preview and write", async () => {
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../frontend/migrate-job-detail.html", import.meta.url), "utf8");
  assert.match(js, /\/group-membership`, \{ dryRun, choices \}\)/);
  assert.match(js, /const choices = dryRun \? state\.memberChoices : shownChoices\(\);/);
  // Only the latest answer is drawn, and Add to groups is off until it is.
  assert.match(js, /if \(seq !== membershipSeq\) return res;/);
  assert.match(js, /document\.getElementById\("membership-apply"\)\.disabled = true;/);
  assert.match(js, /document\.addEventListener\("change", onMemberPick\)/);
  assert.match(js, /<th>Destination group<\/th>/);
  // No same-name match: "Pick a group", marked, and the device is not added until one is picked.
  assert.match(js, /value \? "" : `<option value="" selected>Pick a group<\/option>`/);
  assert.match(js, /member-pick\$\{value \? "" : " is-warn"\}/);
  assert.match(js, /<option value="none"[^`]*>Don't add<\/option>/);
  assert.match(js, /"no-group": \["tag-warn", "no group"\]/);
  assert.match(html, /Pick another group, or\s+<em>Don't add<\/em>, in its row/);
});

test("the picker's labels and choices behave in the page", async () => {
  // The page module needs a DOM to boot, so check the picker's markup by evaluating the function alone.
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  const src = js.slice(js.indexOf("function groupPicker"), js.indexOf("\nboot();"));
  const { esc, escAttr } = await import("../frontend/js/ui.js");
  const groupPicker = new Function("esc", "escAttr", `${src}; return groupPicker;`)(esc, escAttr);
  const groups = [{ id: "g1", name: "Child", type: "computer" }, { id: "g2", name: "Servers", type: "server" }];
  const matched = groupPicker({ endpointId: "e1", hostname: "WIN10", status: "will-add", destGroupId: "g1" }, groups);
  assert.match(matched, /<option value="g1" selected>Child<\/option>/);
  assert.doesNotMatch(matched, /Pick a group|is-warn/);
  assert.match(matched, /Servers \(servers\)/);
  const unmatched = groupPicker({ endpointId: "e1", hostname: "WIN10", status: "no-group", destGroupId: null }, groups);
  assert.match(unmatched, /<option value="" selected>Pick a group<\/option>/);
  assert.match(unmatched, /class="member-pick is-warn"/);
  const out = groupPicker({ endpointId: "e1", hostname: "WIN10", status: "left-out", destGroupId: null }, groups);
  assert.match(out, /<option value="none" selected>Don't add<\/option>/);
  assert.doesNotMatch(out, /Pick a group/);
});

test("real run: posts the new IDs to the destination group and audits it", async () => {
  seedMoved();
  destGroups.push({ id: "dg-sql", name: "SQL", type: "server" });
  await writeJobs([baseJob()]);
  fake.reset();
  const before = (await readAudit(root)).length;
  const res = await restoreGroupMembership("local-1");
  const posts = fake.writes();
  assert.equal(posts.length, 2);
  assert.ok(posts.every((w) => w.tenant === "dst" && w.method === "POST"));
  assert.deepEqual(posts.find((w) => w.path.includes("dg-fin")).body, { ids: ["new-1"] });
  assert.deepEqual(posts.find((w) => w.path.includes("dg-sql")).body, { ids: ["new-3"] });
  assert.equal(res.rows.find((r) => r.endpointId === uuid(1)).status, "added");
  assert.equal(res.rows.find((r) => r.endpointId === uuid(3)).status, "added");
  const entries = (await readAudit(root)).slice(before);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.ok && e.resource === "endpoint-group-membership" && e.side === "dest"));
});

test("errors: devices the API reports, and a group synced from Active Directory", async () => {
  seedMoved();
  destGroups.push({ id: "dg-sql", name: "SQL", type: "server" });
  addBehaviour = (groupId, ids) => {
    if (groupId === "dg-sql") return { status: 409, body: { error: "Conflict", message: "group is synced from AD" } };
    return { status: 201, body: { addedEndpoints: [], errors: { endpointsNotFound: ids } } };
  };
  await writeJobs([baseJob()]);
  fake.reset();
  const before = (await readAudit(root)).length;
  const res = await restoreGroupMembership("local-1");
  const r1 = res.rows.find((r) => r.endpointId === uuid(1));
  assert.equal(r1.status, "error");
  assert.match(r1.message, /did not find this device/);
  const r3 = res.rows.find((r) => r.endpointId === uuid(3));
  assert.equal(r3.status, "error");
  assert.match(r3.message, /Active Directory/);
  const entries = (await readAudit(root)).slice(before);
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.ok === false));
});

test("an addition Sophos answers with 500 is sent once, and a read-back that finds the device counts it added", async () => {
  const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
  setReadBackDelays([0, 0, 0]);
  seedMoved();
  // Sophos makes the change and still answers 500, as seen live on 26/09/2026.
  addBehaviour = (groupId, ids) => {
    destMembers[groupId] = [...(destMembers[groupId] ?? []), ...ids];
    return { status: 500, body: { error: "InternalError", message: "Error processing data" } };
  };
  await writeJobs([baseJob()]);
  fake.reset();
  const before = (await readAudit(root)).length;
  const res = await restoreGroupMembership("local-1");
  const r1 = res.rows.find((r) => r.endpointId === uuid(1));
  assert.equal(r1.status, "added");
  assert.equal(r1.message, "Sophos answered 500, but a read-back found the device in the group on Test Destination, so the change was made");
  assert.equal(fake.writes().length, 1, "never sent twice");
  const entries = (await readAudit(root)).slice(before);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ok, true);
  assert.match(entries[0].detail.note, /read-back found/);

  // Not there on any read-back: failed, saying where the tool looked and what it found, and to wait, not to go and check.
  seedMoved();
  addBehaviour = () => ({ status: 500, body: { error: "InternalError" } });
  fake.reset();
  const again = await restoreGroupMembership("local-1");
  const r1b = again.rows.find((r) => r.endpointId === uuid(1));
  assert.equal(r1b.status, "error");
  assert.equal(r1b.message, 'Sophos API error 500: InternalError. The tool read the group "FINANCE" on Test Destination three times and found the device was not in it. Sophos can take a while to show a change, so this does not prove it failed. Wait a minute, then preview again: a device in the group by then shows as already in group.');
  assert.equal(fake.writes().length, 1);
});

test("older jobs without a snapshot read the device's group on the sending tenant", async () => {
  seedMoved();
  const job = baseJob();
  delete job.endpointGroups;
  await writeJobs([job]);
  fake.reset();
  const res = await restoreGroupMembership("local-1", { dryRun: true });
  assert.equal(res.rows.find((r) => r.endpointId === uuid(1)).status, "will-add");
  assert.equal(fake.writes().length, 0);
});

test("a job moving devices back to the source adds them on the source tenant", async () => {
  seedMoved();
  await writeJobs([baseJob({ direction: "dest-to-source" })]);
  // In this direction the receiving tenant is the source, which has no groups here.
  fake.reset();
  const res = await restoreGroupMembership("local-1", { dryRun: true });
  assert.equal(res.receivingSide, "source");
  const groupReads = fake.calls.filter((c) => c.path === "/endpoint/v1/endpoint-groups");
  assert.ok(groupReads.every((c) => c.tenant === "src"));
});

test("an addition on a job moving devices back names the source tenant it read, and says what to check when it could not read", async () => {
  const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
  setReadBackDelays([0, 0, 0]);
  seedMoved();
  const srcGroups = [{ id: "sg-fin", name: "Finance", type: "computer" }];
  let reads = 0;
  fake.on(SRC, "GET", "/endpoint/v1/endpoint-groups", (req) => page(srcGroups, req.query));
  fake.on(SRC, "GET", /^\/endpoint\/v1\/endpoint-groups\/[^/]+\/endpoints$/, () => (++reads === 1 ? { body: { items: [], pages: { size: 500 } } } : { status: 403, body: { error: "Forbidden", message: "no read" } }));
  fake.on(SRC, "POST", /^\/endpoint\/v1\/endpoint-groups\/[^/]+\/endpoints$/, () => ({ status: 500, body: { error: "InternalError" } }));
  await writeJobs([baseJob({ direction: "dest-to-source" })]);
  fake.reset();
  const res = await restoreGroupMembership("local-1", { dryRun: false, choices: { [uuid(1)]: "sg-fin", [uuid(2)]: null, [uuid(3)]: null, [uuid(4)]: null, [uuid(5)]: null } });
  const r1 = res.rows.find((r) => r.endpointId === uuid(1));
  assert.equal(r1.status, "error");
  assert.equal(r1.message, 'Sophos API error 500: InternalError. A read-back could not read the group "Finance" on Test Source (Sophos API error 403: Forbidden - no read). The change may still have gone through: check the group "Finance" on Test Source before trying again.');
  assert.deepEqual(fake.writes().map((w) => w.tenant), ["src"]);

  // Found there after the unclear answer: the note names the source tenant, not "the destination".
  seedMoved();
  const members = [];
  reads = 0;
  fake.on(SRC, "GET", /^\/endpoint\/v1\/endpoint-groups\/[^/]+\/endpoints$/, () => ({ body: { items: members.map((id) => ({ id })), pages: { size: 500 } } }));
  fake.on(SRC, "POST", /^\/endpoint\/v1\/endpoint-groups\/[^/]+\/endpoints$/, (req) => {
    members.push(...req.body.ids);
    return { status: 500, body: { error: "InternalError" } };
  });
  fake.reset();
  const found = await restoreGroupMembership("local-1", { dryRun: false, choices: { [uuid(1)]: "sg-fin", [uuid(2)]: null, [uuid(3)]: null, [uuid(4)]: null, [uuid(5)]: null } });
  const f1 = found.rows.find((r) => r.endpointId === uuid(1));
  assert.equal(f1.status, "added");
  assert.equal(f1.message, "Sophos answered 500, but a read-back found the device in the group on Test Source, so the change was made");
});

test("an unknown job id is a not-found error", async () => {
  await writeJobs([]);
  await assert.rejects(() => restoreGroupMembership("nope"), /not found/);
});

test("an addition only partly found by the read-back says the rest may have gone through, in the audit too", async () => {
  const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
  setReadBackDelays([0, 0, 0]);
  seedMoved();
  destMembers = {};
  destGroups.push({ id: "dg-child", name: "Child", type: "computer" });
  addBehaviour = (groupId, ids) => {
    destMembers[groupId] = [...(destMembers[groupId] ?? []), ids[0]];
    return { status: 500, body: { error: "InternalError" } };
  };
  await writeJobs([baseJob()]);
  fake.reset();
  const before = (await readAudit(root)).length;
  const res = await restoreGroupMembership("local-1", { dryRun: false, choices: { [uuid(1)]: "dg-child", [uuid(4)]: "dg-child", [uuid(2)]: null } });
  const by = (n) => res.rows.find((r) => r.endpointId === uuid(n));
  assert.equal(by(1).status, "added");
  assert.equal(by(4).status, "error");
  assert.match(by(4).message, /The tool read the group "Child" on Test Destination three times and found 1 of the 2 devices in it, but not this one\. Sophos can take a while to show a change, so this does not prove it failed\. Wait a minute, then preview again/);
  const [entry] = (await readAudit(root)).slice(before);
  assert.equal(entry.ok, false);
  assert.match(entry.error, /found 1 of the 2 devices in it, but not this one/);
  assert.equal(fake.writes().length, 1);
});

test("Add to groups sends the group each row shows, and null for a row shown with no group", async () => {
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  const src = js.slice(js.indexOf("function shownChoices"), js.indexOf("async function applyMembership"));
  const PICKABLE = new Set(["will-add", "already-member", "no-group", "group-missing", "left-out"]);
  const state = {
    memberChoices: { e3: "g9" },
    membershipShown: { rows: [
      { endpointId: "e1", newId: "n1", status: "will-add", destGroupId: "g1" },
      { endpointId: "e2", newId: "n2", status: "group-missing", destGroupId: null },
      { endpointId: "e3", newId: "n3", status: "will-add", destGroupId: "g9" },
      { endpointId: "e4", newId: "n4", status: "already-member", destGroupId: "g1" },
      { endpointId: "e5", newId: null, status: "not-moved", destGroupId: null },
    ] },
  };
  const shownChoices = new Function("state", "PICKABLE", `${src}; return shownChoices;`)(state, PICKABLE);
  assert.deepEqual(shownChoices(), { e3: "g9", e1: "g1", e2: null, e4: "g1" });
});
