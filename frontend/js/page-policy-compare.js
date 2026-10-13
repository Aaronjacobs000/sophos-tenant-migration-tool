import "./nav.js";
import { api } from "./api.js";
import {
  flattenForCompare,
  summarizeEntries,
  renderCompareSummary,
  renderCompareTable,
  renderValue,
} from "./diff-view.js";
import { toast } from "./toast.js";
import { plural, resultsModal, outcomeOf, notesOf, countAssignments } from "./ui.js";
import { refreshSection } from "./preload-client.js";

const state = {
  sourcePolicy: null,
  destPolicy: null,
  // More than one policy matched the name ignoring case, so none was paired.
  ambiguous: false,
  entries: [],
  showOnlyDiffs: true,
  filter: "",
};

let compareUrl = "";

async function boot() {
  const params = new URLSearchParams(window.location.search);
  const sourceId = params.get("sourceId");
  const destId = params.get("destId");
  if (!sourceId) {
    document.getElementById("header-area").innerHTML =
      `<div class="banner banner-err">Missing sourceId.</div>`;
    return;
  }

  compareUrl = destId
    ? `/api/compare/policies/${encodeURIComponent(sourceId)}/${encodeURIComponent(destId)}`
    : `/api/compare/policies/${encodeURIComponent(sourceId)}`;

  if (await load()) wireToolbar();
}

/** Fetch the comparison and draw it. False when it could not be loaded. */
async function load() {
  try {
    const res = await api.get(compareUrl);
    state.sourcePolicy = res.sourcePolicy;
    state.destPolicy = res.destPolicy;
    state.ambiguous = !!res.ambiguous;
    // The server's copy of the settings names web profiles instead of each tenant's ID for them.
    state.entries = flattenForCompare(
      res.settings?.source ?? res.sourcePolicy?.settings ?? {},
      res.settings?.dest ?? res.destPolicy?.settings ?? {},
    );
    renderHeader();
    renderBody();
    return true;
  } catch (err) {
    document.getElementById("header-area").innerHTML =
      `<div class="banner banner-err">${escapeHtml(err.message || "Failed to compare")}</div>`;
    return false;
  }
}

function renderHeader() {
  const lead = state.destPolicy
    ? `Comparing <strong>${escapeHtml(state.sourcePolicy.name)}</strong> on the source and the destination.`
    : `Source policy <strong>${escapeHtml(state.sourcePolicy.name)}</strong> has no matching destination policy.${state.ambiguous ? " More than one policy matches its name ignoring case, so none is paired, and a clone would add yet another. Rename them so each name is unique ignoring case, then compare again." : ""}`;
  document.getElementById("page-lead").innerHTML = lead;

  const summary = summarizeEntries(state.entries);
  const summaryHtml = state.destPolicy ? renderCompareSummary(summary) : "";

  // Metadata diff (enabled, priority, enforced)
  const metaRows = renderMetadataRows();

  const cloneLabel = state.destPolicy
    ? "Overwrite destination with source"
    : "Clone to destination";

  document.getElementById("header-area").innerHTML = `
    <header class="compare-page-header">
      <div>
        <h2 class="compare-title">${escapeHtml(state.sourcePolicy.name)}</h2>
        <div class="compare-meta-row">
          <code>${escapeHtml(state.sourcePolicy.type)}</code>
          ${state.destPolicy ? `<span class="hint">${matchedBy()}</span>` : state.ambiguous ? `<span class="tag tag-warn">Ambiguous name</span>` : `<span class="tag tag-src">No destination match</span>`}
        </div>
      </div>
      <span class="compare-actions">
        ${state.ambiguous && !state.destPolicy ? "" : `<button id="preview-btn" class="btn">Preview</button>`}
        ${state.ambiguous && !state.destPolicy ? "" : `<button id="clone-btn" class="btn btn-primary">${escapeHtml(cloneLabel)}</button>`}
      </span>
    </header>
    ${summaryHtml}
    ${metaRows}
  `;

  // No clone when the name is ambiguous: the destination may hold this policy under another case already.
  document.getElementById("clone-btn")?.addEventListener("click", cloneToDest);
  document.getElementById("preview-btn")?.addEventListener("click", previewClone);

  // Show the compare card if we have a destination to compare against
  if (state.destPolicy) {
    document.getElementById("compare-card").hidden = false;
  }
}

/** How the destination policy was paired: by the same name, or the one name that matches ignoring case. */
function matchedBy() {
  return state.destPolicy.name === state.sourcePolicy.name
    ? "Matched by name and type"
    : `Matched by type and by name ignoring case: <strong>${escapeHtml(state.destPolicy.name)}</strong> on the destination`;
}

function renderMetadataRows() {
  const src = state.sourcePolicy ?? {};
  const dst = state.destPolicy ?? {};
  const fields = [
    { key: "enabled", label: "Enabled" },
    // Not compared: a clone goes to the bottom of the destination's order,
    // so its priority differs by design (the deep match skips it too).
    { key: "priority", label: "Priority", compare: false },
    { key: "enforced", label: "Enforced" },
  ];
  const rows = fields
    .map((f) => {
      const sv = src[f.key];
      const dv = dst[f.key];
      const status = !state.destPolicy
        ? "source-only"
        : f.compare === false
          ? "not-compared"
          : sv === dv
            ? "match"
            : "differ";
      const pillClass = {
        match: "tag-ok",
        differ: "tag-warn",
        "source-only": "tag-src",
        "not-compared": "tag-muted",
      }[status];
      const label = { match: "match", differ: "differs", "source-only": "source only", "not-compared": "not compared" }[status];
      const role = status === "differ";
      return `
        <tr class="compare-row compare-row-${status}">
          <td class="compare-path"><span class="set-label">${escapeHtml(f.label)}</span></td>
          <td class="compare-cell">${renderValue(sv ?? undefined, false, role ? "before" : "")}</td>
          <td class="compare-cell">${state.destPolicy ? renderValue(dv ?? undefined, false, role ? "after" : "") : `<span class="compare-missing">not set</span>`}</td>
          <td class="compare-status"><span class="tag ${pillClass}">${label}</span></td>
        </tr>`;
    })
    .join("");

  return `
    <table class="data-table compare-table compare-meta">
      <thead>
        <tr><th>Policy field</th><th><span class="side-title">Source</span></th><th><span class="side-title is-dest">Destination</span></th><th>Status</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderBody() {
  if (!state.destPolicy) {
    document.getElementById("compare-body").innerHTML = "";
    return;
  }
  const html = renderCompareTable(state.entries, {
    showOnlyDiffs: state.showOnlyDiffs,
    filter: state.filter,
  });
  document.getElementById("compare-body").innerHTML = html;
}

function wireToolbar() {
  document.getElementById("show-only-diffs").addEventListener("change", (e) => {
    state.showOnlyDiffs = e.target.checked;
    renderBody();
  });
  document.getElementById("filter").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderBody();
  });
}

async function cloneToDest() {
  const overwrite = !!state.destPolicy;
  const verb = overwrite
    ? "overwrite the destination policy with source"
    : "clone this policy to the bottom of the destination's priority order";
  // An overwrite sends the source's name too, so a policy paired ignoring case takes the source's name.
  const rename = state.destPolicy && state.destPolicy.name !== state.sourcePolicy.name
    ? `\n\nThe destination policy "${state.destPolicy.name}" is renamed "${state.sourcePolicy.name}".`
    : "";
  if (!confirm(`Are you sure you want to ${verb}?${rename}\n\nIts assignments are added where the destination has a match.`)) return;
  let results;
  try {
    const res = await api.post("/api/migrate/policies", {
      policyIds: [state.sourcePolicy.id],
      overwrite,
    });
    results = res.results ?? [];
  } catch (err) {
    // The request itself failed: one failed row with the reason.
    results = [{ sourceId: state.sourcePolicy.id, ok: false, action: overwrite ? "overwrite" : "create", error: err.message || "Migration failed" }];
  }
  showResults(results, overwrite);
  // Compare again so the page shows the new state. The results list stays open over it.
  // Refresh the destination's cached policies too, so the Policies page shows the write.
  if (results.some((r) => r.ok)) {
    await refreshSection("dest", "policies").catch(() => {});
    await load();
  }
}

/** The overwrite or clone as a dry run: what it would write, and each assignment it would add or can't match. */
async function previewClone() {
  const overwrite = !!state.destPolicy;
  let results;
  try {
    const res = await api.post("/api/migrate/policies", {
      policyIds: [state.sourcePolicy.id],
      overwrite,
      dryRun: true,
    });
    results = res.results ?? [];
  } catch (err) {
    toast(err.message || "Preview failed", "err");
    return;
  }
  showResults(results, overwrite, true);
}

/**
 * The results list, as on the Policies page: the policy tagged updated for an
 * overwrite, created or already there for a clone, or failed with the reason,
 * with notes on settings changed to fit and a line per assignment. A preview
 * tags it would update or would create.
 */
function showResults(results, overwrite, dryRun = false) {
  const rows = results.map((r) => ({
    outcome: r.ok && r.action === "overwrite" ? "updated" : r.ok && r.action === "dry-run-overwrite" ? "would-update" : outcomeOf(r),
    text: state.sourcePolicy.name,
    error: r.error,
    notes: notesOf(r),
  }));
  const done = dryRun ? (overwrite ? "would-update" : "would-create") : overwrite ? "updated" : "created";
  const count = (outcome) => rows.filter((r) => r.outcome === outcome).length;
  const a = countAssignments(results);
  const bad = count("failed") > 0 || a.failed > 0;
  const csv = a.pending + a["not-matched"] + a.failed ? " Export assignments (CSV) on the Policies page lists every source assignment, for setting the rest by hand." : "";
  // Assignment counts only for a policy that has assignments.
  const assigned = results.some((r) => r.assignments);
  const extra = (n, verb) => (assigned ? `, ${plural(n, "assignment")} ${verb}` : "");
  if (dryRun) {
    toast(`Preview: ${count("failed") ? "would fail" : overwrite ? "would update" : "would clone"}${extra(a["will-set"], "to add")}`, bad ? "err" : "ok");
  } else {
    toast(`${overwrite ? "Updated" : "Cloned"} ${count(done)} / failed ${count("failed")}${extra(a.set, "added")}`, bad ? "err" : "ok");
  }
  resultsModal({
    title: dryRun ? "Preview: nothing was written" : overwrite ? "Overwrite results" : "Clone results",
    summary: dryRun
      ? `${plural(count(done), "policy", "policies")} would be ${overwrite ? "updated" : "created"} on the destination${assigned ? `, and ${plural(a["will-set"], "assignment")} added` : ""}.${csv}`
      : `${plural(count(done), "policy", "policies")} ${done} on the destination${assigned ? `, and ${plural(a.set, "assignment")} added` : ""}. Each write is in data/audit.log.${csv}`,
    groups: [{ title: productLabel(state.sourcePolicy.type), rows }],
  });
}

/** "web-control" as "Web Control", as the Policies page labels a product. */
function productLabel(type) {
  return type.split(/[-_]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
