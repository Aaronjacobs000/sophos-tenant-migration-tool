// App shell: grouped left rail, top bar with the tenant route and status dots,
// and the Ctrl K command palette. Self-bootstrapping: paints immediately, then
// fetches /api/status in the background and updates the route when ready, so
// the shell stays usable even if Sophos API calls hang.

import { api } from "./api.js";
import { icon, mark } from "./icons.js";

const NAV = [
  { group: "Overview", items: [
    { href: "/", label: "Dashboard", icon: "dashboard" },
  ] },
  { group: "Configuration", items: [
    { href: "/policies.html", label: "Policies", icon: "shield", also: ["/policy-compare.html", "/policy-detail.html"] },
    { href: "/web-filtering.html", label: "Web filtering", icon: "globe" },
    { href: "/ai-defense.html", label: "AI Defense", icon: "sparkle" },
    { href: "/groups.html", label: "Groups", icon: "folders" },
    { href: "/exclusions.html", label: "Exclusions", icon: "filter" },
  ] },
  { group: "Devices", items: [
    { href: "/endpoints.html", label: "Endpoints", icon: "laptop", also: ["/migrate.html"] },
    { href: "/migrate-jobs.html", label: "Migrations", icon: "migrate", also: ["/migrate-job-detail.html"] },
  ] },
  { group: "Tools", items: [
    { href: "/partner-explorer.html", label: "Partner Explorer", icon: "building", partnerOnly: true },
    { href: "/search.html", label: "Search", icon: "search" },
    { href: "/logs.html", label: "Logs", icon: "logs" },
  ] },
  { group: "Settings", items: [
    { href: "/credentials.html", label: "Credentials", icon: "key" },
    { href: "/help.html", label: "Help", icon: "help" },
  ] },
];

let lastStatus = null;

function currentPath() {
  const p = window.location.pathname;
  return p === "/index.html" ? "/" : p;
}

function visibleItems() {
  const isPartner = lastStatus?.mode === "partner";
  return NAV.map((g) => ({
    group: g.group,
    items: g.items.filter((it) => !it.partnerOnly || isPartner),
  })).filter((g) => g.items.length > 0);
}

export function renderNav(status = null) {
  if (status) lastStatus = status;
  renderRail();
  renderTopbar();
}

function renderRail() {
  const mount = document.getElementById("app-rail");
  if (!mount) return;
  const path = currentPath();
  const groups = visibleItems().map((g) => {
    const links = g.items.map((it) => {
      const active = it.href === path || (it.also ?? []).includes(path);
      return `<a class="rail-link${active ? " is-active" : ""}" href="${it.href}"${active ? ' aria-current="page"' : ""} title="${escapeAttr(it.label)}">${icon(it.icon)}<span>${escapeHtml(it.label)}</span></a>`;
    }).join("");
    return `<div class="rail-group"><div class="rail-label">${escapeHtml(g.group)}</div>${links}</div>`;
  }).join("");
  mount.innerHTML = `
    <a class="rail-brand" href="/" title="Sophos Fusion Tenant Migration Tool">
      ${mark()}
      <span class="brand-text"><span class="brand-name">Tenant Migration</span><span class="brand-sub">for Sophos Fusion</span></span>
    </a>
    <nav aria-label="Main">${groups}</nav>
    <div class="rail-foot">Unofficial tool, not from Sophos.</div>
  `;
}

function renderTopbar() {
  const mount = document.getElementById("app-nav");
  if (!mount) return;
  mount.classList.add("topbar");
  const mode = lastStatus?.mode === "partner" ? "Partner" : lastStatus ? "Direct" : "";
  mount.innerHTML = `
    <div class="route" aria-label="Migration route">
      ${routeSide("Source", lastStatus?.source)}
      ${icon("arrowRight", "route-arrow")}
      ${routeSide("Destination", lastStatus?.dest)}
    </div>
    <span class="topbar-spacer"></span>
    ${mode ? `<span class="tag tag-muted" title="Credential mode">${mode}</span>` : ""}
    <button type="button" class="btn" id="pal-open" title="Go to a page or find a device (Ctrl K)">${icon("search")}<span>Search</span><kbd>Ctrl K</kbd></button>
  `;
  mount.querySelector("#pal-open").addEventListener("click", openPalette);
}

function routeSide(role, side) {
  let state = "loading";
  let name = "checking";
  let title = "Checking connection";
  if (side) {
    if (side.ok) {
      state = "ok";
      const shortId = (side.identity?.tenantId ?? "").slice(0, 8);
      name = side.identity?.displayName || shortId || "connected";
      title = `Connected. Tenant ${side.identity?.tenantId ?? ""}`.trim();
    } else if (side.configured) {
      state = "error";
      name = "connection failed";
      title = side.error ?? "Connection failed";
    } else {
      state = "unconfigured";
      name = "not configured";
      title = "Not configured. Add credentials on the Credentials page.";
    }
  }
  const href = state === "ok" ? "/" : "/credentials.html";
  return `<a class="route-side" href="${href}" data-state="${state}" title="${escapeAttr(title)}"><span class="conn-dot"></span><span class="route-role">${role}</span><span class="route-name">${escapeHtml(name)}</span></a>`;
}

export function renderFooter() {
  const mount = document.getElementById("page-footer");
  if (!mount) return;
  mount.innerHTML = `<p class="copyright">Unofficial tool, not from Sophos. MIT licence, © 2026 Aaron Jacobs.</p>`;
}

// ---------- command palette ----------

let palette = null;
let palItems = [];
let palIdx = 0;
let palSearchTimer = null;
let palSearchSeq = 0;

function ensurePalette() {
  if (palette) return palette;
  palette = document.createElement("div");
  palette.className = "overlay hidden";
  palette.innerHTML = `
    <div class="palette" role="dialog" aria-label="Command palette">
      <div class="pal-inputrow">${icon("search")}<input class="pal-input" type="text" placeholder="Go to a page, or type a hostname" autocomplete="off" spellcheck="false" /></div>
      <div class="pal-results"></div>
      <div class="pal-foot"><span><kbd>Up</kbd> <kbd>Down</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
    </div>`;
  document.body.appendChild(palette);
  palette.addEventListener("click", (e) => { if (e.target === palette) closePalette(); });
  const input = palette.querySelector(".pal-input");
  input.addEventListener("input", () => updatePalette(input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palIdx + 1, palItems.length - 1); drawPalette(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(palIdx - 1, 0); drawPalette(); }
    else if (e.key === "Enter") { e.preventDefault(); const it = palItems[palIdx]; if (it) go(it.href); }
  });
  return palette;
}

function openPalette() {
  const el = ensurePalette();
  el.classList.remove("hidden");
  const input = el.querySelector(".pal-input");
  input.value = "";
  updatePalette("");
  input.focus();
}

function closePalette() {
  palette?.classList.add("hidden");
}

function go(href) {
  closePalette();
  window.location.href = href;
}

function pageItems(q) {
  const needle = q.trim().toLowerCase();
  const out = [];
  for (const g of visibleItems()) {
    for (const it of g.items) {
      if (!needle || it.label.toLowerCase().includes(needle) || g.group.toLowerCase().includes(needle)) {
        out.push({ kind: "page", section: "Pages", label: it.label, sub: g.group, icon: it.icon, href: it.href });
      }
    }
  }
  return out;
}

function updatePalette(q) {
  palItems = pageItems(q);
  palIdx = 0;
  drawPalette();
  clearTimeout(palSearchTimer);
  const term = q.trim();
  if (term.length < 2) return;
  const seq = ++palSearchSeq;
  palItems.push({ kind: "status", section: "Devices", label: `Searching both tenants for "${term}"`, icon: "search", href: `/search.html?q=${encodeURIComponent(term)}` });
  drawPalette();
  palSearchTimer = setTimeout(async () => {
    let found = [];
    let failed = false;
    try {
      const res = await fetch(`/api/search/endpoints?q=${encodeURIComponent(term)}`, { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      found = (data.items ?? []).slice(0, 8);
    } catch {
      failed = true;
    }
    if (seq !== palSearchSeq) return;
    palItems = pageItems(q);
    if (failed) {
      palItems.push({ kind: "status", section: "Devices", label: "Device search is unavailable right now", icon: "alert", href: `/search.html?q=${encodeURIComponent(term)}` });
    } else if (found.length === 0) {
      palItems.push({ kind: "status", section: "Devices", label: `No devices match "${term}"`, icon: "search", href: `/search.html?q=${encodeURIComponent(term)}` });
    } else {
      for (const r of found) {
        const ep = r.endpoint ?? {};
        const side = r.side === "source" ? "source" : r.side === "dest" ? "destination" : (r.tenantName || "other tenant");
        palItems.push({
          kind: "device",
          section: "Devices",
          label: ep.hostname || ep.id || "unknown",
          sub: `${side} · ${ep.os?.name || ep.type || ""}`.trim(),
          icon: ep.type === "server" ? "server" : "laptop",
          href: `/search.html?q=${encodeURIComponent(ep.hostname || term)}`,
        });
      }
    }
    drawPalette();
  }, 250);
}

function drawPalette() {
  const box = palette.querySelector(".pal-results");
  if (!palItems.length) {
    box.innerHTML = `<div class="pal-empty">No matches.</div>`;
    return;
  }
  let lastSection = null;
  box.innerHTML = palItems.map((it, i) => {
    const head = it.section !== lastSection ? `<div class="pal-section">${escapeHtml(it.section)}</div>` : "";
    lastSection = it.section;
    return `${head}<div class="pal-item${i === palIdx ? " is-active" : ""}" data-i="${i}"><span class="pal-icon">${icon(it.icon)}</span><span class="pal-label">${escapeHtml(it.label)}</span>${it.sub ? `<span class="pal-sub">${escapeHtml(it.sub)}</span>` : ""}</div>`;
  }).join("");
  box.querySelectorAll(".pal-item").forEach((el) => {
    el.addEventListener("click", () => go(palItems[Number(el.dataset.i)].href));
    el.addEventListener("mousemove", () => {
      const i = Number(el.dataset.i);
      if (i !== palIdx) { palIdx = i; drawPalette(); }
    });
  });
  box.querySelector(".pal-item.is-active")?.scrollIntoView({ block: "nearest" });
}

document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    if (!document.getElementById("app-nav")) return;
    e.preventDefault();
    if (palette && !palette.classList.contains("hidden")) closePalette();
    else openPalette();
  } else if (e.key === "Escape" && palette && !palette.classList.contains("hidden")) {
    closePalette();
  }
});

// ---------- boot ----------

// Static markup can ask for an icon with <span data-icon="name"></span>.
function hydrateIcons() {
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.outerHTML = icon(el.dataset.icon);
  });
}

async function bootNav() {
  hydrateIcons();
  renderNav();
  renderFooter();
  try {
    const status = await api.get("/api/status");
    renderNav(status);
    if (status?.status === "unconfigured") {
      // Jobs are checked with their own stored credentials, so their pages work without a connection.
      const path = window.location.pathname;
      const allowList = ["/welcome.html", "/credentials.html", "/migrate-jobs.html", "/migrate-job-detail.html"];
      if (!allowList.includes(path)) {
        window.location.href = "/welcome.html";
      }
    }
  } catch (err) {
    console.error("nav: status check failed", err);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootNav);
} else {
  bootNav();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
