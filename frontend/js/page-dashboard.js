import "./nav.js";
import { api } from "./api.js";
import { getPreloadStatus, refreshSection, startPreload, getCachedSection } from "./preload-client.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";
import { esc, escAttr, plural } from "./ui.js";
import { verifySummary } from "./migration-view.js";

const SECTIONS = [
  { id: "policies", label: "Policies", href: "/policies.html" },
  { id: "groups", label: "Groups", href: "/groups.html" },
  { id: "scanning-exclusions", label: "Scanning exclusions", href: "/exclusions.html" },
  { id: "allowed-items", label: "Allowed items", href: "/exclusions.html" },
  { id: "blocked-items", label: "Blocked items", href: "/exclusions.html" },
  { id: "endpoints", label: "Endpoints", href: "/endpoints.html" },
];

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

let pollHandle = null;
let tenantStatus = null;
let journeyRequested = false;
let journeyData = null;

async function boot() {
  wireDrawer();
  renderJourney(null);
  const settled = await loadStatus();
  if (settled) loadJourney();
  pollHandle = setInterval(pollOnce, 3000);

  document.getElementById("preload-restart").addEventListener("click", async () => {
    try {
      await startPreload();
      toast("Preload restarted.", "info");
      journeyRequested = false;
      if (!pollHandle) pollHandle = setInterval(pollOnce, 3000);
    } catch (err) {
      toast(err.message || "Restart failed", "err");
    }
  });
}

async function pollOnce() {
  const stop = await loadStatus();
  if (stop) {
    clearInterval(pollHandle);
    pollHandle = null;
    loadJourney();
  }
}

function wireDrawer() {
  const btn = document.getElementById("details-toggle");
  const drawer = document.getElementById("conn-details");
  btn.addEventListener("click", () => {
    const open = drawer.classList.toggle("hidden") === false;
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Hide details" : "Connection details";
  });
}

async function loadStatus() {
  // Each is read on its own: when Sophos refuses a tenant's credentials, the
  // tenant status still says so while the preload status answers 503.
  const [status, preload] = await Promise.allSettled([api.get("/api/status"), getPreloadStatus()]);
  if (status.status === "fulfilled") {
    tenantStatus = status.value;
    renderHero(tenantStatus);
    renderTenantDetails(tenantStatus);
    renderJourney(journeyData);
  }
  if (status.status === "rejected" || preload.status === "rejected") {
    const err = status.status === "rejected" ? status.reason : preload.reason;
    document.getElementById("preload-grid").innerHTML = `<div class="banner banner-err">${notLoaded(err)}</div>`;
    return true;
  }

  const loaded = preload.value;
  renderPreloadGrid(loaded);

  const stillLoading = ["source", "dest"].some((side) =>
    SECTIONS.some((s) => loaded[side][s.id]?.state === "loading"),
  );
  return !stillLoading;
}

/** Why nothing loaded: each tenant that isn't connected and the reason it gave, or the error. */
function notLoaded(err) {
  const down = [["Source", tenantStatus?.source], ["Destination", tenantStatus?.dest]].filter(([, side]) => side && !side.ok);
  if (!down.length) return esc(err?.message || "Failed to load preload status");
  const why = down.map(([name, side]) => `${name} not connected: ${esc(side.error || (side.configured ? "no answer from Sophos" : "no credentials"))}`);
  return `${why.join(". ")}. Nothing loads until both tenants are connected. <a href="/credentials.html">Update credentials</a>`;
}

// ---------- hero ----------

function sideState(side) {
  if (!side) return "loading";
  if (side.ok) return "ok";
  if (side.configured) return "error";
  return "unconfigured";
}

function sideName(side, fallback) {
  if (!side?.ok) return fallback;
  return side.identity?.displayName || (side.identity?.tenantId ?? "").slice(0, 8) || fallback;
}

function renderHero(status) {
  for (const side of ["source", "dest"]) {
    const el = document.querySelector(`.hero-side[data-side="${side}"]`);
    const data = status?.[side];
    el.dataset.state = sideState(data);
    el.querySelector(".hero-name").textContent = sideName(data, side === "source" ? "Source" : "Destination");
    el.title = data?.ok ? `Tenant ${data.identity?.tenantId ?? ""}` : (data?.error ?? "Not configured");
  }
  const arrow = document.querySelector(".hero-arrow");
  if (!arrow.innerHTML) arrow.innerHTML = icon("arrowRight");

  const meta = document.getElementById("hero-meta");
  const s = status?.source;
  const d = status?.dest;
  const mode = status?.mode === "partner" ? "Partner credentials" : "Direct tenant credentials";
  const regions = [s?.identity?.region, d?.identity?.region].filter(Boolean);
  const regionText = regions.length === 2 && regions[0] === regions[1]
    ? `both in ${regions[0]}`
    : regions.length ? `regions ${regions.join(" and ")}` : "";
  const problems = [s, d].filter((x) => x && !x.ok).length;
  meta.textContent = problems
    ? `${mode} · ${plural(problems, "tenant")} not connected`
    : [mode, regionText].filter(Boolean).join(" · ");
}

function renderTenantDetails(status) {
  renderSideDetails("source", status?.source);
  renderSideDetails("dest", status?.dest);
}

function renderSideDetails(side, data) {
  const body = document.querySelector(`[data-body="${side}"]`);
  if (!body) return;
  if (!data?.configured) {
    body.innerHTML = `<p class="hint">Not configured. Add credentials on the <a href="/credentials.html">Credentials</a> page.</p>`;
    return;
  }
  if (!data.ok) {
    body.innerHTML = `
      <pre class="error-pre">${esc(data.error || "")}</pre>
      <p class="hint"><a href="/credentials.html">Update credentials</a></p>`;
    return;
  }
  const id = data.identity;
  const labelRow = id.displayName
    ? `<dt>Label</dt><dd>${esc(id.displayName)}</dd>`
    : `<dt>Label</dt><dd><span class="hint">Set one on the <a href="/credentials.html">Credentials</a> page</span></dd>`;
  const regionRow = id.region ? `<dt>Region</dt><dd><code>${esc(id.region)}</code></dd>` : "";
  body.innerHTML = `
    <dl class="kv-list">
      ${labelRow}
      <dt>Tenant ID</dt><dd><code>${esc(id.tenantId)}</code></dd>
      ${regionRow}
      <dt>API host</dt><dd><code>${esc(id.apiHost)}</code></dd>
    </dl>`;
}

// ---------- journey ----------

async function loadJourney() {
  if (journeyRequested) return;
  journeyRequested = true;
  // The cached sections and the job list come back at once; the deep policy
  // match can take a while on a large tenant, so its counts fill in after.
  const deepPromise = api.get("/api/compare/policies/deep").catch((err) => ({ error: err.message }));
  const [groupsS, groupsD, scanS, scanD, allowS, allowD, blockS, blockD, epS, epD, jobs] = await Promise.all([
    cached("source", "groups"), cached("dest", "groups"),
    cached("source", "scanning-exclusions"), cached("dest", "scanning-exclusions"),
    cached("source", "allowed-items"), cached("dest", "allowed-items"),
    cached("source", "blocked-items"), cached("dest", "blocked-items"),
    cached("source", "endpoints"), cached("dest", "endpoints"),
    api.get("/api/migrate/devices/jobs").then((r) => r.items ?? []).catch(() => null),
  ]);

  const groupsMissing = groupsS && groupsD ? onlyOnSource(groupsS, groupsD, (g) => (g.name ?? "").toLowerCase()) : null;
  const exclusionsMissing = [
    [scanS, scanD, (x) => `${x.type}::${x.value}`],
    [allowS, allowD, (x) => `${x.type}::${JSON.stringify(x.properties ?? {})}`],
    [blockS, blockD, (x) => `${x.type}::${JSON.stringify(x.properties ?? {})}`],
  ].reduce((sum, [s, d, key]) => (sum === null || !s || !d ? null : sum + onlyOnSource(s, d, key)), 0);

  journeyData = { deep: null, policyCounts: null, groupsMissing, exclusionsMissing, epS, epD, jobs };
  renderJourney(journeyData);

  const deep = await deepPromise;
  journeyData = { ...journeyData, deep, policyCounts: deep?.matches ? countMatches(deep.matches) : null };
  renderJourney(journeyData);
}

async function cached(side, section) {
  try {
    const res = await getCachedSection(side, section);
    return res.status?.state === "ok" ? res.items ?? [] : null;
  } catch {
    return null;
  }
}

function countMatches(matches) {
  const c = { match: 0, differ: 0, sourceOnly: 0, destOnly: 0 };
  for (const m of matches) {
    if (m.status === "match") c.match++;
    else if (m.status === "differ") c.differ++;
    else if (m.status === "source-only") c.sourceOnly++;
    else if (m.status === "dest-only") c.destOnly++;
  }
  return c;
}

function onlyOnSource(source, dest, key) {
  const d = new Set(dest.map(key));
  return source.filter((x) => !d.has(key(x))).length;
}

function isStale(ep) {
  return !ep.lastSeenAt || Date.now() - new Date(ep.lastSeenAt).getTime() > FOURTEEN_DAYS_MS;
}

function renderJourney(data) {
  const el = document.getElementById("journey");
  const s = tenantStatus?.source;
  const d = tenantStatus?.dest;
  const connected = [s, d].filter((x) => x?.ok).length;

  const connect = {
    n: 1, title: "Connect", icon: "plug", href: "/credentials.html", cta: "Credentials",
    state: !tenantStatus ? "loading" : connected === 2 ? "ok" : "bad",
    tag: !tenantStatus ? "Checking" : connected === 2 ? "Both connected" : `${connected} of 2 connected`,
    lines: [
      s?.ok ? `Source: ${esc(sideName(s, "source"))}` : "Source: not connected",
      d?.ok ? `Destination: ${esc(sideName(d, "destination"))}` : "Destination: not connected",
    ],
  };

  // A tenant that isn't connected loads nothing, so the steps that compare the two don't wait for it.
  const notConnected = { state: "muted", tag: "Not loaded", lines: ["Needs both tenants connected."] };
  let config;
  if (tenantStatus && connected < 2) {
    config = { ...notConnected };
  } else if (!data) {
    config = { state: "loading", tag: "Waiting", lines: ["Counts appear once both tenants have loaded."] };
  } else {
    const lines = [];
    let toReview = 0;
    if (data.policyCounts) {
      const c = data.policyCounts;
      toReview += c.differ + c.sourceOnly;
      const parts = [];
      if (c.differ) parts.push(`<b>${c.differ}</b> differ`);
      if (c.sourceOnly) parts.push(`<b>${c.sourceOnly}</b> source only`);
      if (c.destOnly) parts.push(`<b>${c.destOnly}</b> destination only`);
      lines.push(`Policies: ${parts.length ? parts.join(", ") : `all <b>${c.match}</b> match`}`);
    } else {
      lines.push(`Policies: ${data.deep?.error ? "comparison failed" : "comparing"}`);
    }
    if (data.groupsMissing !== null) {
      toReview += data.groupsMissing;
      lines.push(`Groups: ${data.groupsMissing ? `<b>${data.groupsMissing}</b> not on destination` : "all present"}`);
    }
    if (data.exclusionsMissing !== null) {
      toReview += data.exclusionsMissing;
      lines.push(`Exclusions: ${data.exclusionsMissing ? `<b>${data.exclusionsMissing}</b> not on destination` : "all present"}`);
    }
    config = {
      state: toReview ? "warn" : data.policyCounts ? "ok" : "loading",
      tag: toReview ? `${toReview} to review` : data.policyCounts ? "In step" : "Comparing",
      lines,
    };
  }
  Object.assign(config, { n: 2, title: "Configuration", icon: "sliders", href: "/policies.html", cta: "Policies" });

  let devices;
  if (tenantStatus && connected < 2) {
    devices = { ...notConnected };
  } else if (!data || !data.epS) {
    devices = { state: "loading", tag: "Waiting", lines: ["Device counts appear once endpoints have loaded."] };
  } else {
    const stale = data.epS.filter(isStale).length;
    const eligible = data.epS.length - stale;
    devices = {
      state: eligible ? "ok" : "muted",
      tag: `${eligible} ready to move`,
      lines: [
        `Source: <b>${data.epS.length}</b> device${data.epS.length === 1 ? "" : "s"}${stale ? `, <b>${stale}</b> stale` : ""}`,
        `Destination: <b>${data.epD ? data.epD.length : "?"}</b> device${data.epD?.length === 1 ? "" : "s"}`,
      ],
    };
  }
  Object.assign(devices, { n: 3, title: "Devices", icon: "laptop", href: "/endpoints.html", cta: "Endpoints" });

  let verify;
  if (!data) {
    verify = { state: "loading", tag: "Checking", lines: ["Migration jobs started here show up once loaded."] };
  } else if (!data.jobs) {
    verify = { state: "muted", tag: "Unavailable", lines: ["Could not read the local job list."] };
  } else if (data.jobs.length === 0) {
    verify = { state: "muted", tag: "No moves yet", lines: ["Jobs started from this tool appear here."] };
  } else {
    const { state, tag, line } = verifySummary(data.jobs);
    verify = { state, tag, lines: [line] };
  }
  Object.assign(verify, { n: 4, title: "Verify", icon: "checkCircle", href: "/migrate-jobs.html", cta: "Migrations" });

  const html = [connect, config, devices, verify].map(stepCard).join("");
  if (el.innerHTML !== html) el.innerHTML = html;
}

function stepCard(step) {
  const tagClass = { ok: "tag-ok", warn: "tag-warn", bad: "tag-bad", loading: "tag-muted", muted: "tag-muted" }[step.state] ?? "tag-muted";
  return `
    <article class="step glass" data-state="${step.state}">
      <div class="step-head">
        <span class="step-n">${step.n}</span>
        <h2>${esc(step.title)}</h2>
        <span class="spacer"></span>
        <span class="tag ${tagClass}">${step.state === "loading" ? '<span class="spin"></span>' : ""}${esc(step.tag)}</span>
      </div>
      <ul class="step-lines">${step.lines.map((l) => `<li>${l}</li>`).join("")}</ul>
      <a class="step-link" href="${step.href}">${esc(step.cta)}${icon("arrowRight")}</a>
    </article>`;
}

// ---------- preload tiles ----------

function renderPreloadGrid(preload) {
  const target = document.getElementById("preload-grid");
  if (!preload) {
    target.innerHTML = `<div class="empty-state">No preload status available.</div>`;
    return;
  }

  const summary = computeSummary(preload);
  document.getElementById("preload-summary").innerHTML = [
    summary.ok ? `<span class="tag tag-ok">${summary.ok} loaded</span>` : "",
    summary.loading ? `<span class="tag tag-warn"><span class="spin"></span>${summary.loading} loading</span>` : "",
    summary.error ? `<span class="tag tag-bad">${summary.error} failed</span>` : "",
    summary.idle ? `<span class="tag tag-muted">${summary.idle} idle</span>` : "",
  ].join("");

  target.innerHTML = SECTIONS.map((section) => `
    <div class="count-tile">
      <a class="count-title" href="${section.href}">${esc(section.label)}</a>
      <div class="count-sides">
        ${countSide("source", section.id, preload.source[section.id])}
        ${countSide("dest", section.id, preload.dest[section.id])}
      </div>
    </div>`).join("");

  target.querySelectorAll("[data-refresh]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const [side, section] = btn.dataset.refresh.split("::");
      btn.disabled = true;
      try {
        await refreshSection(side, section);
        toast(`Refreshed ${section} (${side}).`, "ok");
      } catch (err) {
        toast(err.message || "Refresh failed", "err");
      } finally {
        await loadStatus();
      }
    });
  });
}

function computeSummary(preload) {
  const counts = { ok: 0, loading: 0, error: 0, idle: 0 };
  for (const side of ["source", "dest"]) {
    for (const section of SECTIONS) {
      const s = preload[side][section.id]?.state ?? "idle";
      counts[s] = (counts[s] ?? 0) + 1;
    }
  }
  return counts;
}

function countSide(side, sectionId, status) {
  const state = status?.state ?? "idle";
  const dotState = { ok: "ok", error: "error", loading: "loading", idle: "unconfigured" }[state];
  let value = "-";
  let detail = "idle";
  if (state === "ok") {
    value = String(status.itemCount ?? 0);
    detail = formatDuration(status.durationMs);
  } else if (state === "loading") {
    value = "...";
    detail = "loading";
  } else if (state === "error") {
    value = "!";
    detail = "failed";
  }
  const title = state === "error" ? status.error ?? "failed" : `${side === "source" ? "Source" : "Destination"}: ${detail}`;
  return `
    <div class="count-side" title="${escAttr(title)}">
      <span class="count-role"><span class="conn-dot" data-state="${dotState}"></span>${side === "source" ? "Source" : "Dest"}</span>
      <span class="count-value${state === "error" ? " is-bad" : ""}">${esc(value)}</span>
      <button class="icon-btn icon-btn-xs" data-refresh="${side}::${sectionId}" title="Refresh ${side === "source" ? "source" : "destination"}" aria-label="Refresh ${side === "source" ? "source" : "destination"}">${icon("refresh")}</button>
    </div>`;
}

function formatDuration(ms) {
  if (!ms || ms < 0) return "no timing";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

boot();
