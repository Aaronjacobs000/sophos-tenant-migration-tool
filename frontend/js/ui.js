// Small render helpers shared by the page scripts.

import { icon } from "./icons.js";

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

export function escAttr(s) {
  return esc(s).replace(/'/g, "&#39;");
}

export function tag(text, variant = "", extra = "") {
  const cls = variant ? `tag tag-${variant}` : "tag";
  return `<span class="${cls}"${extra ? ` ${extra}` : ""}>${text}</span>`;
}

export function relTime(iso) {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * A "more" button that opens a small menu. items: [{ label, icon, danger, attrs }]
 * where attrs is a string of data attributes the page wires up itself.
 */
export function rowMenu(items, label = "More actions") {
  const buttons = items.map((it) =>
    `<button type="button" class="${it.danger ? "is-danger" : ""}" ${it.attrs ?? ""}>${it.icon ? icon(it.icon) : ""}${esc(it.label)}</button>`,
  ).join("");
  return `<span class="row-menu"><button type="button" class="icon-btn" data-menu-toggle aria-haspopup="menu" aria-expanded="false" title="${escAttr(label)}" aria-label="${escAttr(label)}">${icon("more")}</button><span class="row-menu-list hidden" role="menu">${buttons}</span></span>`;
}

/**
 * The cell after a source row's checkbox: a tick when the row is already on
 * the destination. The row may be dimmed, but this cell is not.
 */
export function onDestCell(onDest) {
  const label = "Already on the destination";
  return `<td class="col-tick">${onDest ? `<span class="on-dest" role="img" title="${label}" aria-label="${label}">${icon("check")}</span>` : ""}</td>`;
}

/** Header for the tick column. */
export const ON_DEST_HEADER = `<th class="col-tick" title="Already on the destination"></th>`;

let menuWired = false;

/** Opens and closes row menus under root. Safe to call after every render. */
export function wireRowMenus(root = document) {
  root.querySelectorAll("[data-menu-toggle]").forEach((btn) => {
    if (btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const list = btn.nextElementSibling;
      const open = list.classList.contains("hidden");
      closeAllMenus();
      if (open) {
        list.classList.remove("hidden");
        btn.setAttribute("aria-expanded", "true");
      }
    });
    btn.nextElementSibling.addEventListener("click", () => closeAllMenus());
  });
  if (!menuWired) {
    menuWired = true;
    document.addEventListener("click", closeAllMenus);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllMenus(); });
  }
}

function closeAllMenus() {
  document.querySelectorAll(".row-menu-list:not(.hidden)").forEach((l) => {
    l.classList.add("hidden");
    l.previousElementSibling?.setAttribute("aria-expanded", "false");
  });
}

/** Thin stacked bar for match / differ / source only / dest only counts. */
export function stackBar(c) {
  const total = (c.match ?? 0) + (c.differ ?? 0) + (c.sourceOnly ?? 0) + (c.destOnly ?? 0);
  if (!total) return "";
  const seg = (n, cls) => (n ? `<span class="${cls}" style="flex:${n}"></span>` : "");
  return `<div class="stack-bar" role="img" aria-label="${escAttr(`${c.match ?? 0} match, ${c.differ ?? 0} differ, ${c.sourceOnly ?? 0} source only, ${c.destOnly ?? 0} destination only`)}">${seg(c.match, "s-match")}${seg(c.differ, "s-differ")}${seg(c.sourceOnly, "s-src")}${seg(c.destOnly, "s-dst")}</div>`;
}

const OUTCOME = {
  created: `<span class="tag tag-ok">created</span>`,
  updated: `<span class="tag tag-ok">updated</span>`,
  "would-create": `<span class="tag tag-accent">would create</span>`,
  "would-update": `<span class="tag tag-accent">would update</span>`,
  skipped: `<span class="tag tag-muted">already there</span>`,
  failed: `<span class="tag tag-bad">failed</span>`,
  added: `<span class="tag tag-ok">added</span>`,
  "would-add": `<span class="tag tag-accent">would add</span>`,
  deleted: `<span class="tag tag-ok">deleted</span>`,
  "would-delete": `<span class="tag tag-accent">would delete</span>`,
  waiting: `<span class="tag tag-muted">waiting</span>`,
};

/** Outcome name for a copy result from any of the migrate routes. */
export function outcomeOf(r) {
  if (!r.ok) return "failed";
  if (r.action === "skip-exists") return "skipped";
  if (String(r.action).startsWith("dry-run")) return "would-create";
  return "created";
}

/**
 * A result's notes for the results list: settings changed to fit, anything
 * else the copy noted, then a policy's assignments, one line each.
 */
export function notesOf(r) {
  return [...(r.adjustments ?? []), ...(r.notes ?? []), ...assignmentNotes(r)];
}

const ASSIGNEE = { user: "user", userGroup: "user group", endpoint: "device", endpointGroup: "device group" };

/** One line per assignment in a policy result, saying what happened to it and why. */
export function assignmentNotes(r) {
  const a = r?.assignments;
  if (!a) return [];
  const lines = (a.rows ?? []).map((row) => {
    const who = `${ASSIGNEE[row.kind] ?? row.kind} "${row.name}"`;
    switch (row.status) {
      case "will-set": return `would assign to ${who}`;
      case "set": return `assigned to ${who}`;
      case "already-set": return `already assigned to ${who}`;
      case "pending": return `pending, ${who}: ${row.reason}`;
      case "not-matched": return `not assigned to ${who}: ${row.reason}`;
      default: return `assigning ${who} failed: ${row.reason}`;
    }
  });
  return [...lines, ...(a.notes ?? [])];
}

/** How many assignments have each status across policy results. */
export function countAssignments(results) {
  const n = { "will-set": 0, set: 0, "already-set": 0, pending: 0, "not-matched": 0, failed: 0 };
  for (const r of results ?? []) {
    for (const row of r.assignments?.rows ?? []) n[row.status] = (n[row.status] ?? 0) + 1;
  }
  return n;
}

/** How many results have each outcome, counted the way the results list tags them. */
export function countOutcomes(results) {
  const n = { created: 0, "would-create": 0, skipped: 0, failed: 0 };
  for (const r of results) n[outcomeOf(r)]++;
  return n;
}

/**
 * Modal listing what a preview or a copy did.
 * groups: [{ title, rows: [{ outcome, text, error, notes }] }]
 */
export function resultsModal({ title, summary, groups }) {
  document.getElementById("results-modal")?.remove();
  const body = groups.filter((g) => g.rows.length).map((g) => `
    <h3>${esc(g.title)}</h3>
    <ul class="result-list">${g.rows.map((r) => `
      <li class="result-row">
        ${OUTCOME[r.outcome] ?? ""}
        <span class="mono-cell">${esc(r.text)}</span>
        ${r.error ? `<span class="ep-error">${esc(r.error)}</span>` : ""}
        ${(r.notes ?? []).length ? `<ul class="result-notes">${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      </li>`).join("")}
    </ul>`).join("");
  const modal = document.createElement("div");
  modal.id = "results-modal";
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-card" role="dialog" aria-label="${escAttr(title)}">
      <header class="modal-header">
        <h2>${esc(title)}</h2>
        <button class="icon-btn modal-close" title="Close" aria-label="Close">${icon("x")}</button>
      </header>
      <div class="modal-body">
        ${summary ? `<p class="hint">${esc(summary)}</p>` : ""}
        ${body || `<div class="empty-state">Nothing to show.</div>`}
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector(".modal-close").addEventListener("click", () => modal.remove());
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  return modal;
}
