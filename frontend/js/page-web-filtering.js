import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { makeSortable } from "./sortable.js";
import { esc, escAttr, plural, resultsModal, outcomeOf, rowMenu, wireRowMenus, onDestCell, ON_DEST_HEADER, notesOf } from "./ui.js";

const TABS = {
  "site-lists": { label: "site list", path: "site-lists", param: "siteListIds" },
  profiles: { label: "profile", path: "profiles", param: "profileIds" },
};

const state = {
  activeTab: "site-lists",
  data: { "site-lists": { source: [], dest: [] }, profiles: { source: [], dest: [] } },
  selected: new Set(), // `${tab}::${id}`
};

async function boot() {
  wireTabs();
  wireSelection();
  wireBasket();
  await loadAll();
  renderActive();
}

async function loadAll() {
  await Promise.all(Object.keys(TABS).flatMap((tab) => ["source", "dest"].map((side) => load(tab, side))));
}

async function load(tab, side) {
  try {
    const res = await api.get(`/api/${side}/web-filters/${TABS[tab].path}`);
    state.data[tab][side] = res.items || [];
  } catch (err) {
    state.data[tab][side] = { error: err.message };
  }
}

const nameKey = (n) => String(n ?? "").trim().toLowerCase();

function renderActive() {
  renderTable("source");
  renderTable("dest");
  for (const tab of Object.keys(TABS)) {
    const el = document.querySelector(`[data-count="${tab}"]`);
    const items = state.data[tab].source;
    if (el) el.textContent = Array.isArray(items) ? String(items.length) : "";
  }
}

function renderTable(side) {
  const tab = state.activeTab;
  const data = state.data[tab][side];
  const target = document.getElementById(`table-${side}`);
  if (data?.error) {
    target.innerHTML = `<div class="banner banner-err">${esc(data.error)}</div>`;
    return;
  }
  const items = Array.isArray(data) ? data : [];
  if (!items.length) {
    target.innerHTML = `<div class="empty-state">No ${tab === "profiles" ? "profiles" : "site lists"}.</div>`;
    return;
  }
  const other = state.data[tab][side === "source" ? "dest" : "source"];
  const otherNames = new Set(Array.isArray(other) ? other.map((x) => nameKey(x.name)) : []);

  const rows = [...items].sort((a, b) => a.name.localeCompare(b.name)).map((it) => {
    const key = `${tab}::${it.id}`;
    const checked = side === "source" && state.selected.has(key) ? "checked" : "";
    const onBoth = otherNames.has(nameKey(it.name));
    const cb = side === "source" ? `<td class="col-check"><input type="checkbox" data-key="${escAttr(key)}" ${checked} aria-label="Select ${escAttr(it.name)}"/></td>${onDestCell(onBoth)}` : "";
    const cls = [onBoth ? "is-dim" : "", checked ? "selected" : ""].filter(Boolean).join(" ");
    const cells = tab === "site-lists"
      ? `<td><span class="cell-name">${esc(it.name)}</span>${it.description ? `<div class="hint">${esc(it.description)}</div>` : ""}</td>
         <td class="tnum">${it.numberOfSites ?? "-"}</td>
         <td>${(it.usedBy || []).map((p) => `<span class="tag tag-muted">${esc(p.name || p.id)}</span>`).join(" ") || `<span class="hint">none</span>`}</td>`
      : `<td><span class="cell-name">${esc(it.name)}</span>${it.description ? `<div class="hint">${esc(it.description)}</div>` : ""}</td>
         <td class="tnum">${(it.consumers || []).length}</td>
         <td><span class="hint">${it.updatedAt ? new Date(it.updatedAt).toLocaleDateString() : ""}</span></td>`;
    const menu = side === "dest"
      ? `<td class="col-actions">${rowMenu([
          { label: "Delete from destination", icon: "trash", danger: true, attrs: `data-delete-id="${escAttr(it.id)}" data-name="${escAttr(it.name)}"` },
        ])}</td>`
      : "";
    return `<tr${cls ? ` class="${cls}"` : ""}${onBoth ? ' title="A list or profile with this name exists on both sides"' : ""}>${cb}${cells}${menu}</tr>`;
  }).join("");

  const head = tab === "site-lists" ? "<th>Name</th><th>Sites</th><th>Used by</th>" : "<th>Name</th><th>Policies</th><th>Updated</th>";
  target.innerHTML = `
    <table class="data-table">
      <thead><tr>${side === "source" ? `<th class="col-check"></th>${ON_DEST_HEADER}` : ""}${head}${side === "dest" ? `<th class="col-actions"></th>` : ""}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  makeSortable(target);
  if (side === "dest") {
    wireRowMenus(target);
    target.querySelectorAll("[data-delete-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => deleteFromDest(tab, e.currentTarget.dataset.deleteId, e.currentTarget.dataset.name));
    });
  }
  if (side === "source") {
    target.querySelectorAll("input[data-key]").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        if (e.target.checked) state.selected.add(e.target.dataset.key);
        else state.selected.delete(e.target.dataset.key);
        e.target.closest("tr")?.classList.toggle("selected", e.target.checked);
        renderBasket();
      });
    });
  }
}

function wireTabs() {
  document.querySelectorAll(".seg-btn[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn[data-tab]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.activeTab = btn.dataset.tab;
      renderActive();
    });
  });
}

function wireSelection() {
  document.getElementById("select-all-source").addEventListener("click", () => {
    const tab = state.activeTab;
    const items = Array.isArray(state.data[tab].source) ? state.data[tab].source : [];
    for (const it of items) state.selected.add(`${tab}::${it.id}`);
    renderActive();
    renderBasket();
    toast(`Selected ${plural(items.length, TABS[tab].label)}.`, "ok");
  });
  document.getElementById("clear-source").addEventListener("click", () => {
    const tab = state.activeTab;
    for (const key of [...state.selected]) if (key.startsWith(`${tab}::`)) state.selected.delete(key);
    renderActive();
    renderBasket();
  });
}

function renderBasket() {
  const n = state.selected.size;
  document.getElementById("basket-count").textContent = String(n);
  document.getElementById("basket-noun").textContent = n === 1 ? "item selected" : "items selected";
  document.getElementById("selection-basket").classList.toggle("hidden", n === 0);
}

function payload() {
  const body = { siteListIds: [], profileIds: [] };
  for (const key of state.selected) {
    const i = key.indexOf("::");
    const tab = key.slice(0, i);
    body[TABS[tab].param].push(key.slice(i + 2));
  }
  return body;
}

function wireBasket() {
  document.getElementById("basket-preview").addEventListener("click", async () => {
    try {
      const res = await api.post("/api/migrate/web-filters", { ...payload(), dryRun: true });
      showResults(res.results ?? [], true);
    } catch (err) {
      toast(err.message || "Preview failed", "err");
    }
  });
  document.getElementById("basket-copy").addEventListener("click", async () => {
    const body = payload();
    const total = body.siteListIds.length + body.profileIds.length;
    if (!confirm(`Copy ${plural(total, "item")} to the destination?\n\nSite lists are created first, then profiles.`)) return;
    try {
      const res = await api.post("/api/migrate/web-filters", body);
      const results = res.results ?? [];
      const failed = results.filter((r) => !r.ok).length;
      toast(`Copied ${results.filter((r) => r.ok && r.action === "create").length} / failed ${failed}`, failed ? "err" : "ok");
      showResults(results, false);
      state.selected.clear();
      renderBasket();
      await Promise.all(Object.keys(TABS).map((tab) => load(tab, "dest")));
      renderActive();
    } catch (err) {
      toast(err.message || "Copy failed", "err");
    }
  });
}

/** Preview the delete first: a list or profile still in use is refused before anything is sent. */
async function deleteFromDest(tab, id, name) {
  const body = { [TABS[tab].param]: [id] };
  const noun = TABS[tab].label;
  try {
    const preview = (await api.post("/api/dest/web-filters/delete", { ...body, dryRun: true })).results ?? [];
    if (preview.some((r) => !r.ok)) {
      showDeleteResults(preview, true);
      return;
    }
    if (!confirm(`Delete the destination ${noun} "${name}"?\n\nThis action is irreversible.`)) return;
    if (!confirm(`Are you absolutely sure? "${name}" will be permanently removed from the destination tenant.`)) return;
    const results = (await api.post("/api/dest/web-filters/delete", body)).results ?? [];
    const failed = results.filter((r) => !r.ok).length;
    if (failed) showDeleteResults(results, false);
    else toast(`Deleted "${name}" from destination.`, "ok");
    await Promise.all(Object.keys(TABS).map((t) => load(t, "dest")));
    renderActive();
  } catch (err) {
    toast(err.message || "Delete failed", "err");
  }
}

function showDeleteResults(results, dryRun) {
  const deleteRow = (r) => ({
    outcome: !r.ok ? "failed" : r.action === "dry-run-delete" ? "would-delete" : "deleted",
    text: r.name,
    error: r.error,
  });
  resultsModal({
    title: dryRun ? "Preview: nothing was deleted" : "Delete results",
    summary: dryRun ? "The destination refuses to delete an item that is still in use." : "Each delete is in data/audit.log.",
    groups: [
      { title: "Profiles", rows: results.filter((r) => r.kind === "profile").map(deleteRow) },
      { title: "Site lists", rows: results.filter((r) => r.kind === "site-list").map(deleteRow) },
    ],
  });
}

function showResults(results, dryRun, overwrite = false) {
  const creates = results.filter((r) => r.ok && (r.action === "create" || r.action === "dry-run-create")).length;
  const replaced = results.filter((r) => r.ok && (r.action === "overwrite" || r.action === "dry-run-overwrite")).length;
  const differing = results.filter((r) => r.ok && r.action === "differs");
  const done = overwrite
    ? `${plural(replaced, "item")} ${dryRun ? "would be replaced" : "replaced"} on the destination.`
    : `${plural(creates, "item")} ${dryRun ? "would be created" : "created"} on the destination.`;
  const modal = resultsModal({
    title: dryRun ? "Preview: nothing was written" : overwrite ? "Overwrite results" : "Copy results",
    summary: `${done}${differing.length ? ` ${plural(differing.length, "item")} with the same name ${differing.length === 1 ? "differs" : "differ"} on the destination.` : ""}${dryRun ? "" : " Each write is in data/audit.log."}`,
    groups: [
      { title: "Site lists", rows: results.filter((r) => r.kind === "site-list").map(row) },
      { title: "Profiles", rows: results.filter((r) => r.kind === "profile").map(row) },
    ],
  });
  if (differing.length) offerOverwrite(modal, differing);
}

/**
 * Under a result list with items that differ: replace them on the
 * destination with the source version, after two confirmations.
 */
function offerOverwrite(modal, differing) {
  const box = document.createElement("div");
  box.className = "form-actions overwrite-offer";
  box.innerHTML = `<p class="hint">An overwrite replaces each one on the destination with the source version, keeping the destination's name. Site lists go first, then profiles.</p>
    <button type="button" class="btn btn-danger" data-overwrite>Overwrite ${esc(plural(differing.length, "item"))} on the destination</button>`;
  modal.querySelector(".modal-body").appendChild(box);
  box.querySelector("[data-overwrite]").addEventListener("click", async () => {
    const names = differing.map((r) => `"${r.sourceName}"`).join(", ");
    if (!confirm(`Overwrite ${plural(differing.length, "item")} on the destination with the source version?\n\n${names}`)) return;
    if (!confirm(`Are you absolutely sure? The destination's current content of ${differing.length === 1 ? "this item" : "these items"} is replaced, and the tool can't put it back.`)) return;
    const body = {
      siteListIds: differing.filter((r) => r.kind === "site-list").map((r) => r.sourceId),
      profileIds: differing.filter((r) => r.kind === "profile").map((r) => r.sourceId),
      overwrite: true,
    };
    try {
      const res = await api.post("/api/migrate/web-filters", body);
      const results = res.results ?? [];
      const failed = results.filter((r) => !r.ok).length;
      toast(`Replaced ${results.filter((r) => r.ok && r.action === "overwrite").length} / failed ${failed}`, failed ? "err" : "ok");
      showResults(results, false, true);
      await Promise.all(Object.keys(TABS).map((tab) => load(tab, "dest")));
      renderActive();
    } catch (err) {
      toast(err.message || "Overwrite failed", "err");
    }
  });
}

function row(r) {
  const outcome = !r.ok ? "failed"
    : r.action === "differs" ? "differs"
      : r.action === "overwrite" ? "updated"
        : r.action === "dry-run-overwrite" ? "would-update"
          : outcomeOf(r);
  return {
    outcome,
    text: r.note ? `${r.sourceName} (${r.note})` : r.sourceName,
    error: r.error,
    notes: notesOf(r),
  };
}

boot();
