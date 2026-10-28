// Migration job monitor. Sending tenant on the left, receiving tenant on the
// right, one row per requested device, and a progress ring for the share that
// has arrived. Built to be left open on a screen: it follows the server's
// event stream (the server sets the pace and stops once the job has finished),
// reconnects if the stream drops, and redraws only the rows that changed.

import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";
import { esc, escAttr } from "./ui.js";
import {
  statusTag,
  statusLabel,
  progressRing,
  formatWait,
  formatWhen,
  formatDate,
  jobSides,
  accessProblem,
} from "./migration-view.js";

const WAIT_NOTE_MS = 2 * 60 * 60 * 1000;
const STALE_GRACE_MS = 90_000;
const RECONNECT_MS = 30_000;
// Wall view shows as many devices as fit and turns to the next set on this beat.
const WALL_PAGE_MS = 12_000;

const state = {
  id: null,
  job: null,
  es: null,
  reconnectTimer: null,
  finished: false,
  streamDown: false,
  nextCheckAt: null,
  lastEventAt: 0,
  sawUnfinished: false,
  membershipPreviewed: false,
  // Destination group picked per device (by its ID on the sending tenant): a group ID, or null to leave it out.
  memberChoices: {},
  // Tamper protection and scan cards: previewed once devices have arrived, then on demand.
  arrivalPreviewed: false,
  tamperShown: null,
  scanShown: null,
  rows: new Map(),
  sig: {},
  wallPage: 0,
};

function boot() {
  state.id = new URLSearchParams(window.location.search).get("id");
  if (!state.id) {
    document.getElementById("job-lead").textContent = "";
    document.getElementById("job-alerts").innerHTML = `<div class="banner banner-err">Missing job id.</div>`;
    return;
  }
  document.addEventListener("click", onAction);
  document.addEventListener("change", onMemberPick);
  document.addEventListener("change", onTamperOption);
  showTamperOptions();
  if (new URLSearchParams(window.location.search).get("view") === "wall") setWall(true);
  window.addEventListener("resize", () => {
    fitWall();
    layoutWall();
  });
  connect();
  setInterval(tick, 1000);
  setInterval(() => {
    if (!document.body.classList.contains("is-wall")) return;
    state.wallPage++;
    layoutWall();
  }, WALL_PAGE_MS);
}

// ---------- live stream ----------

function connect() {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.es) state.es.close();
  state.finished = false;
  const es = new EventSource(`/api/migrate/devices/jobs/${encodeURIComponent(state.id)}/stream`);
  state.es = es;
  es.addEventListener("status", (e) => {
    try {
      const job = JSON.parse(e.data);
      state.streamDown = false;
      state.lastEventAt = Date.now();
      state.nextCheckAt = job.nextCheckAt ?? null;
      apply(job);
    } catch (err) {
      console.error("bad status event", err);
    }
  });
  es.addEventListener("done", () => {
    es.close();
    if (state.es === es) state.es = null;
    state.finished = true;
    state.nextCheckAt = null;
    const job = state.job;
    if (job && state.sawUnfinished) {
      const ok = job.status === "completed";
      toast(ok ? "Migration completed. Every device has checked in." : `Migration finished: ${statusLabel(job.status).toLowerCase()}.`, ok ? "ok" : "info", 8000);
    }
    renderLive();
  });
  es.addEventListener("error", (e) => {
    // The server sends "error" events for a failed check; the browser sends one when the connection drops.
    if (e.data) return;
    if (state.finished) return;
    state.streamDown = true;
    renderLive();
    if (es.readyState === EventSource.CLOSED) {
      if (state.es === es) state.es = null;
      scheduleReconnect();
    }
  });
}

function scheduleReconnect() {
  if (state.reconnectTimer || state.finished) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, RECONNECT_MS);
}

// Once a second: countdowns, wait times, and a watchdog for a stream that went quiet.
function tick() {
  if (!state.job) return;
  renderLive();
  for (const el of document.querySelectorAll("[data-wait-since]")) {
    el.textContent = formatWait(Date.now() - Date.parse(el.dataset.waitSince));
  }
  if (!state.finished && state.nextCheckAt && Date.now() > Date.parse(state.nextCheckAt) + STALE_GRACE_MS) {
    state.streamDown = true;
    state.nextCheckAt = null;
    connect();
  }
}

function apply(job) {
  state.job = job;
  if (!job.progress.finished) state.sawUnfinished = true;
  render(job);
}

// ---------- rendering ----------

function render(job) {
  const p = job.progress;
  const sides = jobSides(job);
  const problem = accessProblem(job);
  document.title = `${p.percent}% · ${job.jobName} · Migration job`;
  document.getElementById("job-title").textContent = job.jobName;
  setHtml("job-status", statusTag(job.status, { large: true, paused: !checkable(job) }));
  const sideCls = (s) => `side-title${s.key === "dest" ? " is-dest" : ""}`;
  setHtml("job-route", `
    <span class="${sideCls(sides.sending)}">${esc(sides.sending.name)}</span>
    ${icon("arrowRight", "ico route-arrow")}
    <span class="${sideCls(sides.receiving)}">${esc(sides.receiving.name)}</span>`);
  document.getElementById("job-lead").textContent =
    `${p.total} device${p.total === 1 ? "" : "s"}, created ${new Date(job.createdAt).toLocaleString()}. ` +
    (p.finished ? "Finished." : `Devices can check in until ${formatDate(p.expiresAt)}, when the job expires.`);
  setHtml("job-counts", counts(p));
  setHtml("job-ring", progressRing(p, { size: "lg", stale: problem?.tone === "bad" || job.monitor?.state === "no-credentials" || job.monitor?.state === "not-found" }));
  renderAlerts(job);
  renderLanesHead(job, sides);
  renderLanes(job);
  // While the job can't be checked, the rows are the last known state: nothing moves.
  document.getElementById("lanes").classList.toggle("is-stale", !checkable(job));
  layoutWall();
  renderDetails(job);
  renderApiStatus(job);
  renderLive();

  const moved = p.arrived + p.waiting > 0;
  if (!state.membershipPreviewed && moved && job.monitor?.state === "ok") {
    state.membershipPreviewed = true;
    loadMembership(true);
  } else if (!state.membershipPreviewed) {
    const text = moved && !checkable(job)
      ? "Available once this job's tenants can be checked again."
      : "Available once devices have moved.";
    setHtml("membership-body", `<div class="empty-state">${text}</div>`);
  }

  // The tamper protection and scan previews only read, so they run once devices have checked in.
  if (!state.arrivalPreviewed && p.arrived > 0 && job.monitor?.state === "ok") {
    state.arrivalPreviewed = true;
    loadTamper(true);
    loadScan(true);
  } else if (!state.arrivalPreviewed) {
    const text = p.arrived > 0 && !checkable(job)
      ? "Available once this job's tenants can be checked again."
      : "Available once devices have checked in.";
    setHtml("tamper-body", `<div class="empty-state">${text}</div>`);
    setHtml("scan-body", `<div class="empty-state">${text}</div>`);
  }
  // "Only those with it on at the source" needs the state the job recorded, which jobs from before 0.5.0 lack.
  const scope = document.getElementById("tamper-scope");
  const recorded = !!job.endpointTamperProtection;
  scope.querySelector('option[value="was-on"]').disabled = !recorded;
  if (!recorded && scope.value === "was-on") scope.value = "all";
}

function checkable(job) {
  return !["rejected", "no-credentials", "not-found"].includes(job.monitor?.state);
}

/** Replace markup only when it changed, so running animations are not restarted. */
function setHtml(id, html) {
  if (state.sig[id] === html) return;
  state.sig[id] = html;
  document.getElementById(id).innerHTML = html;
}

function counts(p) {
  const item = (n, label, cls) => `<div class="count-chip ${cls}${n ? "" : " is-zero"}"><b class="tnum">${n}</b><span>${label}</span></div>`;
  return [
    item(p.arrived, "arrived", "is-arrived"),
    item(p.waiting, "waiting for check-in", "is-waiting"),
    item(p.requested, "not handed over", "is-requested"),
    item(p.failed + p.expired, "failed", "is-failed"),
  ].join("");
}

function renderLive() {
  const job = state.job;
  const el = document.getElementById("job-live");
  if (!job) return;
  const m = job.monitor ?? {};
  const lastOk = m.lastOkAt ? formatWhen(m.lastOkAt) : null;
  let dot = "ok";
  let text;
  if (state.streamDown && !state.finished) {
    dot = "warn";
    text = `Lost the connection to the tool. Reconnecting.${lastOk ? ` Last update ${lastOk}.` : ""}`;
  } else if (m.state === "rejected") {
    dot = "error";
    text = `Can't check: credentials rejected.${lastOk ? ` Last successful check ${lastOk}.` : ""}`;
  } else if (m.state === "no-credentials" || m.state === "not-found") {
    dot = "warn";
    text = `Can't check this job.${lastOk ? ` Last successful check ${lastOk}.` : " Showing the saved state."}`;
  } else if (m.state === "error") {
    dot = "warn";
    text = `Last check failed, retrying.${lastOk ? ` Last successful check ${lastOk}.` : ""}`;
  } else if (state.finished || job.progress.finished) {
    dot = "idle";
    text = `Finished. Last checked ${lastOk ?? "never"}. Not checking any more.`;
  } else {
    text = `Live. Updated ${lastOk ?? "not yet"}`;
  }
  const next = !state.finished && state.nextCheckAt && !state.streamDown
    ? Math.max(0, Math.round((Date.parse(state.nextCheckAt) - Date.now()) / 1000))
    : null;
  const nextText = next === null ? "" : next === 0 ? ", checking now" : `, next check in ${formatWait(next * 1000)}`;
  const html = `<span class="conn-dot" data-state="${dot === "idle" ? "unconfigured" : dot}"></span><span>${esc(text)}${esc(dot === "ok" ? nextText : "")}</span>`;
  if (el.innerHTML !== html) el.innerHTML = html;
}

function renderAlerts(job) {
  const p = job.progress;
  const m = job.monitor ?? {};
  const saved = m.lastOkAt ? `from the last successful check, ${new Date(m.lastOkAt).toLocaleString()}` : "saved with the job";
  const out = [];
  const actions = (...buttons) => `<div class="alert-actions">${buttons.join("")}</div>`;
  const btn = (action, label, primary) => `<button type="button" class="btn btn-small${primary ? " btn-primary" : ""}" data-action="${action}">${label}</button>`;

  if (m.state === "rejected") {
    out.push(alert("bad", "key", "Can't check status: credentials rejected",
      `Sophos refused the credentials stored with this job, so its progress can't be checked. They may have been deleted or changed in Sophos Fusion. The devices below show the last known state, ${saved}.`,
      actions(btn("attach-form", "Attach new credentials", true), btn("check-now", "Check again"))));
  } else if (m.state === "no-credentials" || m.state === "not-found") {
    out.push(alert("warn", "key", "Credentials not stored for this job",
      `${esc(m.message || "The tool has no credentials for this job's tenants.")} The devices below show the state ${saved}.`,
      actions(btn("attach-current", "Use the current connection", true), btn("attach-form", "Enter credentials"))));
  } else if (m.state === "error") {
    out.push(alert("warn", "alert", "The last check failed",
      `${esc(m.message || "Sophos did not answer.")} The tool keeps trying. The devices below show the state ${saved}.`, ""));
  } else if (!job.credentials?.stored && m.via === "current") {
    out.push(alert("info", "info", "Credentials not stored for this job",
      "It is checked with the tool's current connection, which points at the same tenants. Store them so the job can still be checked after the tool points at other tenants.",
      actions(btn("attach-current", "Store credentials", true))));
  }

  // How the start went, when Sophos gave no clear answer to it: the note the read-back left.
  for (const note of job.startNotes ?? []) {
    out.push(alert("info", "info", "Sophos gave no clear answer when this move started", `${esc(note)}.`, ""));
  }
  if (p.tamperLost > 0) {
    out.push(alert("warn", "lock", `${p.tamperLost} device${p.tamperLost === 1 ? "" : "s"} arrived without tamper protection`,
      `${p.tamperLost === 1 ? "It" : "They"} had it on at the source. A moved device takes the receiving tenant's setting. The Tamper protection card below can turn it on.`,
      actions(btn("goto-tamper", "Go to tamper protection", true))));
  }
  if (checkable(job) && !p.finished && p.oldestWaitSince && Date.now() - Date.parse(p.oldestWaitSince) > WAIT_NOTE_MS) {
    const long = p.devices.filter((d) => d.state === "waiting" && Date.now() - Date.parse(d.handedOverAt) > WAIT_NOTE_MS).length;
    out.push(alert("info", "clock", `${long} device${long === 1 ? " has" : "s have"} waited over 2 hours to check in`,
      `A device moves when it next checks in, so one that is switched off or offline waits. It can check in until ${new Date(p.expiresAt).toLocaleString()}, when the job expires.`, ""));
  }
  if (p.expired > 0) {
    out.push(alert("bad", "clock", `${p.expired} device${p.expired === 1 ? "" : "s"} did not check in before the job expired`,
      "Devices have to check in within 14 days for the move to land. Start a new migration for them once they are back online.", ""));
  }
  for (const [label, snap] of [["Sending", job.direction === "dest-to-source" ? job.destSnapshot : job.sourceSnapshot], ["Receiving", job.direction === "dest-to-source" ? job.sourceSnapshot : job.destSnapshot]]) {
    const err = snap?.errorMessage || snap?.errorCode;
    if (err) out.push(alert("bad", "alert", `${label} tenant reported an error`, esc(err), ""));
  }
  setHtml("job-alerts", out.join(""));
}

function alert(tone, ico, title, body, actionsHtml) {
  return `
    <div class="monitor-alert" data-tone="${tone}">
      <span class="alert-ico">${icon(ico)}</span>
      <div class="alert-body"><strong>${esc(title)}</strong><p>${body}</p></div>
      ${actionsHtml}
    </div>`;
}

function renderLanesHead(job, sides) {
  const side = (s, role) => `
    <div class="lane-tenant ${s.key === "dest" ? "is-dest" : "is-src"}">
      <span class="lane-role">${role}</span>
      <span class="lane-tenant-name">${esc(s.name)}</span>
      <span class="lane-tenant-meta">${s.tenantId ? `<code title="${escAttr(s.tenantId)}">${esc(s.tenantId.slice(0, 8))}</code>` : "tenant not recorded"}${s.region ? ` · ${esc(s.region)}` : ""}</span>
    </div>`;
  setHtml("lanes-head", `${side(sides.sending, "From")}<div class="lane-head-mid" aria-hidden="true">${icon("arrowRight")}</div>${side(sides.receiving, "To")}`);
}

// Rows are keyed by device ID and only replaced when their content changes.
function renderLanes(job) {
  const lanes = document.getElementById("lanes");
  const devices = [...job.progress.devices].sort((a, b) => a.hostname.localeCompare(b.hostname, undefined, { numeric: true }));
  if (!devices.length) {
    lanes.innerHTML = `<div class="empty-state">This job has no devices.</div>`;
    state.rows.clear();
    return;
  }
  lanes.dataset.density = devices.length > 14 ? "compact" : "comfortable";
  lanes.querySelector(".empty-state")?.remove();
  const seen = new Set();
  let prev = null;
  for (const d of devices) {
    seen.add(d.id);
    const html = laneRow(d);
    let row = state.rows.get(d.id);
    if (!row) {
      row = document.createElement("div");
      row.className = "lane-row";
      row.dataset.id = d.id;
      state.rows.set(d.id, row);
    }
    if (row.dataset.sig !== html) {
      row.innerHTML = html;
      row.dataset.sig = html;
      row.dataset.state = d.state;
    }
    const want = prev ? prev.nextSibling : lanes.firstChild;
    if (want !== row) lanes.insertBefore(row, want);
    prev = row;
  }
  for (const [id, row] of state.rows) {
    if (!seen.has(id)) {
      row.remove();
      state.rows.delete(id);
    }
  }
}

/**
 * A device's tamper protection for its lane: at the source on the left, on the
 * receiving tenant on the right once it has arrived, flagged when it had it on
 * and arrived without it.
 */
function tamperBit(d, side) {
  const t = d.tamperProtection;
  if (!t || t.supported === false) return "";
  const value = side === "from" ? t.atSource : t.arrived;
  if (typeof value !== "boolean") return "";
  const state = value ? "on" : "off";
  const title = side === "from"
    ? `Tamper protection at the source when the job was created: ${state}`
    : `Tamper protection on the receiving tenant: ${state}${t.readAt ? `, read ${formatWhen(t.readAt)}` : ""}${t.lost ? ". It was on at the source." : ""}`;
  return ` · <span class="tp-bit${side === "to" && t.lost ? " is-lost" : ""}" title="${escAttr(title)}">TP ${value ? "on" : "off"}</span>`;
}

function laneRow(d) {
  const oldId = `<code class="lane-id" title="${escAttr(d.id)}">${esc(d.id.slice(0, 8))}</code>`;
  const group = `${d.group ? ` · ${esc(d.group)}` : ""}${tamperBit(d, "from")}`;
  const fromTag = {
    requested: `<span class="tag tag-muted">Requested</span>`,
    waiting: `<span class="tag tag-accent">Handed over</span>`,
    arrived: `<span class="tag tag-muted">Moved</span>`,
    failed: `<span class="tag tag-bad">Not moved</span>`,
    expired: `<span class="tag tag-bad">Not moved</span>`,
  }[d.state];
  const fromSub = {
    requested: "Waiting for Sophos to hand it over",
    waiting: d.handedOverAt ? `Handed over ${formatWhen(d.handedOverAt)}` : "Handed over",
    arrived: "Old record stays here, offline",
    failed: "Still on this tenant",
    expired: "Still on this tenant",
  }[d.state];

  const newId = d.newId ? `<code class="lane-id" title="${escAttr(d.newId)}">${esc(d.newId)}</code>` : "";
  let to;
  if (d.state === "arrived") {
    to = `
      <div class="lane-dev">
        <span class="lane-host">${esc(d.hostname)}</span>
        <span class="lane-sub">${newId}${tamperBit(d, "to")}</span>
      </div>
      <span class="lane-end"><span class="tag tag-ok">${icon("check")}Arrived</span>${checkInTime(d)}</span>`;
  } else if (d.state === "waiting") {
    const since = d.handedOverAt ? `<span class="lane-time">waiting <b data-wait-since="${escAttr(d.handedOverAt)}">${esc(formatWait(Date.now() - Date.parse(d.handedOverAt)))}</b></span>` : "";
    to = `
      <div class="lane-dev is-ghost">
        <span class="lane-host">${esc(d.hostname)}</span>
        <span class="lane-sub">${newId ? `Registered as ${newId}` : "Registered, new ID not reported yet"}</span>
      </div>
      <span class="lane-end"><span class="tag tag-warn"><span class="conn-dot" data-state="loading"></span>Waiting for check-in</span>${since}</span>`;
  } else if (d.state === "requested") {
    to = `<span class="lane-slot">Not handed over yet</span>`;
  } else if (d.state === "failed") {
    to = `<span class="lane-slot is-bad">${icon("xCircle")}Move failed${d.reason ? `: ${esc(d.reason)}` : ""}</span>`;
  } else {
    to = `<span class="lane-slot is-bad">${icon("clock")}Did not check in before the job expired</span>`;
  }

  const mark = { arrived: icon("check"), failed: icon("x"), expired: icon("x") }[d.state] ?? "";
  return `
    <div class="lane-cell lane-from">
      <div class="lane-dev">
        <span class="lane-host">${esc(d.hostname)}</span>
        <span class="lane-sub">${oldId}${group}</span>
      </div>
      <span class="lane-end">${fromTag}<span class="lane-time">${esc(fromSub)}</span></span>
    </div>
    <div class="lane-link" aria-hidden="true"><span class="lane-track"></span>${d.state === "waiting" ? `<span class="lane-pulse"></span>` : ""}${mark ? `<span class="lane-mark">${mark}</span>` : ""}</div>
    <div class="lane-cell lane-to">${to}</div>`;
}

/**
 * A device's check-in time. Sophos records none, so the tool knows the check-in
 * came between its last check that found the device waiting and its first that
 * found it checked in. Close together (the page was open), the second is the
 * check-in time; far apart, it is only when the tool first saw it.
 */
function checkInTime(d) {
  const after = d.checkedInAfter ? formatWhen(d.checkedInAfter) : "";
  const title = d.checkInTimeExact
    ? `Sophos does not record when a device checks in. The tool saw it waiting${after ? ` at ${after}` : ""} and checked in at ${formatWhen(d.checkedInAt)}.`
    : `Sophos does not record when a device checks in, and the tool was not checking at the time. It checked in${after ? ` after ${after} and` : ""} by ${formatWhen(d.checkedInAt)}.`;
  const label = d.checkInTimeExact ? "checked in" : "first seen checked in";
  return `<span class="lane-time" title="${escAttr(title)}">${label} ${esc(formatWhen(d.checkedInAt))}</span>`;
}

function renderDetails(job) {
  const toSource = job.direction === "dest-to-source";
  const c = job.credentials ?? { stored: false };
  const finished = job.progress.finished;
  const creds = c.stored
    ? `<span class="tag tag-ok">${icon("lock")}Stored, encrypted</span> <span class="hint">${esc(c.mode === "partner" ? "partner credential" : "tenant credentials")}, ${esc(new Date(c.storedAt).toLocaleString())}</span>
       <div class="cred-actions"><button type="button" class="btn btn-small btn-danger" data-action="remove-creds">Remove stored credentials</button>${finished ? `<span class="hint">This job has finished, so it no longer needs them.</span>` : ""}</div>`
    : `<span class="tag tag-muted">Not stored</span>
       <div class="cred-actions"><button type="button" class="btn btn-small" data-action="attach-current">Use the current connection</button><button type="button" class="btn btn-small" data-action="attach-form">Enter credentials</button></div>`;
  setHtml("job-meta", `
    <dl class="kv-list">
      <dt>Name</dt><dd>${esc(job.jobName)}</dd>
      <dt>Direction</dt><dd><span class="tag ${toSource ? "tag-dst" : "tag-src"}">${toSource ? "destination" : "source"}</span> ${icon("arrowRight")} <span class="tag ${toSource ? "tag-src" : "tag-dst"}">${toSource ? "source" : "destination"}</span></dd>
      <dt>Migration ID</dt><dd><code>${esc(job.destMigrationId)}</code></dd>
      <dt>Created</dt><dd>${esc(new Date(job.createdAt).toLocaleString())}</dd>
      <dt>Expires</dt><dd>${esc(new Date(job.progress.expiresAt).toLocaleString())}</dd>
      <dt>Credentials</dt><dd>${creds}</dd>
      <dt>Local job ID</dt><dd><code>${esc(job.localJobId)}</code></dd>
    </dl>`);
}

function renderApiStatus(job) {
  setHtml("api-status", `
    <div>
      <h3 class="side-title">Source</h3>
      ${renderSnapshot(job.sourceSnapshot, "source", job.sourceMigrationId)}
    </div>
    <div>
      <h3 class="side-title is-dest">Destination</h3>
      ${renderSnapshot(job.destSnapshot, "dest", job.destMigrationId)}
    </div>`);
}

function renderSnapshot(snap, side, migrationId) {
  if (!snap) {
    return `<div class="banner banner-warn">No data from the ${side === "dest" ? "destination" : "source"} API yet.</div>`;
  }
  const counts = snap.endpointCounts || {};
  const countsHtml = counts.total != null
    ? `<dt>Endpoints</dt><dd>${counts.total ?? 0} total, ${counts.successful ?? 0} ok, ${counts.failed ?? 0} failed, ${counts.pending ?? 0} pending</dd>`
    : "";
  const errorHtml = snap.errorCode || snap.errorMessage
    ? `<div class="banner banner-err">${snap.errorCode ? `<strong>${esc(snap.errorCode)}</strong>: ` : ""}${esc(snap.errorMessage || "Unknown error")}</div>`
    : "";
  const finished = snap.finishedAt ? `<dt>Finished</dt><dd>${new Date(snap.finishedAt).toLocaleString()}</dd>` : "";
  return `
    <dl class="kv-list">
      <dt>Migration ID</dt><dd><code>${esc(migrationId)}</code></dd>
      <dt>API status</dt><dd>${snap.status ? `<span class="tag tag-muted">${esc(snap.status)}</span>` : `<span class="hint">not reported</span>`}</dd>
      <dt>Mode</dt><dd>${esc(snap.mode || snap.type || "not reported")}</dd>
      ${countsHtml}
      ${finished}
    </dl>
    ${errorHtml}`;
}

// ---------- actions ----------

async function onAction(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "check-now") return checkNow(btn);
  if (action === "wall") return setWall(!document.body.classList.contains("is-wall"));
  if (action === "attach-current") return attachCurrent(btn);
  if (action === "attach-form") return openAttachForm();
  if (action === "remove-creds") return removeCreds(btn);
  if (action === "membership-preview") return loadMembership(true);
  if (action === "membership-apply") return applyMembership();
  if (action === "tamper-preview") return loadTamper(true);
  if (action === "tamper-apply") return applyTamper();
  if (action === "scan-preview") return loadScan(true);
  if (action === "scan-apply") return applyScan();
  if (action === "goto-tamper") return document.getElementById("tamper-card").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function checkNow(btn) {
  btn.disabled = true;
  try {
    const job = await api.get(`/api/migrate/devices/jobs/${encodeURIComponent(state.id)}`);
    apply(job);
    // Restart the stream so its pace follows the new state (for example after new credentials).
    if (!job.progress.finished) connect();
    toast("Checked with Sophos.", "ok");
  } catch (err) {
    toast(err.message || "Check failed", "err");
  } finally {
    btn.disabled = false;
  }
}

async function attachCurrent(btn) {
  btn.disabled = true;
  try {
    const job = await api.post(`/api/migrate/devices/jobs/${encodeURIComponent(state.id)}/credentials`, { use: "current" });
    apply(job);
    toast("Credentials stored with this job.", "ok");
    connect();
  } catch (err) {
    toast(err.message || "Could not attach the credentials", "err", 9000);
  } finally {
    btn.disabled = false;
  }
}

async function removeCreds(btn) {
  if (!confirm("Remove the credentials stored with this job?\n\nThe job can then only be checked while the tool points at its tenants. The tool's own connection is not changed.")) return;
  btn.disabled = true;
  try {
    const job = await api.post(`/api/migrate/devices/jobs/${encodeURIComponent(state.id)}/credentials/remove`, {});
    apply(job);
    toast("Stored credentials removed.", "ok");
  } catch (err) {
    toast(err.message || "Could not remove the credentials", "err");
  } finally {
    btn.disabled = false;
  }
}

function openAttachForm() {
  document.getElementById("attach-modal")?.remove();
  const sides = state.job ? jobSides(state.job) : null;
  const field = (name, label, type) => `<label>${label}<input type="${type}" name="${name}" autocomplete="off" spellcheck="false" required /></label>`;
  const modal = document.createElement("div");
  modal.id = "attach-modal";
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-card" role="dialog" aria-label="Attach credentials">
      <header class="modal-header"><h2>Attach credentials to this job</h2><button type="button" class="icon-btn" data-close title="Close" aria-label="Close">${icon("x")}</button></header>
      <form class="modal-body cred-form" id="attach-form">
        <p class="hint">Tenant API credentials for the two tenants this job ran on, from <strong>Global Settings &gt; API Credentials</strong> in each. The tool checks that both tenants know this migration job before it stores them, encrypted. For partner credentials, point the tool at the two tenants and use the current connection instead.</p>
        <div class="split-row">
          <fieldset class="attach-side"><legend>From: ${esc(sides?.sending.name ?? "sending tenant")}</legend>${field("sendingId", "Client ID", "text")}${field("sendingSecret", "Client secret", "password")}</fieldset>
          <fieldset class="attach-side"><legend>To: ${esc(sides?.receiving.name ?? "receiving tenant")}</legend>${field("receivingId", "Client ID", "text")}${field("receivingSecret", "Client secret", "password")}</fieldset>
        </div>
        <div id="attach-result"></div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Check and store</button><button type="button" class="btn" data-close>Cancel</button></div>
      </form>
    </div>`;
  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest("[data-close]")) close(); });
  modal.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const submit = f.querySelector("[type=submit]");
    submit.disabled = true;
    f.querySelector("#attach-result").innerHTML = `<p class="hint"><span class="spin"></span> Checking with Sophos</p>`;
    try {
      const job = await api.post(`/api/migrate/devices/jobs/${encodeURIComponent(state.id)}/credentials`, {
        use: "direct",
        sending: { clientId: f.sendingId.value, clientSecret: f.sendingSecret.value },
        receiving: { clientId: f.receivingId.value, clientSecret: f.receivingSecret.value },
      });
      close();
      apply(job);
      toast("Credentials checked and stored with this job.", "ok");
      connect();
    } catch (err) {
      f.querySelector("#attach-result").innerHTML = `<div class="banner banner-err">${esc(err.message || "Could not attach the credentials")}</div>`;
      submit.disabled = false;
    }
  });
  modal.querySelector("input").focus();
}

function setWall(on) {
  document.body.classList.toggle("is-wall", on);
  const url = new URL(window.location.href);
  if (on) url.searchParams.set("view", "wall");
  else url.searchParams.delete("view");
  history.replaceState(null, "", url);
  const label = document.querySelector("#wall-btn .wall-label");
  if (label) label.textContent = on ? "Exit wall view" : "Wall view";
  fitWall();
}

// Wall view scales the page with the screen, so a large display reads from across the room.
function fitWall() {
  const on = document.body.classList.contains("is-wall");
  const zoom = on ? Math.min(2.2, Math.max(1, window.innerWidth / 1440)) : 1;
  document.documentElement.style.setProperty("--wall-zoom", String(zoom));
  layoutWall();
}

// Nobody scrolls a wall screen, so wall view shows the devices that fit and pages through the rest.
function layoutWall() {
  const lanes = document.getElementById("lanes");
  const foot = document.getElementById("lanes-foot");
  const rows = [...lanes.querySelectorAll(".lane-row")];
  for (const r of rows) r.hidden = false;
  foot.hidden = true;
  if (!document.body.classList.contains("is-wall") || rows.length < 2) return;
  const top = rows[0].getBoundingClientRect().top;
  const rowH = rows[1].getBoundingClientRect().top - top;
  const perPage = Math.max(1, Math.floor((window.innerHeight - top - 76) / rowH));
  if (rows.length <= perPage) return;
  const pages = Math.ceil(rows.length / perPage);
  state.wallPage %= pages;
  const first = state.wallPage * perPage;
  rows.forEach((r, i) => { r.hidden = i < first || i >= first + perPage; });
  foot.hidden = false;
  foot.textContent = `Devices ${first + 1} to ${Math.min(first + perPage, rows.length)} of ${rows.length}. The list turns every ${WALL_PAGE_MS / 1000} seconds.`;
}

// ---------- group membership after the move ----------

const MEMBERSHIP_TAG = {
  "will-add": ["tag-accent", "will add"],
  added: ["tag-ok", "added"],
  "already-member": ["tag-muted", "already in group"],
  "no-group": ["tag-warn", "no group"],
  "group-missing": ["tag-warn", "group missing"],
  "left-out": ["tag-muted", "left out"],
  "not-moved": ["tag-muted", "not moved yet"],
  "move-failed": ["tag-bad", "move failed"],
  "no-new-id": ["tag-warn", "no new ID"],
  error: ["tag-bad", "failed"],
};

// Rows whose destination group can be picked: moved, with a new ID, and not yet written.
const PICKABLE = new Set(["will-add", "already-member", "no-group", "group-missing", "left-out"]);

/** A change in a row's destination group picker: remember it and preview again. */
function onMemberPick(e) {
  const select = e.target.closest("[data-member-pick]");
  if (!select) return;
  const id = select.dataset.memberPick;
  if (select.value === "") delete state.memberChoices[id];
  else state.memberChoices[id] = select.value === "none" ? null : select.value;
  loadMembership(true, { quiet: true });
}

// Each preview or write is numbered, and only the latest one's answer is drawn.
let membershipSeq = 0;

/**
 * Previews (dryRun) or writes the group changes. Add to groups stays off until
 * the answer is drawn, so it always sends what the table shows. A preview
 * after a pick (quiet) keeps the table while it runs and puts the focus back
 * on the picker, so the keyboard can step through a list.
 */
async function loadMembership(dryRun, { quiet = false } = {}) {
  const seq = ++membershipSeq;
  const body = document.getElementById("membership-body");
  document.getElementById("membership-apply").disabled = true;
  const focused = document.activeElement?.dataset?.memberPick;
  if (quiet) document.getElementById("membership-summary").innerHTML = `<span class="spin"></span>`;
  else body.innerHTML = `<p class="hint"><span class="spin"></span> ${dryRun ? "Working out which devices go where" : "Adding devices to groups"}</p>`;
  const choices = dryRun ? state.memberChoices : shownChoices();
  try {
    const res = await api.post(`/api/migrate/devices/jobs/${encodeURIComponent(state.id)}/group-membership`, { dryRun, choices });
    if (seq !== membershipSeq) return res;
    state.membershipShown = res;
    renderMembership(res);
    if (focused) document.querySelector(`[data-member-pick="${CSS.escape(focused)}"]`)?.focus();
    return res;
  } catch (err) {
    if (seq === membershipSeq) body.innerHTML = `<div class="banner banner-err">${esc(err.message || "Group membership check failed")}</div>`;
    return null;
  }
}

/**
 * The picks for a write: the group each pickable row shows, or null for a row
 * shown with no group, so a group that appears after the preview is never
 * used unseen.
 */
function shownChoices() {
  const choices = { ...state.memberChoices };
  for (const r of state.membershipShown?.rows ?? []) {
    if (!r.newId || !PICKABLE.has(r.status) || r.endpointId in choices) continue;
    choices[r.endpointId] = (r.status === "will-add" || r.status === "already-member") && r.destGroupId ? r.destGroupId : null;
  }
  return choices;
}

async function applyMembership() {
  const toAdd = document.getElementById("membership-apply").dataset.count;
  if (!confirm(`Add ${toAdd} moved device(s) to the destination groups shown?\n\nThis writes to the receiving tenant.`)) return;
  const res = await loadMembership(false);
  if (!res) return;
  const failed = res.counts.error ?? 0;
  toast(`Added ${res.counts.added ?? 0} device(s) to groups${failed ? `, ${failed} failed` : ""}.`, failed ? "err" : "ok");
}

function renderMembership(res) {
  const c = res.counts;
  const willAdd = c["will-add"] ?? 0;
  const apply = document.getElementById("membership-apply");
  apply.disabled = willAdd === 0;
  apply.dataset.count = String(willAdd);
  const parts = [];
  if (res.dryRun && willAdd) parts.push(`<span class="tag tag-accent">${willAdd} to add</span>`);
  if (c.added) parts.push(`<span class="tag tag-ok">${c.added} added</span>`);
  const unplaced = (c["group-missing"] ?? 0) + (c["no-group"] ?? 0);
  if (unplaced) parts.push(`<span class="tag tag-warn">${unplaced} need${unplaced === 1 ? "s" : ""} a group</span>`);
  if (c.error) parts.push(`<span class="tag tag-bad">${c.error} failed</span>`);
  document.getElementById("membership-summary").innerHTML = parts.join(" ");

  const groups = res.destGroups ?? [];
  const groupName = (id) => groups.find((g) => g.id === id)?.name;
  const rows = res.rows.map((r) => {
    const [cls, label] = MEMBERSHIP_TAG[r.status] ?? ["tag-muted", r.status];
    const dest = r.newId && PICKABLE.has(r.status)
      ? groupPicker(r, groups)
      : r.destGroupId ? esc(groupName(r.destGroupId) ?? r.destGroupId) : `<span class="hint">none</span>`;
    return `
      <tr>
        <td><span class="cell-name">${esc(r.hostname)}</span></td>
        <td>${r.sourceGroup ? esc(r.sourceGroup) : `<span class="hint">none</span>`}</td>
        <td>${dest}</td>
        <td><div class="status-stack"><span class="tag ${cls}">${esc(label)}</span>${r.message ? `<span class="hint">${esc(r.message)}</span>` : ""}</div></td>
      </tr>`;
  }).join("");
  document.getElementById("membership-body").innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Device</th><th>Source group</th><th>Destination group</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint check-foot">${res.dryRun ? "Preview only. Nothing was written." : "Each group change is in data/audit.log."}</p>`;
}

/**
 * The destination group picker for one row: the receiving tenant's groups,
 * starting on the group the server matched by name. With no match it shows
 * "Pick a group", marked, so the device is not added until one is picked.
 */
function groupPicker(r, groups) {
  const value = r.status === "left-out" ? "none" : r.destGroupId ?? "";
  const options = [
    value ? "" : `<option value="" selected>Pick a group</option>`,
    `<option value="none"${value === "none" ? " selected" : ""}>Don't add</option>`,
    ...groups.map((g) => `<option value="${escAttr(g.id)}"${g.id === value ? " selected" : ""}>${esc(g.name)}${g.type === "server" ? " (servers)" : ""}</option>`),
  ].join("");
  return `<select class="member-pick${value ? "" : " is-warn"}" data-member-pick="${escAttr(r.endpointId)}" aria-label="Destination group for ${escAttr(r.hostname)}">${options}</select>`;
}

// ---------- tamper protection and scan after arrival ----------

const TAMPER_DEFAULTS = { turnOn: true, newPasswords: true, scope: "all" };

/** The choices for this job, as last set in this browser, or the defaults (both changes on). */
function tamperOptions() {
  try {
    const saved = JSON.parse(localStorage.getItem(`tamperOptions:${state.id}`) || "null");
    if (saved && typeof saved === "object") {
      return {
        turnOn: typeof saved.turnOn === "boolean" ? saved.turnOn : TAMPER_DEFAULTS.turnOn,
        newPasswords: typeof saved.newPasswords === "boolean" ? saved.newPasswords : TAMPER_DEFAULTS.newPasswords,
        scope: saved.scope === "was-on" ? "was-on" : "all",
      };
    }
  } catch {
    // Storage can be blocked or empty: the defaults stand.
  }
  return { ...TAMPER_DEFAULTS };
}

function showTamperOptions() {
  const o = tamperOptions();
  document.getElementById("tamper-turn-on").checked = o.turnOn;
  document.getElementById("tamper-new-passwords").checked = o.newPasswords;
  document.getElementById("tamper-scope").value = o.scope;
}

/** The choices the card shows now. */
function shownTamperOptions() {
  return {
    turnOn: document.getElementById("tamper-turn-on").checked,
    newPasswords: document.getElementById("tamper-new-passwords").checked,
    scope: document.getElementById("tamper-scope").value === "was-on" ? "was-on" : "all",
  };
}

/** A changed choice is remembered for this job and previewed again, so Apply sends what the table shows. */
function onTamperOption(e) {
  if (!e.target.closest("[data-tamper-option]")) return;
  const o = shownTamperOptions();
  try {
    localStorage.setItem(`tamperOptions:${state.id}`, JSON.stringify(o));
  } catch {
    // Not remembered; the choice still applies on this page.
  }
  if (state.arrivalPreviewed) loadTamper(true, { quiet: true });
}

let tamperSeq = 0;

async function loadTamper(dryRun, { quiet = false } = {}) {
  const seq = ++tamperSeq;
  const apply = document.getElementById("tamper-apply");
  apply.disabled = true;
  const options = shownTamperOptions();
  if (!options.turnOn && !options.newPasswords) {
    setHtml("tamper-summary", "");
    document.getElementById("tamper-body").innerHTML = `<div class="empty-state">Pick at least one change.</div>`;
    return null;
  }
  if (quiet) document.getElementById("tamper-summary").innerHTML = `<span class="spin"></span>`;
  else document.getElementById("tamper-body").innerHTML = `<p class="hint"><span class="spin"></span> ${dryRun ? "Reading tamper protection on the arrived devices" : "Changing tamper protection, then reading it back"}</p>`;
  try {
    const res = await api.post(`/api/migrate/devices/jobs/${encodeURIComponent(state.id)}/tamper-protection`, { dryRun, ...options });
    if (seq !== tamperSeq) return res;
    state.arrivalPreviewed = true;
    state.tamperShown = res;
    renderTamper(res);
    refreshJob();
    return res;
  } catch (err) {
    if (seq === tamperSeq) document.getElementById("tamper-body").innerHTML = `<div class="banner banner-err">${esc(err.message || "Tamper protection check failed")}</div>`;
    return null;
  }
}

async function applyTamper() {
  const shown = state.tamperShown;
  const n = shown?.counts?.["will-change"] ?? 0;
  if (!n) return;
  const o = shown.options;
  const what = [o.turnOn ? "turn tamper protection on where it is off" : "", o.newPasswords ? "make a new tamper protection password" : ""].filter(Boolean).join(" and ");
  if (!confirm(`For ${n} device${n === 1 ? "" : "s"} on ${shown.receivingName || "the receiving tenant"}: ${what}?\n\nThis writes to the receiving tenant.`)) return;
  // The options Apply sends are the ones the preview used, so it does what the table showed.
  const seq = ++tamperSeq;
  document.getElementById("tamper-apply").disabled = true;
  document.getElementById("tamper-body").innerHTML = `<p class="hint"><span class="spin"></span> Changing tamper protection, then reading it back</p>`;
  try {
    const res = await api.post(`/api/migrate/devices/jobs/${encodeURIComponent(state.id)}/tamper-protection`, { dryRun: false, turnOn: o.turnOn, newPasswords: o.newPasswords, scope: o.scope });
    if (seq === tamperSeq) {
      state.tamperShown = res;
      renderTamper(res);
    }
    refreshJob();
    const bad = (res.counts.failed ?? 0) + (res.counts.requested ?? 0);
    toast(`Tamper protection: ${res.counts.changed ?? 0} done${bad ? `, ${bad} to check` : ""}.`, bad ? "err" : "ok");
  } catch (err) {
    if (seq === tamperSeq) document.getElementById("tamper-body").innerHTML = `<div class="banner banner-err">${esc(err.message || "Tamper protection change failed")}</div>`;
  }
}

/**
 * The tamper protection card saves what it read with the job. A finished job's
 * stream has stopped, so the lanes and the flag are redrawn from the job here.
 */
async function refreshJob() {
  try {
    apply(await api.get(`/api/migrate/devices/jobs/${encodeURIComponent(state.id)}`));
  } catch {
    // The stream redraws them on its next update, if the job is still running.
  }
}

const TAMPER_TAG = {
  "will-change": ["tag-accent", "will change"],
  changed: ["tag-ok", "done"],
  requested: ["tag-warn", "requested"],
  failed: ["tag-bad", "failed"],
  "already-on": ["tag-muted", "already on"],
  "not-supported": ["tag-muted", "no tamper protection"],
  "out-of-scope": ["tag-muted", "left out"],
  "not-arrived": ["tag-muted", "not arrived"],
  "not-found": ["tag-warn", "record missing"],
};

const onOff = (v) => (v === true ? "on" : v === false ? "off" : "");

function renderTamper(res) {
  const c = res.counts;
  const willChange = c["will-change"] ?? 0;
  document.getElementById("tamper-apply").disabled = !res.dryRun || willChange === 0;
  const parts = [];
  if (res.dryRun && willChange) parts.push(`<span class="tag tag-accent">${willChange} to change</span>`);
  if (c.changed) parts.push(`<span class="tag tag-ok">${c.changed} done</span>`);
  if (c.requested) parts.push(`<span class="tag tag-warn">${c.requested} requested</span>`);
  if (c.failed) parts.push(`<span class="tag tag-bad">${c.failed} failed</span>`);
  if (res.globalEnabled === false) parts.push(`<span class="tag tag-warn">Off for the tenant</span>`);
  document.getElementById("tamper-summary").innerHTML = parts.join(" ");

  const notes = res.notes.length
    ? `<ul class="check-warnings">${res.notes.map((n) => `<li>${icon("alert")}<span>${esc(n)}</span></li>`).join("")}</ul>`
    : "";
  const rows = res.rows.map((r) => {
    const [cls, label] = TAMPER_TAG[r.status] ?? ["tag-muted", r.status];
    const source = r.status === "not-supported" ? `<span class="hint">none</span>`
      : r.atSource === undefined ? `<span class="hint">not recorded</span>` : onOff(r.atSource) || `<span class="hint">unknown</span>`;
    const value = r.after !== undefined ? r.after : r.before;
    // Not read for a device that hasn't arrived; none for one without tamper protection; amber when it was on at the source.
    const now = r.status === "not-supported" ? `<span class="hint">none</span>`
      : typeof value !== "boolean" ? `<span class="hint">not read</span>`
        : value === false && r.atSource === true ? `<span class="tp-bit is-lost" title="On at the source">off</span>` : onOff(value);
    const changes = r.changes.map((x) => (x === "turn-on" ? "turn on" : "new password")).join(", ");
    const password = r.passwordChanged ? `<span class="hint">new password</span>` : "";
    return `
      <tr>
        <td><span class="cell-name">${esc(r.hostname)}</span></td>
        <td>${source}</td>
        <td>${now}</td>
        <td>${changes ? esc(changes) : `<span class="hint">none</span>`}</td>
        <td><div class="status-stack"><span class="tag ${cls}">${esc(label)}</span>${password}${r.message ? `<span class="hint">${esc(r.message)}</span>` : ""}</div></td>
      </tr>`;
  }).join("");
  document.getElementById("tamper-body").innerHTML = `
    ${notes}
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Device</th><th>At source</th><th>Now</th><th>Change</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint check-foot">${res.dryRun ? "Preview only. Nothing was written." : "Each request is in data/audit.log. No password is shown or kept."}</p>`;
}

let scanSeq = 0;

async function loadScan(dryRun) {
  const seq = ++scanSeq;
  document.getElementById("scan-apply").disabled = true;
  document.getElementById("scan-body").innerHTML = `<p class="hint"><span class="spin"></span> ${dryRun ? "Finding the arrived devices" : "Asking the devices to scan"}</p>`;
  try {
    const res = await api.post(`/api/migrate/devices/jobs/${encodeURIComponent(state.id)}/scan`, { dryRun });
    if (seq !== scanSeq) return res;
    state.arrivalPreviewed = true;
    state.scanShown = res;
    renderScan(res);
    return res;
  } catch (err) {
    if (seq === scanSeq) document.getElementById("scan-body").innerHTML = `<div class="banner banner-err">${esc(err.message || "Scan check failed")}</div>`;
    return null;
  }
}

async function applyScan() {
  const shown = state.scanShown;
  const n = shown?.counts?.["will-scan"] ?? 0;
  if (!n) return;
  if (!confirm(`Ask ${n} device${n === 1 ? "" : "s"} on ${shown.receivingName || "the receiving tenant"} to run a scan now?\n\nThis writes to the receiving tenant, and many devices scanning at once slows them down.`)) return;
  const res = await loadScan(false);
  if (!res) return;
  const failed = res.counts.failed ?? 0;
  toast(`Scan requested on ${res.counts.requested ?? 0} device(s)${failed ? `, ${failed} failed` : ""}.`, failed ? "err" : "ok");
}

const SCAN_TAG = {
  "will-scan": ["tag-accent", "will scan"],
  requested: ["tag-ok", "requested"],
  failed: ["tag-bad", "failed"],
  "not-arrived": ["tag-muted", "not arrived"],
  "not-found": ["tag-warn", "record missing"],
};

function renderScan(res) {
  const c = res.counts;
  const n = c["will-scan"] ?? 0;
  document.getElementById("scan-apply").disabled = !res.dryRun || n === 0;
  const parts = [];
  if (res.dryRun && n) parts.push(`<span class="tag tag-accent">${n} to scan</span>`);
  if (c.requested) parts.push(`<span class="tag tag-ok">${c.requested} requested</span>`);
  if (c.failed) parts.push(`<span class="tag tag-bad">${c.failed} failed</span>`);
  document.getElementById("scan-summary").innerHTML = parts.join(" ");
  const rows = res.rows.map((r) => {
    const [cls, label] = SCAN_TAG[r.status] ?? ["tag-muted", r.status];
    const when = r.requestedAt ? `<span class="hint">${esc(formatWhen(r.requestedAt))}</span>` : "";
    return `
      <tr>
        <td><span class="cell-name">${esc(r.hostname)}</span></td>
        <td><div class="status-stack"><span class="tag ${cls}">${esc(label)}</span>${when}${r.message ? `<span class="hint">${esc(r.message)}</span>` : ""}</div></td>
      </tr>`;
  }).join("");
  document.getElementById("scan-body").innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead><tr><th>Device</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <p class="hint check-foot">${res.dryRun ? "Preview only. Nothing was written." : "Each request is in data/audit.log."}</p>`;
}

boot();
