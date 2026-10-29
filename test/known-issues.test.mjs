// Known issues on the Start migration page (0.5.1). MACEP-11452: a Mac moved through the API to another
// data region only partly migrates. The check warns and never blocks, and it reads the selection only when
// the tenants are in different regions.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFakeSophos, endpointActions } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";
import { startHttp } from "./helpers/http.mjs";

const fake = createFakeSophos();
const { state } = await bootApp(fake);
const { checksRouter } = await import("../backend/dist/routes/checks.js");
const { KNOWN_ISSUES, isMac, regionOf } = await import("../backend/dist/services/known-issues.js");
const http = await startHttp([checksRouter]);
after(() => http.close());

// Tenants in one data region share its API host, as on Sophos.
const EU = "https://api-eu01.central.sophos.com";
const US = "https://api-us01.central.sophos.com";
const EU_A = fake.addTenant({ tenantId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", clientId: "eu-a-client", secret: "eu-a-secret", host: EU });
const EU_B = fake.addTenant({ tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", clientId: "eu-b-client", secret: "eu-b-secret", host: EU });
const US_C = fake.addTenant({ tenantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", clientId: "us-c-client", secret: "us-c-secret", host: US });

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const device = (n, hostname, platform, name) => ({ id: uuid(n), hostname, type: "computer", os: { isServer: false, platform, name } });
endpointActions(fake, EU_A, [
  device(1, "MBP-1", "macOS", "macOS Sonoma"),
  device(2, "MBP-2", "macOS", "macOS Sequoia"),
  device(3, "PC-3", "windows", "Windows 11 Enterprise"),
]);
endpointActions(fake, US_C, [device(11, "MBP-11", "macOS", "macOS Sonoma")]);

const MACEP = "MACEP-11452";
const URL_MACEP = "https://docs.sophos.com/support/kil/index.html?product=MACEP";
const PARTLY = "A Mac moved through the API to another region only partly migrates: updates, Live Query and Live Connect fail.";

async function pointToolAt(source, dest) {
  await state.saveDirectCredentials({
    source: { clientId: source.clientId, clientSecret: source.secret, label: "Source tenant" },
    dest: { clientId: dest.clientId, clientSecret: dest.secret, label: "Destination tenant" },
  });
  fake.reset();
}

/** The selection reads: [tenant ID, number of IDs]. The preload's full list sends no IDs. */
const selectionReads = () =>
  fake.calls.filter((c) => c.kind === "tenant" && c.path === "/endpoint/v1/endpoints" && c.query.ids).map((c) => [c.tenant, c.query.ids.split(",").length]);

const check = (endpointIds, direction = "source-to-dest") => http.post("/api/checks/known-issues", { endpointIds, direction });

test("cross region with Macs: warns with MACEP-11452, the Mac count, the fix and the link, reading only", async () => {
  await pointToolAt(EU_A, US_C);
  const res = await check([uuid(1), uuid(2), uuid(3), uuid(1).toUpperCase()]);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.sending.region, res.body.receiving.region, res.body.crossRegion], ["eu01", "us01", true]);
  assert.deepEqual(res.body.checked, [MACEP]);
  assert.deepEqual(res.body.findings, [{
    reference: MACEP,
    url: URL_MACEP,
    warning: `MACEP-11452: 2 selected Macs are moving to another data region (eu01 to us01). ${PARTLY} After the move, uninstall Sophos from those Macs and reinstall it from the receiving tenant.`,
  }]);
  assert.deepEqual(fake.writes(), []);
  assert.deepEqual(selectionReads(), [[EU_A.tenantId, 3]], "one read for the selection, each device once");
});

test("cross region without Macs: no warning", async () => {
  await pointToolAt(EU_A, US_C);
  const res = await check([uuid(3)]);
  assert.equal(res.status, 200);
  assert.equal(res.body.crossRegion, true);
  assert.deepEqual(res.body.findings, []);
  assert.deepEqual(res.body.checked, [MACEP]);
  assert.deepEqual(fake.writes(), []);
});

test("same region with Macs: no warning, and the selection is not read", async () => {
  await pointToolAt(EU_A, EU_B);
  const res = await check([uuid(1), uuid(2)]);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.sending.region, res.body.receiving.region, res.body.crossRegion], ["eu01", "eu01", false]);
  assert.deepEqual(res.body.findings, []);
  assert.deepEqual(selectionReads(), []);
  assert.deepEqual(fake.writes(), []);
});

test("a move back reads the destination as the sending tenant and names one Mac", async () => {
  await pointToolAt(EU_A, US_C);
  const res = await check([uuid(11)], "dest-to-source");
  assert.deepEqual([res.body.sending.side, res.body.sending.region, res.body.receiving.region], ["dest", "us01", "eu01"]);
  assert.equal(res.body.findings[0].warning, `MACEP-11452: 1 selected Mac is moving to another data region (us01 to eu01). ${PARTLY} After the move, uninstall Sophos from that Mac and reinstall it from the receiving tenant.`);
  assert.deepEqual(selectionReads(), [[US_C.tenantId, 1]]);
});

// The entry on its own, with the selection and the regions it would see.
const macep = KNOWN_ISSUES.find((i) => i.reference === MACEP);
const region = (side, role, r) => ({ side, role, tenantName: null, region: r });
const move = (crossRegion, records, unread, regions = ["eu01", "us01"]) => ({
  sending: region("source", "sending", regions[0]),
  receiving: region("dest", "receiving", regions[1]),
  crossRegion,
  selection: async () => ({ records, unread }),
});
const mac = { id: "m", os: { platform: "macOS" } };
const pc = { id: "w", os: { platform: "windows" } };

test("devices that could not be read may be Macs, so a cross region move with them warns and says so", async () => {
  assert.equal(
    await macep.warning(move(true, [pc], 2)),
    `MACEP-11452: This move goes to another data region (eu01 to us01), and 2 selected devices could not be read, so they may be Macs. ${PARTLY} After the move, uninstall Sophos from any Macs and reinstall it from the receiving tenant.`,
  );
  assert.equal(
    await macep.warning(move(true, [mac], 1)),
    `MACEP-11452: 1 selected Mac is moving to another data region (eu01 to us01). 1 more selected device could not be read, so it may be a Mac. ${PARTLY} After the move, uninstall Sophos from any Macs and reinstall it from the receiving tenant.`,
  );
});

test("regions that can't be compared warn when Macs are selected, and say to check the regions", async () => {
  assert.equal(
    await macep.warning(move(null, [mac, mac, pc], 0, ["eu01", null])),
    `MACEP-11452: The tenants' data regions could not be compared, so check whether the 2 selected Macs are moving to another region. ${PARTLY} If the regions differ, uninstall Sophos from those Macs after the move and reinstall it from the receiving tenant.`,
  );
  assert.equal(await macep.warning(move(null, [pc], 0, [null, null])), null);
});

test("the same region never reads the selection; no text uses a dash", async () => {
  const same = { ...move(false, [mac], 0), selection: async () => assert.fail("same region must not read the selection") };
  assert.equal(await macep.warning(same), null);
  for (const m of [move(true, [mac], 0), move(true, [mac, mac], 3), move(true, [], 1), move(null, [mac], 0), move(null, [], 2)]) {
    const text = await macep.warning(m);
    assert.ok(text.startsWith("MACEP-11452: "), text);
    assert.doesNotMatch(text, /[\u2013\u2014]/);
  }
});

test("a Mac is told by its platform, or by its OS name when the platform is missing", () => {
  assert.equal(isMac({ os: { platform: "macOS" } }), true);
  assert.equal(isMac({ os: { platform: "windows", name: "Windows 11" } }), false);
  assert.equal(isMac({ os: { platform: "linux", name: "Ubuntu" } }), false);
  assert.equal(isMac({ os: { name: "macOS Ventura" } }), true);
  assert.equal(isMac({ os: { name: "Mac OS X" } }), true);
  assert.equal(isMac({}), false);
});

test("the region is the one the API host names, or the host itself", () => {
  assert.equal(regionOf({ region: "au01", apiHost: "https://api-au01.central.sophos.com" }), "au01");
  assert.equal(regionOf({ region: null, apiHost: "https://API-Other.Example.test" }), "api-other.example.test");
  assert.equal(regionOf({ region: null, apiHost: "" }), null);
});

test("the Start migration page has the known issues card, which shows each warning with a link to the Known Issues list", async () => {
  const html = await readFile(new URL("../frontend/migrate.html", import.meta.url), "utf8");
  const js = await readFile(new URL("../frontend/js/page-migrate.js", import.meta.url), "utf8");
  assert.match(html, /id="known-issues-card"/);
  assert.match(js, /api\.post\("\/api\/checks\/known-issues", \{ endpointIds: ids, direction \}\)/);
  assert.match(js, /escapeHtml\(f\.warning\)\} <a href="\$\{escapeHtml\(f\.url\)\}" target="_blank" rel="noopener">Known Issues list<\/a>/);
});
