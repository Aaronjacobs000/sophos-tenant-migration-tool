// Every list is read past its first page. Without pageTotal the Sophos page-number lists give no page count
// (measured live 13/10/2026), so a list that waits for one stops at 100. A group's member list pages by key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { state } = await bootApp(fake);
const { listPolicies } = await import("../backend/dist/sophos/api/policies.js");
const { listUsers } = await import("../backend/dist/sophos/api/users.js");
const { listUserGroups } = await import("../backend/dist/sophos/api/user-groups.js");
const { listGroups, listGroupMembers } = await import("../backend/dist/sophos/api/groups.js");
const { listScanningExclusions, listAllowedItems } = await import("../backend/dist/sophos/api/exclusions.js");
const { listLocalSites } = await import("../backend/dist/sophos/api/web-control.js");
const { listMigrationJobs, listMigrationJobEndpoints } = await import("../backend/dist/sophos/api/migrations.js");

const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const data = {
  "/endpoint/v1/policies": many(250, (i) => ({ id: `p${i}`, name: `Policy ${i}`, type: i % 2 ? "web-control" : "threat-protection" })),
  "/common/v1/directory/users": many(130, (i) => ({ id: `u${i}`, name: `User ${i}` })),
  "/common/v1/directory/user-groups": many(201, (i) => ({ id: `ug${i}`, name: `Group ${i}` })),
  "/endpoint/v1/endpoint-groups": many(101, (i) => ({ id: `g${i}`, name: `Group ${i}`, type: "computer" })),
  "/endpoint/v1/settings/exclusions/scanning": many(120, (i) => ({ id: `x${i}`, type: "path", value: `C:\\x${i}` })),
  "/endpoint/v1/settings/allowed-items": many(205, (i) => ({ id: `a${i}`, type: "sha256" })),
  "/endpoint/v1/settings/web-control/local-sites": many(150, (i) => ({ id: `s${i}`, url: `s${i}.example.com`, tags: ["T"] })),
  "/endpoint/v1/migrations": many(110, (i) => ({ id: `m${i}`, status: "done" })),
  "/endpoint/v1/migrations/job-1/endpoints": many(230, (i) => ({ id: `e${i}`, status: "succeeded" })),
};
for (const [path, items] of Object.entries(data)) {
  // Answers as Sophos does: a page count only when pageTotal=true is asked for.
  fake.on(DST, "GET", path, (req) => page(items.filter((x) => !req.query.policyType || x.type === req.query.policyType), req.query));
}
const ctx = () => state.requireContext("dest");
const reads = (path) => fake.calls.filter((c) => c.tenant === "dst" && c.path === path);

for (const [label, fn, path, pages] of [
  ["policies", (c) => listPolicies(c.client, c.tenantId), "/endpoint/v1/policies", 3],
  ["users", (c) => listUsers(c.client, c.tenantId), "/common/v1/directory/users", 2],
  ["user groups", (c) => listUserGroups(c.client, c.tenantId), "/common/v1/directory/user-groups", 3],
  ["endpoint groups", (c) => listGroups(c.client, c.tenantId), "/endpoint/v1/endpoint-groups", 2],
  ["scanning exclusions", (c) => listScanningExclusions(c.client, c.tenantId), "/endpoint/v1/settings/exclusions/scanning", 2],
  ["allowed items", (c) => listAllowedItems(c.client, c.tenantId), "/endpoint/v1/settings/allowed-items", 3],
  ["Website Management entries", (c) => listLocalSites(c.client, c.tenantId), "/endpoint/v1/settings/web-control/local-sites", 2],
  ["migration jobs", (c) => listMigrationJobs(c.client, c.tenantId), "/endpoint/v1/migrations", 2],
  ["a migration job's devices", (c) => listMigrationJobEndpoints(c.client, c.tenantId, "job-1"), "/endpoint/v1/migrations/job-1/endpoints", 3],
]) {
  test(`${label}: every page is read, asking for the page count on the first`, async () => {
    fake.reset();
    const items = await fn(ctx());
    assert.deepEqual(items.map((x) => x.id), data[path].map((x) => x.id));
    const calls = reads(path);
    assert.equal(calls.length, pages);
    assert.equal(calls[0].query.pageTotal, "true");
    assert.deepEqual(calls.map((c) => c.query.page), Array.from({ length: pages }, (_, i) => String(i + 1)));
  });
}

test("a policy type filter is sent with every page", async () => {
  fake.reset();
  const items = await listPolicies(ctx().client, ctx().tenantId, { policyType: "web-control" });
  assert.equal(items.length, 125);
  assert.ok(items.every((p) => p.type === "web-control"));
  const calls = reads("/endpoint/v1/policies");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.query.policyType === "web-control"));
});

test("a group's members are read by key, not page number: page numbers are ignored there", async () => {
  const members = many(1100, (i) => ({ id: `ep${i}`, hostname: `PC-${i}` }));
  // As measured on 13/10/2026: page is ignored (page=5 answered with the first page), pages.nextKey leads on.
  fake.on(DST, "GET", "/endpoint/v1/endpoint-groups/g-big/endpoints", (req) => {
    const size = Number(req.query.pageSize ?? 50);
    const from = req.query.pageFromKey ? Number(req.query.pageFromKey) : 0;
    const items = members.slice(from, from + size);
    const next = from + size < members.length ? String(from + size) : undefined;
    return { body: { items, pages: { size, maxSize: 500, ...(next ? { nextKey: next } : {}) } } };
  });
  fake.reset();
  const items = await listGroupMembers(ctx().client, ctx().tenantId, "g-big");
  assert.equal(items.length, 1100);
  assert.equal(new Set(items.map((e) => e.id)).size, 1100, "no page read twice");
  const calls = reads("/endpoint/v1/endpoint-groups/g-big/endpoints");
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((c) => c.query.pageFromKey ?? null), [null, "500", "1000"]);
  assert.ok(calls.every((c) => c.query.page === undefined));
});
