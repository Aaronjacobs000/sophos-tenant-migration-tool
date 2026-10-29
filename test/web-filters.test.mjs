// API #3: web filtering site lists and profiles, and the web profile ID
// remap on policy clone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { copyWebFilters } = await import("../backend/dist/services/web-filter-copier.js");
const { migratePolicies } = await import("../backend/dist/services/policy-migrator.js");

const db = { src: {}, dst: {} };
function seed() {
  db.src.lists = [
    { id: "sl-a", name: "Allowed partners", description: "Partner portals", numberOfSites: 2 },
    { id: "sl-b", name: "Blocked shops", numberOfSites: 1 },
    { id: "sl-c", name: "Empty list", numberOfSites: 0 },
    { id: "sl-d", name: "Not selected", numberOfSites: 1 },
  ];
  db.src.sites = {
    "sl-a": [{ id: "s1", site: "partner1.example.test" }, { id: "s2", site: "partner2.example.test" }],
    "sl-b": [{ id: "s3", site: "shop.example.test" }],
    "sl-c": [],
    "sl-d": [{ id: "s4", site: "other.example.test" }],
  };
  db.dst.lists = [{ id: "dl-b", name: "BLOCKED SHOPS", numberOfSites: 1 }];
  // The same site in another case: the same list.
  db.dst.sites = { "dl-b": [{ id: "d3", site: "SHOP.example.test" }] };
  db.src.profiles = [
    {
      id: "wp-1", name: "Staff", description: "Default staff profile",
      consumers: [{ type: "computerWebControlPolicy", id: "pol-src-1" }],
      filterByCategory: true, categoryGroupActions: [{ name: "Adult", action: "block" }],
      filterBySiteList: true,
      siteListActions: [
        { id: "sl-a", action: "allow", priority: 3 },
        { id: "sl-b", action: "block", priority: 2 },
        { id: "sl-d", action: "warn", priority: 1 },
      ],
    },
    { id: "wp-2", name: "Kiosk", preset: "strict" },
  ];
  db.dst.profiles = [{ id: "dp-2", name: "kiosk", preset: "strict" }];
}

// The destination's names, as GET /web-filters/v1/profiles/metadata gives them (shape measured 29/10/2026).
const metadata = {
  presets: [{ name: "strict" }, { name: "keep-it-clean" }],
  categories: [{ name: "uncategorized", label: "Uncategorized" }, { name: "gambling", group: "adult", label: "Gambling" }, { name: "news", group: "productivity", label: "News" }],
};

for (const [key, tenant] of [["src", SRC], ["dst", DST]]) {
  fake.on(tenant, "GET", "/web-filters/v1/site-lists", (req) => page(db[key].lists, req.query));
  fake.on(tenant, "GET", /^\/web-filters\/v1\/site-lists\/[^/]+\/sites$/, (req) => page(db[key].sites?.[req.path.split("/")[4]] ?? [], req.query));
  fake.on(tenant, "GET", "/web-filters/v1/profiles", (req) => page(db[key].profiles.map(({ id, name, consumers }) => ({ id, name, consumers })), req.query));
  fake.on(tenant, "GET", /^\/web-filters\/v1\/profiles\/[^/]+$/, (req) => {
    const p = db[key].profiles.find((x) => x.id === req.path.split("/").pop());
    return p ? { body: p } : { status: 404, body: { error: "NotFound" } };
  });
  fake.on(tenant, "POST", "/web-filters/v1/site-lists", (req) => {
    const created = { id: fake.nextId("dl"), ...req.body };
    db[key].lists.push(created);
    return { status: 201, body: created };
  });
  fake.on(tenant, "POST", "/web-filters/v1/profiles", (req) => {
    const created = { id: fake.nextId("dp"), ...req.body };
    db[key].profiles.push(created);
    return { status: 201, body: created };
  });
}

// After the per-profile route, so it is matched first.
fake.on(DST, "GET", "/web-filters/v1/profiles/metadata", () => ({ body: metadata }));

test("dry run: plans site lists and profiles, maps rules, writes nothing", async () => {
  seed();
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await copyWebFilters({ siteListIds: ["sl-a", "sl-b", "sl-c"], profileIds: ["wp-1", "wp-2"], dryRun: true });
  assert.equal(fake.writes().length, 0);
  assert.equal((await readAudit(root)).length, before);
  const r = (id) => results.find((x) => x.sourceId === id);
  assert.equal(r("sl-a").action, "dry-run-create");
  assert.equal(r("sl-a").note, "2 sites");
  assert.equal(r("sl-b").action, "skip-exists", "names match without case");
  assert.equal(r("sl-c").ok, false, "empty lists cannot be created");
  assert.equal(r("wp-2").action, "skip-exists");
  const wp1 = r("wp-1");
  assert.equal(wp1.action, "dry-run-create");
  assert.ok(wp1.adjustments.some((a) => /would map to the copy made in this run/.test(a)));
  assert.ok(wp1.adjustments.some((a) => /dropped the "warn" rule for site list "Not selected"/.test(a)));
});

test("real copy: creates lists then a profile whose rules point at destination lists", async () => {
  seed();
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await copyWebFilters({ siteListIds: ["sl-a", "sl-b"], profileIds: ["wp-1", "wp-2"] });
  const writes = fake.writes();
  assert.ok(writes.every((w) => w.tenant === "dst"));
  const listPosts = writes.filter((w) => w.path === "/web-filters/v1/site-lists");
  assert.equal(listPosts.length, 1);
  assert.deepEqual(listPosts[0].body, { name: "Allowed partners", sites: ["partner1.example.test", "partner2.example.test"], description: "Partner portals" });
  const newListId = results.find((x) => x.sourceId === "sl-a").destId;

  const profilePosts = writes.filter((w) => w.path === "/web-filters/v1/profiles");
  assert.equal(profilePosts.length, 1, "Kiosk already exists by name");
  const body = profilePosts[0].body;
  assert.equal(body.name, "Staff");
  assert.equal(body.consumers, undefined, "policy links are not copied");
  assert.deepEqual(body.categoryGroupActions, [{ name: "Adult", action: "block" }]);
  assert.deepEqual(body.siteListActions, [
    { id: newListId, action: "allow", priority: 3 },
    { id: "dl-b", action: "block", priority: 2 },
  ]);
  const wp1 = results.find((x) => x.sourceId === "wp-1");
  assert.ok(wp1.adjustments.some((a) => /Not selected/.test(a)));

  const entries = (await readAudit(root)).slice(before);
  assert.deepEqual(entries.map((e) => e.resource), ["web-filter-site-list", "web-filter-profile"]);
  assert.ok(entries.every((e) => e.ok && e.side === "dest"));
});

// ---- policy clone: web profile ID remap ----

const PROFILE_KEY = "endpoint.web-control.web-profile-id";
const SCHEDULE_KEY = "endpoint.web-control.web-profile-schedules";
const policies = { src: [], dst: [] };
for (const [key, tenant] of [["src", SRC], ["dst", DST]]) {
  fake.on(tenant, "GET", "/endpoint/v1/policies", (req) => page(policies[key], req.query));
  fake.on(tenant, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
    const p = policies[key].find((x) => x.id === req.path.split("/").pop());
    return p ? { body: p } : { status: 404, body: { error: "NotFound" } };
  });
  fake.on(tenant, "POST", "/endpoint/v1/policies", (req) => ({ status: 201, body: { id: fake.nextId("pol"), ...req.body } }));
}

function seedPolicies() {
  seed();
  db.dst.profiles.push({ id: "dp-staff", name: "STAFF" });
  policies.src = [
    { id: "pol-1", name: "Staff browsing", type: "web-control", enabled: true, priority: 1, settings: {
      [PROFILE_KEY]: { value: "wp-1" },
      [SCHEDULE_KEY]: { value: [{ profileId: "wp-1", days: ["monday"] }, { profileId: "wp-2", days: ["sunday"] }] },
      "endpoint.web-control.web-filtering.enabled": { value: true },
    } },
    { id: "pol-2", name: "Lab browsing", type: "web-control", enabled: true, priority: 2, settings: {
      [PROFILE_KEY]: { value: "wp-missing" },
    } },
  ];
  policies.dst = [];
}

test("policy clone: maps the web profile ID and schedule to same-named destination profiles", async () => {
  seedPolicies();
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["pol-1"] });
  assert.equal(res.ok, true);
  const post = fake.writes().find((w) => w.path === "/endpoint/v1/policies");
  assert.equal(post.body.settings[PROFILE_KEY].value, "dp-staff");
  assert.deepEqual(post.body.settings[SCHEDULE_KEY].value, [{ profileId: "dp-staff", days: ["monday"] }, { profileId: "dp-2", days: ["sunday"] }]);
  assert.ok(res.adjustments.some((a) => /mapped web profile "Staff"/.test(a)));
});

test("policy clone dry run: reports the remap and writes nothing", async () => {
  seedPolicies();
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["pol-1"], dryRun: true });
  assert.equal(res.action, "dry-run-create");
  assert.equal(fake.writes().length, 0);
  assert.ok(res.adjustments.some((a) => /mapped web profile "Staff"/.test(a)));
});

// The live API refuses a web control policy whose profile ID is left out
// ("Invalid Web Profile Id", 26/09/2026), so the policy is not sent at all.
test("policy clone: a profile missing on the destination stops the policy and says which to copy", async () => {
  seedPolicies();
  db.dst.profiles = db.dst.profiles.filter((p) => p.id !== "dp-staff");
  fake.reset();
  const audited = (await readAudit(root)).length;
  const res = await migratePolicies({ policyIds: ["pol-1", "pol-2"] });
  assert.equal(fake.writes().length, 0);
  assert.deepEqual(res.map((r) => [r.ok, r.action]), [[false, "create"], [false, "create"]]);
  assert.match(res[0].error, /web profile "Staff" is not on the destination: copy it on the Web filtering page first/);
  assert.match(res[1].error, /web profile wp-missing was not found on the source/);
  for (const r of res) assert.doesNotMatch(r.error, /[\u2013\u2014]/);
  assert.equal((await readAudit(root)).length, audited, "nothing written, nothing audited");

  const [dry] = await migratePolicies({ policyIds: ["pol-1"], dryRun: true });
  assert.deepEqual([dry.ok, dry.action], [false, "dry-run-create"]);
  assert.match(dry.error, /"Staff" is not on the destination/);
});

test("policy clone: a schedule profile missing on the destination drops the schedule only", async () => {
  seedPolicies();
  db.dst.profiles = db.dst.profiles.filter((p) => p.id !== "dp-2");
  fake.reset();
  const [res] = await migratePolicies({ policyIds: ["pol-1"] });
  assert.equal(res.ok, true);
  const post = fake.writes().find((w) => w.path === "/endpoint/v1/policies");
  assert.equal(post.body.settings[PROFILE_KEY].value, "dp-staff");
  assert.equal(post.body.settings[SCHEDULE_KEY], undefined);
  assert.ok(res.adjustments.some((a) => /dropped the web profile schedule: "Kiosk" is not on the destination/.test(a)));
});

test("policy clone: policies without a web profile make no profile lookups", async () => {
  seedPolicies();
  policies.src.push({ id: "pol-3", name: "Base TP", type: "threat-protection", settings: { "endpoint.threat-protection.amsi.enabled": { value: true } } });
  // As the live API returns it for a policy that does not use web profiles.
  policies.src.push({ id: "pol-4", name: "Legacy web", type: "web-control", settings: { [PROFILE_KEY]: { value: "" }, [SCHEDULE_KEY]: { value: [] } } });
  fake.reset();
  const res = await migratePolicies({ policyIds: ["pol-3", "pol-4"], dryRun: true });
  assert.equal(res[1].adjustments, undefined);
  assert.equal(fake.calls.filter((c) => c.path === "/web-filters/v1/profiles").length, 0);
});

// ---- 0.5.0: limits, category names, and same-name items that differ (web filtering guide, 14/10/2026) ----

let putAnswer = null;
for (const [key, tenant] of [["src", SRC], ["dst", DST]]) {
  fake.on(tenant, "PUT", /^\/web-filters\/v1\/site-lists\/[^/]+$/, (req) => {
    if (putAnswer) { const a = putAnswer; putAnswer = null; if (a.apply) applyListPut(key, req); return a.response ?? a; }
    return { body: applyListPut(key, req) };
  });
  fake.on(tenant, "PUT", /^\/web-filters\/v1\/profiles\/[^/]+$/, (req) => {
    const id = req.path.split("/").pop();
    const i = db[key].profiles.findIndex((p) => p.id === id);
    db[key].profiles[i] = { id, ...req.body };
    return { body: db[key].profiles[i] };
  });
}
function applyListPut(key, req) {
  const id = req.path.split("/").pop();
  const list = db[key].lists.find((l) => l.id === id);
  Object.assign(list, { name: req.body.name, description: req.body.description, numberOfSites: req.body.sites.length });
  db[key].sites = { ...(db[key].sites ?? {}), [id]: req.body.sites.map((site, n) => ({ id: `${id}-s${n}`, site })) };
  return { ...list, sites: req.body.sites };
}
const wfWrites = () => fake.writes().filter((w) => w.path.startsWith("/web-filters/"));

test("a list over 750 sites, or a 21st list on the destination, is not sent and says why", async () => {
  seed();
  db.src.sites["sl-a"] = Array.from({ length: 751 }, (_, i) => ({ id: `s${i}`, site: `s${i}.example.test` }));
  db.dst.lists = Array.from({ length: 19 }, (_, i) => ({ id: `dl-${i}`, name: `Existing ${i}`, numberOfSites: 1 }));
  fake.reset();
  const res = await copyWebFilters({ siteListIds: ["sl-a", "sl-b", "sl-d"] });
  const r = (id) => res.find((x) => x.sourceId === id);
  assert.equal(r("sl-a").error, "not sent: the list has 751 sites, and Sophos allows at most 750 in a list");
  assert.equal(r("sl-b").action, "create", "the 20th list is made");
  assert.equal(r("sl-b").ok, true);
  assert.equal(r("sl-d").error, "not sent: the destination has 20 site lists, and Sophos allows at most 20 in a tenant");
  assert.deepEqual(wfWrites().map((w) => w.body.name), ["Blocked shops"]);

  seed();
  db.dst.lists = Array.from({ length: 19 }, (_, i) => ({ id: `dl-${i}`, name: `Existing ${i}`, numberOfSites: 1 }));
  fake.reset();
  const dry = await copyWebFilters({ siteListIds: ["sl-b", "sl-d"], dryRun: true });
  assert.equal(dry[0].action, "dry-run-create");
  assert.equal(dry[1].error, "not sent: the destination would then have 20 site lists, and Sophos allows at most 20 in a tenant");
  assert.deepEqual(fake.writes(), []);
});

test("a profile is checked against the destination's names and not sent with one it doesn't have", async () => {
  seed();
  db.src.profiles.push({ id: "wp-3", name: "Odd names", filterByCategory: true, preset: "Strict", categoryGroupActions: [{ name: "gaming", action: "block" }], categoryActions: [{ name: "News", action: "warn" }, { name: "crypto", action: "block" }] });
  fake.reset();
  const [res] = await copyWebFilters({ profileIds: ["wp-3"] });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not sent: the destination has no category group "gaming", category "crypto". Names can differ between tenants; change the profile on the source, or set it up on the destination by hand');
  assert.deepEqual(wfWrites(), []);
  const meta = fake.calls.find((c) => c.path === "/web-filters/v1/profiles/metadata");
  assert.equal(meta.tenant, "dst");
  assert.equal(meta.headers["accept-language"], "en", "the API refuses Node's default Accept-Language");

  // Names it has, in another case, go through.
  db.src.profiles[2] = { id: "wp-3", name: "Odd names", filterByCategory: true, preset: "Strict", categoryGroupActions: [{ name: "ADULT", action: "block" }] };
  fake.reset();
  const [ok] = await copyWebFilters({ profileIds: ["wp-3"] });
  assert.equal(ok.action, "create");
  assert.equal(ok.ok, true);
});

test("when the destination's names can't be read, the profile is still copied and the result says the names were not checked", async () => {
  seed();
  fake.on(DST, "GET", "/web-filters/v1/profiles/metadata", () => ({ status: 400, body: { error: "badRequest", message: "Invalid format of argument: Accept-Language" } }));
  try {
    fake.reset();
    const res = await copyWebFilters({ siteListIds: ["sl-a"], profileIds: ["wp-1"] });
    const wp1 = res.find((x) => x.sourceId === "wp-1");
    assert.equal(wp1.action, "create");
    assert.ok(wp1.adjustments.includes("the destination's category names could not be read, so they were not checked (Sophos API error 400: badRequest - Invalid format of argument: Accept-Language)"));
  } finally {
    fake.on(DST, "GET", "/web-filters/v1/profiles/metadata", () => ({ body: metadata }));
  }
});

test("a same-name list or profile with other content shows as differs, with what differs, and nothing is written", async () => {
  seed();
  db.dst.sites = { "dl-b": [{ id: "d3", site: "shop.example.test" }, { id: "d4", site: "extra.example.test" }] };
  db.dst.lists[0].description = "dest copy";
  db.dst.profiles = [{ id: "dp-2", name: "kiosk", preset: "keep-it-clean" }];
  fake.reset();
  const res = await copyWebFilters({ siteListIds: ["sl-b"], profileIds: ["wp-2"] });
  assert.deepEqual(res.map((r) => [r.sourceId, r.action, r.ok, r.destId]), [["sl-b", "differs", true, "dl-b"], ["wp-2", "differs", true, "dp-2"]]);
  assert.deepEqual(res[0].differences, ["sites: 0 only on the source, 1 only on the destination", "description"]);
  assert.deepEqual(res[1].differences, ["preset"]);
  assert.deepEqual(fake.writes(), []);
});

test("overwrite replaces a differing list and profile with PUT, keeps the destination's names, and is audited; matching items are left", async () => {
  seed();
  db.dst.sites = { "dl-b": [{ id: "d4", site: "extra.example.test" }] };
  db.dst.profiles = [{ id: "dp-2", name: "kiosk", preset: "keep-it-clean" }, { id: "dp-staff", name: "STAFF", filterByCategory: false }];
  fake.reset();
  const dry = await copyWebFilters({ siteListIds: ["sl-b"], profileIds: ["wp-1", "wp-2"], overwrite: true, dryRun: true });
  assert.deepEqual(dry.map((r) => r.action), ["dry-run-overwrite", "dry-run-overwrite", "dry-run-overwrite"]);
  assert.deepEqual(fake.writes(), []);

  const before = (await readAudit(root)).length;
  const res = await copyWebFilters({ siteListIds: ["sl-b"], profileIds: ["wp-1", "wp-2"], overwrite: true });
  assert.deepEqual(res.map((r) => [r.sourceId, r.action, r.ok]), [["sl-b", "overwrite", true], ["wp-1", "overwrite", true], ["wp-2", "overwrite", true]]);
  const puts = fake.writes();
  assert.deepEqual(puts.map((w) => `${w.tenant} ${w.method} ${w.path}`), [
    "dst PUT /web-filters/v1/site-lists/dl-b",
    "dst PUT /web-filters/v1/profiles/dp-staff",
    "dst PUT /web-filters/v1/profiles/dp-2",
  ]);
  assert.deepEqual(puts[0].body, { name: "BLOCKED SHOPS", sites: ["shop.example.test"] });
  assert.equal(puts[1].body.name, "STAFF");
  assert.deepEqual(puts[1].body.siteListActions, [{ id: "dl-b", action: "block", priority: 2 }], "rules point at the destination lists");
  assert.equal(puts[1].body.consumers, undefined);
  assert.deepEqual(puts[2].body, { name: "kiosk", preset: "strict" });
  const entries = (await readAudit(root)).slice(before);
  assert.deepEqual(entries.map((e) => [e.action, e.resource, e.resourceId, e.ok]), [
    ["update", "web-filter-site-list", "dl-b", true],
    ["update", "web-filter-profile", "dp-staff", true],
    ["update", "web-filter-profile", "dp-2", true],
  ]);

  // Now they match: nothing more to write.
  fake.reset();
  const again = await copyWebFilters({ siteListIds: ["sl-b"], profileIds: ["wp-2"], overwrite: true });
  assert.deepEqual(again.map((r) => r.action), ["skip-exists", "skip-exists"]);
  assert.deepEqual(fake.writes(), []);
});

test("an overwrite Sophos answers unclearly is read back, never sent twice", async () => {
  const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
  setReadBackDelays([0, 0, 0]);
  try {
    seed();
    db.dst.sites = { "dl-b": [{ id: "d4", site: "extra.example.test" }] };
    putAnswer = { apply: true, response: { status: 500, body: { error: "InternalError" } } };
    fake.reset();
    const [made] = await copyWebFilters({ siteListIds: ["sl-b"], overwrite: true });
    assert.equal(fake.writes().length, 1);
    assert.equal(made.ok, true);
    assert.deepEqual(made.notes, ["Sophos answered 500, but a read-back found the new sites on the destination, so the change was made"]);

    seed();
    db.dst.sites = { "dl-b": [{ id: "d4", site: "extra.example.test" }] };
    putAnswer = { status: 500, body: { error: "InternalError" } };
    fake.reset();
    const [missed] = await copyWebFilters({ siteListIds: ["sl-b"], overwrite: true });
    assert.equal(fake.writes().length, 1);
    assert.equal(missed.ok, false);
    assert.match(missed.error, /The tool read the destination's site list "BLOCKED SHOPS" three times and found the old sites still there\. Sophos can take a while to show a change, so this does not prove it failed\. Wait a minute, then preview again/);
  } finally {
    setReadBackDelays([1000, 3000, 6000]);
  }
});

test("the web filtering page shows differs and offers the overwrite only after two confirmations", async () => {
  const { readFile } = await import("node:fs/promises");
  const js = await readFile(new URL("../frontend/js/page-web-filtering.js", import.meta.url), "utf8");
  const offer = js.slice(js.indexOf("function offerOverwrite"), js.indexOf("function row("));
  assert.equal((offer.match(/if \(!confirm\(/g) ?? []).length, 2);
  assert.match(offer, /overwrite: true/);
  const ui = await readFile(new URL("../frontend/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /differs: `<span class="tag tag-warn">differs<\/span>`/);
  const { notesOf } = await import("../frontend/js/ui.js");
  assert.deepEqual(notesOf({ differences: ["preset"], adjustments: ["a"] }), ["differs: preset", "a"]);
});
