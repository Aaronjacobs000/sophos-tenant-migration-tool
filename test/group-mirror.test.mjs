// Group mirroring: the create API rejects an empty description, and user
// groups already on the destination are skipped and every create is audited.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const { mirrorGroups, mirrorUserGroups, endpointGroupDescription } = await import("../backend/dist/services/group-mirror.js");
const { migrateConfigRouter } = await import("../backend/dist/routes/migrate-config.js");
const http = await startHttp([migrateConfigRouter]);
after(() => http.close());

// As the live API returns them: a group made without a description reads back as "".
const srcGroups = [
  { id: "sg-1", name: "Parent group", type: "computer", description: "" },
  { id: "sg-2", name: "Finance", type: "computer", description: "Finance laptops" },
  { id: "sg-3", name: "SQL", type: "server" },
  { id: "sg-6", name: "Sydney, level 3", type: "computer", description: "" },
  { id: "sg-5", name: "Sydney", type: "computer", description: 'Level 3, "east" wing; desks #1 to #40' },
];
fake.on(SRC, "GET", "/endpoint/v1/endpoint-groups", (req) => page(srcGroups, req.query));
fake.on(SRC, "GET", /^\/endpoint\/v1\/endpoint-groups\/[^/]+$/, (req) => {
  const g = srcGroups.find((x) => x.id === req.path.split("/").pop());
  return g ? { body: g } : { status: 404, body: { error: "NotFound" } };
});
fake.on(DST, "GET", "/endpoint/v1/endpoint-groups", (req) => page([], req.query));
// Measured on a live tenant 25/09/2026: description "" is a 400. And on 13/10/2026: a comma, semicolon,
// # or double quote in the description is a 400 too.
fake.on(DST, "POST", "/endpoint/v1/endpoint-groups", (req) =>
  req.body.description === "" || /[,;#"]/.test(req.body.description ?? "")
    ? { status: 400, body: { error: "badRequest", message: '400 BAD_REQUEST "Validation failure"' } }
    : { status: 201, body: { id: fake.nextId("dg"), ...req.body } });

test("groups with an empty or missing description mirror without one", async () => {
  fake.reset();
  const results = await mirrorGroups({ groupIds: ["sg-1", "sg-2", "sg-3"] });
  assert.deepEqual(results.map((r) => [r.sourceName, r.ok, r.action]), [
    ["Parent group", true, "create"],
    ["Finance", true, "create"],
    ["SQL", true, "create"],
  ]);
  const posts = fake.writes().filter((w) => w.method === "POST");
  assert.equal("description" in posts[0].body, false);
  assert.equal(posts[1].body.description, "Finance laptops");
  assert.equal("description" in posts[2].body, false);
  assert.equal(posts[2].body.type, "server");
});

test("a second source group with a name mirrored in the same run is already there, in a dry run too", async () => {
  srcGroups.push({ id: "sg-4", name: "FINANCE", type: "computer", description: "" });
  try {
    for (const dryRun of [true, false]) {
      fake.reset();
      const results = await mirrorGroups({ groupIds: ["sg-2", "sg-4", "sg-2"], dryRun });
      assert.deepEqual(results.map((r) => r.action), dryRun ? ["dry-run-create", "skip-exists", "skip-exists"] : ["create", "skip-exists", "skip-exists"]);
      assert.equal(fake.writes().length, dryRun ? 0 : 1, "before 26/09/2026 this made three groups");
    }
  } finally {
    srcGroups.pop();
  }
});

// ---- user groups ----

const srcUserGroups = [
  { id: "su-1", name: "Finance", description: "Finance staff" },
  { id: "su-2", name: "IT admins", description: "" },
  { id: "su-3", name: "Contractors" },
];
const dstUserGroups = [{ id: "du-1", name: "finance", description: "Already here" }];
fake.on(SRC, "GET", "/common/v1/directory/user-groups", (req) => page(srcUserGroups, req.query));
fake.on(DST, "GET", "/common/v1/directory/user-groups", (req) => page(dstUserGroups, req.query));
fake.on(DST, "POST", "/common/v1/directory/user-groups", (req) =>
  req.body.name === "Contractors"
    ? { status: 400, body: { error: "badRequest", message: "refused" } }
    : { status: 201, body: { id: fake.nextId("du"), ...req.body } });

test("user groups: one already on the destination is skipped, the others are created and audited", async () => {
  fake.reset();
  const before = (await readAudit(root)).length;
  const results = await mirrorUserGroups({ userGroupIds: ["su-1", "su-2", "su-3", "su-gone"] });
  assert.deepEqual(results.map((r) => [r.sourceName, r.ok, r.action]), [
    ["Finance", true, "skip-exists"],
    ["IT admins", true, "create"],
    ["Contractors", false, "create"],
    ["(unknown)", false, "create"],
  ]);
  assert.match(results[3].error, /not found/);
  const posts = fake.writes().filter((w) => w.method === "POST").map((w) => w.body);
  assert.deepEqual(posts, [{ name: "IT admins" }, { name: "Contractors" }], "no empty description is sent");
  const audit = (await readAudit(root)).slice(before);
  assert.deepEqual(audit.map((a) => [a.resource, a.ok, a.detail.name]), [["user-group", true, "IT admins"], ["user-group", false, "Contractors"]]);
});

test("user groups: a dry run writes nothing, and plans a name once", async () => {
  fake.reset();
  const results = await mirrorUserGroups({ userGroupIds: ["su-1", "su-2", "su-2"], dryRun: true });
  assert.deepEqual(results.map((r) => r.action), ["skip-exists", "dry-run-create", "skip-exists"]);
  assert.deepEqual(fake.writes(), []);
});

test("POST /api/migrate/user-groups needs IDs and returns one result per group", async () => {
  fake.reset();
  assert.equal((await http.post("/api/migrate/user-groups", {})).status, 400);
  const res = await http.post("/api/migrate/user-groups", { userGroupIds: ["su-1"], dryRun: true });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.results.map((r) => [r.sourceId, r.action]), [["su-1", "skip-exists"]]);
  assert.deepEqual(fake.writes(), []);
});

test("a description with characters Sophos refuses is sent without them, and the result says so", async () => {
  assert.deepEqual(endpointGroupDescription("Finance laptops"), { description: "Finance laptops" });
  assert.deepEqual(endpointGroupDescription(undefined), { description: "" });
  const tidy = endpointGroupDescription('Level 3, "east" wing; desks #1 to #40');
  assert.equal(tidy.description, "Level 3 east wing desks 1 to 40");
  assert.match(tidy.changed, /^description changed: Sophos refuses commas, semicolons, #, double quotes in endpoint group descriptions through its API/);

  fake.reset();
  const [r] = await mirrorGroups({ groupIds: ["sg-5"] });
  assert.equal(r.ok, true, r.error);
  const [post] = fake.writes();
  assert.equal(post.body.description, "Level 3 east wing desks 1 to 40");
  assert.equal(post.body.name, "Sydney", "the name is the match key and is sent as it is");
  assert.match(r.notes[0], /^description changed:/);
});

test("a group whose name Sophos would refuse is not sent, and the result says to rename it on the source", async () => {
  for (const dryRun of [true, false]) {
    fake.reset();
    const [r] = await mirrorGroups({ groupIds: ["sg-6"], dryRun });
    assert.equal(r.ok, false);
    assert.match(r.error, /^not sent: Sophos refuses commas in endpoint group names through its API, and the tool matches groups by name, so it does not change it: rename the group on the source/);
    assert.deepEqual(fake.writes(), []);
  }
});
