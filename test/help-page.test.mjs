// The Help page carries the README's hosting note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const help = await readFile(new URL("../frontend/help.html", import.meta.url), "utf8");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("Help says there is no sign-in and how to share the tool, as the README does", () => {
  const security = help.slice(help.indexOf("<h2>Security</h2>"), help.indexOf("<h2>Useful links</h2>"));
  for (const phrase of [
    "The tool has no sign-in of its own.",
    "shares its connection and its jobs, and the audit log does not record who made a change",
    "run it on a server behind your own sign-in, for example a reverse proxy with single sign-on on the same server that forwards to",
    "127.0.0.1:3100",
  ]) {
    assert.ok(security.includes(phrase), `Help: ${phrase}`);
    assert.ok(readme.includes(phrase), `README: ${phrase}`);
  }
});

test("Help says partner and organization credentials work, as the README and the setup wizard do", () => {
  assert.doesNotMatch(help, /Partner or organization credentials are not supported/);
  assert.match(help, /one partner or organization credential that manages both tenants/);
  assert.match(readme, /one partner or organization credential that manages both tenants/);
});

test("Help's Dry runs card names the Preview buttons the pages have, and the pages without one", async () => {
  const card = help.slice(help.indexOf("<h2>Dry runs</h2>"), help.indexOf("<h2>Audit log</h2>"));
  assert.doesNotMatch(card, /The Preview buttons run it/);
  const page = (file) => readFile(new URL(`../frontend/${file}`, import.meta.url), "utf8");
  const button = (html, label) => new RegExp(`<button[^>]*>${label.replace(/[()]/g, "\\$&")}</button>`).test(html);
  for (const [file, label, named] of [
    ["policies.html", "Preview", "Policies"],
    ["exclusions.html", "Preview", "Exclusions"],
    ["web-filtering.html", "Preview", "Web filtering"],
    ["migrate.html", "Preview (dry run)", "Start migration"],
    ["migrate-job-detail.html", "Preview", "Group membership card"],
  ]) {
    assert.ok(button(await page(file), label), `${file} has ${label}`);
    assert.ok(card.includes(named), `Help names ${named}`);
  }
  assert.doesNotMatch(await page("groups.html"), /Preview/, "groups.html has no preview");
  assert.match(card, /The Groups page has no preview/);
  // Compare draws its Preview button from its script.
  const compare = await readFile(new URL("../frontend/js/page-policy-compare.js", import.meta.url), "utf8");
  assert.match(compare, /<button id="preview-btn" class="btn">Preview<\/button>/);
  assert.ok(card.includes("Compare"), "Help names Compare");
});

test("Help and the README name MACEP-11452, the fix, and the Known Issues list", () => {
  const checks = help.slice(help.indexOf("<h2>Checks before a move</h2>"), help.indexOf("<h2>Tamper protection</h2>"));
  assert.match(checks, /runs four read-only checks/);
  for (const [name, text] of [["Help", checks], ["README", readme]]) {
    assert.ok(text.includes("MACEP-11452: a Mac moved through the API to a tenant in another data region only partly migrates, so updates, Live Query and Live Connect fail."), name);
    assert.ok(text.includes("uninstall Sophos from them and reinstall it from the receiving tenant"), name);
    assert.ok(text.includes("https://docs.sophos.com/support/kil/index.html"), name);
  }
});
