// Only reads are retried. Sophos can answer 500 to a write and still make the change (seen live on
// 26/09/2026), so a write is sent once, and a create or an addition that gets no clear answer is read
// back: made, with a note, or failed with a warning that it may still have gone through.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { SophosClient, UnclearWriteError } = await import("../backend/dist/sophos/client/sophos-client.js");
const { TokenManager } = await import("../backend/dist/sophos/auth/token-manager.js");
const { TenantResolver } = await import("../backend/dist/sophos/client/tenant-resolver.js");
const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
const { mirrorGroups, mirrorUserGroups } = await import("../backend/dist/services/group-mirror.js");
const { copyExclusions } = await import("../backend/dist/services/exclusion-copier.js");
const { copyWebFilters } = await import("../backend/dist/services/web-filter-copier.js");
const { migratePolicies, setRecentCloneWindow } = await import("../backend/dist/services/policy-migrator.js");
const { startMigration } = await import("../backend/dist/services/device-migrator.js");
const { getJob } = await import("../backend/dist/services/migration-store.js");
const { publicJob } = await import("../backend/dist/services/job-view.js");

// No waiting in tests: the read retry backoff and the read-back waits.
SophosClient.prototype.sleep = async () => {};
setReadBackDelays([0, 0, 0]);
// Each test starts with no recent clones: several clone a policy of the same name.
beforeEach(() => {
  setRecentCloneWindow(0);
  setRecentCloneWindow(60_000);
});

const ADVICE = /The change may still have gone through: check the destination before trying again\.$/;
// After a read-back that looked and found nothing: where it looked, what it found, the caveat, and advice that fits.
const CAVEAT = "Sophos can take a while to show a change, so this does not prove it failed.";
const RETRY = "Wait a minute or two, then try again: anything on the destination by then is skipped as already there.";
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const missed = (where, found, advice = RETRY) => new RegExp(`\\. The tool read ${esc(where)} three times and found ${esc(found)}\\. ${esc(CAVEAT)} ${esc(advice)}$`);
const tokens = new TokenManager(DST.clientId, DST.secret);
const resolver = new TenantResolver(tokens);
await resolver.init();
const client = new SophosClient(tokens, resolver);
const calls = (path) => fake.calls.filter((c) => c.kind === "tenant" && c.path === path);

// ---- the client ----

test("a GET answered 500 is tried again, and the answer that works is used", async () => {
  let n = 0;
  fake.on(DST, "GET", "/t/flaky", () => (++n === 1 ? { status: 500, body: { error: "InternalError" } } : { body: { ok: true } }));
  fake.reset();
  assert.deepEqual(await client.tenantRequest(DST.tenantId, "/t/flaky"), { ok: true });
  assert.equal(calls("/t/flaky").length, 2);
});

test("a GET that keeps failing is tried three times, then throws the last error", async () => {
  fake.on(DST, "GET", "/t/down", () => ({ status: 503, body: { error: "Unavailable" } }));
  fake.reset();
  await assert.rejects(() => client.tenantRequest(DST.tenantId, "/t/down"), /Sophos API error 503: Unavailable/);
  assert.equal(calls("/t/down").length, 3);
});

test("a GET answered 404 without a JSON body is not tried again", async () => {
  fake.on(DST, "GET", "/t/gone", () => new Response("not here", { status: 404 }));
  fake.reset();
  await assert.rejects(() => client.tenantRequest(DST.tenantId, "/t/gone"), /Sophos API error \(404\): not here/);
  assert.equal(calls("/t/gone").length, 1);
});

for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
  test(`a ${method} answered 500 is sent once and says the change may have gone through`, async () => {
    fake.on(DST, method, "/t/write", () => ({ status: 500, body: { error: "InternalError", message: "Error processing data", correlationId: "c-1" } }));
    fake.reset();
    const err = await client.tenantRequest(DST.tenantId, "/t/write", { method, body: { a: 1 } }).catch((e) => e);
    assert.ok(err instanceof UnclearWriteError, err.message);
    assert.equal(err.status, 500);
    assert.equal(err.method, method);
    assert.match(err.message, /^Sophos API error 500: InternalError - Error processing data \(correlationId: c-1\)\. /);
    assert.match(err.message, ADVICE);
    assert.equal(calls("/t/write").length, 1);
  });
}

test("a write whose connection drops is sent once and is unclear", async () => {
  fake.on(DST, "POST", "/t/reset", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); });
  fake.reset();
  const err = await client.tenantRequest(DST.tenantId, "/t/reset", { method: "POST", body: {} }).catch((e) => e);
  assert.ok(err instanceof UnclearWriteError);
  assert.match(err.message, /fetch failed \(ECONNRESET\)\. The change may still have gone through/);
  assert.equal(calls("/t/reset").length, 1);
});

test("a write whose connection never opened is a plain failure: nothing reached Sophos", async () => {
  fake.on(DST, "POST", "/t/refused", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); });
  fake.reset();
  const err = await client.tenantRequest(DST.tenantId, "/t/refused", { method: "POST", body: {} }).catch((e) => e);
  assert.ok(!(err instanceof UnclearWriteError));
  assert.match(err.message, /fetch failed \(ECONNREFUSED\)$/);
  assert.equal(calls("/t/refused").length, 1);
});

test("a write whose connection times out before it opens is a plain failure", async () => {
  fake.on(DST, "POST", "/t/connect-timeout", () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }); });
  fake.reset();
  const err = await client.tenantRequest(DST.tenantId, "/t/connect-timeout", { method: "POST", body: {} }).catch((e) => e);
  assert.ok(!(err instanceof UnclearWriteError));
  assert.equal(calls("/t/connect-timeout").length, 1);
});

test("a write Sophos refuses with 400 is sent once and is a clear failure", async () => {
  fake.on(DST, "POST", "/t/bad", () => ({ status: 400, body: { error: "BadRequest", message: "nope" } }));
  fake.reset();
  const err = await client.tenantRequest(DST.tenantId, "/t/bad", { method: "POST", body: {} }).catch((e) => e);
  assert.ok(!(err instanceof UnclearWriteError));
  assert.equal(err.message, "Sophos API error 400: BadRequest - nope");
  assert.equal(calls("/t/bad").length, 1);
});

test("a write turned away with 429 waits and is sent again, because Sophos did not act on it", async () => {
  let n = 0;
  fake.on(DST, "POST", "/t/busy", () => (++n === 1
    ? new Response(JSON.stringify({ error: "TooManyRequests" }), { status: 429, headers: { "Retry-After": "0" } })
    : { status: 201, body: { id: "x-1" } }));
  fake.reset();
  assert.deepEqual(await client.tenantRequest(DST.tenantId, "/t/busy", { method: "POST", body: {} }), { id: "x-1" });
  assert.equal(calls("/t/busy").length, 2);
});

test("a request still turned away with 429 after three tries fails with the rate limit", async () => {
  fake.on(DST, "POST", "/t/busy2", () => new Response("{}", { status: 429, headers: { "Retry-After": "0" } }));
  fake.reset();
  await assert.rejects(() => client.tenantRequest(DST.tenantId, "/t/busy2", { method: "POST", body: {} }), /^Error: Sophos API error 429: rate limited after 3 attempts: \{\}$/);
  assert.equal(calls("/t/busy2").length, 3);
});

test("a write answered 200 with an empty body is done, sent once", async () => {
  fake.on(DST, "DELETE", "/t/empty", () => new Response("", { status: 200 }));
  fake.reset();
  assert.deepEqual(await client.tenantRequest(DST.tenantId, "/t/empty", { method: "DELETE" }), {});
  assert.equal(calls("/t/empty").length, 1);
});

// ---- the copies read back after an unclear answer ----

const lastAudit = async (n = 1) => (await readAudit(root)).slice(-n);

// Endpoint and user groups: the source group, the destination's list, and a create answered 500.
const groups = { dst: [], dstUser: [] };
let groupCreateMakesIt = true;
fake.on(SRC, "GET", /^\/endpoint\/v1\/endpoint-groups\/[^/]+$/, (req) => ({ body: { id: req.path.split("/").pop(), name: "Finance", description: "", type: "computer" } }));
fake.on(DST, "GET", "/endpoint/v1/endpoint-groups", (req) => page(groups.dst, req.query));
fake.on(DST, "POST", "/endpoint/v1/endpoint-groups", (req) => {
  if (groupCreateMakesIt) groups.dst.push({ id: "dg-new", ...req.body });
  return { status: 500, body: { error: "InternalError", message: "Error processing data" } };
});
fake.on(SRC, "GET", "/common/v1/directory/user-groups", (req) => page([{ id: "su-1", name: "Admins" }], req.query));
fake.on(DST, "GET", "/common/v1/directory/user-groups", (req) => page(groups.dstUser, req.query));
fake.on(DST, "POST", "/common/v1/directory/user-groups", (req) => {
  groups.dstUser.push({ id: "du-new", ...req.body });
  return { status: 502, body: { error: "BadGateway" } };
});

test("group mirror: a create answered 500 that a read-back finds is created, with a note, sent once", async () => {
  groups.dst = [];
  groupCreateMakesIt = true;
  fake.reset();
  const [r] = await mirrorGroups({ groupIds: ["sg-1"] });
  assert.equal(r.ok, true);
  assert.equal(r.action, "create");
  assert.equal(r.destId, "dg-new");
  assert.deepEqual(r.notes, ["Sophos answered 500, but a read-back found the group on the destination, so the change was made"]);
  assert.equal(fake.writes().length, 1);
  const [entry] = await lastAudit();
  assert.equal(entry.ok, true);
  assert.equal(entry.resourceId, "dg-new");
  assert.match(entry.detail.note, /read-back found the group/);
});

test("group mirror: a create answered 500 that a read-back does not find fails, sent once, with the warning", async () => {
  groups.dst = [];
  groupCreateMakesIt = false;
  fake.reset();
  const [r] = await mirrorGroups({ groupIds: ["sg-1"] });
  assert.equal(r.ok, false);
  assert.match(r.error, /^Sophos API error 500: InternalError - Error processing data\. The tool read /);
  assert.match(r.error, missed("the destination's endpoint groups", 'no group named "Finance"'));
  assert.doesNotMatch(r.error, /check the destination/, "the tool already read the destination");
  assert.equal(fake.writes().length, 1);
  assert.equal(calls("/endpoint/v1/endpoint-groups").filter((c) => c.method === "GET").length, 4, "the list before, and three read-backs");
  const [entry] = await lastAudit();
  assert.equal(entry.ok, false);
  assert.match(entry.error, missed("the destination's endpoint groups", 'no group named "Finance"'));
});

test("group mirror: after an unclear create no read-back found, a second group of that name is not sent", async () => {
  groups.dst = [];
  groupCreateMakesIt = false;
  fake.reset();
  // Both source IDs read back as "Finance".
  const res = await mirrorGroups({ groupIds: ["sg-1", "sg-2"] });
  assert.equal(res[0].ok, false);
  assert.match(res[0].error, /The tool read the destination's endpoint groups three times and found no group named "Finance"/);
  assert.equal(res[1].ok, false);
  assert.match(res[1].error, /^not sent: an earlier create in this run with the same name got no clear answer from Sophos/);
  assert.match(res[1].error, /Wait a minute or two, then try again: anything on the destination by then is skipped as already there$/);
  assert.doesNotMatch(res[1].error, /check the destination/);
  assert.equal(fake.writes().length, 1, "the second is never sent");
});

test("a read-back that can't read the destination says so, not that the item is missing", async () => {
  groups.dst = [];
  groupCreateMakesIt = false;
  let lists = 0;
  fake.on(DST, "GET", "/endpoint/v1/endpoint-groups", (req) => (++lists === 1 ? page(groups.dst, req.query) : { status: 403, body: { error: "Forbidden", message: "no read" } }));
  try {
    fake.reset();
    const [r] = await mirrorGroups({ groupIds: ["sg-1"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /A read-back could not read the destination's endpoint groups \(Sophos API error 403: Forbidden - no read\)\. The change may still have gone through: check the destination before trying again\.$/);
    assert.doesNotMatch(r.error, /found no group/, "nothing was read, so nothing is said to be missing");
  } finally {
    fake.on(DST, "GET", "/endpoint/v1/endpoint-groups", (req) => page(groups.dst, req.query));
  }
});

test("user group mirror: a create answered 502 that a read-back finds is created", async () => {
  groups.dstUser = [];
  fake.reset();
  const [r] = await mirrorUserGroups({ userGroupIds: ["su-1"] });
  assert.equal(r.ok, true);
  assert.equal(r.destId, "du-new");
  assert.match(r.notes[0], /^Sophos answered 502, but a read-back found the user group/);
  assert.equal(fake.writes().length, 1);
});

test("user group mirror: a create answered 502 that a read-back does not find names the user groups it read", async () => {
  groups.dstUser = [];
  fake.on(DST, "POST", "/common/v1/directory/user-groups", () => ({ status: 502, body: { error: "BadGateway" } }));
  try {
    fake.reset();
    const [r] = await mirrorUserGroups({ userGroupIds: ["su-1"] });
    assert.equal(r.ok, false);
    assert.match(r.error, missed("the destination's user groups", 'no user group named "Admins"'));
  } finally {
    fake.on(DST, "POST", "/common/v1/directory/user-groups", (req) => {
      groups.dstUser.push({ id: "du-new", ...req.body });
      return { status: 502, body: { error: "BadGateway" } };
    });
  }
});

test("the not-found message gives the real read-back span: three reads over about 10 seconds", async () => {
  const { notFound } = await import("../backend/dist/services/write-check.js");
  setReadBackDelays([1000, 3000, 6000]);
  try {
    const err = notFound(new UnclearWriteError("Sophos API error 500: InternalError", "POST", 500), { where: "the destination's site lists", found: 'no site list named "Blocked"' });
    assert.equal(err.message, "Sophos API error 500: InternalError. The tool read the destination's site lists three times over about 10 seconds and found no site list named \"Blocked\". Sophos can take a while to show a change, so this does not prove it failed. Wait a minute or two, then try again: anything on the destination by then is skipped as already there.");
    assert.ok(err instanceof UnclearWriteError, "still unclear, so the copy keeps treating it as possibly made");
  } finally {
    setReadBackDelays([0, 0, 0]);
  }
});

// Exclusions: a scanning exclusion, and the TLS decryption list edited with PATCH { add }.
const excl = { dst: [], tls: [] };
fake.on(SRC, "GET", "/endpoint/v1/settings/exclusions/scanning", (req) => page([{ id: "se-1", type: "path", value: "C:\\Tools\\", scanMode: "onDemandAndOnAccess" }], req.query));
fake.on(DST, "GET", "/endpoint/v1/settings/exclusions/scanning", (req) => page(excl.dst, req.query));
fake.on(DST, "POST", "/endpoint/v1/settings/exclusions/scanning", (req) => {
  excl.dst.push({ id: "de-new", ...req.body });
  return { status: 500, body: { error: "InternalError" } };
});
const TLS = "/endpoint/v1/settings/web-control/tls-decryption/excluded-websites";
fake.on(SRC, "GET", TLS, (req) => page([{ value: "a.example" }, { value: "b.example" }], req.query));
fake.on(DST, "GET", TLS, (req) => page(excl.tls, req.query));
fake.on(DST, "PATCH", TLS, (req) => {
  excl.tls.push(req.body.add[0]);
  return { status: 504, body: { error: "GatewayTimeout" } };
});

test("exclusion copy: a create answered 500 that a read-back finds is created, sent once", async () => {
  excl.dst = [];
  fake.reset();
  const [r] = await copyExclusions({ selections: { scanning: ["se-1"] } });
  assert.equal(r.ok, true);
  assert.equal(r.destId, "de-new");
  assert.match(r.notes[0], /^Sophos answered 500, but a read-back found it on the destination/);
  assert.equal(fake.writes().length, 1);
});

test("exclusion copy: a create answered 500 that a read-back does not find names the list it read", async () => {
  excl.dst = [];
  fake.on(DST, "POST", "/endpoint/v1/settings/exclusions/scanning", () => ({ status: 500, body: { error: "InternalError" } }));
  try {
    fake.reset();
    const [r] = await copyExclusions({ selections: { scanning: ["se-1"] } });
    assert.equal(r.ok, false);
    assert.match(r.error, missed("the destination's scanning exclusions", "no matching item"));
    assert.equal(fake.writes().length, 1);
  } finally {
    fake.on(DST, "POST", "/endpoint/v1/settings/exclusions/scanning", (req) => {
      excl.dst.push({ id: "de-new", ...req.body });
      return { status: 500, body: { error: "InternalError" } };
    });
  }
});

test("TLS exclusions: an addition answered unclearly counts the websites a read-back finds, and warns for the rest", async () => {
  excl.tls = [];
  fake.reset();
  const res = await copyExclusions({ selections: { "tls-excluded-websites": ["a.example", "b.example"] } });
  const by = (v) => res.find((r) => r.sourceId === v);
  assert.equal(by("a.example").ok, true);
  assert.match(by("a.example").notes[0], /read-back found the website/);
  assert.equal(by("b.example").ok, false);
  assert.match(by("b.example").error, missed("the destination's websites excluded from TLS decryption", "1 of the 2 websites it sent, but not this one"));
  assert.equal(fake.writes().length, 1);
  const [entry] = await lastAudit();
  assert.equal(entry.ok, false, "one website is unaccounted for");
});

// Web filtering: a site list created by a 500, then a profile that points at it.
const wf = { lists: [], profiles: [] };
fake.on(SRC, "GET", "/web-filters/v1/site-lists", (req) => page([{ id: "sl-1", name: "Blocked" }], req.query));
fake.on(SRC, "GET", "/web-filters/v1/site-lists/sl-1/sites", (req) => page([{ site: "bad.example" }], req.query));
fake.on(SRC, "GET", "/web-filters/v1/profiles", (req) => page([{ id: "sp-1", name: "Staff" }], req.query));
fake.on(SRC, "GET", "/web-filters/v1/profiles/sp-1", () => ({ body: { id: "sp-1", name: "Staff", filterBySiteList: true, siteListActions: [{ id: "sl-1", action: "block", priority: 1 }] } }));
fake.on(DST, "GET", "/web-filters/v1/site-lists", (req) => page(wf.lists, req.query));
fake.on(DST, "GET", "/web-filters/v1/profiles", (req) => page(wf.profiles, req.query));
fake.on(DST, "POST", "/web-filters/v1/site-lists", (req) => {
  wf.lists.push({ id: "dl-new", ...req.body });
  return { status: 500, body: { error: "InternalError" } };
});
fake.on(DST, "POST", "/web-filters/v1/profiles", (req) => ({ status: 201, body: { id: "dp-new", ...req.body } }));

test("web filtering: a site list a read-back finds after a 500 is created, and the profile maps to it", async () => {
  wf.lists = [];
  fake.reset();
  const res = await copyWebFilters({ siteListIds: ["sl-1"], profileIds: ["sp-1"] });
  const list = res.find((r) => r.kind === "site-list");
  assert.equal(list.ok, true);
  assert.equal(list.destId, "dl-new");
  assert.match(list.notes[0], /read-back found the site list/);
  const profilePost = fake.writes().find((w) => w.path === "/web-filters/v1/profiles");
  assert.deepEqual(profilePost.body.siteListActions, [{ id: "dl-new", action: "block", priority: 1 }]);
  assert.equal(fake.writes().filter((w) => w.path === "/web-filters/v1/site-lists").length, 1);
});

test("web filtering: a site list and a profile that no read-back finds name the lists they read", async () => {
  wf.lists = [];
  wf.profiles = [];
  fake.on(DST, "POST", "/web-filters/v1/site-lists", () => ({ status: 500, body: { error: "InternalError" } }));
  fake.on(DST, "POST", "/web-filters/v1/profiles", () => ({ status: 503, body: { error: "Unavailable" } }));
  try {
    fake.reset();
    const res = await copyWebFilters({ siteListIds: ["sl-1"], profileIds: [] });
    assert.match(res.find((r) => r.kind === "site-list").error, missed("the destination's site lists", 'no site list named "Blocked"'));
    // A profile whose site list is on the destination already, so only the profile's create is unclear.
    wf.lists = [{ id: "dl-1", name: "Blocked" }];
    fake.reset();
    const res2 = await copyWebFilters({ siteListIds: [], profileIds: ["sp-1"] });
    assert.match(res2.find((r) => r.kind === "profile").error, missed("the destination's web filtering profiles", 'no profile named "Staff"'));
  } finally {
    fake.on(DST, "POST", "/web-filters/v1/site-lists", (req) => {
      wf.lists.push({ id: "dl-new", ...req.body });
      return { status: 500, body: { error: "InternalError" } };
    });
    fake.on(DST, "POST", "/web-filters/v1/profiles", (req) => ({ status: 201, body: { id: "dp-new", ...req.body } }));
  }
});

// Policies: a clone answered 500, and an overwrite answered 500.
const pol = { src: [], dst: [] };
let policyCreateMakesIt = true;
fake.on(SRC, "GET", "/endpoint/v1/policies", (req) => page(pol.src, req.query));
fake.on(SRC, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => ({ body: pol.src.find((p) => p.id === req.path.split("/").pop()) }));
fake.on(DST, "GET", "/endpoint/v1/policies", (req) => page(pol.dst, req.query));
fake.on(DST, "POST", "/endpoint/v1/policies", (req) => {
  if (policyCreateMakesIt) pol.dst.push({ id: "dpol-new", ...req.body });
  // Names a setting, as a refusal would: the tool must not drop it and send the policy again.
  return { status: 500, body: { error: "InternalError", message: "Must provide an allowed value for setting (x.y)." } };
});
fake.on(DST, "PATCH", /^\/endpoint\/v1\/policies\/[^/]+$/, () => ({ status: 500, body: { error: "InternalError" } }));
const policy = (id, name) => ({ id, name, type: "threat-protection", enabled: true, enforced: false, priority: 2, settings: { "x.y": { value: 1 } } });

test("policy clone: a create answered 500 that a read-back finds is created, sent once", async () => {
  pol.src = [policy("sp-1", "Laptops")];
  pol.dst = [policy("dold", "laptops old")];
  policyCreateMakesIt = true;
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-1"] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.action, "create");
  assert.equal(r.destId, "dpol-new");
  assert.match(r.notes[0], /^Sophos answered 500, but a read-back found the policy/);
  assert.equal(r.adjustments, undefined, "nothing was dropped");
  assert.equal(fake.writes().length, 1);
});

test("policy clone: a 500 naming a setting is not sent again without it, and says the change may have gone through", async () => {
  pol.src = [policy("sp-1", "Laptops")];
  pol.dst = [];
  policyCreateMakesIt = false;
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-1"] });
  assert.equal(r.ok, false);
  assert.match(r.error, missed("the destination's policies", 'no new threat-protection policy named "Laptops"'));
  assert.equal(fake.writes().length, 1);
});

test("policy clone: the same policy twice, the second answered 500, is not taken for the first clone", async () => {
  pol.src = [policy("sp-1", "Laptops")];
  pol.dst = [];
  let n = 0;
  fake.on(DST, "POST", "/endpoint/v1/policies", (req) => {
    if (++n === 1) {
      pol.dst.push({ id: "dpol-first", ...req.body });
      return { status: 201, body: { id: "dpol-first", ...req.body } };
    }
    return { status: 500, body: { error: "InternalError" } };
  });
  try {
    fake.reset();
    const res = await migratePolicies({ policyIds: ["sp-1", "sp-1"] });
    assert.equal(res[0].ok, true);
    assert.equal(res[0].destId, "dpol-first");
    assert.equal(res[1].ok, false, "before the fix the read-back found the first clone and called this one created");
    assert.match(res[1].error, /found no new threat-protection policy named "Laptops"/);

    // A run straight after sends nothing: the unclear clone may yet show in the list (about 22 s, measured 13/10/2026).
    fake.reset();
    n = 1;
    pol.dst = [];
    const soon = await migratePolicies({ policyIds: ["sp-1"] });
    assert.equal(soon[0].ok, false);
    assert.match(soon[0].error, /^not sent: this tool cloned this policy \d+ s ago and could not confirm that copy/);
    assert.equal(fake.writes().length, 0, "before 0.4.2 this sent a second create");

    // Once that minute has passed, a third of the same name after an unclear one in the same run is not sent.
    setRecentCloneWindow(0);
    setRecentCloneWindow(60_000);
    fake.reset();
    const again = await migratePolicies({ policyIds: ["sp-1", "sp-1"] });
    assert.equal(again[0].ok, false);
    assert.match(again[1].error, /^not sent: an earlier create in this run with the same name/);
    assert.equal(fake.writes().length, 1);
  } finally {
    setRecentCloneWindow(0);
    setRecentCloneWindow(60_000);
    fake.on(DST, "POST", "/endpoint/v1/policies", (req) => {
      if (policyCreateMakesIt) pol.dst.push({ id: "dpol-new", ...req.body });
      return { status: 500, body: { error: "InternalError", message: "Must provide an allowed value for setting (x.y)." } };
    });
  }
});

test("policy overwrite: a PATCH answered 500 is sent once and says the change may have gone through", async () => {
  pol.src = [policy("sp-1", "Laptops")];
  pol.dst = [policy("dp-1", "Laptops")];
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-1"], overwrite: true });
  assert.equal(r.ok, false);
  assert.equal(r.action, "overwrite");
  assert.match(r.error, ADVICE);
  assert.equal(fake.writes().length, 1);
});

// Device moves: the sender trigger answered 500.
const DEVICE = "00000000-0000-4000-8000-000000000009";
const recent = new Date(Date.now() - 60e3).toISOString();
fake.on(SRC, "GET", `/endpoint/v1/endpoints/${DEVICE}`, () => ({ body: { id: DEVICE, hostname: "WIN10", type: "computer", lastSeenAt: recent } }));
for (const t of [SRC, DST]) fake.on(t, "GET", "/endpoint/v1/settings/migration", () => ({ body: { enabled: true, expiresAt: "2099-01-01T00:00:00Z" } }));
let receiverAnswer = () => ({ status: 201, body: { id: "job-9", token: "handshake-9", mode: "receiving" } });
let senderKnowsJob = false;
fake.on(DST, "POST", "/endpoint/v1/migrations", () => receiverAnswer());
fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-9", () => ({ status: 500, body: { error: "InternalError" } }));
fake.on(SRC, "GET", "/endpoint/v1/migrations/job-9", () => (senderKnowsJob
  ? { body: { id: "job-9", mode: "sending" } }
  : { status: 404, body: { error: "NotFound", message: "no such job" } }));
const migrationWrites = () => fake.writes().filter((w) => w.path.startsWith("/endpoint/v1/migrations")).map((w) => `${w.tenant} ${w.method}`);

test("device move: a trigger answered 500 that the sending tenant shows started is saved as a job", async () => {
  senderKnowsJob = true;
  fake.reset();
  const res = await startMigration({ jobName: "unclear trigger", endpointIds: [DEVICE] });
  assert.ok(res.job);
  const saved = await getJob(res.job.localJobId);
  assert.equal(saved.sourceMigrationId, "job-9");
  assert.equal(saved.destMigrationId, "job-9");
  assert.deepEqual(migrationWrites(), ["dst POST", "src PUT"], "sent once, and the receiving job is not deleted");
  const note = "Sophos answered 500, but a read-back found the move on the sending tenant Test Source, so the change was made";
  const [entry] = await lastAudit();
  assert.equal(entry.resource, "migration-sender");
  assert.equal(entry.ok, true);
  assert.equal(entry.detail.note, note);
  // Where the user acted: the start answers with the job, and the job page shows its start notes.
  assert.deepEqual(saved.startNotes, [note]);
  assert.deepEqual(publicJob(saved).startNotes, [note]);
});

test("device move: a trigger with a clear answer leaves no start note", async () => {
  fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-9", () => ({ body: { id: "job-9", mode: "sending" } }));
  try {
    fake.reset();
    const res = await startMigration({ jobName: "clear trigger", endpointIds: [DEVICE] });
    assert.equal((await getJob(res.job.localJobId)).startNotes, undefined);
  } finally {
    fake.on(SRC, "PUT", "/endpoint/v1/migrations/job-9", () => ({ status: 500, body: { error: "InternalError" } }));
  }
});

test("the job page shows a job's start notes as an alert", async () => {
  const js = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  const src = js.slice(js.indexOf("function renderAlerts"), js.indexOf("function alert("));
  const shown = [];
  const renderAlerts = new Function("checkable", "alert", "setHtml", "esc", "WAIT_NOTE_MS", `${src}; return renderAlerts;`)(
    () => true,
    (tone, ico, title, body) => `${tone}|${title}|${body}`,
    (_id, html) => shown.push(html),
    (t) => String(t),
    7200e3,
  );
  const note = "Sophos answered 500, but a read-back found the move on the sending tenant Test Source, so the change was made";
  renderAlerts({ monitor: { state: "ok" }, credentials: { stored: true }, startNotes: [note], progress: { finished: false, expired: 0, devices: [] } });
  assert.equal(shown.at(-1), `info|Sophos gave no clear answer when this move started|${note}.`);
  renderAlerts({ monitor: { state: "ok" }, credentials: { stored: true }, progress: { finished: false, expired: 0, devices: [] } });
  assert.equal(shown.at(-1), "", "no alert without a note");
});

const TRIGGER_ADVICE = "Nothing was saved in this tool. The receiving job on Test Destination was left in place in case the move started, and expires by itself 14 days after it was created. In a few minutes, open the Migrations page, which lists the jobs on both tenants: if job job-9 shows as sending, the move started; if not, start the move again.";

test("device move: a trigger answered 500 that no read-back finds fails, leaves the receiving job, and says where it looked", async () => {
  senderKnowsJob = false;
  fake.reset();
  const err = await startMigration({ jobName: "unclear trigger 2", endpointIds: [DEVICE] }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.match(err.message, /^Sophos API error 500: InternalError\. The tool read /);
  assert.match(err.message, missed("migration job job-9 on the sending tenant Test Source", "no such job there", TRIGGER_ADVICE));
  assert.doesNotMatch(err.message, /check the destination/, "the tool already read the sending tenant");
  assert.deepEqual(migrationWrites(), ["dst POST", "src PUT"], "no DELETE of a receiving job that may be in use");
  const [entry] = await lastAudit();
  assert.equal(entry.resource, "migration-sender");
  assert.equal(entry.ok, false);
  assert.match(entry.error, /found no such job there/);
});

test("device move: a trigger read-back that can't read the sending tenant says so, and where to check", async () => {
  fake.on(SRC, "GET", "/endpoint/v1/migrations/job-9", () => ({ status: 403, body: { error: "Forbidden", message: "no read" } }));
  try {
    fake.reset();
    const err = await startMigration({ jobName: "unclear trigger unread", endpointIds: [DEVICE] }).catch((e) => e);
    assert.match(err.message, /A read-back could not read migration job job-9 on the sending tenant Test Source \(Sophos API error 403: Forbidden - no read\)\. The change may still have gone through: check the Migrations page before trying again\. The Migrations page lists the jobs on both tenants, including ones this tool did not save\.$/);
    assert.doesNotMatch(err.message, /found no such job/);
    assert.deepEqual(migrationWrites(), ["dst POST", "src PUT"]);
  } finally {
    fake.on(SRC, "GET", "/endpoint/v1/migrations/job-9", () => (senderKnowsJob
      ? { body: { id: "job-9", mode: "sending" } }
      : { status: 404, body: { error: "NotFound", message: "no such job" } }));
  }
});

test("device move: a job the sending tenant shows without saying it is sending does not count as started", async () => {
  fake.on(SRC, "GET", "/endpoint/v1/migrations/job-9", () => ({ body: { id: "job-9" } }));
  try {
    fake.reset();
    await assert.rejects(
      () => startMigration({ jobName: "unclear trigger 3", endpointIds: [DEVICE] }),
      /found the job there, but not marked as sending \(mode: not reported\)\. Sophos can take a while/,
    );
  } finally {
    fake.on(SRC, "GET", "/endpoint/v1/migrations/job-9", () => (senderKnowsJob
      ? { body: { id: "job-9", mode: "sending" } }
      : { status: 404, body: { error: "NotFound", message: "no such job" } }));
  }
});

test("device move: a receiving job answered 500 is not retried and no trigger is sent", async () => {
  receiverAnswer = () => ({ status: 500, body: { error: "InternalError" } });
  fake.reset();
  await assert.rejects(
    () => startMigration({ jobName: "unclear receiver", endpointIds: [DEVICE] }),
    /may still have gone through.*The Migrations page lists the jobs on both tenants/,
  );
  assert.deepEqual(migrationWrites(), ["dst POST"]);
  const [entry] = await lastAudit();
  assert.equal(entry.resource, "migration-receiver");
  assert.equal(entry.ok, false);
});

// ---- the pages show the notes ----

test("every results list shows a result's notes with its adjustments", async () => {
  const { notesOf } = await import("../frontend/js/ui.js");
  assert.deepEqual(notesOf({ adjustments: ["a"], notes: ["b"] }), ["a", "b"]);
  assert.deepEqual(notesOf({}), []);
  for (const file of ["page-exclusions.js", "page-groups.js", "page-policies.js", "page-policy-compare.js", "page-web-filtering.js"]) {
    const js = await readFile(new URL(`../frontend/js/${file}`, import.meta.url), "utf8");
    assert.match(js, /notes: notesOf\(r\)/, file);
    assert.doesNotMatch(js, /notes: r\.adjustments/, file);
  }
});
