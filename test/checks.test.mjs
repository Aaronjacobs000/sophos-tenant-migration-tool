// API #1 (Device Migration pre-flight) and API #2 (destination licence check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSophos, SRC, DST, json } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const fake = createFakeSophos();
await bootApp(fake);
const { evaluateMigrationWindow, checkMigrationWindow } = await import("../backend/dist/services/migration-window.js");
const { analyseLicenses, summariseLicense, checkLicenses } = await import("../backend/dist/services/license-check.js");
const { SophosClient } = await import("../backend/dist/sophos/client/sophos-client.js");

const NOW = new Date("2026-09-24T00:00:00Z");

test("window: off, closed, closing, open, no limit", () => {
  assert.equal(evaluateMigrationWindow({ enabled: false }, NOW).status, "off");
  assert.equal(evaluateMigrationWindow({ enabled: true, expiresAt: "2026-09-20T00:00:00Z" }, NOW).status, "closed");
  const closing = evaluateMigrationWindow({ enabled: true, expiresAt: "2026-09-24T05:00:00Z" }, NOW);
  assert.equal(closing.status, "closing");
  assert.equal(closing.hoursLeft, 5);
  const open = evaluateMigrationWindow({ enabled: true, expiresAt: "2026-10-01T00:00:00Z" }, NOW);
  assert.equal(open.status, "open");
  assert.equal(open.noTimeLimit, false);
  const far = evaluateMigrationWindow({ enabled: true, expiresAt: "2099-01-01T00:00:00Z" }, NOW);
  assert.equal(far.status, "open");
  assert.equal(far.noTimeLimit, true);
  assert.equal(evaluateMigrationWindow({ enabled: true }, NOW).noTimeLimit, true);
  assert.equal(evaluateMigrationWindow({}, NOW).status, "unknown");
  for (const s of [open, closing, far]) assert.doesNotMatch(s.message, /[\u2013\u2014]/);
});

test("window: reads the sending tenant for each direction, GET only", async () => {
  fake.on(SRC, "GET", "/endpoint/v1/settings/migration", () => ({ body: { enabled: true, expiresAt: "2099-01-01T00:00:00Z" } }));
  fake.on(DST, "GET", "/endpoint/v1/settings/migration", () => ({ body: { enabled: false } }));
  const forward = await checkMigrationWindow("source-to-dest");
  assert.equal(forward.sending.side, "source");
  assert.equal(forward.sending.status, "open");
  assert.equal(forward.receiving.status, "off");
  const back = await checkMigrationWindow("dest-to-source");
  assert.equal(back.sending.side, "dest");
  assert.equal(back.sending.status, "off");
  assert.equal(fake.writes().length, 0);
});

test("window: an API error becomes status unknown with the message", async () => {
  fake.on(SRC, "GET", "/endpoint/v1/settings/migration", () => ({ status: 403, body: { error: "Forbidden", message: "not allowed" } }));
  const res = await checkMigrationWindow("source-to-dest");
  assert.equal(res.sending.status, "unknown");
  assert.match(res.sending.error, /403/);
});

const lic = (name, extra = {}) => ({ product: { code: name.toUpperCase().replace(/\W+/g, "-"), name }, type: "term", perpetual: false, endDate: "2027-08-17", ...extra });

test("licence summary: classes, families and free seats", () => {
  const xdrUser = summariseLicense(lic("Sophos XDR - User", { quantity: 100, usage: { current: { count: 40 } } }), NOW);
  assert.equal(xdrUser.deviceClass, "computer");
  assert.deepEqual(xdrUser.families.sort(), ["computer", "xdr"]);
  assert.equal(xdrUser.free, 60);
  const mdrServer = summariseLicense(lic("Sophos MDR Complete - Server MSP Monthly", { unlimited: true, perpetual: true, endDate: undefined }), NOW);
  assert.equal(mdrServer.deviceClass, "server");
  assert.ok(mdrServer.families.includes("mdr"));
  assert.equal(mdrServer.free, null);
  const mobile = summariseLicense(lic("Central Intercept X for Mobile", { quantity: 10 }), NOW);
  assert.equal(mobile.deviceClass, null);
  const fwPack = summariseLicense(lic("Central Firewall Integration Pack", { quantity: 10 }), NOW);
  assert.deepEqual(fwPack.families, []);
  const enc = summariseLicense(lic("Central Device Encryption", { quantity: 5 }), NOW);
  assert.deepEqual(enc.families, ["encryption"]);
  const expired = summariseLicense(lic("Sophos XDR - Server", { endDate: "2026-01-01", quantity: 5 }), NOW);
  assert.equal(expired.expired, true);
});

test("licence analysis: short seats, missing features and no licence for a class", () => {
  const sending = [
    lic("Sophos MDR Complete - User MSP Monthly", { unlimited: true }),
    lic("Central Device Encryption MSP Monthly", { unlimited: true }),
    lic("Sophos MDR Complete - Server MSP Monthly", { unlimited: true }),
  ];
  const receiving = [
    lic("Sophos XDR - User", { quantity: 10, usage: { current: { count: 8 } } }),
    lic("Central MTR Advanced Add-on for Intercept X Advanced with XDR", { quantity: 10, usage: { current: { count: 1 } } }),
  ];
  const a = analyseLicenses(sending, receiving, { total: 6, computers: 5, servers: 1, unknown: 0 }, NOW);
  const xdr = a.seats.find((s) => s.name === "Sophos XDR - User");
  assert.equal(xdr.free, 2);
  assert.equal(xdr.short, true);
  const mtr = a.seats.find((s) => s.name.startsWith("Central MTR"));
  assert.equal(mtr.short, false);
  assert.ok(a.warnings.some((w) => /no server protection licence/.test(w)));
  assert.ok(a.families.find((f) => f.family === "encryption").missing);
  assert.ok(a.families.find((f) => f.family === "server").missing);
  assert.equal(a.families.find((f) => f.family === "mdr").missing, false);
  for (const w of a.warnings) assert.doesNotMatch(w, /[\u2013\u2014]/);
});

test("licence check: calls the global host with the tenant scope header, GET only", async () => {
  fake.reset();
  fake.onGlobal("GET", "/licenses/v1/licenses", (req) => {
    const tenant = req.headers["x-tenant-id"];
    if (tenant === SRC.tenantId) return { body: { licenses: [lic("Sophos XDR - Server", { quantity: 50 })] } };
    if (tenant === DST.tenantId) return { body: { licenses: [lic("Sophos XDR - User", { quantity: 50 })] } };
    return { status: 400, body: { error: "BadRequest" } };
  });
  fake.on(SRC, "GET", /^\/endpoint\/v1\/endpoints\/.+$/, (req) => ({ body: { id: req.path.split("/").pop(), type: req.path.endsWith("srv") ? "server" : "computer", hostname: "h" } }));
  const res = await checkLicenses({ endpointIds: ["ep-1", "ep-srv"], direction: "source-to-dest" });
  assert.deepEqual(res.selected, { total: 2, computers: 1, servers: 1, unknown: 0 });
  assert.ok(res.families.find((f) => f.family === "server").missing);
  const global = fake.calls.filter((c) => c.kind === "global");
  assert.equal(global.length, 2);
  for (const c of global) {
    assert.equal(c.method, "GET");
    assert.ok(c.headers["x-tenant-id"]);
  }
  assert.equal(fake.writes().length, 0);
});

test("licence check: a device listed more than once is read and counted once, so the seat check is not overstated", async () => {
  const PC = "00000000-0000-4000-8000-0000000000aa";
  const SRV = "00000000-0000-4000-8000-0000000000bb";
  fake.reset();
  fake.onGlobal("GET", "/licenses/v1/licenses", (req) => ({
    body: { licenses: req.headers["x-tenant-id"] === DST.tenantId ? [lic("Sophos XDR - User", { quantity: 1 }), lic("Sophos XDR - Server", { quantity: 1 })] : [] },
  }));
  fake.on(SRC, "GET", /^\/endpoint\/v1\/endpoints\/.+$/, (req) => {
    const id = req.path.split("/").pop();
    return { body: { id, type: id.toLowerCase() === SRV ? "server" : "computer", hostname: "h" } };
  });
  const { startHttp } = await import("./helpers/http.mjs");
  const { checksRouter } = await import("../backend/dist/routes/checks.js");
  const http = await startHttp([checksRouter]);
  try {
    const res = await http.post("/api/checks/licenses", { endpointIds: [PC, PC.toUpperCase(), SRV, PC, SRV.toUpperCase()], direction: "source-to-dest" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.selected, { total: 2, computers: 1, servers: 1, unknown: 0 });
    assert.deepEqual(res.body.seats.map((s) => [s.name, s.needed, s.free, s.short]), [["Sophos XDR - User", 1, 1, false], ["Sophos XDR - Server", 1, 1, false]]);
    assert.deepEqual(res.body.warnings.filter((w) => /free seat/.test(w)), []);
    const reads = fake.calls.filter((c) => c.kind === "tenant" && c.path.startsWith("/endpoint/v1/endpoints"));
    assert.deepEqual(reads.map((c) => [c.path, c.query.ids]), [["/endpoint/v1/endpoints", `${PC},${SRV}`]], "each device is read once, by the spelling listed first, in one call");
    assert.equal(fake.writes().length, 0);
  } finally {
    await http.close();
  }
});

test("scope header: an explicit X-Tenant-ID replaces a partner's identity header", async () => {
  const seen = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push(init.headers); return json(200, { licenses: [] }); };
  try {
    const tm = { getToken: async () => "tok" };
    const tr = {
      getIdentity: () => ({ id: "partner-1", idType: "partner", apiHosts: { global: "https://api.central.sophos.com" } }),
      getIdHeader: () => ({ name: "X-Partner-ID", value: "partner-1" }),
    };
    const client = new SophosClient(tm, tr);
    await client.globalRequest("/licenses/v1/licenses", { headers: { "X-Tenant-ID": "tenant-9" } });
    await client.globalRequest("/partner/v1/tenants");
  } finally {
    globalThis.fetch = saved;
  }
  assert.equal(seen[0]["X-Tenant-ID"], "tenant-9");
  assert.equal(seen[0]["X-Partner-ID"], undefined);
  assert.equal(seen[1]["X-Partner-ID"], "partner-1");
});

test("licence check: devices the preload cache does not hold are read 100 IDs a call, not one call each", async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-2${String(i).padStart(11, "0")}`);
  fake.reset();
  fake.onGlobal("GET", "/licenses/v1/licenses", () => ({ body: { licenses: [] } }));
  fake.on(SRC, "GET", "/endpoint/v1/endpoints", (req) => ({
    body: { items: req.query.ids.split(",").filter((id) => !id.endsWith("9")).map((id, i) => ({ id, hostname: "h", type: i % 2 ? "server" : "computer" })), pages: {} },
  }));
  const res = await checkLicenses({ endpointIds: ids, direction: "source-to-dest" });
  const reads = fake.calls.filter((c) => c.kind === "tenant" && c.path.startsWith("/endpoint/v1/endpoints"));
  assert.deepEqual(reads.map((c) => [c.path, c.query.ids.split(",").length]), [["/endpoint/v1/endpoints", 100], ["/endpoint/v1/endpoints", 100], ["/endpoint/v1/endpoints", 50]]);
  assert.equal(res.selected.total, 250);
  assert.equal(res.selected.unknown, 25, "devices with no record are counted as unread");
  assert.equal(res.selected.computers + res.selected.servers, 225);
  assert.equal(fake.writes().length, 0);
});
