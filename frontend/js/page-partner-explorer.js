import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { makeSortable } from "./sortable.js";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

const state = {
  tenants: [],
  filter: "",
};

async function boot() {
  try {
    const status = await api.get("/api/status");
    if (status.mode !== "partner") {
      document.getElementById("tenant-list").innerHTML =
        `<div class="empty-state">Partner Explorer is only available in partner mode.<br/>
         Switch to partner credentials on the <a href="/credentials.html">Credentials</a> page.</div>`;
      document.getElementById("global-results").innerHTML =
        `<div class="empty-state">Not available in direct mode.</div>`;
      return;
    }
  } catch {}

  await loadTenants();

  document.getElementById("filter-tenants").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderTenantList();
  });
  document.getElementById("close-detail").addEventListener("click", () => {
    document.getElementById("tenant-detail").classList.add("hidden");
  });
  document.getElementById("global-search-btn").addEventListener("click", globalSearch);
  document.getElementById("global-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") globalSearch();
  });
}

async function loadTenants() {
  try {
    const res = await api.get("/api/partner/tenants");
    state.tenants = (res.items || []).sort((a, b) => a.name.localeCompare(b.name));
    renderTenantList();
  } catch (err) {
    document.getElementById("tenant-list").innerHTML =
      `<div class="banner banner-err">${esc(err.message || "Failed to load tenants")}</div>`;
  }
}

function renderTenantList() {
  const filtered = state.tenants.filter((t) =>
    !state.filter ||
    t.name.toLowerCase().includes(state.filter.toLowerCase()) ||
    t.id.toLowerCase().includes(state.filter.toLowerCase()),
  );
  document.getElementById("tenant-count").textContent =
    `${filtered.length} of ${state.tenants.length} tenants`;

  if (filtered.length === 0) {
    document.getElementById("tenant-list").innerHTML =
      `<div class="empty-state">No tenants match the filter.</div>`;
    return;
  }

  const rows = filtered.map((t) => `
    <tr>
      <td><strong>${esc(t.name)}</strong></td>
      <td><code>${esc(t.id)}</code></td>
      <td>${esc(t.dataRegion)}</td>
      <td>${esc(t.dataGeography)}</td>
      <td class="col-actions">
        <button class="btn btn-small explore-btn" data-id="${escAttr(t.id)}" data-name="${escAttr(t.name)}">Explore</button>
      </td>
    </tr>
  `).join("");

  document.getElementById("tenant-list").innerHTML = `
    <table class="data-table">
      <thead><tr><th>Name</th><th>Tenant ID</th><th>Region</th><th>Geography</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  makeSortable(document.getElementById("tenant-list"));

  // Wire explore buttons using event delegation on the container
  document.getElementById("tenant-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".explore-btn");
    if (!btn) return;
    exploreTenant(btn.dataset.id, btn.dataset.name);
  });
}

// --- Global endpoint search ---

async function globalSearch() {
  const q = document.getElementById("global-search").value.trim();
  const results = document.getElementById("global-results");
  if (!q) { toast("Enter a hostname to search.", "info"); return; }

  results.innerHTML = `<div class="empty-state">Searching all tenants for "${esc(q)}"…</div>`;
  try {
    const res = await api.get(`/api/search/endpoints?q=${encodeURIComponent(q)}&scope=all`);
    renderSearchResults(res.items || [], q);
  } catch (err) {
    results.innerHTML = `<div class="banner banner-err">${esc(err.message || "Search failed")}</div>`;
  }
}

function renderSearchResults(items, q) {
  const results = document.getElementById("global-results");
  if (items.length === 0) {
    results.innerHTML = `<div class="empty-state">No endpoints matching "${esc(q)}" found across any tenant.</div>`;
    return;
  }

  const rows = items.map((r) => {
    const ep = r.endpoint;
    const stale = isStale(ep);
    const staleBadge = stale ? ` <span class="tag tag-bad">stale</span>` : "";
    const os = ep.os ? `${ep.os.name || ep.os.platform || ""}`.trim() : "";
    const ips = (ep.ipv4Addresses || []).slice(0, 2).join(", ") || "-";
    const lastSeen = ep.lastSeenAt ? fmtRelative(ep.lastSeenAt) : "never";
    return `
      <tr>
        <td><strong>${esc(ep.hostname || "")}</strong>${staleBadge}</td>
        <td><code>${esc(r.tenantName || r.tenantId.slice(0, 12))}</code></td>
        <td>${sideLabel(r.side)}</td>
        <td>${esc(os)}</td>
        <td>${esc(ep.health?.overall || "")}</td>
        <td><span class="hint">${esc(ips)}</span></td>
        <td><span class="hint">${lastSeen}</span></td>
        <td><span class="hint">${esc(ep.associatedPerson?.name || ep.associatedPerson?.viaLogin || "")}</span></td>
      </tr>`;
  }).join("");

  results.innerHTML = `
    <p class="hint">${items.length} result${items.length === 1 ? "" : "s"} for "${esc(q)}"</p>
    <table class="data-table">
      <thead><tr><th>Hostname</th><th>Tenant</th><th>Side</th><th>OS</th><th>Health</th><th>IP</th><th>Seen</th><th>User</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  makeSortable(results);
}

// --- Tenant drill-down ---

async function exploreTenant(tenantId, tenantName) {
  const panel = document.getElementById("tenant-detail");
  panel.classList.remove("hidden");
  panel.scrollIntoView({ behavior: "smooth" });
  document.getElementById("detail-title").textContent = `${tenantName}`;
  const body = document.getElementById("detail-body");

  body.innerHTML = `
    <dl class="kv-list kv-gap">
      <dt>Tenant ID</dt><dd><code>${esc(tenantId)}</code></dd>
    </dl>
    <div class="panel-toolbar">
      <input type="search" id="tenant-ep-search" placeholder="Search devices in ${escAttr(tenantName)}" class="wide-search" />
      <button class="btn" id="tenant-ep-search-btn">Search</button>
    </div>
    <div id="tenant-ep-results" class="table-wrap"><div class="empty-state">Enter a hostname above to search this tenant's endpoints.</div></div>
  `;

  const doSearch = async () => {
    const q = document.getElementById("tenant-ep-search").value.trim();
    const target = document.getElementById("tenant-ep-results");
    if (!q) { toast("Enter a hostname.", "info"); return; }

    target.innerHTML = `<div class="empty-state">Searching…</div>`;
    try {
      const res = await api.get(`/api/search/endpoints?q=${encodeURIComponent(q)}&scope=all`);
      const items = (res.items || []).filter((r) => r.tenantId === tenantId);
      if (items.length === 0) {
        target.innerHTML = `<div class="empty-state">No endpoints matching "${esc(q)}" in ${esc(tenantName)}.</div>`;
        return;
      }
      const rows = items.map((r) => {
        const ep = r.endpoint;
        const os = ep.os ? `${ep.os.name || ep.os.platform || ""}`.trim() : "-";
        const lastSeen = ep.lastSeenAt ? fmtRelative(ep.lastSeenAt) : "never";
        const ips = (ep.ipv4Addresses || []).slice(0, 2).join(", ") || "-";
        return `
          <tr>
            <td><strong>${esc(ep.hostname || "")}</strong></td>
            <td>${esc(os)}</td>
            <td>${esc(ep.health?.overall || "")}</td>
            <td><span class="hint">${esc(ips)}</span></td>
            <td><span class="hint">${lastSeen}</span></td>
          </tr>`;
      }).join("");
      target.innerHTML = `
        <p class="hint">${items.length} result${items.length === 1 ? "" : "s"}</p>
        <table class="data-table">
          <thead><tr><th>Hostname</th><th>OS</th><th>Health</th><th>IP</th><th>Seen</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
    } catch (err) {
      target.innerHTML = `<div class="banner banner-err">${esc(err.message)}</div>`;
    }
  };

  document.getElementById("tenant-ep-search-btn").addEventListener("click", doSearch);
  document.getElementById("tenant-ep-search").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
}

function sideLabel(side) {
  if (side === "source") return `<span class="tag tag-src">source</span>`;
  if (side === "dest") return `<span class="tag tag-dst">destination</span>`;
  return `<span class="tag tag-muted">other</span>`;
}

function isStale(ep) {
  if (!ep.lastSeenAt) return true;
  return Date.now() - new Date(ep.lastSeenAt).getTime() > FOURTEEN_DAYS_MS;
}

function fmtRelative(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  return `${Math.floor(ms / 86400000)}d ago`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escAttr(s) { return esc(s).replace(/'/g, "&#39;"); }

boot();
