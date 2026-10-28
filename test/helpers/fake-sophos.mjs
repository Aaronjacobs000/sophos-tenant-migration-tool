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
