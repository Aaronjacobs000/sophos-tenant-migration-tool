// Policies, users, user groups and endpoint groups are read past the first page. Without pageTotal the
// Sophos list APIs give no page count (measured live 13/10/2026), so a list that waits for one stops at 100.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
const { state } = await bootApp(fake);
const { listPolicies } = await import("../backend/dist/sophos/api/policies.js");
const { listUsers } = await import("../backend/dist/sophos/api/users.js");
const { listUserGroups } = await import("../backend/dist/sophos/api/user-groups.js");
const { listGroups } = await import("../backend/dist/sophos/api/groups.js");

const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const data = {
  "/endpoint/v1/policies": many(250, (i) => ({ id: `p${i}`, name: `Policy ${i}`, type: i % 2 ? "web-control" : "threat-protection" })),
  "/common/v1/directory/users": many(130, (i) => ({ id: `u${i}`, name: `User ${i}` })),
  "/common/v1/directory/user-groups": many(201, (i) => ({ id: `ug${i}`, name: `Group ${i}` })),
  "/endpoint/v1/endpoint-groups": many(101, (i) => ({ id: `g${i}`, name: `Group ${i}`, type: "computer" })),
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
