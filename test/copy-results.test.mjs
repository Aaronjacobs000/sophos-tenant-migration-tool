// A copy's message and its results list count the same things: items already
// on the destination are "already there", not copied.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { countOutcomes, outcomeOf } from "../frontend/js/ui.js";

const page = (file) => readFile(new URL(`../frontend/js/${file}`, import.meta.url), "utf8");

// As the migrate routes return them: eleven created and one already on the destination.
const copied = [
  ...Array.from({ length: 11 }, (_, i) => ({ type: "scanning", sourceId: `s${i}`, ok: true, action: "create" })),
  { type: "scanning", sourceId: "s-dup", ok: true, action: "skip-exists" },
];

test("counts match the tags in the results list", () => {
  const n = countOutcomes(copied);
  assert.deepEqual(n, { created: 11, "would-create": 0, skipped: 1, failed: 0 });
  assert.equal(n.created, copied.filter((r) => outcomeOf(r) === "created").length);

  const mixed = [
    { ok: true, action: "dry-run-create" },
    { ok: true, action: "dry-run-overwrite" },
    { ok: true, action: "skip-exists" },
    { ok: false, action: "create", error: "refused" },
  ];
  assert.deepEqual(countOutcomes(mixed), { created: 0, "would-create": 2, skipped: 1, failed: 1 });
});

test("exclusions: the copy message counts created items, as the list does", async () => {
  const js = await page("page-exclusions.js");
  const copy = js.slice(js.indexOf('getElementById("basket-copy")'), js.indexOf("// One line of text"));
  assert.match(copy, /const n = countOutcomes\(res\.results \?\? \[\]\);/);
  assert.match(copy, /toast\(`Copied \$\{n\.created\} \/ failed \$\{n\.failed\}`/);
  assert.doesNotMatch(copy, /filter\(\(r\) => r\.ok\)/);
  const list = js.slice(js.indexOf("function showResults"));
  assert.match(list, /countOutcomes\(results\)/);
});

test("groups: the mirror lists every group, counted as the list tags them", async () => {
  const js = await page("page-groups.js");
  const mirror = js.slice(js.indexOf('getElementById("basket-mirror")'), js.indexOf("function esc("));
  assert.match(mirror, /mirror\("\/api\/migrate\/groups", \{ groupIds: epIds \}/);
  // User groups go through the route that skips ones already there and audits each create.
  assert.match(mirror, /mirror\("\/api\/migrate\/user-groups", \{ userGroupIds: ugIds \}/);
  assert.doesNotMatch(mirror, /\/api\/dest\/user-groups/);
  assert.match(mirror, /const n = countOutcomes\(\[\.\.\.endpoint, \.\.\.user\]\);\s*toast\(`Mirrored \$\{n\.created\} \/ failed \$\{n\.failed\}`/);
  assert.match(mirror, /showResults\(endpoint, user\);/);
  const list = js.slice(js.indexOf("function showResults"));
  assert.match(list, /outcome: outcomeOf\(r\)/);
  assert.match(list, /resultsModal\(\{/);
  assert.match(list, /plural\(n\.created, "group"\)/);
});

test("policies: both clone buttons and the preview show the results list", async () => {
  const js = await page("page-policies.js");
  assert.equal([...js.matchAll(/api\.post\("\/api\/migrate\/policies"/g)].length, 3);
  assert.equal([...js.matchAll(/reportClone\(res\.results \?\? \[\]\);/g)].length, 2);
  assert.equal([...js.matchAll(/reportClone\(res\.results \?\? \[\], true\);/g)].length, 1, "the preview");
  assert.match(js, /policyIds: ids,\s*dryRun: true,/);
  assert.doesNotMatch(js, /filter\(\(r\) => r\.ok\)/);
  const report = js.slice(js.indexOf("function reportClone"), js.indexOf("function summarizeAssignments"));
  assert.match(report, /const n = countOutcomes\(results\);/);
  assert.match(report, /toast\(`Cloned \$\{n\.created\} \/ failed \$\{n\.failed\}/);
  assert.match(report, /outcome: outcomeOf\(r\)/);
  assert.match(report, /notes: notesOf\(r\)/);
  assert.match(report, /plural\(n\.created, "policy", "policies"\)/);
  assert.match(report, /title: dryRun \? "Preview: nothing was written" : "Clone results"/);
});

test("policy Compare: an overwrite or clone shows the results list, which stays open while Compare runs again", async () => {
  const js = await page("page-policy-compare.js");
  const write = js.slice(js.indexOf("async function cloneToDest"), js.indexOf("function showResults"));
  assert.equal([...js.matchAll(/api\.post\("\/api\/migrate\/policies"/g)].length, 2, "the write and its preview");
  assert.match(write, /showResults\(results, overwrite\);/);
  // A request that fails outright is a failed row with its reason.
  assert.match(write, /results = \[\{ sourceId: state\.sourcePolicy\.id, ok: false, [^\]]*error: err\.message/);
  // Compare runs again in place: a page reload would close the list. The
  // destination's cached policies are refreshed first, so the Policies page shows the write.
  assert.match(write, /if \(results\.some\(\(r\) => r\.ok\)\) \{\s*await refreshSection\("dest", "policies"\)\.catch\(\(\) => \{\}\);\s*await load\(\);\s*\}/);
  assert.doesNotMatch(js, /location\.reload/);
  const list = js.slice(js.indexOf("function showResults"));
  assert.match(list, /outcome: r\.ok && r\.action === "overwrite" \? "updated" : r\.ok && r\.action === "dry-run-overwrite" \? "would-update" : outcomeOf\(r\)/);
  assert.match(list, /error: r\.error/);
  assert.match(list, /notes: notesOf\(r\)/);
  assert.match(list, /resultsModal\(\{/);
  const ui = await readFile(new URL("../frontend/js/ui.js", import.meta.url), "utf8");
  assert.match(ui, /updated: `<span class="tag tag-ok">updated<\/span>`/);
});
