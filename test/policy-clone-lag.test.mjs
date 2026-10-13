// Sophos can take about 22 s to list a new policy (measured 13/10/2026), while GET by ID finds it at once.
// An unclear create is read back for about 26 s, and a clone run soon after another finds the first copy
// by ID instead of making a duplicate.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { migratePolicies, setRecentCloneWindow } = await import("../backend/dist/services/policy-migrator.js");
const { setReadBackDelays } = await import("../backend/dist/services/write-check.js");
const { SophosClient } = await import("../backend/dist/sophos/client/sophos-client.js");
SophosClient.prototype.sleep = async () => {};
// Three reads for other copies, five for a policy, as in the app; no waiting.
setReadBackDelays([0, 0, 0], [0, 0, 0, 0, 0]);

const src = [{ id: "sp-1", name: "Laptops", type: "threat-protection", enabled: true, priority: 2, settings: {} }];
let dst = [];
let listLag = 0; // list reads a new policy stays out of the list for
let createAnswer = null;
let getById = (id) => dst.find((p) => p.id === id);
let getError = null;

fake.on(SRC, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => ({ body: src.find((p) => p.id === req.path.split("/").pop()) }));
fake.on(SRC, "GET", "/endpoint/v1/policies", (req) => page(src, req.query));
fake.on(DST, "GET", "/endpoint/v1/policies", (req) => {
  for (const p of dst) p.listReads = (p.listReads ?? 0) + 1;
  return page(dst.filter((p) => p.listReads > p.lag).map(({ listReads, lag, ...p }) => p), req.query);
});
fake.on(DST, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, (req) => {
  if (getError) return getError;
  const p = getById(req.path.split("/").pop());
  if (!p) return { status: 404, body: { error: "resourceNotFound", message: "No policy found" } };
  const { listReads, lag, ...rest } = p;
  return { body: rest };
});
fake.on(DST, "POST", "/endpoint/v1/policies", (req) => {
  const p = { id: fake.nextId("dpol"), ...req.body, lag: listLag };
  dst.push(p);
  const { lag, ...body } = p;
  return createAnswer ?? { status: 201, body };
});

beforeEach(() => {
  setRecentCloneWindow(0);
  setRecentCloneWindow(60_000);
  dst = [];
  listLag = 0;
  createAnswer = null;
  getError = null;
});
const posts = () => fake.writes().filter((w) => w.method === "POST");

test("a clone run again before the list shows the first copy finds it by ID and makes no second one", async () => {
  listLag = 99;
  fake.reset();
  const [first] = await migratePolicies({ policyIds: ["sp-1"] });
  assert.equal(first.action, "create");
  const [dry] = await migratePolicies({ policyIds: ["sp-1"], dryRun: true });
  assert.equal(dry.action, "skip-exists");
  const [again] = await migratePolicies({ policyIds: ["sp-1"] });
  assert.equal(again.action, "skip-exists", "before 0.4.2 this made a second Laptops policy");
  assert.equal(again.destId, first.destId);
  assert.equal(posts().length, 1);
});

test("an unclear create is read back for long enough to find a policy the list shows on its fifth read", async () => {
  listLag = 4;
  createAnswer = { status: 500, body: { error: "InternalError" } };
  fake.reset();
  const [r] = await migratePolicies({ policyIds: ["sp-1"] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.destId, dst[0].id);
  assert.match(r.notes[0], /^Sophos answered 500, but a read-back found the policy/);
  const listReads = fake.calls.filter((c) => c.tenant === "dst" && c.method === "GET" && c.path === "/endpoint/v1/policies");
  assert.equal(listReads.length, 6, "the run's own read, then five read-backs");
  assert.ok(listReads.slice(1).every((c) => c.query.policyType === "threat-protection"), "the read-back asks for that type");
  assert.equal(posts().length, 1);
});

test("an unclear create the read-back never finds says it read five times, and blocks another clone for a minute", async () => {
  listLag = 99;
  createAnswer = { status: 500, body: { error: "InternalError" } };
  getById = () => undefined;
  try {
    fake.reset();
    const [r] = await migratePolicies({ policyIds: ["sp-1"] });
    assert.equal(r.ok, false);
    assert.match(r.error, /The tool read the destination's policies 5 times and found no new threat-protection policy named "Laptops"/);
    const [again] = await migratePolicies({ policyIds: ["sp-1"] });
    assert.equal(again.ok, false);
    assert.match(again.error, /^not sent: this tool cloned this policy \d+ s ago and could not confirm that copy/);
    assert.equal(posts().length, 1);
  } finally {
    getById = (id) => dst.find((p) => p.id === id);
  }
});

test("a recent clone that has since been deleted is forgotten, so the policy can be cloned again", async () => {
  listLag = 99;
  fake.reset();
  await migratePolicies({ policyIds: ["sp-1"] });
  dst = [];
  const [again] = await migratePolicies({ policyIds: ["sp-1"] });
  assert.equal(again.action, "create");
  assert.equal(posts().length, 2);
});

test("a recent clone that can't be read blocks another clone instead of risking a duplicate", async () => {
  listLag = 99;
  fake.reset();
  await migratePolicies({ policyIds: ["sp-1"] });
  getError = { status: 503, body: { error: "ServiceUnavailable" } };
  const [again] = await migratePolicies({ policyIds: ["sp-1"] });
  assert.equal(again.ok, false);
  assert.match(again.error, /^not sent: this tool cloned this policy/);
  assert.equal(posts().length, 1);
});
