// AI Defense policies: compare, copy with the Endpoint scope mapped, order and
// state, overwrite, scope additions, unclear writes, and the routes.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { fakeAiDefense } from "./helpers/fake-ai-defense.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";
import { assignmentNotes } from "../frontend/js/ui.js";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const {
  compareAiPolicies, copyAiPolicies, scopeTargets, addToScope, aiPolicyDifferences, pairAiPolicy,
  PARTNER_NOT_COPIED, NO_DEST_BASE, ENDPOINT_OFF, LEFT_OFF_EMPTY, TAGS_STAY,
} = await import("../backend/dist/services/ai-defense-copier.js");
const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
setReadBackDelays([0, 0, 0]);
const { aiDefenseRouter, migrateAiDefenseRouter } = await import("../backend/dist/routes/ai-defense.js");
const http = await startHttp([migrateAiDefenseRouter, aiDefenseRouter]);
after(() => http.close());

// ---- directories ----

const directory = { src: {}, dst: {} };
for (const [side, tenant] of [["src", SRC], ["dst", DST]]) {
  fake.on(tenant, "GET", "/common/v1/directory/users", (req) => page(directory[side].users, req.query));
  fake.on(tenant, "GET", "/common/v1/directory/user-groups", (req) => page(directory[side].userGroups, req.query));
  fake.on(tenant, "GET", "/endpoint/v1/endpoint-groups", (req) => page(directory[side].endpointGroups, req.query));
  fake.on(tenant, "GET", "/endpoint/v1/endpoints", (req) => {
    const ids = req.query.ids ? req.query.ids.split(",") : null;
    const items = directory[side].endpoints.filter((e) => !ids || ids.includes(e.id));
    return { body: { items, pages: { size: items.length, maxSize: 500 } } };
  });
}

// ---- policies, in the shapes live tenants return ----

const FIREWALL = { enabled: true, scope: { groups: [{ group_id: "fw-g1", name: "HQ firewalls", web_policy_ids: ["18910", "18912"] }] } };
const sourcePolicies = () => [
  {
    id: "sp-staff", name: "Staff standard", description: "Baseline for staff", state: "ENABLED",
    baseRule: { generativeAiCategoryAction: "BLOCK", appControlCategoryAction: null },
    tags: { env: "prod" },
    rules: [
      { target: { conditions: [{ dimension: "app", operator: "IN", values: ["chatgpt", "claude"] }] }, action: "WARN", note: "Not sanctioned yet" },
      { target: { conditions: [{ dimension: "app", operator: "IN", values: ["microsoft-copilot"] }] }, action: "ALLOW" },
      { target: { conditions: [] }, action: "BLOCK" },
    ],
    sensors: {
      endpoint: { enabled: true, scope: {
        group_ids: ["sug-fin"], groups: [{ id: "sug-fin", name: "Finance" }],
        users: [{ id: "su-bob", name: "CORP\\bob" }],
        device_ids: ["se-pc1"], devices: [{ id: "se-pc1", name: "PC-01" }],
        device_group_ids: ["seg-syd"], device_groups: [{ id: "seg-syd", name: "Sydney" }],
      } },
      firewall: FIREWALL,
    },
  },
  {
    id: "sp-edu", name: "Education and public sector", state: "DISABLED", origin: "BUILT_IN", builtInKey: "education-v1", builtInVersion: 1,
    rules: [
      { target: { conditions: [{ dimension: "compliance", operator: "MISSING_ANY", values: ["gdpr_compliant"] }] }, action: "BLOCK", note: "No GDPR, no go", enforcementMechanismOverride: ["WEB_CONTROL"] },
      { target: { conditions: [{ dimension: "category", operator: "IN", values: ["general_assistant", "image_generator"] }] }, action: "WARN",
        dataControls: { clipboardCopy: "allow", clipboardPaste: "warn", upload: "block", download: "allow" } },
    ],
    sensors: { endpoint: { enabled: true, scope: { group_ids: ["sug-hr"], groups: [{ id: "sug-hr", name: "HR" }], users: [] } } },
  },
  {
    id: "sp-pending", name: "Pending laptops", state: "ENABLED",
    rules: [{ target: { conditions: [{ dimension: "risk_level", operator: "IN", values: ["critical", "high"] }] }, action: "BLOCK" }],
    sensors: { endpoint: { enabled: true, scope: { device_ids: ["se-pc2"], devices: [{ id: "se-pc2", name: "PC-02" }] } } },
  },
  {
    id: "sp-fw", name: "Firewall only", state: "ENABLED", rules: [],
    sensors: { endpoint: { enabled: false, scope: {} }, firewall: FIREWALL },
  },
  { id: "sp-partner", name: "Partner rules", origin: "PARTNER", state: "ENABLED", rules: [], sensors: { endpoint: { enabled: true, scope: { type: "EVERYONE" } } } },
  {
    id: "sp-base", name: "Source Base", kind: "TENANT_BASE", state: "ENABLED", description: "Applies to all endpoints",
    baseRule: { generativeAiCategoryAction: "BLOCK", appControlCategoryAction: null },
    rules: [{ target: { conditions: [] }, action: "ALLOW" }],
    sensors: { endpoint: { enabled: true, scope: { type: "EVERYONE" } } },
  },
];
const destPolicies = () => [
  { id: "dp-existing", name: "Existing dest", state: "ENABLED", rules: [], sensors: { endpoint: { enabled: true, scope: { users: [{ id: "du-alice", name: "Alice Jones" }] } } } },
  { id: "dp-base", name: "AI Defense Base Policy", kind: "TENANT_BASE", state: "ENABLED", description: "Applies to all endpoints", rules: [], sensors: { endpoint: { enabled: true, scope: { type: "EVERYONE" } } } },
];
const ACTIVE = { onboarding: { status: "COMPLETED" }, licenseState: "ACTIVE", licenseExpiryDate: "2031-03-26T23:59:59.999Z" };
const srcAi = fakeAiDefense(fake, SRC, { settings: ACTIVE });
const dstAi = fakeAiDefense(fake, DST);

function seed() {
  directory.src = {
    users: [{ id: "su-bob", name: "CORP\\bob" }, { id: "su-alice", name: "Alice", email: "alice@example.com" }],
    userGroups: [{ id: "sug-fin", name: "Finance" }, { id: "sug-hr", name: "HR" }],
    endpointGroups: [{ id: "seg-syd", name: "Sydney", type: "computer" }],
    endpoints: [{ id: "se-pc1", hostname: "PC-01", type: "computer" }, { id: "se-pc2", hostname: "PC-02", type: "computer" }],
  };
  directory.dst = {
    users: [{ id: "du-bob", name: "corp\\bob" }, { id: "du-alice", name: "Alice Jones", email: "ALICE@example.com" }],
    userGroups: [{ id: "dug-fin", name: "finance" }],
    endpointGroups: [{ id: "deg-syd", name: "Sydney", type: "computer" }],
    endpoints: [{ id: "de-pc1", hostname: "pc-01", type: "computer" }],
  };
  srcAi.reset(sourcePolicies(), ACTIVE);
  dstAi.reset(destPolicies(), null);
  fake.reset();
}

const ALL = ["sp-staff", "sp-edu", "sp-pending", "sp-fw", "sp-partner", "sp-base"];
const by = (results, id) => results.find((r) => r.sourceId === id);
const rowStatus = (r) => Object.fromEntries((r.assignments?.rows ?? []).map((x) => [`${x.kind} ${x.name}`, x.status]));
const ops = () => fake.fusionWrites().map((c) => `${c.tenant} ${c.op.replace("MigrationAiDefense", "")}`);

// ---- pure helpers ----

test("scopeTargets reads both forms of each dimension and the legacy user_ids, once each", () => {
  const t = scopeTargets({
    users: [{ id: "u1", name: "CORP\\a" }], user_ids: ["u1", "u2"],
    group_ids: ["g1"], groups: [{ id: "g1", name: "Finance" }, { id: "g2" }],
    device_ids: ["d1"], device_group_ids: [], device_groups: [{ id: "dg1", name: "Sydney" }],
  });
  assert.deepEqual(t.map((x) => `${x.kind}:${x.id}:${x.name ?? ""}`).sort(), [
    "endpoint:d1:", "endpointGroup:dg1:Sydney", "user:u1:CORP\\a", "user:u2:", "userGroup:g1:Finance", "userGroup:g2:",
  ]);
  assert.deepEqual(scopeTargets({ type: "EVERYONE" }), []);
  assert.deepEqual(scopeTargets(null), []);
});

test("addToScope adds each new target in both forms and keeps what is there", () => {
  const before = { users: [{ id: "u1", name: "a", exchange_login: "a@x" }], group_ids: ["g1"], extra: 1 };
  const out = addToScope(before, [
    { kind: "user", id: "u1", name: "a" },
    { kind: "user", id: "u2", name: "CORP\\b" },
    { kind: "userGroup", id: "g2", name: "HR" },
    { kind: "endpoint", id: "d1", name: "PC-01" },
  ]);
  assert.deepEqual(out, {
    users: [{ id: "u1", name: "a", exchange_login: "a@x" }, { id: "u2", name: "CORP\\b" }],
    group_ids: ["g1", "g2"], groups: [{ id: "g2", name: "HR" }],
    device_ids: ["d1"], devices: [{ id: "d1", name: "PC-01" }],
    extra: 1,
  });
  assert.deepEqual(before.group_ids, ["g1"], "the original is not changed");
});

test("differences ignore rule positions, condition and value order, the name and the scope", () => {
  const a = { name: "X", state: "ENABLED", rules: [{ position: 0, target: { conditions: [{ dimension: "app", operator: "IN", values: ["b", "a"] }, { dimension: "risk_level", operator: "IN", values: ["high"] }] }, action: "BLOCK" }], baseRule: {}, tags: { b: "2", a: "1" }, sensors: { endpoint: { enabled: true, scope: { group_ids: ["g1"] } } } };
  const b = { name: "x", state: "ENABLED", rules: [{ position: 5, target: { conditions: [{ dimension: "risk_level", operator: "IN", values: ["high"] }, { dimension: "app", operator: "IN", values: ["a", "b"] }] }, action: "BLOCK", note: "" }], baseRule: { generativeAiCategoryAction: "ALLOW" }, tags: { a: "1", b: "2" }, sensors: { endpoint: { enabled: true, scope: {} } } };
  assert.deepEqual(aiPolicyDifferences(a, b), []);
  const c = { ...b, state: "DISABLED", rules: [{ ...b.rules[0], action: "WARN" }], baseRule: { generativeAiCategoryAction: "BLOCK" }, tags: {} };
  assert.deepEqual(aiPolicyDifferences(a, c), [
    "rules: rule 1 differs",
    "Generative AI category action: ALLOW on the source, BLOCK on the destination",
    "tags",
    "state: on on the source, off on the destination",
  ]);
});

test("a base policy pairs with the destination's base policy whatever its name; a shared name is ambiguous", () => {
  const base = { id: "b1", name: "Mine", kind: "TENANT_BASE" };
  const destBase = { id: "b2", name: "AI Defense Base Policy", kind: "TENANT_BASE" };
  assert.equal(pairAiPolicy(base, [base], [destBase]).dest, destBase);
  const p = { id: "p1", name: "Dup", kind: "TENANT" };
  assert.deepEqual(pairAiPolicy(p, [p], [{ id: "d1", name: "dup ", kind: "TENANT" }, { id: "d2", name: "DUP", kind: "TENANT" }]), { ambiguous: true });
  assert.equal(pairAiPolicy(p, [p], [{ id: "d1", name: " dup", kind: "TENANT" }]).dest.id, "d1");
});

// ---- compare ----

test("compare: source only, not copied, the base policy differs, and the destination's own", async () => {
  seed();
  const m = await compareAiPolicies();
  const of = (name) => m.find((x) => x.name === name);
  assert.equal(of("Staff standard").status, "source-only");
  assert.equal(of("Partner rules").status, "not-copied");
  assert.equal(of("Partner rules").reason, PARTNER_NOT_COPIED);
  assert.equal(of("Source Base").status, "differ");
  assert.equal(of("Source Base").destId, "dp-base");
  assert.deepEqual(of("Source Base").differences, ["rules: 1 on the source, 0 on the destination", "Generative AI category action: BLOCK on the source, ALLOW on the destination"]);
  assert.equal(of("Existing dest").status, "dest-only");
  assert.deepEqual(fake.fusionWrites(), []);
});

// ---- dry run ----

test("dry run: maps the scope, notes what is not copied and where each copy goes, and writes nothing", async () => {
  seed();
  const before = (await readAudit(root)).length;
  const results = await copyAiPolicies({ policyIds: ALL, dryRun: true });
  assert.deepEqual(fake.fusionWrites(), []);
  assert.deepEqual(fake.writes(), []);
  assert.equal((await readAudit(root)).length, before);

  const staff = by(results, "sp-staff");
  assert.equal(staff.action, "dry-run-create");
  assert.deepEqual(rowStatus(staff), {
    "user CORP\\bob": "will-set", "userGroup Finance": "will-set", "endpointGroup Sydney": "will-set", "endpoint PC-01": "will-set",
  });
  assert.ok(staff.adjustments.some((a) => /Firewall sensor is not copied/.test(a)));
  assert.deepEqual(staff.notes, ['would be created turned off and placed straight after "Existing dest", then turned on']);

  const edu = by(results, "sp-edu");
  assert.equal(edu.action, "dry-run-create");
  assert.equal(rowStatus(edu)["userGroup HR"], "not-matched");
  assert.match(edu.assignments.rows[0].reason, /mirror it on the Groups page, then copy the policy again/);
  assert.deepEqual(edu.notes, ['would be created turned off and placed straight after "Staff standard"'], "the copies keep their source order");

  const pending = by(results, "sp-pending");
  assert.equal(rowStatus(pending)["endpoint PC-02"], "pending");
  assert.match(pending.assignments.rows[0].reason, /once its move lands, copy the policy again to add it/);
  assert.ok(pending.adjustments.includes(LEFT_OFF_EMPTY));

  assert.equal(by(results, "sp-fw").ok, false);
  assert.equal(by(results, "sp-fw").error, ENDPOINT_OFF);
  assert.equal(by(results, "sp-partner").error, PARTNER_NOT_COPIED);
  assert.equal(by(results, "sp-base").action, "differs", "the base pairs with the destination's and is left as it is");
});

// ---- real copy ----

test("copy: created off, moved to the bottom in source order, turned on, scope mapped and read back, all audited", async () => {
  seed();
  const before = (await readAudit(root)).length;
  const results = await copyAiPolicies({ policyIds: ALL });

  assert.deepEqual(ops(), [
    "dst CreatePolicy", "dst MovePolicy", "dst EnablePolicy",
    "dst CreatePolicy", "dst MovePolicy",
    "dst CreatePolicy", "dst MovePolicy",
  ]);
  assert.ok(fake.fusionWrites().every((c) => c.tenant === "dst"));

  const creates = fake.fusionWrites().filter((c) => c.op.endsWith("CreatePolicy")).map((c) => c.variables.input);
  assert.deepEqual(creates[0], {
    name: "Staff standard",
    description: "Baseline for staff",
    rules: [
      { target: { conditions: [{ dimension: "app", operator: "IN", values: ["chatgpt", "claude"] }] }, action: "WARN", note: "Not sanctioned yet" },
      { target: { conditions: [{ dimension: "app", operator: "IN", values: ["microsoft-copilot"] }] }, action: "ALLOW" },
      { target: { conditions: [] }, action: "BLOCK" },
    ],
    baseRule: { generativeAiCategoryAction: "BLOCK" },
    sensors: { endpoint: { enabled: true, scope: {
      users: [{ id: "du-bob", name: "corp\\bob" }],
      group_ids: ["dug-fin"], groups: [{ id: "dug-fin", name: "finance" }],
      device_group_ids: ["deg-syd"], device_groups: [{ id: "deg-syd", name: "Sydney" }],
      device_ids: ["de-pc1"], devices: [{ id: "de-pc1", name: "pc-01" }],
    } } },
    state: "DISABLED",
    tags: { env: "prod" },
  }, "the destination's IDs and names, the Endpoint sensor only, and created off");
  assert.equal(creates[1].builtInKey, "education-v1");
  assert.equal(creates[1].builtInVersion, 1);
  assert.deepEqual(creates[1].rules[0].enforcementMechanismOverride, ["WEB_CONTROL"]);
  assert.deepEqual(creates[1].rules[1].dataControls, { clipboardCopy: "allow", clipboardPaste: "warn", upload: "block", download: "allow" });
  assert.deepEqual(creates[1].sensors.endpoint.scope, {}, "nothing matched");

  // The destination, read back.
  const order = dstAi.policies.map((p) => `${p.rank} ${p.name} ${p.state}`);
  assert.deepEqual(order, [
    "1 Existing dest ENABLED",
    "2 Staff standard ENABLED",
    "3 Education and public sector DISABLED",
    "4 Pending laptops DISABLED",
    "5 AI Defense Base Policy ENABLED",
  ]);
  const staff = by(results, "sp-staff");
  assert.equal(staff.action, "create");
  assert.ok(staff.ok);
  assert.ok(Object.values(rowStatus(staff)).every((s) => s === "set"));
  assert.deepEqual(staff.notes, ['placed straight after "Existing dest"', "turned on, as on the source"]);
  assert.deepEqual(by(results, "sp-edu").notes, ['placed straight after "Staff standard"']);
  const pending = by(results, "sp-pending");
  assert.ok(pending.ok);
  assert.ok(pending.adjustments.includes(LEFT_OFF_EMPTY));
  assert.equal(by(results, "sp-base").action, "differs");

  const entries = (await readAudit(root)).slice(before);
  assert.deepEqual(entries.map((e) => `${e.action} ${e.ok}`), ["create true", "move true", "enable true", "create true", "move true", "create true", "move true"]);
  assert.ok(entries.every((e) => e.resource === "ai-defense-policy" && e.side === "dest"));
  assert.deepEqual(entries[0].detail.scope.map((s) => s.destId).sort(), ["de-pc1", "deg-syd", "du-bob", "dug-fin"]);

  // The results list shows each scope row the way the Policies page shows assignments.
  assert.ok(assignmentNotes(staff).includes('assigned to user "CORP\\bob"'));
});

test("copy again: already there and nothing written; a device that lands later is added, and an overwrite turns the policy on", async () => {
  seed();
  await copyAiPolicies({ policyIds: ["sp-staff", "sp-edu", "sp-pending"] });
  fake.reset();
  const again = await copyAiPolicies({ policyIds: ["sp-staff", "sp-edu", "sp-pending"] });
  assert.deepEqual(fake.fusionWrites(), []);
  assert.equal(by(again, "sp-staff").action, "skip-exists");
  assert.ok(Object.values(rowStatus(by(again, "sp-staff"))).every((s) => s === "already-set"));
  assert.equal(by(again, "sp-edu").action, "skip-exists");
  const p = by(again, "sp-pending");
  assert.equal(p.action, "differs", "left off while the source's is on");
  assert.deepEqual(p.differences, ["state: on on the source, off on the destination"]);
  const [stays] = await copyAiPolicies({ policyIds: ["sp-pending"], overwrite: true, dryRun: true });
  assert.deepEqual(stays.notes, ["would stay turned off: none of the users, groups or devices it applies to are on the destination yet"]);

  // The device moves, then the policy is copied again: the device is added, nothing else changes.
  directory.dst.endpoints.push({ id: "de-pc2", hostname: "PC-02", type: "computer" });
  const copy = dstAi.policies.find((x) => x.name === "Pending laptops");
  copy.sensors.dns = { enabled: false, scope: {} };
  fake.reset();
  const added = by(await copyAiPolicies({ policyIds: ["sp-pending"] }), "sp-pending");
  assert.equal(added.action, "differs");
  assert.equal(rowStatus(added)["endpoint PC-02"], "set");
  const [update] = fake.fusionWrites();
  assert.equal(update.op, "MigrationAiDefenseUpdatePolicy");
  assert.deepEqual(Object.keys(update.variables.input).sort(), ["sensors", "version"]);
  assert.deepEqual(update.variables.input.sensors.endpoint.scope, { device_ids: ["de-pc2"], devices: [{ id: "de-pc2", name: "PC-02" }] });
  assert.deepEqual(update.variables.input.sensors.dns, { enabled: false, scope: {} }, "the destination's other sensors are sent back, because sensors replaces the whole map");
  assert.equal(copy.state, "DISABLED", "a copy without overwrite leaves the state");

  fake.reset();
  const auditBefore = (await readAudit(root)).length;
  const over = by(await copyAiPolicies({ policyIds: ["sp-pending"], overwrite: true }), "sp-pending");
  assert.deepEqual((await readAudit(root)).slice(auditBefore).map((e) => e.action), ["update", "enable"], "audited in the order sent");
  assert.equal(over.action, "overwrite");
  assert.ok(over.ok);
  assert.deepEqual(over.notes, ["turned on, as on the source"]);
  assert.deepEqual(ops(), ["dst UpdatePolicy", "dst EnablePolicy"]);
  assert.equal(dstAi.find(copy.id).state, "ENABLED");
  assert.deepEqual(dstAi.find(copy.id).sensors.dns, { enabled: false, scope: {} });
});

test("overwrite: replaces rules, base rule and tags, keeps the destination's name, place and scope, and the base policy's sensors", async () => {
  seed();
  await copyAiPolicies({ policyIds: ["sp-staff"] });
  const copy = dstAi.policies.find((x) => x.name === "Staff standard");
  copy.name = "STAFF standard";
  copy.rules = [{ position: 0, target: { conditions: [] }, action: "ALLOW", enforcementMechanismOverride: null, note: null, dataControls: null }];
  copy.tags = { env: "test" };
  copy.sensors.endpoint.scope.users.push({ id: "du-alice", name: "Alice Jones" });
  const rank = copy.rank;

  const preview = by(await copyAiPolicies({ policyIds: ["sp-staff", "sp-base"], dryRun: true }), "sp-staff");
  assert.equal(preview.action, "differs");
  assert.deepEqual(preview.differences, ["rules: 3 on the source, 1 on the destination", "tags"]);
  fake.reset();
  const results = await copyAiPolicies({ policyIds: ["sp-staff", "sp-base"], overwrite: true });
  const staff = by(results, "sp-staff");
  assert.equal(staff.action, "overwrite");
  assert.ok(staff.ok, staff.error);
  assert.ok(staff.adjustments.some((a) => /Firewall/.test(a)));
  const after = dstAi.find(copy.id);
  assert.equal(after.name, "STAFF standard");
  assert.equal(after.rank, rank);
  assert.equal(after.rules.length, 3);
  assert.deepEqual(after.tags, { env: "prod" });
  assert.ok(after.sensors.endpoint.scope.users.some((u) => u.id === "du-alice"), "nothing is taken out of the scope");
  assert.deepEqual(aiPolicyDifferences(srcAi.find("sp-staff"), after), []);

  const base = by(results, "sp-base");
  assert.equal(base.action, "overwrite");
  assert.ok(base.ok, base.error);
  const update = fake.fusionWrites().find((c) => c.variables.id === "dp-base");
  assert.equal(update.variables.input.sensors, undefined, "the base policy keeps its sensors");
  assert.equal(update.variables.input.name, undefined);
  const destBase = dstAi.find("dp-base");
  assert.equal(destBase.name, "AI Defense Base Policy");
  assert.equal(destBase.baseRule.generativeAiCategoryAction, "BLOCK");
  assert.equal(destBase.rules.length, 1);
});

test("overwrite: tags the source doesn't have stay, because Sophos ignores an empty tag list, and the result says so", async () => {
  seed();
  await copyAiPolicies({ policyIds: ["sp-edu"] });
  const copy = dstAi.policies.find((x) => x.name === "Education and public sector");
  copy.tags = { edited: "on the destination" };
  copy.rules[0].action = "WARN";
  const [preview] = await copyAiPolicies({ policyIds: ["sp-edu"], overwrite: true, dryRun: true });
  assert.ok(preview.adjustments.includes(TAGS_STAY), "the preview says so too");
  fake.reset();
  const [r] = await copyAiPolicies({ policyIds: ["sp-edu"], overwrite: true });
  assert.ok(r.ok, r.error);
  assert.equal(r.action, "overwrite");
  assert.ok(r.adjustments.includes(TAGS_STAY));
  const [update] = fake.fusionWrites();
  assert.equal("tags" in update.variables.input, false, "no empty tag list is sent");
  assert.equal(dstAi.find(copy.id).rules[0].action, "BLOCK");
  assert.deepEqual(dstAi.find(copy.id).tags, { edited: "on the destination" });
});

test("a destination without a base policy: the source's is not created", async () => {
  seed();
  dstAi.reset(destPolicies().filter((p) => p.kind !== "TENANT_BASE"));
  const [r] = await copyAiPolicies({ policyIds: ["sp-base"] });
  assert.equal(r.ok, false);
  assert.equal(r.error, NO_DEST_BASE);
  assert.deepEqual(fake.fusionWrites(), []);
});

test("an ambiguous name, and a destination partner policy with the same name, are not written", async () => {
  seed();
  dstAi.reset([...destPolicies(), { id: "dp-d1", name: "staff STANDARD", rules: [], sensors: { endpoint: { enabled: true, scope: {} } } }, { id: "dp-d2", name: "Staff standard ", rules: [], sensors: { endpoint: { enabled: true, scope: {} } } }]);
  const [amb] = await copyAiPolicies({ policyIds: ["sp-staff"], overwrite: true });
  assert.equal(amb.ok, false);
  assert.match(amb.error, /more than one AI Defense policy matches "Staff standard" ignoring case/);

  dstAi.reset([...destPolicies(), { id: "dp-p", name: "Staff standard", origin: "PARTNER", rules: [], sensors: { endpoint: { enabled: true, scope: {} } } }]);
  const [plain] = await copyAiPolicies({ policyIds: ["sp-staff"] });
  assert.equal(plain.action, "differs");
  assert.ok(Object.values(rowStatus(plain)).every((s) => s === "not-matched"));
  const [over] = await copyAiPolicies({ policyIds: ["sp-staff"], overwrite: true });
  assert.equal(over.ok, false);
  assert.match(over.error, /partner policy, which is read only, so it can't be overwritten/);
  assert.deepEqual(fake.fusionWrites(), []);
});

test("a create Sophos answers 500 to: found by a read-back with a note, or not found and the same name is not sent again", async () => {
  seed();
  dstAi.answer = { apply: true, response: { status: 502, body: { message: "bad gateway" } } };
  const [found] = await copyAiPolicies({ policyIds: ["sp-edu"] });
  assert.ok(found.ok, found.error);
  assert.equal(found.action, "create");
  assert.match(found.notes[0], /Sophos answered 502, but a read-back found the policy on the destination/);
  assert.equal(fake.fusionWrites().filter((c) => c.op.endsWith("CreatePolicy")).length, 1, "a create is never sent twice");

  seed();
  dstAi.answer = { status: 500, body: { message: "internal" } };
  const results = await copyAiPolicies({ policyIds: ["sp-edu", "sp-edu"] });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /The tool read the destination's AI Defense policies three times( over about \d+ seconds)? and found no new policy named "Education and public sector"/);
  assert.match(results[1].error, /an earlier create in this run with the same name got no clear answer/);
  assert.equal(fake.fusionWrites().length, 1);
  const last = (await readAudit(root)).at(-1);
  assert.equal(last.ok, false);
  assert.equal(last.action, "create");
});

test("a refused move leaves the copy at the top and off, and says so", async () => {
  seed();
  dstAi.refuse.set("MigrationAiDefenseMovePolicy", "move refused");
  try {
    const before = (await readAudit(root)).length;
    const [r] = await copyAiPolicies({ policyIds: ["sp-staff"] });
    assert.ok(r.ok, r.error);
    assert.deepEqual(ops(), ["dst CreatePolicy", "dst MovePolicy"], "not turned on while it sits at the top");
    assert.match(r.notes[0], /left at the top of the destination's order: moving it below "Existing dest" failed \(move refused\)\. Move it in Sophos Fusion; it was left turned off/);
    const copy = dstAi.find(r.destId);
    assert.equal(copy.rank, 1);
    assert.equal(copy.state, "DISABLED");
    assert.deepEqual((await readAudit(root)).slice(before).map((e) => `${e.action} ${e.ok}`), ["create true", "move false"]);
  } finally {
    dstAi.refuse.clear();
  }
});

test("a refused turn-on leaves the copy off where it belongs, and says so", async () => {
  seed();
  dstAi.refuse.set("MigrationAiDefenseEnablePolicy", "enable refused");
  try {
    const [r] = await copyAiPolicies({ policyIds: ["sp-staff"] });
    assert.ok(r.ok, r.error);
    assert.ok(r.notes.includes("created turned off: turning it on failed (enable refused). Turn it on in Sophos Fusion"));
    assert.equal(dstAi.find(r.destId).rank, 2);
  } finally {
    dstAi.refuse.clear();
  }
});

// ---- routes ----

test("GET policies: the list in priority order with the AI Defense setup; a tenant Fusion doesn't hold answers 503", async () => {
  seed();
  const src = await http.get("/api/source/ai-defense/policies");
  assert.equal(src.status, 200);
  assert.deepEqual(src.body.items.map((p) => p.rank), [1, 2, 3, 4, 5, 6]);
  assert.equal(src.body.items.at(-1).kind, "TENANT_BASE");
  assert.deepEqual(src.body.settings, ACTIVE);
  const dst = await http.get("/api/dest/ai-defense/policies");
  assert.equal(dst.body.settings, null, "not set up");

  fake.onFusion(DST, null);
  try {
    const gone = await http.get("/api/dest/ai-defense/policies");
    assert.equal(gone.status, 503);
    assert.match(gone.body.message, /Sophos Fusion does not hold tenant 22222222-2222-4222-8222-222222222222, or this credential can't reach it there/);
    assert.equal((await http.get("/api/compare/ai-defense/policies")).status, 503);
  } finally {
    dstAi.register();
  }
});

test("DELETE: destination only, never the base policy or a partner policy; a delete is audited", async () => {
  seed();
  dstAi.reset([...destPolicies(), { id: "dp-partner", name: "From partner", origin: "PARTNER", rules: [], sensors: { endpoint: { enabled: true, scope: {} } } }]);
  assert.equal((await http.del("/api/source/ai-defense/policies/sp-staff")).status, 400);
  assert.match((await http.del("/api/dest/ai-defense/policies/dp-base")).body.message, /base policy can't be deleted/);
  assert.match((await http.del("/api/dest/ai-defense/policies/dp-partner")).body.message, /partner policy is read only/);
  assert.equal((await http.del("/api/dest/ai-defense/policies/nope")).status, 404);
  assert.deepEqual(fake.fusionWrites(), []);

  const before = (await readAudit(root)).length;
  const res = await http.del("/api/dest/ai-defense/policies/dp-existing");
  assert.equal(res.status, 204);
  assert.equal(dstAi.find("dp-existing"), undefined);
  const [entry] = (await readAudit(root)).slice(before);
  assert.deepEqual([entry.action, entry.resource, entry.resourceId, entry.ok, entry.detail.name], ["delete", "ai-defense-policy", "dp-existing", true, "Existing dest"]);
});

test("POST migrate needs policy IDs; compare and a preview through the route write nothing", async () => {
  seed();
  assert.equal((await http.post("/api/migrate/ai-defense", {})).status, 400);
  const cmp = await http.get("/api/compare/ai-defense/policies");
  assert.equal(cmp.status, 200);
  assert.ok(cmp.body.matches.some((m) => m.status === "source-only"));
  const prev = await http.post("/api/migrate/ai-defense", { policyIds: ["sp-staff"], dryRun: true });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.results[0].action, "dry-run-create");
  assert.deepEqual(fake.fusionWrites(), []);
});
