// Policy assignments (appliesTo) follow a clone: each target is matched on the destination by name, email or
// hostname, written in the shape Sophos accepts (measured live 13/10/2026) and read back by ID.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { migratePolicies } = await import("../backend/dist/services/policy-migrator.js");
const {
  appliesToBody, idsOf, modeOf, matchUser, matchUserGroup, matchEndpointGroup, matchEndpoint,
} = await import("../backend/dist/services/policy-assignments.js");
const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
const { SophosClient } = await import("../backend/dist/sophos/client/sophos-client.js");

SophosClient.prototype.sleep = async () => {};
setReadBackDelays([0, 0, 0]);

// ---- the shapes and the matching ----

test("a device body always carries endpoints; a user body only the keys with IDs; never both kinds", () => {
  assert.deepEqual(appliesToBody("device", { endpointGroups: ["g1"] }), { endpoints: [], endpointGroups: ["g1"] });
  assert.deepEqual(appliesToBody("device", { endpoints: ["e1"], endpointGroups: [] }), { endpoints: ["e1"] });
  assert.deepEqual(appliesToBody("device", { endpoints: ["e1"], endpointGroups: ["g1"] }), { endpoints: ["e1"], endpointGroups: ["g1"] });
  assert.deepEqual(appliesToBody("user", { users: ["u1"], userGroups: [] }), { users: ["u1"] });
  assert.deepEqual(appliesToBody("user", { users: [], userGroups: ["ug1"] }), { userGroups: ["ug1"] });
  assert.deepEqual(appliesToBody("user", { users: ["u1"], userGroups: ["ug1"] }), { users: ["u1"], userGroups: ["ug1"] });
  // Device IDs handed to a user body are not sent.
  assert.deepEqual(appliesToBody("user", { users: ["u1"], endpoints: ["e1"] }), { users: ["u1"] });
  assert.deepEqual(appliesToBody("device", { endpoints: ["e1"], users: ["u1"] }), { endpoints: ["e1"] });
});

test("IDs are read as strings, { id } tolerated; the mode follows the keys that hold IDs", () => {
  assert.deepEqual(idsOf({ users: ["a", { id: "b" }, "", null] }, "users"), ["a", "b"]);
  assert.equal(modeOf({ users: [], userGroups: [] }), undefined);
  assert.equal(modeOf({ users: [], userGroups: ["g"] }), "user");
  assert.equal(modeOf({ endpoints: [], endpointGroups: ["g"] }), "device");
  assert.equal(modeOf(undefined), undefined);
});

test("users match by email first, ignoring case, then by name; more than one is not a match", () => {
  const dest = [
    { id: "d1", name: "Alice Smith", email: "Alice@Example.com" },
    { id: "d2", name: "CORP\\bob" },
    { id: "d3", name: "Twin" },
    { id: "d4", name: "twin" },
  ];
  assert.deepEqual(matchUser({ id: "s1", name: "Alice", email: "alice@example.com" }, dest), { destId: "d1" });
  assert.deepEqual(matchUser({ id: "s2", name: "corp\\BOB" }, dest), { destId: "d2" });
  assert.deepEqual(matchUser({ id: "s3", name: "Alice Smith", email: "other@example.com" }, dest), { destId: "d1" }, "falls back to the name");
  const twin = matchUser({ id: "s4", name: "Twin" }, dest);
  assert.equal(twin.status, "not-matched");
  assert.match(twin.reason, /^2 users on the destination are named "Twin"/);
  const none = matchUser({ id: "s5", name: "Carol", email: "carol@example.com" }, dest);
  assert.deepEqual(none, { status: "not-matched", reason: 'no user on the destination has the email carol@example.com or the name "Carol"' });
});

test("groups match by name ignoring case; device groups only of the same type", () => {
  assert.deepEqual(matchUserGroup({ id: "s", name: "Finance " }, [{ id: "d", name: "finance" }]), { destId: "d" });
  const missingUg = matchUserGroup({ id: "s", name: "HR" }, []);
  assert.match(missingUg.reason, /^no user group named "HR" on the destination: mirror it on the Groups page/);
  const dest = [{ id: "dc", name: "Sydney", type: "computer" }, { id: "ds", name: "SYDNEY", type: "server" }];
  assert.deepEqual(matchEndpointGroup({ id: "s", name: "Sydney", type: "server" }, dest), { destId: "ds" });
  assert.deepEqual(matchEndpointGroup({ id: "s", name: "sydney", type: "computer" }, dest), { destId: "dc" });
  const none = matchEndpointGroup({ id: "s", name: "Perth", type: "server" }, dest);
  assert.equal(none.status, "not-matched");
  assert.match(none.reason, /^no server group named "Perth" on the destination: mirror it on the Groups page, then clone again$/);
});

test("devices match by hostname and type; none is pending, more than one is not a match", () => {
  const dest = [
    { id: "d1", hostname: "PC-01", type: "computer" },
    { id: "d2", hostname: "dc01", type: "server" },
    { id: "d3", hostname: "DC01", type: "server" },
    { id: "d4", hostname: "WEB", type: "server" },
  ];
  assert.deepEqual(matchEndpoint({ id: "s1", hostname: "pc-01", type: "computer" }, dest), { destId: "d1" });
  const pending = matchEndpoint({ id: "s2", hostname: "PC-02", type: "computer" }, dest);
  assert.equal(pending.status, "pending");
  assert.match(pending.reason, /^no device named "PC-02" on the destination yet: once its move lands, clone again to add it$/);
  const twice = matchEndpoint({ id: "s3", hostname: "DC01", type: "server" }, dest);
  assert.equal(twice.status, "not-matched");
  assert.match(twice.reason, /^2 devices named "DC01" on the destination/);
  assert.equal(matchEndpoint({ id: "s4", hostname: "WEB", type: "computer" }, dest).status, "pending", "a server of that name is another device");
});

// ---- through the clone, against a fake that answers as Sophos does ----

const DEVICE_KEYS = ["endpoints", "endpointGroups"];
const USER_KEYS = ["users", "userGroups"];
const policies = { src: [], dst: [] };
const directory = { src: {}, dst: {} };
let failNextPatch = null;
let dropOnPatch = [];

/** Sophos's answer to an appliesTo, or the stored form of it. */
function checkAppliesTo(type, a) {
  const keys = Object.keys(a ?? {});
  const all = keys.flatMap((k) => a[k] ?? []);
  if (all.some((x) => typeof x !== "string")) return { status: 400, body: { error: "badRequest", message: "Error parsing the query params or request body" } };
  const user = keys.some((k) => USER_KEYS.includes(k));
  const device = keys.some((k) => DEVICE_KEYS.includes(k));
  if (user && device) return { status: 400, body: { error: "badRequest", message: "AppliesTo node should include only either endpoints, endpointGroups or users, userGroups but not a mix of them" } };
  if (user && type.startsWith("server-")) return { status: 400, body: { error: "badRequest", message: `Policy type ${type} can only be applied to endpoints` } };
  // Measured: endpointGroups without endpoints beside it is a 500 that changes nothing.
  if (keys.includes("endpointGroups") && !keys.includes("endpoints")) return { status: 500, body: { error: "InternalServerError", message: "Error processing data" } };
  return { stored: device ? { endpoints: a.endpoints ?? [], endpointGroups: a.endpointGroups ?? [] } : { users: a.users ?? [], userGroups: a.userGroups ?? [] } };
}

const idOf = (req) => req.path.split("/").pop();
fake.on(SRC, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
  const p = policies.src.find((x) => x.id === idOf(req));
  return p ? { body: p } : { status: 404, body: { error: "NotFound" } };
});
fake.on(SRC, "GET", "/endpoint/v1/policies", (req) => page(policies.src, req.query));
fake.on(DST, "GET", "/endpoint/v1/policies", (req) => page(policies.dst, req.query));
fake.on(DST, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
  const p = policies.dst.find((x) => x.id === idOf(req));
  return p ? { body: structuredClone(p) } : { status: 404, body: { error: "NotFound" } };
});
fake.on(DST, "POST", "/endpoint/v1/policies", (req) => {
  const fresh = req.body.type.startsWith("server-") ? { endpoints: [], endpointGroups: [] } : { users: [], userGroups: [] };
  const p = { id: fake.nextId("dpol"), ...req.body, appliesTo: fresh };
  policies.dst.push(p);
  return { status: 201, body: p };
});
fake.on(DST, "PATCH", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
  const p = policies.dst.find((x) => x.id === idOf(req));
  if (!p) return { status: 404, body: { error: "NotFound" } };
  if (req.body.appliesTo) {
    const checked = checkAppliesTo(p.type, req.body.appliesTo);
    if (!checked.stored) return checked;
    if (failNextPatch) {
      const answer = failNextPatch;
      failNextPatch = null;
      if (answer.makesIt) p.appliesTo = checked.stored;
      return answer.response;
    }
    p.appliesTo = checked.stored;
    // A write Sophos accepts but does not keep, for the read-back test.
    for (const id of dropOnPatch) for (const k of Object.keys(p.appliesTo)) p.appliesTo[k] = p.appliesTo[k].filter((x) => x !== id);
  }
  const { appliesTo: _a, ...rest } = req.body;
  Object.assign(p, rest);
  return { body: p };
});
for (const [tenant, side] of [[SRC, "src"], [DST, "dst"]]) {
  fake.on(tenant, "GET", "/common/v1/directory/users", (req) => page(directory[side].users ?? [], req.query));
  fake.on(tenant, "GET", "/common/v1/directory/user-groups", (req) => page(directory[side].userGroups ?? [], req.query));
  fake.on(tenant, "GET", "/endpoint/v1/endpoint-groups", (req) => page(directory[side].endpointGroups ?? [], req.query));
  fake.on(tenant, "GET", "/endpoint/v1/endpoints", (req) => {
    const ids = req.query.ids ? req.query.ids.split(",") : null;
    const items = (directory[side].endpoints ?? []).filter((e) => !ids || ids.includes(e.id));
    return { body: { items, pages: { size: items.length, maxSize: 500 } } };
  });
}

function seed() {
  failNextPatch = null;
  dropOnPatch = [];
  directory.src = {
    users: [
      { id: "su-alice", name: "Alice", email: "alice@example.com" },
      { id: "su-bob", name: "CORP\\bob" },
      { id: "su-carol", name: "Carol", email: "carol@example.com" },
    ],
    userGroups: [{ id: "sug-fin", name: "Finance" }, { id: "sug-hr", name: "HR" }],
    endpointGroups: [{ id: "seg-syd", name: "Sydney", type: "computer" }, { id: "seg-srv", name: "Sydney", type: "server" }],
    endpoints: [
      { id: "se-pc1", hostname: "PC-01", type: "computer" },
      { id: "se-pc2", hostname: "PC-02", type: "computer" },
      { id: "se-dc", hostname: "DC01", type: "server" },
    ],
  };
  directory.dst = {
    users: [{ id: "du-alice", name: "Alice Jones", email: "ALICE@example.com" }, { id: "du-bob", name: "corp\\bob" }],
    userGroups: [{ id: "dug-fin", name: "finance" }],
    endpointGroups: [{ id: "deg-syd", name: "Sydney", type: "computer" }, { id: "deg-srv", name: "Sydney", type: "server" }],
    endpoints: [
      { id: "de-pc1", hostname: "pc-01", type: "computer" },
      { id: "de-dc", hostname: "DC01", type: "server" },
    ],
  };
  policies.src = [
    { id: "sp-dev", name: "Laptops", type: "threat-protection", enabled: false, priority: 2, settings: {},
      appliesTo: { endpoints: ["se-pc1", "se-pc2"], endpointGroups: ["seg-syd"] } },
    { id: "sp-user", name: "Staff web", type: "web-control", enabled: false, priority: 1, settings: {},
      appliesTo: { users: ["su-alice", "su-bob", "su-carol"], userGroups: ["sug-fin", "sug-hr"] } },
    { id: "sp-srv", name: "Servers", type: "server-threat-protection", enabled: false, priority: 1, settings: {},
      appliesTo: { endpoints: ["se-dc"], endpointGroups: ["seg-srv"] } },
    { id: "sp-none", name: "Nobody", type: "web-control", enabled: false, priority: 3, settings: {},
      appliesTo: { users: [], userGroups: [] } },
  ];
  policies.dst = [];
}

const byStatus = (r) => Object.fromEntries(r.assignments.rows.map((x) => [`${x.kind} ${x.name}`, x.status]));
const patches = () => fake.writes().filter((w) => w.method === "PATCH");

test("clone: a device policy is created bare, then its groups and devices are added with the endpoints companion and read back", async () => {
  seed();
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-dev"] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.action, "create");
  const [post] = fake.writes().filter((w) => w.method === "POST");
  assert.equal("appliesTo" in post.body, false, "the create carries no assignments");
  const [patch] = patches();
  assert.equal(patch.path, `/endpoint/v1/policies/${r.destId}`);
  assert.deepEqual(patch.body, { appliesTo: { endpoints: ["de-pc1"], endpointGroups: ["deg-syd"] } });
  assert.equal(r.assignments.mode, "device");
  assert.deepEqual(byStatus(r), {
    "endpointGroup Sydney": "set",
    "endpoint PC-01": "set",
    "endpoint PC-02": "pending",
  });
  const pending = r.assignments.rows.find((x) => x.name === "PC-02");
  assert.match(pending.reason, /^no device named "PC-02" on the destination yet/);
  // Read back by ID after the write.
  const reads = fake.calls.filter((c) => c.method === "GET" && c.path === `/endpoint/v1/policies/${r.destId}`);
  assert.ok(reads.length >= 2, "read before and after the write");
  assert.deepEqual(policies.dst[0].appliesTo, { endpoints: ["de-pc1"], endpointGroups: ["deg-syd"] });
});

test("clone: a user policy gets users by email then name and user groups by name; the unmatched say why", async () => {
  seed();
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-user"] });
  assert.equal(r.ok, true, r.error);
  const [patch] = patches();
  assert.deepEqual(patch.body, { appliesTo: { users: ["du-alice", "du-bob"], userGroups: ["dug-fin"] } });
  assert.equal(r.assignments.mode, "user");
  assert.deepEqual(byStatus(r), {
    "user Alice (alice@example.com)": "set",
    "user CORP\\bob": "set",
    "user Carol (carol@example.com)": "not-matched",
    "userGroup Finance": "set",
    "userGroup HR": "not-matched",
  });
  const hr = r.assignments.rows.find((x) => x.name === "HR");
  assert.match(hr.reason, /^no user group named "HR" on the destination: mirror it on the Groups page, then clone again$/);
});

test("clone: a server policy takes the server group of that name and the one device of that hostname", async () => {
  seed();
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-srv"] });
  assert.equal(r.ok, true, r.error);
  const [patch] = patches();
  assert.deepEqual(patch.body, { appliesTo: { endpoints: ["de-dc"], endpointGroups: ["deg-srv"] } });
  assert.deepEqual(byStatus(r), { "endpointGroup Sydney": "set", "endpoint DC01": "set" });
});

test("dry run: says what would be assigned and what can't be, and writes nothing", async () => {
  seed();
  fake.reset();
  const res = await migratePolicies({ policyIds: ["sp-dev", "sp-user", "sp-none"], dryRun: true });
  assert.deepEqual(fake.writes(), []);
  assert.deepEqual(byStatus(res[0]), { "endpointGroup Sydney": "will-set", "endpoint PC-01": "will-set", "endpoint PC-02": "pending" });
  assert.equal(res[0].assignments.rows.find((x) => x.name === "PC-01").destId, "de-pc1");
  assert.deepEqual(byStatus(res[1]), {
    "user Alice (alice@example.com)": "will-set",
    "user CORP\\bob": "will-set",
    "user Carol (carol@example.com)": "not-matched",
    "userGroup Finance": "will-set",
    "userGroup HR": "not-matched",
  });
  assert.ok(res[1].assignments.rows.filter((x) => x.status === "not-matched").every((x) => x.reason));
  assert.equal(res[2].assignments, undefined, "a policy that applies to nothing has no assignment report");
});

test("a policy already on the destination is left as it is; its assignments are added to what it has, and again adds nothing", async () => {
  seed();
  policies.dst = [{ id: "dp-1", name: "Laptops", type: "threat-protection", enabled: true, priority: 4, settings: {},
    appliesTo: { endpoints: ["de-other"], endpointGroups: ["deg-syd"] } }];
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-dev"] });
  assert.equal(r.action, "skip-exists");
  const writes = fake.writes();
  assert.equal(writes.length, 1, "no settings write, one assignment write");
  assert.deepEqual(writes[0].body, { appliesTo: { endpoints: ["de-other", "de-pc1"], endpointGroups: ["deg-syd"] } }, "nothing removed");
  assert.deepEqual(byStatus(r), { "endpointGroup Sydney": "already-set", "endpoint PC-01": "set", "endpoint PC-02": "pending" });

  // PC-02 lands: the next clone adds it and nothing else.
  directory.dst.endpoints.push({ id: "de-pc2", hostname: "PC-02", type: "computer" });
  fake.reset();
  const [again] = await migratePolicies({ policyIds: ["sp-dev"] });
  assert.deepEqual(patches().map((w) => w.body), [{ appliesTo: { endpoints: ["de-other", "de-pc1", "de-pc2"], endpointGroups: ["deg-syd"] } }]);
  assert.deepEqual(byStatus(again), { "endpointGroup Sydney": "already-set", "endpoint PC-01": "already-set", "endpoint PC-02": "set" });

  fake.reset();
  const [third] = await migratePolicies({ policyIds: ["sp-dev"] });
  assert.deepEqual(fake.writes(), [], "everything is there already");
  assert.ok(third.assignments.rows.every((x) => x.status === "already-set"));
});

test("a destination policy that applies to users does not get devices: Sophos can't hold both", async () => {
  seed();
  policies.dst = [{ id: "dp-1", name: "Laptops", type: "threat-protection", enabled: true, priority: 4, settings: {},
    appliesTo: { users: ["du-bob"], userGroups: [] } }];
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-dev"] });
  assert.deepEqual(fake.writes(), []);
  const row = r.assignments.rows.find((x) => x.name === "PC-01");
  assert.equal(row.status, "not-matched");
  assert.match(row.reason, /^the destination policy applies to users, and Sophos can't assign users and devices on one policy$/);
  assert.equal(r.assignments.rows.find((x) => x.name === "PC-02").status, "pending", "a pending device stays pending");
});

test("overwrite: the settings are written, then the assignments", async () => {
  seed();
  policies.dst = [{ id: "dp-1", name: "Staff web", type: "web-control", enabled: true, priority: 4, settings: {}, appliesTo: { users: [], userGroups: [] } }];
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-user"], overwrite: true });
  assert.equal(r.action, "overwrite");
  const writes = patches();
  assert.equal(writes.length, 2);
  assert.equal("appliesTo" in writes[0].body, false);
  assert.deepEqual(writes[1].body, { appliesTo: { users: ["du-alice", "du-bob"], userGroups: ["dug-fin"] } });
});

test("a write Sophos accepts that the read-back does not show is failed, with the reason", async () => {
  seed();
  dropOnPatch = ["de-pc1"];
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-dev"] });
  assert.equal(r.ok, true, "the policy itself was created");
  const pc1 = r.assignments.rows.find((x) => x.name === "PC-01");
  assert.equal(pc1.status, "failed");
  assert.match(pc1.reason, /^Sophos accepted the assignments, but a read-back of the destination policy "Laptops" by ID did not show this one$/);
  assert.equal(r.assignments.rows.find((x) => x.name === "Sydney").status, "set");
  const entry = (await readAudit(root)).filter((e) => e.resource === "policy-assignments").at(-1);
  assert.equal(entry.ok, false);
  assert.equal(entry.resourceId, r.destId);
  assert.deepEqual(entry.detail.failed.map((f) => f.name), ["PC-01"]);
});

test("a write answered 500 that the read-back finds is set, with a note; one it doesn't find is failed and sent once", async () => {
  seed();
  failNextPatch = { makesIt: true, response: { status: 500, body: { error: "InternalServerError" } } };
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-srv"] });
  assert.deepEqual(byStatus(r), { "endpointGroup Sydney": "set", "endpoint DC01": "set" });
  assert.match(r.assignments.notes[0], /^Sophos answered 500, but a read-back found the assignments on the destination policy "Servers"/);
  assert.equal(patches().length, 1);

  seed();
  failNextPatch = { makesIt: false, response: { status: 500, body: { error: "InternalServerError" } } };
  fake.reset();
  const [miss] = await migratePolicies({ policyIds: ["sp-srv"] });
  assert.ok(miss.assignments.rows.every((x) => x.status === "failed"));
  assert.match(miss.assignments.rows[0].reason, /The tool read the destination policy "Servers" three times and found none of the assignments/);
  assert.equal(patches().length, 1, "never sent twice");
});

test("a refusal fails the assignments, not the policy, and is audited", async () => {
  seed();
  failNextPatch = { makesIt: false, response: { status: 400, body: { error: "badRequest", message: "nope" } } };
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-user"] });
  assert.equal(r.ok, true);
  assert.equal(r.action, "create");
  const set = r.assignments.rows.filter((x) => x.status === "failed");
  assert.equal(set.length, 3);
  assert.match(set[0].reason, /^Sophos refused the assignments: Sophos API error 400: badRequest - nope/);
  const entry = (await readAudit(root)).filter((e) => e.resource === "policy-assignments").at(-1);
  assert.equal(entry.ok, false);
  assert.equal(entry.action, "update");
});

test("assignments are not tried for a policy that was not written", async () => {
  seed();
  fake.on(DST, "POST", "/endpoint/v1/policies", () => ({ status: 400, body: { error: "badRequest", message: "no" } }));
  try {
    fake.reset();
    const [r] = await migratePolicies({ policyIds: ["sp-dev"] });
    assert.equal(r.ok, false);
    assert.equal(r.assignments, undefined);
    assert.deepEqual(patches(), []);
  } finally {
    fake.on(DST, "POST", "/endpoint/v1/policies", (req) => {
      const fresh = req.body.type.startsWith("server-") ? { endpoints: [], endpointGroups: [] } : { users: [], userGroups: [] };
      const p = { id: fake.nextId("dpol"), ...req.body, appliesTo: fresh };
      policies.dst.push(p);
      return { status: 201, body: p };
    });
  }
});

test("the user and group lists are read past the first page", async () => {
  seed();
  directory.dst.users = [
    ...Array.from({ length: 150 }, (_, i) => ({ id: `filler-${i}`, name: `Filler ${i}` })),
    { id: "du-alice", name: "Alice Jones", email: "alice@example.com" },
  ];
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-user"], dryRun: true });
  assert.equal(r.assignments.rows.find((x) => x.kind === "user" && x.sourceId === "su-alice").destId, "du-alice");
  const userPages = fake.calls.filter((c) => c.tenant === "dst" && c.path === "/common/v1/directory/users");
  assert.equal(userPages[0].query.pageTotal, "true");
  assert.equal(userPages.length, 2);
});
