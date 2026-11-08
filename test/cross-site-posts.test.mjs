// A page on another site can post a form, plain text or an empty body to 127.0.0.1 without a CORS
// preflight. None of those may add devices to groups, write to a tenant or start a reload.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createFakeSophos, SRC, DST, page } from "./helpers/fake-sophos.mjs";
import { bootApp, readAudit } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { root } = await bootApp(fake);
const preloader = await import("../backend/dist/services/preloader.js");

// Every router, in the order server.ts mounts them.
const routers = [];
for (const [file, names] of [
  ["status", ["statusRouter"]],
  ["credentials", ["credentialsRouter"]],
  ["compare", ["compareRouter"]],
  ["migrate-config", ["migrateConfigRouter"]],
  ["migrate-devices", ["migrateDevicesRouter"]],
  ["preload", ["preloadRouter"]],
  ["logs", ["logsRouter"]],
  ["search", ["searchRouter"]],
  ["checks", ["checksRouter"]],
  ["web-filters", ["migrateWebFiltersRouter"]],
  ["ai-defense", ["migrateAiDefenseRouter"]],
  ["policies", ["policiesRouter"]],
  ["groups", ["groupsRouter"]],
  ["exclusions", ["exclusionsRouter"]],
  ["endpoints", ["endpointsRouter"]],
  ["web-filters", ["webFiltersRouter"]],
  ["ai-defense", ["aiDefenseRouter"]],
]) {
  const mod = await import(`../backend/dist/routes/${file}.js`);
  for (const n of names) routers.push(mod[n]);
}
const http = await startHttp(routers);
after(() => http.close());

// One moved device whose source group exists on the destination, so a real run would add it.
const DEVICE = "00000000-0000-4000-8000-000000000001";
const NEW = "00000000-0000-4000-8000-00000000000a";
for (const t of [SRC, DST]) {
  fake.on(t, "GET", "/endpoint/v1/migrations/job-1/endpoints", (req) => page([{ id: DEVICE, status: "succeeded", newId: NEW }], req.query));
}
fake.on(DST, "GET", "/endpoint/v1/endpoint-groups", (req) => page([{ id: "dg-fin", name: "Finance", type: "computer" }], req.query));
fake.on(DST, "GET", /^\/endpoint\/v1\/endpoint-groups\/[^/]+\/endpoints$/, () => ({ body: { items: [], pages: { size: 500 } } }));
fake.on(DST, "POST", /^\/endpoint\/v1\/endpoint-groups\/[^/]+\/endpoints$/, (req) => ({ status: 201, body: { addedEndpoints: req.body.ids.map((id) => ({ id })), errors: {} } }));
fake.on(DST, "POST", "/common/v1/directory/user-groups", (req) => ({ status: 201, body: { id: "ug-1", ...req.body } }));

await mkdir(path.join(root, "data"), { recursive: true });
await writeFile(path.join(root, "data", "migration-jobs.json"), JSON.stringify([{
  localJobId: "local-1", jobName: "wave 1", createdAt: new Date().toISOString(), direction: "source-to-dest",
  sourceMigrationId: "job-1", destMigrationId: "job-1",
  endpointIds: [DEVICE], endpointHostnames: { [DEVICE]: "FIN-LT-01" },
  endpointGroups: { [DEVICE]: { id: "sg-fin", name: "Finance" } },
  status: "complete", sourceSnapshot: null, destSnapshot: null,
}], null, 2));

const MEMBERSHIP = "/api/migrate/devices/jobs/local-1/group-membership";
const CREATE_ROUTES = [
  "/api/dest/groups",
  "/api/dest/user-groups",
  "/api/dest/policies",
  "/api/dest/exclusions/scanning",
  "/api/dest/exclusions/allowed-items",
  "/api/dest/exclusions/blocked-items",
];
const PRELOAD_ROUTES = ["/api/preload/start", "/api/preload/refresh/groups/dest"];

/** The three kinds of post another site can send without the browser asking first. */
const crossSite = (p) => [
  ["no body", () => http.bare(p)],
  ["form", () => http.form(p, "dryRun=false&name=x")],
  ["text/plain", () => http.text(p, '{"dryRun":false,"name":"x"}')],
];

async function preloadSettled() {
  for (let i = 0; i < 200; i++) {
    const st = preloader.getPreloadStatus();
    if (!["source", "dest"].some((side) => Object.values(st[side]).some((x) => x.state === "loading"))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("the pages send JSON bodies, so the guards let them through", async () => {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url, init });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const client = await import("../frontend/js/preload-client.js");
    await client.startPreload();
    await client.refreshSection("dest", "groups");
  } finally {
    globalThis.fetch = fake.fetch;
  }
  assert.equal(sent.length, 2);
  for (const { init } of sent) {
    assert.equal(init.method, "POST");
    assert.equal(init.headers["Content-Type"], "application/json");
    assert.equal(init.body, "{}");
  }

  // Every api.post in the frontend passes a body, which api.js sends as JSON.
  const dir = new URL("../frontend/js/", import.meta.url);
  const { readdir } = await import("node:fs/promises");
  let calls = 0;
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".js"))) {
    const js = await readFile(new URL(file, dir), "utf8");
    for (const m of js.matchAll(/api\.post\(/g)) {
      calls++;
      assert.ok(hasSecondArgument(js, m.index + m[0].length), `${file}: api.post without a body at offset ${m.index}`);
    }
  }
  assert.ok(calls >= 15, "found the frontend's posts");

  // The job page states dryRun as a boolean every time.
  const detail = await readFile(new URL("../frontend/js/page-migrate-job-detail.js", import.meta.url), "utf8");
  assert.match(detail, /\/group-membership`, \{ dryRun, choices \}\)/);
  const args = [...detail.matchAll(/loadMembership\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(args.length >= 3);
  for (const a of args) assert.ok(["true", "false", "true, { quiet: true }", "dryRun, { quiet = false } = {}"].includes(a), `loadMembership(${a})`);
});

test("group membership refuses a form, plain text or bodiless post, and adds nothing", async () => {
  fake.reset();
  const before = (await readAudit(root)).length;
  for (const [kind, send] of crossSite(MEMBERSHIP)) {
    const res = await send();
    assert.equal(res.status, 415, kind);
  }
  assert.deepEqual(fake.writes(), []);
  assert.equal((await readAudit(root)).length, before);
});

test("group membership needs dryRun stated as true or false in JSON; the job page's own requests still work", async () => {
  fake.reset();
  for (const body of [{}, { dryRun: "false" }, { dryRun: null }, { dryRun: 0 }, { other: true }]) {
    const res = await http.post(MEMBERSHIP, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(res.body.message, /dryRun/);
  }
  assert.deepEqual(fake.writes(), []);

  const preview = await http.post(MEMBERSHIP, { dryRun: true });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.dryRun, true);
  assert.equal(preview.body.counts["will-add"], 1);
  assert.deepEqual(fake.writes(), [], "a preview writes nothing");

  const real = await http.post(MEMBERSHIP, { dryRun: false });
  assert.equal(real.status, 200);
  assert.equal(real.body.counts.added, 1);
  assert.deepEqual(fake.writes().map((w) => `${w.tenant} ${w.method} ${w.path}`), ["dst POST /endpoint/v1/endpoint-groups/dg-fin/endpoints"]);
});

test("create routes refuse a post another site could send, and an empty JSON body, before calling Sophos", async () => {
  fake.reset();
  for (const p of CREATE_ROUTES) {
    for (const [kind, send] of crossSite(p)) {
      assert.equal((await send()).status, 415, `${kind} ${p}`);
    }
    const empty = await http.post(p, {});
    assert.equal(empty.status, 400, `{} ${p}`);
  }
  assert.deepEqual(fake.writes(), []);

  // A JSON post still reaches Sophos.
  const created = await http.post("/api/dest/user-groups", { name: "Finance users" });
  assert.equal(created.status, 201);
  assert.deepEqual(fake.writes().map((w) => [w.tenant, w.method, w.path, w.body]), [["dst", "POST", "/common/v1/directory/user-groups", { name: "Finance users" }]]);
});

test("no POST route writes to a tenant when another site posts to it", async () => {
  const posts = routers
    .flatMap((r) => r.stack.filter((l) => l.route?.methods.post).map((l) => l.route.path))
    .map((p) => "/api" + p.replace(":side", "dest").replace(":id", "local-1").replace(":section", "groups"));
  assert.ok(posts.includes(MEMBERSHIP) && posts.includes("/api/dest/user-groups") && posts.includes("/api/migrate/ai-defense"), "the sweep covers the real routes");
  fake.reset();
  const before = (await readAudit(root)).length;
  for (const p of posts) {
    for (const [kind, send] of crossSite(p)) {
      const res = await send();
      assert.ok(res.status < 500, `${kind} ${p} answered ${res.status}`);
    }
  }
  await preloadSettled();
  assert.deepEqual(fake.writes(), []);
  assert.equal((await readAudit(root)).length, before);
});

test("the preload routes accept JSON only", async () => {
  fake.reset();
  for (const p of PRELOAD_ROUTES) {
    for (const [kind, send] of crossSite(p)) {
      assert.equal((await send()).status, 415, `${kind} ${p}`);
    }
  }
  assert.deepEqual(fake.calls.filter((c) => c.kind === "tenant"), [], "a refused post starts no reload");

  for (const p of PRELOAD_ROUTES) {
    const res = await http.post(p, {});
    assert.equal(res.status, 200, p);
    assert.equal(res.body.ok, true);
    await preloadSettled();
  }
  assert.ok(fake.calls.some((c) => c.kind === "tenant" && c.method === "GET"), "the dashboard's own requests reload");
});

/** True when the call whose arguments start at `from` has a second top-level argument. */
function hasSecondArgument(js, from) {
  let depth = 0;
  let quote = null;
  for (let i = from; i < js.length; i++) {
    const ch = js[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      else if (quote === "`" && ch === "$" && js[i + 1] === "{") {
        // Skip a template expression, which may hold its own quotes and brackets.
        let d = 1;
        i += 2;
        for (; i < js.length && d > 0; i++) {
          if (js[i] === "{") d++;
          else if (js[i] === "}") d--;
        }
        i--;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) {
      if (depth === 0) return false;
      depth--;
    } else if (ch === "," && depth === 0) {
      // A trailing comma before the closing parenthesis is not a second argument.
      const rest = js.slice(i + 1).trimStart();
      return !rest.startsWith(")");
    }
  }
  return false;
}
