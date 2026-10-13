import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { getCachedSection, refreshSection } from "./preload-client.js";
import { makeSortable } from "./sortable.js";
import { icon } from "./icons.js";
import { rowMenu, wireRowMenus, stackBar, onDestCell, ON_DEST_HEADER, plural, resultsModal, outcomeOf, countOutcomes, notesOf, countAssignments } from "./ui.js";
import { pairPolicy } from "./policy-pairing.js";

// Friendly labels for known Sophos endpoint policy types. Anything not in
// this map falls back to title-casing the raw type slug.
const PRODUCT_LABELS = {
  "threat-protection": "Threat Protection",
  "server-threat-protection": "Server Threat Protection",
  "peripheral-control": "Peripheral Control",
  "server-peripheral-control": "Server Peripheral Control",
  "application-control": "Application Control",
  "server-application-control": "Server Application Control",
  "server-web-control": "Server Web Control",
  "data-loss-prevention": "Data Loss Prevention",
  "web-control": "Web Control",
  "update-management": "Update Management",
  "windows-firewall": "Windows Firewall",
  "endpoint-firewall": "Endpoint Firewall",
  "agent-update": "Agent Update",
  "tamper-protection": "Tamper Protection",
  "device-encryption": "Device Encryption",
  "server-lockdown": "Server Lockdown",
  "exploit-mitigation": "Exploit Mitigation",
  "wireless": "Wireless",
};

// CSV columns, identical to the standalone export script.
const ASSIGNMENT_CSV_HEADER = [
  "policy_name", "policy_type", "enabled", "priority",
  "assignee_kind", "assignee_name", "assignee_id",
];

const state = {
  source: [],
  dest: [],
  selectedSource: new Set(),
  filter: "",
  hideMatching: false,
  // Deep match data, keyed by `source:${id}` and `dest:${id}`
  // Values: { status: "match"|"differ"|"source-only"|"dest-only", diffCount }
  matchById: new Map(),
  matchTotal: 0,
  matchStatus: "idle", // "idle" | "loading" | "ready" | "error"
  matchError: null,
};

async function boot() {
  await Promise.all([loadSide("source"), loadSide("dest")]);
  wireToolbar();
  wireBasket();
  render();
  // Kick off the deep policy match in the background. The toggle is disabled
  // until it completes; once ready we re-render with badges.
  loadDeepMatch();
}

async function loadSide(side) {
  try {
    const cached = await getCachedSection(side, "policies");
    if (cached.status?.state === "ok") {
      state[side] = cached.items || [];
      return;
    }
    if (cached.status?.state === "loading") {
      state[side] = { loading: true };
      return;
    }
    if (cached.status?.state === "error") {
      state[side] = { error: cached.status.error };
      return;
    }
    const res = await api.get(`/api/${side}/policies`);
    state[side] = res.items || [];
  } catch (err) {
    state[side] = { error: err.message };
  }
}

async function loadDeepMatch(forceRefresh = false) {
  state.matchStatus = "loading";
  state.matchError = null;
  updateToggleState();
  try {
    const url = forceRefresh
      ? "/api/compare/policies/deep?refresh=true"
      : "/api/compare/policies/deep";
    const res = await api.get(url);
    const map = new Map();
    for (const m of res.matches || []) {
      if (m.sourceId) map.set(`source:${m.sourceId}`, m);
      if (m.destId) map.set(`dest:${m.destId}`, m);
    }
    state.matchById = map;
    state.matchTotal = (res.matches || []).length;
    state.matchStatus = "ready";
    updateToggleState();
    render();
  } catch (err) {
    state.matchStatus = "error";
    state.matchError = err.message || "Failed to compute deep match";
    updateToggleState();
  }
}

function updateToggleState() {
  const toggle = document.getElementById("hide-matching");
  const note = document.getElementById("hide-matching-note");
  if (!toggle || !note) return;

  if (state.matchStatus === "ready") {
    toggle.disabled = false;
    const total = state.matchTotal;
    note.textContent = `Deep match ready, ${total} policies compared`;
    note.className = "hint";
  } else if (state.matchStatus === "loading") {
    toggle.disabled = true;
    if (state.hideMatching === false) {
      // toggle is unchecked anyway, just show the loading hint
    }
    note.innerHTML = `<span class="spin"></span> Comparing settings on both sides, this can take a moment`;
    note.className = "hint";
  } else if (state.matchStatus === "error") {
    toggle.disabled = true;
    note.innerHTML = `Deep match failed: ${escapeHtml(state.matchError ?? "unknown error")}. <a href="#" id="retry-deep">Retry</a>`;
    note.className = "hint is-bad";
    document.getElementById("retry-deep")?.addEventListener("click", (e) => {
      e.preventDefault();
      loadDeepMatch(true);
    });
  } else {
    toggle.disabled = true;
    note.textContent = "";
  }
}

function wireToolbar() {
  document.getElementById("search").addEventListener("input", (e) => {
    state.filter = e.target.value;
    render();
  });
  document.getElementById("hide-matching").addEventListener("change", (e) => {
    state.hideMatching = e.target.checked;
    render();
  });
  document.getElementById("refresh-match").addEventListener("click", () => {
    loadDeepMatch(true);
  });
  document.getElementById("export-assignments").addEventListener("click", exportAssignments);
  document.getElementById("hide-matching").disabled = true;
  updateToggleState();
}

function render() {
  const content = document.getElementById("content");

  // Surface preload errors / loading state explicitly
  if (state.source?.error || state.dest?.error) {
    content.innerHTML = `
      <div class="banner banner-err">
        ${state.source?.error ? `<div><strong>Source:</strong> ${escapeHtml(state.source.error)}</div>` : ""}
        ${state.dest?.error ? `<div><strong>Dest:</strong> ${escapeHtml(state.dest.error)}</div>` : ""}
      </div>
      <button class="btn mt" id="retry-btn">Retry preload</button>
    `;
    document.getElementById("retry-btn").addEventListener("click", async () => {
      content.innerHTML = `<div class="empty-state">Refreshing…</div>`;
      try {
        await Promise.all([
          refreshSection("source", "policies"),
          refreshSection("dest", "policies"),
        ]);
        await Promise.all([loadSide("source"), loadSide("dest")]);
        render();
      } catch (err) {
        toast(err.message || "Refresh failed", "err");
      }
    });
    return;
  }

  if (state.source?.loading || state.dest?.loading) {
    content.innerHTML = `<div class="empty-state">Preload is still running. The dashboard shows live status.</div>`;
    return;
  }

  const sourcePolicies = Array.isArray(state.source) ? state.source : [];
  const destPolicies = Array.isArray(state.dest) ? state.dest : [];

  if (sourcePolicies.length === 0 && destPolicies.length === 0) {
    content.innerHTML = `<div class="empty-state">No policies found in either tenant.</div>`;
    return;
  }

  const sourceByType = groupByType(sourcePolicies);
  const destByType = groupByType(destPolicies);
  const allTypes = new Set([
    ...Object.keys(sourceByType),
    ...Object.keys(destByType),
  ]);
  const sortedTypes = [...allTypes].sort((a, b) =>
    productLabel(a).localeCompare(productLabel(b)),
  );

  const sections = sortedTypes
    .map((type) => renderProductSection(type, sourceByType[type] ?? [], destByType[type] ?? []))
    .filter((html) => html !== null)
    .join("");

  if (!sections) {
    const reason = state.hideMatching
      ? "All products match between source and destination (deep settings comparison)."
      : "No products match the current filter.";
    content.innerHTML = `<div class="empty-state">${escapeHtml(reason)}</div>`;
    return;
  }

  content.innerHTML = sections;
  wireRows();
  makeSortable(content);
}

function groupByType(policies) {
  const out = {};
  for (const p of policies) {
    const t = p.type || "unknown";
    if (!out[t]) out[t] = [];
    out[t].push(p);
  }
  for (const k of Object.keys(out)) {
    out[k].sort((a, b) => a.name.localeCompare(b.name));
  }
  return out;
}

function productLabel(type) {
  return PRODUCT_LABELS[type] || titleCase(type);
}

function titleCase(slug) {
  return slug
    .split(/[-_]/)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

/**
 * Look up the deep match record for a policy on one side ("source" or
 * "dest"). Returns null if the deep match isn't ready yet or this policy
 * isn't in the result.
 */
function lookupMatch(policy, side) {
  if (state.matchStatus !== "ready") return null;
  return state.matchById.get(`${side}:${policy.id}`) ?? null;
}

/** The deep match records for a product's policies on both sides. */
function productMatches(srcList, dstList) {
  return [
    ...srcList.map((p) => lookupMatch(p, "source")),
    ...dstList.map((p) => lookupMatch(p, "dest")),
  ];
}

/**
 * Determine whether a product section is "all matching" by deep comparison.
 * Returns true ONLY when every policy on both sides is paired and its pair
 * has status === "match" (zero deep diffs).
 * If the deep match isn't ready, falls back to never hiding (safest).
 */
function productAllMatch(srcList, dstList) {
  if (state.matchStatus !== "ready") return false;
  return productMatches(srcList, dstList).every((m) => m?.status === "match");
}

/** Shown on a source policy whose name matches more than one policy ignoring case. */
const AMBIGUOUS_TAG = `<span class="tag tag-warn" title="More than one policy matches this name ignoring case, so it is not paired with any destination policy">ambiguous name</span>`;

function renderProductSection(type, srcList, dstList) {
  const q = state.filter.toLowerCase();
  const matches = (p) => !q || p.name.toLowerCase().includes(q);
  const srcFiltered = srcList.filter(matches);
  const dstFiltered = dstList.filter(matches);

  if (q && srcFiltered.length === 0 && dstFiltered.length === 0) return null;

  if (state.hideMatching && productAllMatch(srcList, dstList)) {
    return null;
  }

  // Each source policy's destination policy, paired as the deep match, Compare and clone pair them.
  const pairing = new Map(srcList.map((p) => [p.id, pairPolicy(p, srcList, dstList)]));
  const pairedDestIds = new Set([...pairing.values()].map((x) => x.dest?.id).filter(Boolean));

  const label = productLabel(type);

  // Per-product summary from the deep match, when it is ready.
  const productStats = computeProductStats(srcList, dstList);
  const productBadge = renderProductBadge(productStats);

  const renderSrcRow = (p) => {
    const { dest, ambiguous } = pairing.get(p.id);
    const inDest = !!dest;
    const checked = state.selectedSource.has(p.id) ? "checked" : "";
    const matchInfo = lookupMatch(p, "source");
    const statusBadge = renderStatusBadge(matchInfo, inDest);
    // An ambiguous name gets Compare, which says why it has no pair, not Clone, which would add yet another.
    const action = inDest || ambiguous
      ? `<button class="btn btn-small" data-compare="${escapeAttr(p.id)}">Compare</button>`
      : `<button class="btn btn-small btn-primary" data-clone="${escapeAttr(p.id)}">Clone</button>`;
    return `
      <tr${checked ? ' class="selected"' : ""}>
        <td class="col-check"><input type="checkbox" data-id="${escapeAttr(p.id)}" ${checked} aria-label="Select ${escapeAttr(p.name)}"/></td>
        ${onDestCell(inDest)}
        <td class="cell-name">
          <a href="/policy-detail.html?side=source&id=${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>
          ${statusBadge}
          ${ambiguous ? AMBIGUOUS_TAG : ""}
        </td>
        <td class="cell-state">${enabledCell(p)}</td>
        <td class="col-actions">${action}</td>
      </tr>`;
  };

  const renderDstRow = (p) => {
    const inSource = pairedDestIds.has(p.id);
    const matchInfo = lookupMatch(p, "dest");
    const statusBadge = renderStatusBadge(matchInfo, inSource, "dest");
    const menu = rowMenu([
      { label: "Delete from destination", icon: "trash", danger: true, attrs: `data-delete-dest="${escapeAttr(p.id)}" data-name="${escapeAttr(p.name)}"` },
    ]);
    return `
      <tr>
        <td class="cell-name">
          <a href="/policy-detail.html?side=dest&id=${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>
          ${statusBadge}
        </td>
        <td class="cell-state">${enabledCell(p)}</td>
        <td class="col-actions">${menu}</td>
      </tr>`;
  };

  const srcTable =
    srcFiltered.length === 0
      ? `<div class="empty-state">No source policies${q ? " match the filter" : ""}.</div>`
      : `<table class="data-table">
           <thead>
             <tr><th class="col-check"></th>${ON_DEST_HEADER}<th>Name</th><th>State</th><th class="col-actions"></th></tr>
           </thead>
           <tbody>${srcFiltered.map(renderSrcRow).join("")}</tbody>
         </table>`;

  const dstTable =
    dstFiltered.length === 0
      ? `<div class="empty-state">No destination policies${q ? " match the filter" : ""}.</div>`
      : `<table class="data-table">
           <thead>
             <tr><th>Name</th><th>State</th><th class="col-actions"></th></tr>
           </thead>
           <tbody>${dstFiltered.map(renderDstRow).join("")}</tbody>
         </table>`;

  return `
    <section class="panel-card product-section">
      <header class="product-header">
        <h2>${escapeHtml(label)}</h2>
        <code class="product-type-tag">${escapeHtml(type)}</code>
        <span class="spacer"></span>
        <span class="hint tnum">${srcList.length} source · ${dstList.length} destination</span>
      </header>
      ${productBadge}
      <div class="product-split">
        <div class="product-side">
          <div class="product-side-label side-title">Source</div>
          ${srcTable}
        </div>
        <div class="product-side">
          <div class="product-side-label side-title is-dest">Destination</div>
          ${dstTable}
        </div>
      </div>
    </section>
  `;
}

function enabledCell(p) {
  return p.enabled === false
    ? `<span class="tag tag-muted">Off</span>`
    : `<span class="hint">On</span>`;
}

function computeProductStats(srcList, dstList) {
  if (state.matchStatus !== "ready") return null;
  const stats = { match: 0, differ: 0, sourceOnly: 0, destOnly: 0, total: 0 };
  // A pair's record is found from both sides; count it once.
  const seen = new Set();
  for (const m of productMatches(srcList, dstList)) {
    if (!m || seen.has(m)) continue;
    seen.add(m);
    stats.total++;
    if (m.status === "match") stats.match++;
    else if (m.status === "differ") stats.differ++;
    else if (m.status === "source-only") stats.sourceOnly++;
    else if (m.status === "dest-only") stats.destOnly++;
  }
  return stats;
}

function renderProductBadge(stats) {
  if (!stats || stats.total === 0) {
    return `<div class="product-bar is-pending">${state.matchStatus === "loading" ? `<span class="hint"><span class="spin"></span> Comparing</span>` : ""}</div>`;
  }
  const item = (n, cls, text) => (n ? `<span class="${cls}"><i></i><b>${n}</b> ${text}</span>` : "");
  return `
    <div class="product-bar">
      ${stackBar(stats)}
      <span class="legend">
        ${item(stats.match, "l-match", "match")}
        ${item(stats.differ, "l-differ", "differ")}
        ${item(stats.sourceOnly, "l-src", "source only")}
        ${item(stats.destOnly, "l-dst", "destination only")}
      </span>
    </div>`;
}

function renderStatusBadge(matchInfo, hasCounterpart, side = "source") {
  if (state.matchStatus !== "ready") return "";
  if (!matchInfo) return "";

  if (matchInfo.status === "match") {
    return `<span class="tag tag-ok" title="Settings match">${icon("check")}match</span>`;
  }
  if (matchInfo.status === "differ") {
    const count = matchInfo.diffCount > 0 ? `${matchInfo.diffCount} change${matchInfo.diffCount === 1 ? "" : "s"}` : "differs";
    return `<span class="tag tag-warn" title="Settings differ">${escapeHtml(count)}</span>`;
  }
  if (matchInfo.status === "source-only") {
    return side === "source" ? `<span class="tag tag-src">source only</span>` : "";
  }
  if (matchInfo.status === "dest-only") {
    return side === "dest" ? `<span class="tag tag-dst">destination only</span>` : "";
  }
  return "";
}

function wireRows() {
  wireRowMenus(document.getElementById("content"));
  document.querySelectorAll('input[type="checkbox"][data-id]').forEach((cb) => {
    cb.addEventListener("change", (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) state.selectedSource.add(id);
      else state.selectedSource.delete(id);
      e.target.closest("tr")?.classList.toggle("selected", e.target.checked);
      renderBasket();
    });
  });
  document.querySelectorAll("[data-compare]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const id = e.currentTarget.dataset.compare;
      window.location.href = `/policy-compare.html?sourceId=${encodeURIComponent(id)}`;
    });
  });
  document.querySelectorAll("[data-clone]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.clone;
      if (!confirm("Clone this policy to destination?\n\nIt goes to the bottom of the destination's priority order, above the base policy. Its assignments are added where the destination has a match.")) return;
      try {
        const res = await api.post("/api/migrate/policies", {
          policyIds: [id],
        });
        reportClone(res.results ?? []);
        await refreshSection("dest", "policies").catch(() => {});
        await loadSide("dest");
        loadDeepMatch(true);
        render();
      } catch (err) {
        toast(err.message || "Clone failed", "err");
      }
    });
  });
  document.querySelectorAll("[data-delete-dest]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const id = e.currentTarget.dataset.deleteDest;
      const name = e.currentTarget.dataset.name;
      if (!confirm(`Delete the destination policy "${name}"?\n\nThis action is irreversible.`)) return;
      // Second confirmation for destructive ops
      if (!confirm(`Are you absolutely sure? "${name}" will be permanently removed from the destination tenant.`)) return;
      try {
        await api.del(`/api/dest/policies/${encodeURIComponent(id)}`);
        toast(`Deleted "${name}" from destination.`, "ok");
        await refreshSection("dest", "policies").catch(() => {});
        await loadSide("dest");
        loadDeepMatch(true);
        render();
      } catch (err) {
        toast(err.message || "Delete failed", "err");
      }
    });
  });
}

function renderBasket() {
  const basket = document.getElementById("selection-basket");
  document.getElementById("basket-count").textContent = String(state.selectedSource.size);
  document.getElementById("basket-noun").textContent = state.selectedSource.size === 1 ? "source policy selected" : "source policies selected";
  basket.classList.toggle("hidden", state.selectedSource.size === 0);
}

function wireBasket() {
  document.getElementById("basket-compare").addEventListener("click", () => {
    if (state.selectedSource.size !== 1) {
      toast("Select exactly one source policy to compare.", "info");
      return;
    }
    const [id] = state.selectedSource;
    window.location.href = `/policy-compare.html?sourceId=${encodeURIComponent(id)}`;
  });

  document.getElementById("basket-preview").addEventListener("click", async () => {
    const ids = Array.from(state.selectedSource);
    if (ids.length === 0) return;
    try {
      const res = await api.post("/api/migrate/policies", {
        policyIds: ids,
        dryRun: true,
      });
      reportClone(res.results ?? [], true);
    } catch (err) {
      toast(err.message || "Preview failed", "err");
    }
  });

  document.getElementById("basket-clone").addEventListener("click", async () => {
    const ids = Array.from(state.selectedSource);
    if (ids.length === 0) return;
    if (!confirm(`Clone ${ids.length} polic${ids.length === 1 ? "y" : "ies"} from source to destination?\n\nClones go to the bottom of the destination's priority order, above the base policy, in their source order. Policies already on the destination are left as they are. Every policy's assignments are added where the destination has a match.`)) return;
    try {
      const res = await api.post("/api/migrate/policies", {
        policyIds: ids,
      });
      reportClone(res.results ?? []);
      state.selectedSource.clear();
      renderBasket();
      await refreshSection("dest", "policies").catch(() => {});
      await loadSide("dest");
      loadDeepMatch(true);
      render();
    } catch (err) {
      toast(err.message || "Clone failed", "err");
    }
  });
}

/**
 * A short message and the results list for a clone or its preview: each
 * policy tagged created, already there or failed, with notes on settings
 * changed to fit and a line per assignment.
 */
function reportClone(results, dryRun = false) {
  const n = countOutcomes(results);
  const a = countAssignments(results);
  const bad = n.failed > 0 || a.failed > 0;
  if (dryRun) toast(`Preview: ${n["would-create"]} to clone / failed ${n.failed}${summarizeAssignments(results)}`, bad ? "err" : "ok");
  else toast(`Cloned ${n.created} / failed ${n.failed}${summarizeAssignments(results)}`, bad ? "err" : "ok");
  const sourceById = new Map((Array.isArray(state.source) ? state.source : []).map((p) => [p.id, p]));
  const byProduct = new Map();
  for (const r of results) {
    const label = productLabel(sourceById.get(r.sourceId)?.type ?? "unknown");
    if (!byProduct.has(label)) byProduct.set(label, []);
    byProduct.get(label).push({
      outcome: outcomeOf(r),
      text: sourceById.get(r.sourceId)?.name ?? r.sourceName,
      error: r.error,
      notes: notesOf(r),
    });
  }
  const unassigned = a.pending + a["not-matched"] + a.failed;
  const csv = unassigned ? " Export assignments (CSV) lists every source assignment, for setting the rest by hand." : "";
  // Assignment counts only when a policy has assignments.
  const assigned = results.some((r) => r.assignments);
  resultsModal({
    title: dryRun ? "Preview: nothing was written" : "Clone results",
    summary: dryRun
      ? `${plural(n["would-create"], "policy", "policies")} would be created on the destination${assigned ? `, and ${plural(a["will-set"], "assignment")} added` : ""}.${csv}`
      : `${plural(n.created, "policy", "policies")} created on the destination${assigned ? `, and ${plural(a.set, "assignment")} added` : ""}. Each write is in data/audit.log.${csv}`,
    groups: [...byProduct].sort(([a], [b]) => a.localeCompare(b)).map(([title, rows]) => ({ title, rows })),
  });
}

/**
 * A short " · assignments: 3 added, 1 pending" suffix for the message, then
 * how many settings were changed to fit. "" when there is neither.
 */
function summarizeAssignments(results) {
  const a = countAssignments(results);
  const parts = [
    [a["will-set"], "to add"],
    [a.set, "added"],
    [a["already-set"], "already there"],
    [a.pending, "pending"],
    [a["not-matched"], "not matched"],
    [a.failed, "failed"],
  ].filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
  // Settings the migrator changed or dropped to fit the destination (full detail
  // is in the results list and the audit log).
  const adjusted = (results ?? []).flatMap((r) => r.adjustments ?? []);
  return (parts.length ? ` · assignments: ${parts.join(", ")}` : "")
    + (adjusted.length ? ` · ${adjusted.length} setting${adjusted.length === 1 ? "" : "s"} adjusted for destination` : "");
}

/**
 * Export every source policy's assignments to a CSV download, for setting by
 * hand what a clone could not match. Same columns as
 * scripts/export-policy-assignments.mjs: for each policy it expands
 * `appliesTo` into one row per assigned user, user group, endpoint or endpoint
 * group (or a single "none" row when unassigned), resolving IDs to names.
 * The policies and the names are read from the source at export time, not
 * from the page's cached copy, so groups and devices made since show by name.
 */
async function exportAssignments() {
  const btn = document.getElementById("export-assignments");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Building CSV";
  try {
    const policies = (await api.get("/api/source/policies")).items ?? [];
    if (policies.length === 0) {
      toast("No policies on the source tenant.", "info");
      return;
    }

    const resolve = await buildAssignmentNameResolver();

    const rows = [ASSIGNMENT_CSV_HEADER];
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

    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
    downloadCsv(csv, "policy-assignments.csv");
    const policyWord = policies.length === 1 ? "policy" : "policies";
    toast(`Exported ${policies.length} ${policyWord} to policy-assignments.csv`, "ok");
  } catch (err) {
    toast(err.message || "Export failed", "err");
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

/**
 * Build an id -> name resolver for assignment targets on the source tenant,
 * read now rather than from the preload cache. Any list that fails to load is
 * skipped; unresolved IDs fall back to the raw ID.
 */
async function buildAssignmentNameResolver() {
  const [endpoints, endpointGroups, userGroups, users] = await Promise.all([
    fetchAllEndpoints(),
    fetchResolverItems("/api/source/groups"),
    fetchResolverItems("/api/source/user-groups"),
    fetchResolverItems("/api/source/users"),
  ]);

  const nameMap = new Map();
  for (const u of users) nameMap.set(u.id, u.name ?? u.email ?? u.id);
  for (const g of userGroups) nameMap.set(g.id, g.name ?? g.id);
  for (const e of endpoints) nameMap.set(e.id, e.hostname ?? e.id);
  for (const g of endpointGroups) nameMap.set(g.id, g.name ?? g.id);

  return (id) => nameMap.get(id) ?? id;
}

// Every source device: the endpoint list is paged by a key, 500 at a time.
async function fetchAllEndpoints() {
  const items = [];
  try {
    let key = "";
    do {
      const res = await api.get(`/api/source/endpoints?pageSize=500${key ? `&pageFromKey=${encodeURIComponent(key)}` : ""}`);
      items.push(...(res.items || []));
      key = res.pages?.nextKey || "";
    } while (key);
  } catch {
    // Unresolved device IDs fall back to the raw ID.
  }
  return items;
}

async function fetchResolverItems(path) {
  try {
    const res = await api.get(path);
    return res.items || [];
  } catch {
    return [];
  }
}

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(text, filename) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, "&#39;"); }

boot();
