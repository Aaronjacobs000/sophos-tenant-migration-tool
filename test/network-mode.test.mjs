// HOST opens the tool to the network; ALLOWED_IPS limits which clients it answers. A client is
// judged by its connection's address, IPv4-mapped IPv6 counts as the IPv4 address it carries, this
// computer is always allowed, and a bad entry stops the server rather than being skipped.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import path from "node:path";
import { createFakeSophos } from "./helpers/fake-sophos.mjs";
import { bootApp } from "./helpers/app.mjs";

const { parseIpAllowList, parseListenHost, networkSettings, isLoopbackIp, normaliseIp } = await import("../backend/dist/config/network.js");
const { allowedClientsOnly } = await import("../backend/dist/middleware/client-ip.js");

test("ALLOWED_IPS matches single IPv4 addresses and subnets", () => {
  const list = parseIpAllowList("192.168.1.0/24, 10.0.0.5, 100.64.0.0/10");
  for (const ip of ["192.168.1.0", "192.168.1.77", "192.168.1.255", "10.0.0.5", "100.64.0.1", "100.105.82.70", "100.127.255.255"]) {
    assert.equal(list.allows(ip), true, ip);
  }
  for (const ip of ["192.168.2.1", "192.168.0.255", "10.0.0.4", "10.0.0.6", "100.63.255.255", "100.128.0.0", "8.8.8.8"]) {
    assert.equal(list.allows(ip), false, ip);
  }
  assert.deepEqual(list.entries, ["192.168.1.0/24", "10.0.0.5", "100.64.0.0/10"]);
});

test("ALLOWED_IPS treats an address with host bits set as its subnet, and /0 and /32 as every and one address", () => {
  assert.equal(parseIpAllowList("192.168.1.10/24").allows("192.168.1.200"), true);
  assert.equal(parseIpAllowList("0.0.0.0/0").allows("203.0.113.9"), true);
  const one = parseIpAllowList("203.0.113.9/32");
  assert.equal(one.allows("203.0.113.9"), true);
  assert.equal(one.allows("203.0.113.8"), false);
});

test("ALLOWED_IPS matches IPv6 addresses and subnets in any spelling", () => {
  const list = parseIpAllowList("fd00::/8, 2001:DB8::1, fe80::/10");
  for (const ip of ["fd7a:115c:a1e0::b734:5248", "2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001", "fe80::1", "[fd00::5]", "fe80::1%en0"]) {
    assert.equal(list.allows(ip), true, ip);
  }
  for (const ip of ["2001:db8::2", "fc00::1", "2600::1", "fec0::1"]) {
    assert.equal(list.allows(ip), false, ip);
  }
  // IPv4 and IPv6 rules never cross: ::/0 is every IPv6 address, not every IPv4 one.
  const v6only = parseIpAllowList("::/0");
  assert.equal(v6only.allows("2600::1"), true);
  assert.equal(v6only.allows("192.168.1.5"), false);
  assert.equal(parseIpAllowList("0.0.0.0/0").allows("2600::1"), false);
});

test("an IPv4-mapped IPv6 client (a dual-stack listener) matches the IPv4 entries", () => {
  const list = parseIpAllowList("192.168.1.0/24, 100.64.0.0/10");
  assert.equal(list.allows("::ffff:192.168.1.20"), true);
  assert.equal(list.allows("::FFFF:100.105.82.70"), true);
  assert.equal(list.allows("::ffff:c0a8:0114"), true, "hex form of 192.168.1.20");
  assert.equal(list.allows("::ffff:192.168.2.20"), false);
  assert.equal(list.allows("::ffff:10.0.0.1"), false);
  // An entry written in mapped form means the IPv4 address too.
  const mapped = parseIpAllowList("::ffff:10.0.0.7, ::ffff:172.16.0.0/108");
  assert.equal(mapped.allows("10.0.0.7"), true);
  assert.equal(mapped.allows("::ffff:10.0.0.7"), true);
  assert.equal(mapped.allows("172.31.255.1"), true, "/108 mapped is /12 IPv4");
  assert.equal(mapped.allows("172.32.0.1"), false);
  assert.equal(normaliseIp("::ffff:192.168.1.20"), "192.168.1.20");
  assert.equal(normaliseIp("2001:0DB8::0001"), "2001:db8::1");
});

test("this computer is always allowed, whatever ALLOWED_IPS says", () => {
  const list = parseIpAllowList("203.0.113.0/24");
  for (const ip of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "0:0:0:0:0:0:0:1"]) {
    assert.equal(list.allows(ip), true, ip);
    assert.equal(isLoopbackIp(ip), true, ip);
  }
  for (const ip of ["", "localhost", "garbage", "128.0.0.1", "::2"]) {
    assert.equal(list.allows(ip), false, JSON.stringify(ip));
  }
});

test("an invalid ALLOWED_IPS entry stops the server, naming every bad entry", () => {
  for (const bad of ["office.lan", "10.0.0.0/33", "fd00::/129", "10.0.0.1/", "10.0.0.0/8/9", "10.0.0.0/-1", "10.0.0.0/x", "1.2.3", "256.1.1.1", "010.0.0.1", "1.2.3.4-1.2.3.9", "*"]) {
    assert.throws(() => parseIpAllowList(`192.168.1.0/24,${bad}`), (err) => {
      assert.match(err.message, /^ALLOWED_IPS has an entry that is not an IP address or subnet/);
      assert.ok(err.message.includes(`"${bad}"`), err.message);
      return true;
    }, bad);
  }
  assert.throws(() => parseIpAllowList("a.lan, 10.0.0.0/8, 1.2.3.4/40"), /entries that are not IP addresses or subnets: "a\.lan", "1\.2\.3\.4\/40".*Host names go in ALLOWED_HOSTS/);
  // Nothing set, or only separators, is no list: every client that can connect is answered.
  for (const empty of [undefined, "", " ", " , ,"]) assert.equal(parseIpAllowList(empty), null);
});

test("HOST defaults to 127.0.0.1 and takes only an IP address", () => {
  assert.equal(parseListenHost(undefined), "127.0.0.1");
  assert.equal(parseListenHost("  "), "127.0.0.1");
  for (const [raw, host] of [["0.0.0.0", "0.0.0.0"], ["::", "::"], ["[::]", "::"], [" 192.168.1.5 ", "192.168.1.5"], ["100.105.82.70", "100.105.82.70"]]) {
    assert.equal(parseListenHost(raw), host, raw);
  }
  for (const bad of ["localhost", "my-mac.local", "0.0.0.0:3100", "*"]) {
    assert.throws(() => parseListenHost(bad), /^Error: HOST must be an IP address/, bad);
  }
  assert.deepEqual(
    { ...networkSettings({}), allowList: null },
    { host: "127.0.0.1", beyondLoopback: false, allowList: null },
  );
  for (const host of ["127.0.0.1", "::1", "127.0.0.2"]) assert.equal(networkSettings({ HOST: host }).beyondLoopback, false, host);
  for (const host of ["0.0.0.0", "::", "192.168.1.5"]) assert.equal(networkSettings({ HOST: host }).beyondLoopback, true, host);
  assert.throws(() => networkSettings({ HOST: "0.0.0.0", ALLOWED_IPS: "lan" }), /ALLOWED_IPS/);
});

test("a credentials save rewrites .env and HOST and ALLOWED_IPS still read back the same", async (t) => {
  const { mkdtemp, writeFile, readFile: read, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dotenv = (await import("dotenv")).default;
  const { readEnvFile, setEnvValues, writeEnvFile } = await import("../backend/dist/config/env-file.js");
  const dir = await mkdtemp(path.join(tmpdir(), "stmt-net-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, ".env");
  await writeFile(file, "HOST=::\nALLOWED_IPS=192.168.1.0/24, fd7a:115c:a1e0::/48,100.64.0.0/10\nCREDENTIAL_MODE=direct\n");
  await writeEnvFile(setEnvValues(await readEnvFile(file), { SOPHOS_SOURCE_LABEL: "Saved by the wizard" }));
  const settings = networkSettings(dotenv.parse(await read(file, "utf8")));
  assert.equal(settings.host, "::");
  assert.deepEqual(settings.allowList.entries, ["192.168.1.0/24", "fd7a:115c:a1e0::/48", "100.64.0.0/10"]);
  assert.equal(settings.allowList.allows("fd7a:115c:a1e0::b734:5248"), true);
});

/** Runs the middleware against a request from `address`, with whatever X-Forwarded-For a client chose to send. */
function run(list, address, headers = {}) {
  let status = null;
  let body = null;
  let passed = false;
  const req = { socket: { remoteAddress: address }, headers };
  const res = { status(code) { status = code; return this; }, json(b) { body = b; return this; } };
  allowedClientsOnly(list)(req, res, () => { passed = true; });
  return { passed, status, body };
}

test("the client check refuses an address outside ALLOWED_IPS with 403, and ignores X-Forwarded-For", () => {
  const list = parseIpAllowList("100.64.0.0/10");
  assert.equal(run(list, "100.105.82.70").passed, true);
  assert.equal(run(list, "::ffff:100.105.82.70").passed, true);
  assert.equal(run(list, "127.0.0.1").passed, true);
  assert.equal(run(list, "::1").passed, true);

  const refused = run(list, "::ffff:192.168.86.50");
  assert.equal(refused.passed, false);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "forbidden_client");
  assert.match(refused.body.message, /\(192\.168\.86\.50\) is not in the tool's ALLOWED_IPS/);

  const spoofed = run(list, "192.168.86.50", { "x-forwarded-for": "100.64.0.1", "x-real-ip": "127.0.0.1" });
  assert.equal(spoofed.passed, false);
  assert.equal(spoofed.status, 403);

  // A socket that has already gone has no address: refused, never waved through.
  assert.equal(run(list, undefined).status, 403);
});

test("with no ALLOWED_IPS the client check answers every client that can connect", () => {
  for (const address of ["192.168.86.50", "2600::1", "127.0.0.1"]) assert.equal(run(null, address).passed, true, address);
});

// Every route, over real HTTP, as server.ts mounts them. The client's address is set per request,
// because a test can only connect from this computer, which is always allowed.
const fake = createFakeSophos();
await bootApp(fake);
const express = (await import("express")).default;
const { localHostOnly } = await import("../backend/dist/middleware/local-host.js");
const { errorHandler } = await import("../backend/dist/middleware/error-handler.js");
const { statusRouter } = await import("../backend/dist/routes/status.js");
const { credentialsRouter } = await import("../backend/dist/routes/credentials.js");
const { migrateDevicesRouter } = await import("../backend/dist/routes/migrate-devices.js");
const { groupsRouter } = await import("../backend/dist/routes/groups.js");

let clientAddress = null;
const app = express();
app.use((req, _res, next) => {
  if (clientAddress) Object.defineProperty(req.socket, "remoteAddress", { value: clientAddress, configurable: true });
  next();
});
app.use(allowedClientsOnly(parseIpAllowList("100.64.0.0/10")));
app.use(localHostOnly);
app.use(express.json());
app.use("/api", statusRouter);
app.use("/api", credentialsRouter);
app.use("/api", migrateDevicesRouter);
app.use("/api", groupsRouter);
const FRONTEND = path.join(process.cwd(), "frontend");
app.use(express.static(FRONTEND, { index: "index.html" }));
app.use((req, res, next) => (req.method !== "GET" || req.path.startsWith("/api/") ? next() : res.sendFile(path.join(FRONTEND, "index.html"))));
app.use(errorHandler);
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
after(() => new Promise((r) => server.close(r)));

function get(p, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      res.resume();
      resolve(res.statusCode);
      req.destroy();
    });
    req.on("error", reject);
    req.end();
  });
}

const ROUTES = ["/", "/index.html", "/help.html", "/js/api.js", "/no-such-page", "/api/status", "/api/credentials", "/api/source/groups", "/api/migrate/devices/jobs", "/api/migrate/devices/jobs/nope/stream"];

test("a client outside ALLOWED_IPS gets 403 from every page, API, Help and the live job stream", async () => {
  clientAddress = "192.168.86.50";
  try {
    for (const p of ROUTES) assert.equal(await get(p), 403, p);
    // A WebSocket-style upgrade is an ordinary request to this server, and is refused the same way.
    assert.equal(await get("/api/migrate/devices/jobs/nope/stream", { Connection: "Upgrade", Upgrade: "websocket" }), 403);
    assert.equal(await get("/api/status", { "X-Forwarded-For": "100.64.0.1" }), 403);
  } finally {
    clientAddress = null;
  }
});

test("a client inside ALLOWED_IPS, and this computer, reach every route", async () => {
  for (const address of ["::ffff:100.105.82.70", null]) {
    clientAddress = address;
    try {
      for (const p of ROUTES) assert.notEqual(await get(p), 403, `${address ?? "loopback"} ${p}`);
      assert.equal(await get("/help.html"), 200);
    } finally {
      clientAddress = null;
    }
  }
});

test("server.ts checks the client before the host check, the body parser and every route", async () => {
  const src = await readFile(new URL("../backend/src/server.ts", import.meta.url), "utf8");
  const guard = src.indexOf("app.use(allowedClientsOnly(network.allowList))");
  assert.ok(guard > 0, "server.ts mounts allowedClientsOnly");
  for (const later of ["app.use(localHostOnly)", "app.use(express.json", 'app.use("/api"', "app.use(express.static"]) {
    assert.ok(src.indexOf(later) > guard, `${later} comes after the client check`);
  }
  assert.match(src, /app\.listen\(PORT, HOST,/);
  assert.match(src, /const HOST = network\.host;/);
});

// The real server, from a copy with no .env, so it starts unconfigured and never reads this
// checkout's settings. fetch is replaced before it loads, so nothing can reach a tenant.
test("a HOST that isn't this computer's, a busy port and any other listen error stop the server with one line and exit code 1", async (t) => {
  const { mkdtemp, cp, symlink, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const net = (await import("node:net")).default;
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(path.join(tmpdir(), "stmt-listen-"));
  // Removes the node_modules link, not what it points at.
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(process.cwd(), "backend/dist"), path.join(root, "backend/dist"), { recursive: true });
  await symlink(path.join(process.cwd(), "node_modules"), path.join(root, "node_modules"), "dir");
  const noFetch = path.join(root, "no-fetch.mjs");
  await writeFile(noFetch, 'globalThis.fetch = () => Promise.reject(new Error("no network in this test"));\n');

  const busy = net.createServer().listen(0, "127.0.0.1");
  await once(busy, "listening");
  const busyPort = busy.address().port;

  function start(env) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", pathToFileURL(noFetch).href, path.join(root, "backend/dist/server.js")], {
        cwd: root,
        env: { PATH: process.env.PATH, JOB_CREDENTIALS_KEY_FILE: path.join(root, "key", "job-credentials.key"), ...env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c) => { stdout += c; });
      child.stderr.on("data", (c) => { stderr += c; });
      // A server that starts listening instead of stopping would never exit.
      const timer = setTimeout(() => child.kill(), 15000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
  }

  try {
    const cases = [
      [{ HOST: "192.0.2.1", PORT: "0" }, /^\[[^\]]+\] error\s+Not starting: HOST is 192\.0\.2\.1, which is not an address on this computer\. Use 127\.0\.0\.1/],
      [{ PORT: String(busyPort) }, new RegExp(`^\\[[^\\]]+\\] error\\s+Not starting: port ${busyPort} on 127\\.0\\.0\\.1 is already in use\\. Stop whatever is using it, or set PORT in \\.env to a free port\\.$`)],
      [{ PORT: "99999" }, /^\[[^\]]+\] error\s+Not starting: can't listen on http:\/\/127\.0\.0\.1:99999: /],
    ];
    for (const [env, line] of cases) {
      const run = await start(env);
      const label = JSON.stringify(env);
      assert.equal(run.code, 1, `${label} exit code`);
      const lines = run.stderr.trim().split("\n");
      assert.equal(lines.length, 1, `${label} one line: ${run.stderr}`);
      assert.match(lines[0], line, label);
      assert.doesNotMatch(run.stdout + run.stderr, /\n\s+at |listening on/, `${label} no stack trace, never listened`);
    }
  } finally {
    busy.close();
  }
});
