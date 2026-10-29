// The dashboard shows the tenant status it has when Sophos refuses a tenant's
// credentials: the preload status then answers 503, and nothing should stay on
// "Checking".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const js = await readFile(new URL("../frontend/js/page-dashboard.js", import.meta.url), "utf8");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const destRefused = {
  status: "configured-invalid",
  mode: "direct",
  source: { configured: true, ok: true, identity: { tenantId: "t-1", displayName: "Test Source", region: "us01" } },
  dest: { configured: true, ok: false, error: 'Sophos auth failed (401): {"error":"invalid_client"}' },
};
const preload503 = Object.assign(new Error("configured-invalid"), {
  status: 503,
  body: { error: "configured-invalid", detail: { dest: destRefused.dest.error } },
});

test("a refused credential: the hero, the details and the steps get the tenant status, and the preload area says which tenant and why", async () => {
  const src = js.slice(js.indexOf("async function loadStatus"), js.indexOf("// ---------- hero ----------"));
  const grid = { innerHTML: "" };
  const drawn = [];
  const page = new Function(
    "api", "getPreloadStatus", "document", "renderHero", "renderTenantDetails", "renderJourney", "renderPreloadGrid", "esc", "SECTIONS",
    `let tenantStatus = null; let journeyData = null; ${src}; return { loadStatus, tenantStatus: () => tenantStatus };`,
  )(
    { get: async (path) => (path === "/api/status" ? destRefused : Promise.reject(new Error(`unexpected ${path}`))) },
    () => Promise.reject(preload503),
    { getElementById: (id) => (id === "preload-grid" ? grid : { innerHTML: "" }) },
    (s) => drawn.push(["hero", s]),
    (s) => drawn.push(["details", s]),
    () => drawn.push(["journey"]),
    () => drawn.push(["grid"]),
    esc,
    [],
  );
  const stop = await page.loadStatus();
  assert.equal(stop, true, "polling stops: nothing loads until the credentials change");
  assert.equal(page.tenantStatus(), destRefused);
  assert.deepEqual(drawn, [["hero", destRefused], ["details", destRefused], ["journey"]]);
  assert.match(grid.innerHTML, /^<div class="banner banner-err">/);
  assert.ok(grid.innerHTML.includes(`Destination not connected: ${esc(destRefused.dest.error)}`), grid.innerHTML);
  assert.match(grid.innerHTML, /Nothing loads until both tenants are connected\. <a href="\/credentials\.html">Update credentials<\/a>/);
});

test("a refused credential: no step card stays on Checking or Waiting", () => {
  const src = js.slice(js.indexOf("function renderJourney"), js.indexOf("function stepCard"));
  const el = { innerHTML: "" };
  const sideName = (side, fallback) => side?.identity?.displayName || fallback;
  const draw = (data) => {
    new Function("document", "esc", "sideName", "verifySummary", "stepCard", "isStale", "tenantStatus", `${src}; return renderJourney;`)(
      { getElementById: () => el }, esc, sideName, () => ({ state: "ok", tag: "All completed", line: "" }),
      (step) => JSON.stringify([step.title, step.state, step.tag]), () => false, destRefused,
    )(data);
    return JSON.parse(`[${el.innerHTML.replace(/\]\[/g, "],[")}]`);
  };
  const before = draw(null);
  assert.deepEqual(before[0], ["Connect", "bad", "1 of 2 connected"]);
  assert.deepEqual(before[1], ["Configuration", "muted", "Not loaded"]);
  assert.deepEqual(before[2], ["Devices", "muted", "Not loaded"]);
  // Once the job list is in, Verify shows it; the cached sections and the policy match all fail.
  const after = draw({ deep: { error: "configured-invalid" }, policyCounts: null, groupsMissing: null, exclusionsMissing: null, epS: null, epD: null, jobs: [] });
  assert.deepEqual(after.map((s) => s[1]), ["bad", "muted", "muted", "muted"]);
  assert.ok(after.every((s) => !["Checking", "Waiting", "Comparing"].includes(s[2])), JSON.stringify(after));
});
