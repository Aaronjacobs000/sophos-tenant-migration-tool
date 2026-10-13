// The tool's API passes on the status Sophos answered with, so a policy that is gone reads as 404, not 500.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { policiesRouter } = await import("../backend/dist/routes/policies.js");
const { groupsRouter } = await import("../backend/dist/routes/groups.js");
const { SophosClient } = await import("../backend/dist/sophos/client/sophos-client.js");
SophosClient.prototype.sleep = async () => {};
const http = await startHttp([policiesRouter, groupsRouter]);
after(() => http.close());

fake.on(SRC, "GET", /^\/endpoint\/v1\/policies\/[^/]+$/, () => ({ status: 404, body: { error: "resourceNotFound", message: "No policy found" } }));
fake.on(DST, "POST", "/endpoint/v1/endpoint-groups", () => ({ status: 400, body: { error: "badRequest", message: '400 BAD_REQUEST "Validation failure"' } }));
fake.on(DST, "GET", /^\/endpoint\/v1\/endpoint-groups\/[^/]+$/, () => ({ status: 503, body: { error: "ServiceUnavailable" } }));
fake.on(DST, "DELETE", /^\/endpoint\/v1\/policies\/[^/]+$/, () => ({ status: 500, body: { error: "InternalError" } }));

test("a Sophos 404 is a 404, with Sophos's message", async () => {
  const res = await http.get("/api/source/policies/gone");
  assert.equal(res.status, 404);
  assert.equal(res.body.error, "sophos_error");
  assert.equal(res.body.status, 404);
  assert.match(res.body.message, /^Sophos API error 404: resourceNotFound - No policy found/);
});

test("a Sophos 400 on a write is a 400", async () => {
  const res = await http.post("/api/dest/groups", { name: "a,b", type: "computer" });
  assert.equal(res.status, 400);
  assert.match(res.body.message, /Validation failure/);
});

test("a read Sophos still answers 5xx after its retries keeps that status", async () => {
  const res = await http.get("/api/dest/groups/g-1");
  assert.equal(res.status, 503);
  assert.equal(fake.calls.filter((c) => c.path === "/endpoint/v1/endpoint-groups/g-1").length, 3, "a read is tried three times");
});

test("a write Sophos answered 500 is a 500 that says it may have gone through", async () => {
  const res = await http.del("/api/dest/policies/p-1");
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "sophos_error");
  assert.match(res.body.message, /The change may still have gone through/);
});

test("an error that is not from Sophos stays a 500 internal error", async () => {
  fake.on(SRC, "GET", "/endpoint/v1/policies", () => new Response("not json", { status: 200 }));
  const res = await http.get("/api/source/policies");
  assert.equal(res.status, 500);
  assert.equal(res.body.error, "internal_error");
});
