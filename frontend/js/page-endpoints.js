import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { getCachedSection, refreshSection } from "./preload-client.js";
import { makeSortable } from "./sortable.js";
import { icon } from "./icons.js";

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

const state = {
  source: [],
  dest: [],
  // Selection is per-side: "source::id" or "dest::id"
  selected: new Set(),
  filters: { source: "", dest: "" },
  hideStale: false,
};

async function boot() {
  await Promise.all([loadSide("source"), loadSide("dest")]);
  wireUI();
}

async function loadSide(side) {
  const target = document.getElementById(`table-${side}`);
  target.innerHTML = `<div class="empty-state">Loading…</div>`;
  try {
    const cached = await getCachedSection(side, "endpoints");
    if (cached.status?.state === "ok") {
      state[side] = cached.items || [];
      renderTable(side);
      return;
    }
    if (cached.status?.state === "loading") {
      target.innerHTML = `<div class="empty-state">Preload in progress…</div>`;
      return;
    }
    if (cached.status?.state === "error") {
      target.innerHTML = `
        <div class="banner banner-err">Preload failed: ${esc(cached.status.error || "")}</div>
        <button class="btn mt" data-retry="${side}">Retry</button>`;
      target.querySelector(`[data-retry="${side}"]`).addEventListener("click", async () => {
        target.innerHTML = `<div class="empty-state">Refreshing…</div>`;
        await refreshSection(side, "endpoints").catch(() => {});
        await loadSide(side);
      });
      return;
    }
    // idle: live fetch
    const res = await api.get(`/api/${side}/endpoints`);
    state[side] = res.items || [];
    renderTable(side);
  } catch (err) {
    target.innerHTML = `<div class="banner banner-err">${esc(err.message || "Failed")}</div>`;
  }
}

function renderTable(side) {
  const filter = state.filters[side].toLowerCase();
  const items = state[side]
    .filter((e) => !filter || (e.hostname || "").toLowerCase().includes(filter))
    .filter((e) => !state.hideStale || !isStale(e))
    .sort((a, b) => (a.hostname || "").localeCompare(b.hostname || ""));

  const target = document.getElementById(`table-${side}`);
  if (items.length === 0) {
    target.innerHTML = `<div class="empty-state">No endpoints${filter ? " match the filter" : ""}.</div>`;
    return;
  }

  const rows = items.map((ep) => {
    const stale = isStale(ep);
    const key = `${side}::${ep.id}`;
    const checked = state.selected.has(key) ? "checked" : "";
    const cb = stale
      ? `<td class="col-check"><input type="checkbox" disabled title="Outside the 14-day window" aria-label="Stale, cannot migrate"/></td>`
      : `<td class="col-check"><input type="checkbox" data-key="${escAttr(key)}" ${checked} aria-label="Select ${escAttr(ep.hostname || "")}"/></td>`;
    const os = ep.os ? `${ep.os.name || ep.os.platform || ""}`.trim() : "";
    const ips = (ep.ipv4Addresses || []).slice(0, 2).join(", ") || "-";
    const person = ep.associatedPerson?.name || ep.associatedPerson?.viaLogin || "";
    const seen = stale ? staleTag(ep) : `<span class="hint">${ep.lastSeenAt ? fmtRelative(ep.lastSeenAt) : "never"}</span>`;
    const serverTag = ep.type === "server" || ep.os?.isServer ? `<span class="tag tag-muted">server</span>` : "";
    return `
      <tr class="${[stale ? "is-stale" : "", checked ? "selected" : ""].filter(Boolean).join(" ")}">
        ${cb}
        <td class="ep-host" title="${escAttr([ep.hostname, os, person].filter(Boolean).join(" · "))}">
          <span class="ep-host-inner"><span class="os-icon" title="${escAttr(os || "Unknown OS")}">${osIcon(ep)}</span><strong>${esc(ep.hostname || "")}</strong>${serverTag}${person ? `<span class="ep-person">${esc(person)}</span>` : ""}</span>
        </td>
        <td class="ep-health">${healthTag(ep.health?.overall)}</td>
        <td class="ep-ip col-ip" title="${escAttr(ips)}"><span class="hint">${esc(ips)}</span></td>
        <td class="ep-seen">${seen}</td>
        <td class="col-actions"><button class="icon-btn" data-detail='${escAttr(JSON.stringify(ep))}' title="Details" aria-label="Details for ${escAttr(ep.hostname || "")}">${icon("info")}</button></td>
      </tr>`;
  }).join("");

  target.innerHTML = `
    <table class="data-table ep-table">
      <thead>
        <tr><th class="col-check"></th><th class="ep-host">Hostname</th><th class="ep-health">Health</th><th class="ep-ip col-ip">IP</th><th class="ep-seen">Seen</th><th class="col-actions"></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
  makeSortable(target);

  target.querySelectorAll('input[type="checkbox"][data-key]').forEach((cb) => {
    cb.addEventListener("change", (e) => {
      if (e.target.checked) state.selected.add(e.target.dataset.key);
      else state.selected.delete(e.target.dataset.key);
      e.target.closest("tr")?.classList.toggle("selected", e.target.checked);
      renderBasket();
    });
  });

  target.querySelectorAll("[data-detail]").forEach((btn) => {
    btn.addEventListener("click", (e) => showDetail(JSON.parse(e.currentTarget.dataset.detail)));
  });
}

function wireUI() {
  document.getElementById("search-source").addEventListener("input", (e) => {
    state.filters.source = e.target.value;
    renderTable("source");
  });
  document.getElementById("search-dest").addEventListener("input", (e) => {
    state.filters.dest = e.target.value;
    renderTable("dest");
  });
  document.getElementById("hide-stale").addEventListener("change", (e) => {
    state.hideStale = e.target.checked;
    renderTable("source");
    renderTable("dest");
  });
  document.getElementById("select-all-source").addEventListener("click", () => selectAll("source"));
  document.getElementById("select-all-dest").addEventListener("click", () => selectAll("dest"));
  // The table is the preload cache, which a device move does not update: a
  // moved device only shows on the receiving side after a reload.
  for (const side of ["source", "dest"]) {
    document.getElementById(`refresh-${side}`).addEventListener("click", (e) => reloadSide(side, e.currentTarget));
  }
  document.getElementById("basket-clear").addEventListener("click", () => {
    state.selected.clear();
    renderTable("source");
    renderTable("dest");
    renderBasket();
  });
  document.getElementById("basket-migrate").addEventListener("click", startMigrate);
}

async function reloadSide(side, btn) {
  btn.disabled = true;
  document.getElementById(`table-${side}`).innerHTML = `<div class="empty-state">Reloading…</div>`;
  try {
    await refreshSection(side, "endpoints");
  } catch (err) {
    toast(err.message || "Reload failed", "err");
  } finally {
    await loadSide(side);
    btn.disabled = false;
  }
}

function selectAll(side) {
  const filter = state.filters[side].toLowerCase();
  const eligible = state[side].filter(
    (e) => !isStale(e) && (!filter || (e.hostname || "").toLowerCase().includes(filter)),
  );
  for (const e of eligible) state.selected.add(`${side}::${e.id}`);
  renderTable(side);
  renderBasket();
  toast(`Selected ${eligible.length} eligible endpoint${eligible.length === 1 ? "" : "s"}.`, "ok");
}

function renderBasket() {
  const basket = document.getElementById("selection-basket");
  const srcCount = [...state.selected].filter((k) => k.startsWith("source::")).length;
  const dstCount = [...state.selected].filter((k) => k.startsWith("dest::")).length;
  const total = srcCount + dstCount;
  basket.classList.toggle("hidden", total === 0);

  let html = "";
  if (srcCount > 0 && dstCount > 0) {
    html = `<strong>${srcCount}</strong> source and <strong>${dstCount}</strong> destination devices selected. Pick one side.`;
  } else {
    const side = srcCount > 0 ? "source" : "dest";
    const count = srcCount || dstCount;
    const filter = state.filters[side].toLowerCase();
    const stale = state[side].filter(
      (e) => isStale(e) && (!filter || (e.hostname || "").toLowerCase().includes(filter)),
    ).length;
    const parts = [`<strong>${count}</strong> selected`];
    if (stale) parts.push(`${stale} stale excluded`);
    parts.push(side === "source" ? "source to destination" : "destination back to source");
    html = parts.join(" · ");
  }
  document.getElementById("basket-text").innerHTML = html;
  document.getElementById("basket-migrate").disabled = srcCount > 0 && dstCount > 0;
}

function startMigrate() {
  const srcIds = [...state.selected].filter((k) => k.startsWith("source::")).map((k) => k.slice(8));
  const dstIds = [...state.selected].filter((k) => k.startsWith("dest::")).map((k) => k.slice(6));

  if (srcIds.length > 0 && dstIds.length > 0) {
    toast("Select endpoints from one side only per migration.", "info");
    return;
  }
  if (srcIds.length === 0 && dstIds.length === 0) return;

  const direction = srcIds.length > 0 ? "source-to-dest" : "dest-to-source";
  const ids = srcIds.length > 0 ? srcIds : dstIds;

  // Store in sessionStorage for the migrate page
  sessionStorage.setItem("endpointSelection", JSON.stringify(ids));
  sessionStorage.setItem("migrationDirection", direction);
  window.location.href = "/migrate.html";
}

function showDetail(ep) {
  let existing = document.getElementById("detail-modal");
  if (existing) existing.remove();

  const products = (ep.assignedProducts || []).map((p) =>
    `<li><code>${esc(p.code)}</code> v${esc(p.version)}, ${esc(p.status)}</li>`
  ).join("") || "<li>none</li>";

  const services = (ep.health?.services?.serviceDetails || []).map((s) =>
    `<li>${esc(s.name)}: ${esc(s.status)}</li>`
  ).join("") || "<li>none</li>";

  const modal = document.createElement("div");
  modal.id = "detail-modal";
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-card">
      <header class="modal-header">
        <h2>${esc(ep.hostname)}</h2>
        <button class="icon-btn modal-close" title="Close" aria-label="Close">${icon("x")}</button>
      </header>
      <div class="modal-body">
        <dl class="kv-list">
          <dt>Endpoint ID</dt><dd><code>${esc(ep.id)}</code></dd>
          <dt>Type</dt><dd>${esc(ep.type || "")}</dd>
          <dt>OS</dt><dd>${esc(ep.os?.name || "")} ${esc(String(ep.os?.majorVersion ?? ""))}.${esc(String(ep.os?.minorVersion ?? ""))} (${esc(ep.os?.platform || "")})</dd>
          <dt>Is server</dt><dd>${ep.os?.isServer ? "yes" : "no"}</dd>
          <dt>Health</dt><dd>${esc(ep.health?.overall || "")}</dd>
          <dt>Threats</dt><dd>${esc(ep.health?.threats?.status || "")}</dd>
          <dt>Services</dt><dd>${esc(ep.health?.services?.status || "")}</dd>
          <dt>IPv4</dt><dd>${esc((ep.ipv4Addresses || []).join(", ") || "none")}</dd>
          <dt>IPv6</dt><dd>${esc((ep.ipv6Addresses || []).join(", ") || "none")}</dd>
          <dt>MAC</dt><dd>${esc((ep.macAddresses || []).join(", ") || "none")}</dd>
          <dt>User</dt><dd>${esc(ep.associatedPerson?.name || "")} ${esc(ep.associatedPerson?.viaLogin ? `(${ep.associatedPerson.viaLogin})` : "")}</dd>
          <dt>Tamper protection</dt><dd>${ep.tamperProtectionEnabled ? "enabled" : "disabled"}</dd>
          <dt>Isolation</dt><dd>${esc(ep.isolation?.status || "none")}</dd>
          <dt>Lockdown</dt><dd>${esc(ep.lockdown?.status || "none")}</dd>
          <dt>Group</dt><dd>${esc(ep.groupName || "none")} ${ep.groupId ? `<code>${esc(ep.groupId)}</code>` : ""}</dd>
          <dt>Last seen</dt><dd>${ep.lastSeenAt ? new Date(ep.lastSeenAt).toLocaleString() : "never"}</dd>
        </dl>
        <h3>Assigned products</h3>
        <ul>${products}</ul>
        <h3>Service details</h3>
        <ul>${services}</ul>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector(".modal-close").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
}

function staleTag(ep) {
  const days = ep.lastSeenAt ? Math.floor((Date.now() - new Date(ep.lastSeenAt).getTime()) / 86_400_000) : null;
  const text = days === null ? "stale, never seen" : `stale ${days}d`;
  const why = days === null
    ? "Never checked in. Devices must check in within 14 days to migrate."
    : `Last seen ${days} days ago. Devices must check in within 14 days to migrate.`;
  return `<span class="tag tag-bad" title="${escAttr(why)}">${esc(text)}</span>`;
}

function healthTag(overall) {
  const h = String(overall || "unknown").toLowerCase();
  if (h === "good") return `<span class="tag tag-ok">${icon("checkCircle")}Good</span>`;
  if (h === "suspicious") return `<span class="tag tag-warn">${icon("alert")}Suspicious</span>`;
  if (h === "bad") return `<span class="tag tag-bad">${icon("xCircle")}Bad</span>`;
  return `<span class="tag tag-muted">${icon("help")}${esc(h.charAt(0).toUpperCase() + h.slice(1))}</span>`;
}

function osIcon(ep) {
  const p = String(ep.os?.platform || ep.os?.name || "").toLowerCase();
  if (p.includes("mac")) return icon("apple");
  if (p.includes("linux") || p.includes("ubuntu") || p.includes("centos") || p.includes("red hat")) return icon("linux");
  if (p.includes("windows")) return icon("windows");
  return icon("device");
}

function isStale(ep) {
  if (!ep.lastSeenAt) return true;
  return Date.now() - new Date(ep.lastSeenAt).getTime() > FOURTEEN_DAYS_MS;
}

function fmtRelative(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}h ago`;
  return `${Math.floor(ms / 86400_000)}d ago`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escAttr(s) { return esc(s).replace(/'/g, "&#39;"); }

boot();
