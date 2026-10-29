#!/usr/bin/env node
/**
 * Export Sophos Fusion (formerly Sophos Central) policy assignments to CSV.
 *
 * Answers GitHub issue #1: "view and export the records of all Peripheral
 * Control policy assigned and which user/device/group ... can we automate this?"
 *
 * For each Peripheral Control and Application Control policy it lists the
 * users, user groups, endpoints and endpoint groups the policy is assigned to
 * (the Sophos `appliesTo` block), resolving IDs to human-readable names.
 *
 * No dependencies: uses the global fetch in Node 18+.
 *
 * Usage:
 *   SOPHOS_CLIENT_ID=xxx SOPHOS_CLIENT_SECRET=yyy \
 *     node scripts/export-policy-assignments.mjs > policy-assignments.csv
 *
 * Optional:
 *   POLICY_TYPES=peripheral-control,application-control,server-peripheral-control,server-application-control
 *   (default shown; server policies are distinct types in the API)
 *   Create the Client ID/Secret in the tenant under
 *   Global Settings > API Credentials (needs read access to Endpoint + Common).
 */

const AUTH_URL = "https://id.sophos.com/api/v2/oauth2/token";
const WHOAMI_URL = "https://api.central.sophos.com/whoami/v1";
const POLICY_TYPES = (process.env.POLICY_TYPES ??
  "peripheral-control,application-control,server-peripheral-control,server-application-control")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

async function getToken(clientId, clientSecret) {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "token",
  });
  // redirect: "manual" on every call: a followed 307 or 308 would send the client secret or the
  // tenant ID to the new host. A redirect is not ok, so it fails with its status.
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function whoami(token) {
  const res = await fetch(WHOAMI_URL, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
  });
  if (!res.ok) throw new Error(`whoami failed: ${res.status} ${await res.text()}`);
  const w = await res.json();
  const apiHost = w.apiHosts?.dataRegion;
  if (!apiHost) {
    throw new Error(
      "No dataRegion host in whoami: these look like partner/org credentials. " +
        "Run this with direct-tenant API credentials, or set a tenant explicitly.",
    );
  }
  return { tenantId: w.id, apiHost };
}

/**
 * Generic Sophos pager. Handles both cursor-based (`pages.nextKey`) and
 * page-number (`pages.total`) responses. Returns the concatenated `items`.
 */
async function fetchAll(apiHost, tenantId, token, path, params = {}) {
  const items = [];
  let page = 1;
  let nextKey = null;
  for (;;) {
    const url = new URL(`${apiHost}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    url.searchParams.set("pageSize", "100");
    if (nextKey) url.searchParams.set("pageFromKey", nextKey);
    else url.searchParams.set("page", String(page));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "X-Tenant-ID": tenantId },
      redirect: "manual",
    });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    items.push(...(data.items ?? []));

    const pages = data.pages ?? {};
    if (pages.nextKey) {
      nextKey = pages.nextKey;
      continue;
    }
    if (pages.total && page < pages.total) {
      page++;
      continue;
    }
    break;
  }
  return items;
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const clientId = need("SOPHOS_CLIENT_ID");
  const clientSecret = need("SOPHOS_CLIENT_SECRET");

  const token = await getToken(clientId, clientSecret);
  const { tenantId, apiHost } = await whoami(token);
  console.error(`Tenant ${tenantId} @ ${apiHost}`);

  // Build id -> name maps for resolution.
  const [users, userGroups, endpoints, endpointGroups] = await Promise.all([
    fetchAll(apiHost, tenantId, token, "/common/v1/directory/users"),
    fetchAll(apiHost, tenantId, token, "/common/v1/directory/user-groups"),
    fetchAll(apiHost, tenantId, token, "/endpoint/v1/endpoints"),
    fetchAll(apiHost, tenantId, token, "/endpoint/v1/endpoint-groups"),
  ]);
  const nameMap = new Map();
  for (const u of users) nameMap.set(u.id, u.name ?? u.email ?? u.id);
  for (const g of userGroups) nameMap.set(g.id, g.name ?? g.id);
  for (const e of endpoints) nameMap.set(e.id, e.hostname ?? e.id);
  for (const g of endpointGroups) nameMap.set(g.id, g.name ?? g.id);
  const resolve = (id) => nameMap.get(id) ?? id;

  // Header
  const rows = [
    ["policy_name", "policy_type", "enabled", "priority", "assignee_kind", "assignee_name", "assignee_id"],
  ];

  for (const policyType of POLICY_TYPES) {
    const policies = await fetchAll(apiHost, tenantId, token, "/endpoint/v1/policies", {
      policyType,
    });
    for (const p of policies) {
      const a = p.appliesTo ?? {};
      const groups = [
        ["user", a.users],
        ["user_group", a.userGroups],
        ["endpoint", a.endpoints],
        ["endpoint_group", a.endpointGroups],
      ];
      let any = false;
      for (const [kind, list] of groups) {
        for (const ref of list ?? []) {
          any = true;
          // The API returns refs as plain UUID strings; tolerate `{ id }` too.
          const refId = typeof ref === "string" ? ref : ref.id;
          rows.push([p.name, p.type, p.enabled ?? "", p.priority ?? "", kind, resolve(refId), refId]);
        }
      }
      if (!any) {
        rows.push([p.name, p.type, p.enabled ?? "", p.priority ?? "", "none", "", ""]);
      }
    }
    console.error(`${policyType}: ${policies.length} policies`);
  }

  process.stdout.write(rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n");
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
