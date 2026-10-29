// In-memory stand-in for the Sophos APIs. Replaces globalThis.fetch so the
// compiled backend talks to it instead of the network. Every request is
// recorded, which lets tests assert exactly which writes happened.

export const SRC = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  clientId: "src-client",
  secret: "src-secret",
  host: "https://api-src.example.test",
};
export const DST = {
  tenantId: "22222222-2222-4222-8222-222222222222",
  clientId: "dst-client",
  secret: "dst-secret",
  host: "https://api-dst.example.test",
};

/** A third tenant, for pointing the tool at another pair. */
export const OTHER = {
  tenantId: "33333333-3333-4333-8333-333333333333",
  clientId: "oth-client",
  secret: "oth-secret",
  host: "https://api-oth.example.test",
};

const GLOBAL = "https://api.central.sophos.com";
const AUTH = "https://id.sophos.com/api/v2/oauth2/token";

export function createFakeSophos() {
  const calls = [];
  const tenants = { [SRC.tenantId]: SRC, [DST.tenantId]: DST, [OTHER.tenantId]: OTHER };
  const byToken = { "tok-src": SRC, "tok-dst": DST, "tok-oth": OTHER };
  // routes[tenantId] = [{ method, path (string or RegExp), handler(req) }]
  const routes = { [SRC.tenantId]: [], [DST.tenantId]: [], [OTHER.tenantId]: [] };
  const globalRoutes = [];
  // Tenants whose API credential has been deleted: sign-in and every call with its token are refused.
  const revoked = new Set();
  let seq = 0;

  const fake = {
    calls,
    /** Add a tenant: { tenantId, clientId, secret, host }. Its access token is "tok-" + clientId. */
    addTenant(t) {
      tenants[t.tenantId] = t;
      byToken[`tok-${t.clientId}`] = t;
      routes[t.tenantId] = [];
      return t;
    },
    /** Delete a tenant's API credential, as if removed in Sophos Fusion. */
    revoke(tenant) {
      revoked.add(tenant.tenantId);
      return fake;
    },
    restore(tenant) {
      revoked.delete(tenant.tenantId);
      return fake;
    },
    /** Register a handler for one tenant. Later registrations win. */
    on(tenant, method, path, handler) {
      routes[tenant.tenantId].unshift({ method, path, handler });
      return fake;
    },
    /** Register a handler on the global host (licensing). */
    onGlobal(method, path, handler) {
      globalRoutes.unshift({ method, path, handler });
      return fake;
    },
    /** Writes (anything but GET) made to a tenant data host. */
    writes() {
      return calls.filter((c) => c.method !== "GET" && c.kind === "tenant");
    },
    reset() {
      calls.length = 0;
    },
    nextId(prefix = "id") {
      seq++;
      return `${prefix}-${String(seq).padStart(4, "0")}`;
    },
  };

  async function fetchImpl(input, init = {}) {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }

    if (url.href === AUTH) {
      const form = new URLSearchParams(init.body);
      const id = form.get("client_id");
      calls.push({ kind: "auth", method, url: url.href, clientId: id });
      const t = Object.values(tenants).find((x) => x.clientId === id);
      if (t && !revoked.has(t.tenantId) && form.get("client_secret") === t.secret) {
        const token = Object.keys(byToken).find((k) => byToken[k] === t);
        return json(200, { access_token: token, expires_in: 3600, token_type: "bearer" });
      }
      return json(401, { error: "invalid_client" });
    }

    const bearer = (headers.authorization ?? "").replace(/^Bearer /, "");
    const caller = byToken[bearer];
    if (!caller || revoked.has(caller.tenantId)) return json(401, { error: "Unauthorized", message: "bad token" });

    if (url.origin === GLOBAL && url.pathname === "/whoami/v1") {
      calls.push({ kind: "whoami", method, url: url.href });
      // A tenant added with idType "partner" answers as a partner credential (no data region of its own).
      if (caller.idType === "partner") return json(200, { id: caller.tenantId, idType: "partner", apiHosts: { global: GLOBAL } });
      return json(200, { id: caller.tenantId, idType: "tenant", apiHosts: { global: GLOBAL, dataRegion: caller.host } });
    }

    const req = { method, url, path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body, caller };

    if (url.origin === GLOBAL) {
      calls.push({ kind: "global", ...req, url: url.href });
      const route = match(globalRoutes, method, url.pathname);
      if (!route) return json(404, { error: "NotFound", message: `fake: no global route for ${method} ${url.pathname}` });
      return respond(await route.handler(req));
    }

    const tenant = Object.values(tenants).find((t) => t.host === url.origin);
    if (!tenant) throw new Error(`fake-sophos: unexpected host ${url.origin}`);
    if (headers["x-tenant-id"] !== tenant.tenantId) return json(403, { error: "Forbidden", message: "tenant header mismatch" });
    calls.push({ kind: "tenant", tenant: tenant === SRC ? "src" : tenant === DST ? "dst" : tenant === OTHER ? "oth" : tenant.tenantId, ...req, url: url.href });
    // The gateway refuses a request line over 7,168 bytes (measured 29/10/2026).
    if (`${method} ${url.pathname}${url.search} HTTP/1.1`.length > 7168) {
      return json(414, { fault: { faultstring: "request line size exceeding 7,168", detail: { errorcode: "protocol.http.TooBigLine" } } });
    }
    const route = match(routes[tenant.tenantId], method, url.pathname);
    // A list by IDs with no route of its own answers from the per-device routes, as the API does.
    if (!route && method === "GET" && url.pathname === "/endpoint/v1/endpoints" && url.searchParams.get("ids")) {
      const items = [];
      for (const id of url.searchParams.get("ids").split(",")) {
        const one = match(routes[tenant.tenantId], "GET", `/endpoint/v1/endpoints/${id}`);
        if (!one) continue;
        const res = respond(await one.handler({ ...req, path: `/endpoint/v1/endpoints/${id}`, query: {} }));
        if (res.status === 200) items.push(await res.json());
      }
      return json(200, { items, pages: { size: items.length, maxSize: 500 } });
    }
    if (!route) {
      if (method === "GET") return json(200, { items: [], pages: { current: 1, size: 100, total: 1, maxSize: 100 } });
      return json(404, { error: "NotFound", message: `fake: no route for ${method} ${url.pathname}` });
    }
    return respond(await route.handler(req));
  }

  fake.fetch = fetchImpl;
  return fake;
}

function match(list, method, path) {
  return list.find((r) => r.method === method && (typeof r.path === "string" ? r.path === path : r.path.test(path)));
}

function respond(result) {
  if (result instanceof Response) return result;
  const { status = 200, body = {} } = result ?? {};
  return json(status, body);
}

export function json(status, body) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A page-number list response with pageTotal support, like the Sophos settings APIs. */
export function page(items, query = {}, size = 100) {
  const n = Math.max(1, Number(query.page ?? 1));
  const pageSize = Math.max(1, Number(query.pageSize ?? size));
  const total = Math.ceil(items.length / pageSize);
  const slice = items.slice((n - 1) * pageSize, n * pageSize);
  const pages = { current: n, size: pageSize, maxSize: 100 };
  if (query.pageTotal === "true") Object.assign(pages, { total, items: items.length });
  return { status: 200, body: { items: slice, pages } };
}

/**
 * Endpoint records on one tenant, with the bulk tamper protection and scan
 * calls, as measured on 29/10/2026:
 *   - POST /endpoint/v1/endpoints/tamper-protection takes 1 to 200 IDs and
 *     { enabled, regeneratePassword }, answers 202 with per-device `items` and
 *     `errors` (left out when there are none), and changes the record at once.
 *   - POST /endpoint/v1/endpoints/scans takes 1 to 500 IDs.
 *   - GET /endpoint/v1/endpoints/{id}/tamper-protection has the password and
 *     previousPasswords with invalidatedAt.
 * Controls: `global` (the tenant's setting), `neverApply` (IDs answered
 * "requested" whose record never changes), `refuse` (ID to errorCode),
 * `answer` (replace the next answer, for a 500 or a 400).
 */
export function endpointActions(fake, tenant, records) {
  const ctl = {
    records: new Map(records.map((r) => [r.id, { tamperProtectionSupported: true, tamperProtectionEnabled: false, ...r }])),
    passwords: new Map(),
    global: { enabled: true },
    neverApply: new Set(),
    refuse: new Map(),
    answer: null,
    tamperCalls: [],
    scanCalls: [],
  };
  let n = 0;
  const password = (id) => {
    if (!ctl.passwords.has(id)) ctl.passwords.set(id, { password: `pw-${id}-0`, previousPasswords: [] });
    return ctl.passwords.get(id);
  };
  const bulk = (req, max, apply) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    if (ids.length < 1 || ids.length > max) {
      return { status: 400, body: { error: "badRequest", message: `Value of 'ids' field was rejected with message: size must be between 1 and ${max}` } };
    }
    if (ctl.answer) {
      const a = ctl.answer;
      ctl.answer = null;
      const out = typeof a === "function" ? a(req) : a;
      if (out?.apply) for (const id of ids) if (ctl.records.has(id)) apply(id);
      return out?.apply ? out.response : out;
    }
    const items = [];
    const errors = [];
    for (const id of ids) {
      const rec = ctl.records.get(id);
      if (!rec) errors.push({ id, errorCode: "notFound", errorMessage: "Endpoint not found" });
      else if (ctl.refuse.has(id)) errors.push({ id, errorCode: ctl.refuse.get(id), errorMessage: `refused by the test (${ctl.refuse.get(id)})` });
      else if (rec.tamperProtectionSupported === false && max === 200) errors.push({ id, errorCode: "notSupported", errorMessage: "Tamper protection is not supported" });
      else {
        items.push({ id, status: "requested", requestedAt: new Date().toISOString() });
        if (!ctl.neverApply.has(id)) apply(id);
      }
    }
    return { status: 202, body: { items, ...(errors.length ? { errors } : {}) } };
  };
  const applyTamper = (body) => (id) => {
    const rec = ctl.records.get(id);
    if (typeof body.enabled === "boolean" && (ctl.global.enabled || !body.enabled)) rec.tamperProtectionEnabled = body.enabled;
    if (body.regeneratePassword) {
      const p = password(id);
      p.previousPasswords.push({ password: p.password, invalidatedAt: new Date().toISOString() });
      p.password = `pw-${id}-${++n}`;
    }
  };
  fake.on(tenant, "GET", "/endpoint/v1/settings/tamper-protection", () => ({ body: ctl.global }));
  fake.on(tenant, "GET", "/endpoint/v1/endpoints", (req) => {
    const ids = (req.query.ids ?? "").split(",").filter(Boolean);
    const items = ids.length ? ids.map((id) => ctl.records.get(id)).filter(Boolean) : [...ctl.records.values()];
    return { body: { items: items.map((r) => ({ ...r })), pages: { size: items.length, maxSize: 500 } } };
  });
  fake.on(tenant, "GET", /^\/endpoint\/v1\/endpoints\/[^/]+$/, (req) => {
    const rec = ctl.records.get(req.path.split("/").pop());
    return rec ? { body: { ...rec } } : { status: 404, body: { error: "NotFound", message: "endpoint not found" } };
  });
  fake.on(tenant, "GET", /^\/endpoint\/v1\/endpoints\/[^/]+\/tamper-protection$/, (req) => {
    const id = req.path.split("/")[4];
    const rec = ctl.records.get(id);
    if (!rec) return { status: 404, body: { error: "NotFound" } };
    const p = password(id);
    return { body: { enabled: rec.tamperProtectionEnabled, password: p.password, previousPasswords: p.previousPasswords } };
  });
  fake.on(tenant, "POST", "/endpoint/v1/endpoints/tamper-protection", (req) => {
    ctl.tamperCalls.push(req.body);
    return bulk(req, 200, applyTamper(req.body ?? {}));
  });
  fake.on(tenant, "POST", "/endpoint/v1/endpoints/scans", (req) => {
    ctl.scanCalls.push(req.body);
    return bulk(req, 500, () => {});
  });
  return ctl;
}
