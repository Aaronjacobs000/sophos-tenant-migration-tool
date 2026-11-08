import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { makeSortable } from "./sortable.js";
import { icon } from "./icons.js";
import { esc, escAttr, plural, resultsModal, outcomeOf, rowMenu, wireRowMenus, onDestCell, ON_DEST_HEADER, notesOf, stackBar, countAssignments } from "./ui.js";

const SIDE = { source: "source", dest: "destination" };

const state = {
  data: { source: [], dest: [] }, // or { error }
  settings: { source: undefined, dest: undefined }, // null: AI Defense not set up; { error }: could not be read
  matches: null, // from /api/compare/ai-defense/policies
  matchError: null,
  selected: new Set(),
};

async function boot() {
  wireSelection();
  wireBasket();
  document.getElementById("refresh").addEventListener("click", reload);
  await reload();
}

async function reload() {
  await Promise.all([load("source"), load("dest")]);
  render();
  await loadMatches();
  render();
}

async function load(side) {
  try {
    const res = await api.get(`/api/${side}/ai-defense/policies`);
    state.data[side] = res.items || [];
    state.settings[side] = "settingsError" in res ? { error: res.settingsError } : res.settings ?? null;
  } catch (err) {
    state.data[side] = { error: err.message };
    state.settings[side] = undefined;
  }
}

async function loadMatches() {
  state.matches = null;
  state.matchError = null;
  if (state.data.source.error || state.data.dest.error) return;
  try {
    state.matches = (await api.get("/api/compare/ai-defense/policies")).matches ?? [];
  } catch (err) {
    state.matchError = err.message || "the comparison failed";
  }
}

function matchOf(side, id) {
  return state.matches?.find((m) => (side === "source" ? m.sourceId : m.destId) === id) ?? null;
}

// ---------- rendering ----------

function render() {
  renderStatus();
  renderSummary();
  renderTable("source");
  renderTable("dest");
}

/** Per side: whether the tenant is set up for AI Defense. A side that could not be read says why in its table. */
function renderStatus() {
  const out = [];
  for (const side of ["source", "dest"]) {
    const data = state.data[side];
    const s = state.settings[side];
    if (data?.error) continue;
    if (s === null) {
      out.push(side === "dest"
        ? `<div class="banner banner-warn">AI Defense isn't set up on the destination. Policies can be copied there, but Sophos enforces them only once AI Defense is licensed and set up on it.</div>`
        : `<div class="banner banner-info">AI Defense isn't set up on the source${Array.isArray(data) && data.length ? "" : ", so it has no policies to copy"}.</div>`);
    } else if (s?.error) {
      out.push(`<div class="banner banner-info">The tool could not read the ${SIDE[side]}'s AI Defense setup: ${esc(s.error)}</div>`);
    } else if (s?.licenseState === "EXPIRED") {
      out.push(`<div class="banner banner-warn">The ${SIDE[side]}'s AI Defense licence has ended.</div>`);
    }
  }
  document.getElementById("ai-status").innerHTML = out.join("");
}

function renderSummary() {
  const el = document.getElementById("match-summary");
  if (state.matchError) {
    el.innerHTML = `Comparison failed: ${esc(state.matchError)}`;
    return;
  }
  if (!state.matches) {
    el.textContent = state.data.source.error || state.data.dest.error ? "" : "Comparing";
    return;
  }
  const n = (s) => state.matches.filter((m) => m.status === s).length;
  const c = { match: n("match"), differ: n("differ"), sourceOnly: n("source-only"), destOnly: n("dest-only") };
  const item = (k, cls, text) => (k ? `<span class="${cls}"><i></i><b>${k}</b> ${text}</span>` : "");
  el.innerHTML = `<span class="product-bar">${stackBar(c)}<span class="legend">${item(c.match, "l-match", "match")}${item(c.differ, "l-differ", "differ")}${item(c.sourceOnly, "l-src", "source only")}${item(c.destOnly, "l-dst", "destination only")}</span></span>`;
}

/** The users, user groups, devices and device groups an Endpoint scope names, counted once each. */
function scopeCounts(scope) {
  const s = scope && typeof scope === "object" ? scope : {};
  const ids = { user: new Set(), userGroup: new Set(), endpoint: new Set(), endpointGroup: new Set() };
  const list = (v) => (Array.isArray(v) ? v : []);
  for (const u of list(s.users)) if (u?.id) ids.user.add(u.id);
  for (const id of list(s.user_ids)) ids.user.add(id);
  for (const [kind, idKey, richKey] of [["userGroup", "group_ids", "groups"], ["endpoint", "device_ids", "devices"], ["endpointGroup", "device_group_ids", "device_groups"]]) {
    for (const id of list(s[idKey])) ids[kind].add(id);
    for (const o of list(s[richKey])) if (o?.id) ids[kind].add(o.id);
  }
  return ids;
}

const KIND_NAMES = { user: ["user", "users"], userGroup: ["user group", "user groups"], endpointGroup: ["device group", "device groups"], endpoint: ["device", "devices"] };

function appliesTo(p) {
  const endpoint = p.sensors?.endpoint;
  if (!endpoint) return `<span class="hint">no Endpoint sensor</span>`;
  if (endpoint.scope?.type === "EVERYONE") return "everyone";
  const ids = scopeCounts(endpoint.scope);
  const parts = Object.entries(KIND_NAMES).filter(([k]) => ids[k].size).map(([k, [one, many]]) => plural(ids[k].size, one, many));
  return parts.length ? esc(parts.join(", ")) : `<span class="hint">nobody yet</span>`;
}

const SENSOR_LABEL = { endpoint: "Endpoint", firewall: "Firewall", dns: "DNS", browser: "Browser" };

function sensors(p) {
  return Object.entries(SENSOR_LABEL)
    .filter(([k]) => p.sensors?.[k])
    .map(([k, label]) => `<span class="tag ${p.sensors[k].enabled ? "tag-muted" : ""}" title="${escAttr(`${label} sensor ${p.sensors[k].enabled ? "on" : "off"}`)}">${label}${p.sensors[k].enabled ? "" : " off"}</span>`)
    .join(" ");
}

function nameTags(p) {
  const tags = [];
  if (p.kind === "TENANT_BASE") tags.push(`<span class="tag tag-muted" title="The base policy applies to everyone and is evaluated last">base</span>`);
  if (p.origin === "PARTNER") tags.push(`<span class="tag tag-muted" title="Set by the partner and read only on the tenant">partner</span>`);
  if (p.builtInKey) tags.push(`<span class="tag tag-muted" title="Made from a Sophos starter template">${esc(p.builtInKey)}</span>`);
  return tags.join(" ");
}

function statusTag(m) {
  if (!m) return "";
  if (m.status === "match") return `<span class="tag tag-ok" title="Rules, base rule, description, tags and state match">${icon("check")}match</span>`;
  if (m.status === "differ") {
    const n = m.differences?.length ?? 0;
    return `<span class="tag tag-warn" title="${escAttr((m.differences ?? []).join("; "))}">${n} ${n === 1 ? "change" : "changes"}</span>`;
  }
  if (m.status === "ambiguous") return `<span class="tag tag-warn" title="${escAttr(m.reason ?? "")}">ambiguous name</span>`;
  if (m.status === "not-copied") return `<span class="tag tag-muted" title="${escAttr(m.reason ?? "")}">not copied</span>`;
  return "";
}

const stateCell = (p) => (p.state === "ENABLED" ? `<span class="tag tag-ok">on</span>` : `<span class="tag tag-muted">off</span>`);

function renderTable(side) {
  const data = state.data[side];
  const target = document.getElementById(`table-${side}`);
  if (data?.error) {
    target.innerHTML = `<div class="banner banner-err">${esc(data.error)}</div>`;
    return;
  }
  const items = Array.isArray(data) ? data : [];
  if (!items.length) {
    target.innerHTML = `<div class="empty-state">No AI Defense policies.</div>`;
    return;
  }
  const rows = items.map((p) => {
    const m = matchOf(side, p.id);
    const onBoth = !!m?.sourceId && !!m?.destId;
    const copyable = p.origin !== "PARTNER";
    const key = p.id;
    const checked = side === "source" && state.selected.has(key) ? "checked" : "";
    const cb = side === "source"
      ? `<td class="col-check"><input type="checkbox" data-key="${escAttr(key)}" ${checked} ${copyable ? "" : 'disabled title="Partner policies are read only and not copied"'} aria-label="Select ${escAttr(p.name)}"/></td>${onDestCell(onBoth)}`
      : "";
    const cls = [onBoth && m?.status === "match" ? "is-dim" : "", checked ? "selected" : ""].filter(Boolean).join(" ");
    const cells = `
      <td><span class="cell-name">${esc(p.name)}</span> ${nameTags(p)} ${statusTag(m)}${p.description ? `<div class="hint">${esc(p.description)}</div>` : ""}</td>
      <td>${stateCell(p)}</td>
      <td class="tnum">${p.rank}</td>
      <td class="tnum">${(p.rules ?? []).length}</td>
      <td>${appliesTo(p)}</td>
      <td>${sensors(p)}</td>`;
    const deletable = p.kind !== "TENANT_BASE" && p.origin !== "PARTNER";
    const menu = side === "dest"
      ? `<td class="col-actions">${deletable ? rowMenu([
          { label: "Delete from destination", icon: "trash", danger: true, attrs: `data-delete-id="${escAttr(p.id)}" data-name="${escAttr(p.name)}"` },
        ]) : ""}</td>`
      : "";
    return `<tr${cls ? ` class="${cls}"` : ""}>${cb}${cells}${menu}</tr>`;
  }).join("");

  const head = "<th>Name</th><th>State</th><th>Rank</th><th>Rules</th><th>Applies to</th><th>Sensors</th>";
  target.innerHTML = `
    <table class="data-table">
      <thead><tr>${side === "source" ? `<th class="col-check"></th>${ON_DEST_HEADER}` : ""}${head}${side === "dest" ? `<th class="col-actions"></th>` : ""}</tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  makeSortable(target);
  if (side === "dest") {
    wireRowMenus(target);
    target.querySelectorAll("[data-delete-id]").forEach((btn) => {
      btn.addEventListener("click", (e) => deleteFromDest(e.currentTarget.dataset.deleteId, e.currentTarget.dataset.name));
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

// ---------- selection and copy ----------

function wireSelection() {
  document.getElementById("select-all-source").addEventListener("click", () => {
    const items = Array.isArray(state.data.source) ? state.data.source.filter((p) => p.origin !== "PARTNER") : [];
    for (const p of items) state.selected.add(p.id);
    render();
    renderBasket();
    toast(`Selected ${plural(items.length, "policy", "policies")}.`, "ok");
  });
  document.getElementById("clear-source").addEventListener("click", () => {
    state.selected.clear();
    render();
    renderBasket();
  });
}

function renderBasket() {
  const n = state.selected.size;
  document.getElementById("basket-count").textContent = String(n);
  document.getElementById("basket-noun").textContent = n === 1 ? "policy selected" : "policies selected";
  document.getElementById("selection-basket").classList.toggle("hidden", n === 0);
}

function wireBasket() {
  document.getElementById("basket-preview").addEventListener("click", async () => {
    try {
      const res = await api.post("/api/migrate/ai-defense", { policyIds: [...state.selected], dryRun: true });
      showResults(res.results ?? [], true);
    } catch (err) {
      toast(err.message || "Preview failed", "err");
    }
  });
  document.getElementById("basket-copy").addEventListener("click", async () => {
    const ids = [...state.selected];
    if (!confirm(`Copy ${plural(ids.length, "policy", "policies")} to the destination?\n\nEach copy is created turned off at the bottom of the destination's order, in its source order, then turned on if the source policy is on. Policies already on the destination are left as they are, and only the users, groups and devices they apply to are added.`)) return;
    try {
      const res = await api.post("/api/migrate/ai-defense", { policyIds: ids });
      const results = res.results ?? [];
      const failed = results.filter((r) => !r.ok).length;
      toast(`Copied ${results.filter((r) => r.ok && r.action === "create").length} / failed ${failed}`, failed ? "err" : "ok");
      showResults(results, false);
      state.selected.clear();
      renderBasket();
      await reload();
    } catch (err) {
      toast(err.message || "Copy failed", "err");
    }
  });
}

async function deleteFromDest(id, name) {
  if (!confirm(`Delete the destination AI Defense policy "${name}"?\n\nThis action is irreversible.`)) return;
  if (!confirm(`Are you absolutely sure? "${name}" will be permanently removed from the destination tenant, and its enforcement with it.`)) return;
  try {
    await api.del(`/api/dest/ai-defense/policies/${encodeURIComponent(id)}`);
    toast(`Deleted "${name}" from destination.`, "ok");
    await reload();
  } catch (err) {
    toast(err.message || "Delete failed", "err");
  }
}

function showResults(results, dryRun, overwrite = false) {
  const creates = results.filter((r) => r.ok && (r.action === "create" || r.action === "dry-run-create")).length;
  const replaced = results.filter((r) => r.ok && (r.action === "overwrite" || r.action === "dry-run-overwrite")).length;
  const differing = results.filter((r) => r.ok && r.action === "differs");
  const a = countAssignments(results);
  const done = overwrite
    ? `${plural(replaced, "policy", "policies")} ${dryRun ? "would be replaced" : "replaced"} on the destination.`
    : `${plural(creates, "policy", "policies")} ${dryRun ? "would be created" : "created"} on the destination.`;
  const scope = dryRun
    ? (a["will-set"] ? ` ${plural(a["will-set"], "user, group or device", "users, groups or devices")} would be added to their scope.` : "")
    : (a.set ? ` ${plural(a.set, "user, group or device", "users, groups or devices")} added to their scope.` : "");
  const unmatched = a.pending + a["not-matched"];
  const modal = resultsModal({
    title: dryRun ? "Preview: nothing was written" : overwrite ? "Overwrite results" : "Copy results",
    summary: `${done}${scope}${unmatched ? ` ${unmatched} pending or not matched.` : ""}${differing.length ? ` ${plural(differing.length, "policy", "policies")} with the same name ${differing.length === 1 ? "differs" : "differ"} on the destination.` : ""}${dryRun ? "" : " Each write is in data/audit.log."}`,
    groups: [{ title: "Policies", rows: results.map(row) }],
  });
  if (differing.length) offerOverwrite(modal, differing);
}

/** Under a result list with policies that differ: replace them on the destination, after two confirmations. */
function offerOverwrite(modal, differing) {
  const box = document.createElement("div");
  box.className = "form-actions overwrite-offer";
  box.innerHTML = `<p class="hint">An overwrite replaces each one's rules, base rule, description and tags with the source version, turns it on or off to match, and adds the users, groups and devices that match. It keeps the destination's name and place in the order.</p>
    <button type="button" class="btn btn-danger" data-overwrite>Overwrite ${esc(plural(differing.length, "policy", "policies"))} on the destination</button>`;
  modal.querySelector(".modal-body").appendChild(box);
  box.querySelector("[data-overwrite]").addEventListener("click", async () => {
    const names = differing.map((r) => `"${r.sourceName}"`).join(", ");
    if (!confirm(`Overwrite ${plural(differing.length, "policy", "policies")} on the destination with the source version?\n\n${names}`)) return;
    if (!confirm(`Are you absolutely sure? The destination's current rules of ${differing.length === 1 ? "this policy" : "these policies"} are replaced, and the tool can't put them back.`)) return;
    try {
      const res = await api.post("/api/migrate/ai-defense", { policyIds: differing.map((r) => r.sourceId), overwrite: true });
      const results = res.results ?? [];
      const failed = results.filter((r) => !r.ok).length;
      toast(`Replaced ${results.filter((r) => r.ok && r.action === "overwrite").length} / failed ${failed}`, failed ? "err" : "ok");
      showResults(results, false, true);
      await reload();
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
  return { outcome, text: r.sourceName, error: r.error, notes: notesOf(r) };
}

boot();
