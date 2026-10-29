import "./nav.js";
import { api } from "./api.js";
import { toast } from "./toast.js";
import { icon } from "./icons.js";

async function boot() {
  const ids = loadSelection();
  const direction = sessionStorage.getItem("migrationDirection") || "source-to-dest";
  const fromLabel = direction === "source-to-dest" ? "source" : "destination";
  const toLabel = direction === "source-to-dest" ? "destination" : "source";

  document.getElementById("direction-display").innerHTML =
    `<span class="tag ${fromLabel === "source" ? "tag-src" : "tag-dst"}">${fromLabel}</span>${icon("arrowRight")}<span class="tag ${toLabel === "source" ? "tag-src" : "tag-dst"}">${toLabel}</span>`;

  // Store direction on the form for use in submission
  document.getElementById("migrate-form").dataset.direction = direction;
  renderSelection(ids, direction);
  wireForm(ids);

  loadWindow(direction);
  loadLicenses(ids, direction);
  loadTamper(ids, direction);
  document.getElementById("window-recheck").addEventListener("click", () => loadWindow(direction));
  document.getElementById("license-recheck").addEventListener("click", () => loadLicenses(ids, direction));
  document.getElementById("tamper-recheck").addEventListener("click", () => loadTamper(ids, direction));
}

// ---------- pre-flight: Device Migration setting (read only) ----------

async function loadWindow(direction) {
  const body = document.getElementById("window-body");
  body.innerHTML = `<p class="hint"><span class="spin"></span> Reading the setting on both tenants</p>`;
  try {
    const res = await api.get(`/api/checks/migration-window?direction=${encodeURIComponent(direction)}`);
    renderWindow(res);
  } catch (err) {
    body.innerHTML = `<div class="banner banner-err">${escapeHtml(err.message || "Check failed")}</div>`;
  }
}

function windowTone(status) {
  return { open: "ok", closing: "warn", closed: "bad", off: "bad", unknown: "warn" }[status] ?? "warn";
}

function renderWindow(res) {
  // Both tenants must allow device migration, so the headline is whichever
  // tenant is in the worse state, and the sending tenant when they tie.
  const rank = { open: 0, closing: 1, unknown: 2, closed: 3, off: 3 };
  const s = res.sending;
  const r = res.receiving;
  const main = (rank[r.status] ?? 2) > (rank[s.status] ?? 2) ? r : s;
  const other = main === s ? r : s;
  const roleLabel = (c) => (c.role === "receiving" ? "Receiving tenant" : "Sending tenant");
  const tone = windowTone(main.status);
  const label = { open: "Open", closing: "Closing soon", closed: "Closed", off: "Off", unknown: "Unknown" }[main.status];
  const fix = ["off", "closed", "unknown"].includes(main.status)
    ? `<p class="hint check-fix">Both tenants must allow device migration. In Sophos Fusion on the ${main.role} tenant, go to <strong>Overview &gt; Global Settings &gt; Device Migration</strong> and turn on <strong>Allow device migration</strong>. Then check again.</p>`
    : "";
  document.getElementById("window-body").innerHTML = `
    <div class="check-main" data-tone="${tone}">
      <span class="conn-dot" data-state="${tone === "ok" ? "ok" : tone === "bad" ? "error" : "warn"}"></span>
      <div>
        <div class="check-title">${roleLabel(main)}${main.tenantName ? `, ${escapeHtml(main.tenantName)}` : ""} <span class="tag tag-${tone === "bad" ? "bad" : tone}">${label}</span></div>
        <p>${escapeHtml(main.message)}</p>
        ${main.error ? `<p class="ep-error">${escapeHtml(main.error)}</p>` : ""}
      </div>
    </div>
    ${fix}
    <dl class="kv-list check-kv">
      <dt>${roleLabel(other)}</dt><dd>${escapeHtml(other.tenantName || other.side)}: ${escapeHtml(other.enabled === true ? "allowed" : other.enabled === false ? "turned off" : "unknown")}</dd>
      <dt>Checked</dt><dd>${escapeHtml(new Date(res.checkedAt).toLocaleTimeString())}</dd>
    </dl>`;
}

// ---------- destination licence check (read only) ----------

async function loadLicenses(ids, direction) {
  const body = document.getElementById("license-body");
  document.getElementById("license-summary").innerHTML = "";
  body.innerHTML = `<p class="hint"><span class="spin"></span> Reading licences on both tenants</p>`;
  try {
    const res = await api.post("/api/checks/licenses", { endpointIds: ids, direction });
    renderLicenses(res);
  } catch (err) {
    body.innerHTML = `<div class="banner banner-err">${escapeHtml(err.message || "Check failed")}</div>`;
  }
}

function renderLicenses(res) {
  const warnCount = res.warnings.length;
  document.getElementById("license-summary").innerHTML = warnCount
    ? `<span class="tag tag-warn">${warnCount} to check</span>`
    : `<span class="tag tag-ok">Looks covered</span>`;

  const sel = res.selected;
  const selLine = `${sel.computers} computer${sel.computers === 1 ? "" : "s"} and ${sel.servers} server${sel.servers === 1 ? "" : "s"} selected${sel.unknown ? `, ${sel.unknown} unread` : ""}.`;

  const seats = res.seats.length
    ? `<table class="data-table check-table">
        <thead><tr><th>Licence</th><th class="num-col">Free</th><th class="num-col">Needed</th><th></th></tr></thead>
        <tbody>${res.seats.map((st) => `
          <tr>
            <td><span class="cell-name">${escapeHtml(st.name)}</span></td>
            <td class="num-col tnum">${st.free === null ? "no limit" : st.free}</td>
            <td class="num-col tnum">${st.needed}</td>
            <td>${st.short ? `<span class="tag tag-warn">short</span>` : `<span class="tag tag-ok">ok</span>`}</td>
          </tr>`).join("")}
        </tbody>
      </table>`
    : `<p class="hint">No endpoint or server licence on the destination matches the selected devices.</p>`;

  const families = res.families.length
    ? `<ul class="family-list">${res.families.map((f) => `
        <li>
          <span class="family-name">${escapeHtml(f.label)}</span>
          <span class="tag ${f.missing ? "tag-warn" : f.receiving.length ? "tag-ok" : "tag-muted"}">${f.missing ? "not on destination" : f.receiving.length ? "on destination" : "destination only"}</span>
          <span class="hint family-names" title="${escapeHtml(`Source: ${f.sending.join(", ") || "none"}. Destination: ${f.receiving.join(", ") || "none"}.`)}">${escapeHtml(f.receiving.join(", ") || f.sending.join(", "))}</span>
        </li>`).join("")}
      </ul>`
    : "";

  const warnings = warnCount
    ? `<ul class="check-warnings">${res.warnings.map((w) => `<li>${icon("alert")}<span>${escapeHtml(w)}</span></li>`).join("")}</ul>`
    : "";

  document.getElementById("license-body").innerHTML = `
    <p class="hint">${escapeHtml(selLine)}</p>
    ${warnings}
    <h3 class="check-h3">Seats</h3>
    ${seats}
    ${families ? `<h3 class="check-h3">Products</h3>${families}` : ""}
    <p class="hint check-foot">Product names map loosely to features, so this check warns and never blocks.</p>`;
}

// ---------- tamper protection (read only) ----------

async function loadTamper(ids, direction) {
  const body = document.getElementById("tamper-body");
  document.getElementById("tamper-summary").innerHTML = "";
  body.innerHTML = `<p class="hint"><span class="spin"></span> Reading tamper protection on both tenants</p>`;
  try {
    const res = await api.post("/api/checks/tamper-protection", { endpointIds: ids, direction });
    renderTamper(res);
  } catch (err) {
    body.innerHTML = `<div class="banner banner-err">${escapeHtml(err.message || "Check failed")}</div>`;
  }
}

/**
 * The receiving tenant's global setting decides whether moved devices arrive
 * with tamper protection, so it is the headline; then how many selected
 * devices have it on now.
 */
function renderTamper(res) {
  const r = res.receiving;
  const tone = r.enabled === true ? "ok" : "warn";
  const label = r.enabled === true ? "On" : r.enabled === false ? "Off" : "Unknown";
  document.getElementById("tamper-summary").innerHTML = res.warnings.length
    ? `<span class="tag tag-warn">${res.warnings.length} to check</span>`
    : `<span class="tag tag-ok">Arrives on</span>`;
  const sel = res.selected;
  const counted = sel.on + sel.off;
  const selLine = `${sel.on} of ${counted} selected device${counted === 1 ? "" : "s"} with tamper protection ${counted === 1 ? "has" : "have"} it on now` +
    `${sel.unsupported ? `. ${sel.unsupported} ${sel.unsupported === 1 ? "has" : "have"} none, as on Linux` : ""}.`;
  const lead = r.enabled === true
    ? "Moved devices take this tenant's tamper protection, so they arrive with it on."
    : r.enabled === false
      ? "Moved devices take this tenant's tamper protection, so they arrive without it."
      : "The setting could not be read.";
  const setting = (c) => (c.enabled === true ? "on" : c.enabled === false ? "off" : "unknown");
  const warnings = res.warnings.length
    ? `<ul class="check-warnings">${res.warnings.map((w) => `<li>${icon("alert")}<span>${escapeHtml(w)}</span></li>`).join("")}</ul>`
    : "";
  document.getElementById("tamper-body").innerHTML = `
    <div class="check-main" data-tone="${tone}">
      <span class="conn-dot" data-state="${tone === "ok" ? "ok" : "warn"}"></span>
      <div>
        <div class="check-title">Receiving tenant${r.tenantName ? `, ${escapeHtml(r.tenantName)}` : ""} <span class="tag tag-${tone}">${label}</span></div>
        <p>${escapeHtml(lead)}</p>
        ${r.error ? `<p class="ep-error">${escapeHtml(r.error)}</p>` : ""}
      </div>
    </div>
    <p class="hint">${escapeHtml(selLine)}</p>
    ${warnings}
    <dl class="kv-list check-kv">
      <dt>Sending tenant</dt><dd>${escapeHtml(res.sending.tenantName || res.sending.side)}: ${setting(res.sending)}</dd>
      <dt>Checked</dt><dd>${escapeHtml(new Date(res.checkedAt).toLocaleTimeString())}</dd>
    </dl>
    <p class="hint check-foot">You don't need to turn off tamper protection to move devices. After the move, the job page can turn it on and make new passwords.</p>`;
}

function loadSelection() {
  try {
    return JSON.parse(sessionStorage.getItem("endpointSelection") || "[]");
  } catch {
    return [];
  }
}

async function renderSelection(ids, direction) {
  const list = document.getElementById("selection-list");
  if (ids.length === 0) {
    list.innerHTML = `<div class="empty-state">No endpoints selected. Pick devices on the <a href="/endpoints.html">Endpoints</a> page first.</div>`;
    return;
  }
  list.innerHTML = `<p class="hint"><strong>${ids.length}</strong> device${ids.length === 1 ? "" : "s"} selected.</p>`;

  // Best-effort enrich with hostnames, read from the side the devices are on.
  const side = direction === "dest-to-source" ? "dest" : "source";
  try {
    const details = [];
    for (const id of ids.slice(0, 30)) {
      try {
        const ep = await api.get(`/api/${side}/endpoints/${encodeURIComponent(id)}`);
        details.push({ id, hostname: ep.hostname || "(unknown)", lastSeen: ep.lastSeenAt });
      } catch {
        details.push({ id, hostname: "(load failed)", lastSeen: null });
      }
    }
    const rows = details
      .map((d) => `<li><span class="sel-host">${escapeHtml(d.hostname)}</span><code class="sel-id" title="${escapeHtml(d.id)}">${escapeHtml(d.id)}</code></li>`)
      .join("");
    const more = ids.length > 30 ? `<p class="hint">And ${ids.length - 30} more.</p>` : "";
    list.innerHTML += `<ul class="sel-list">${rows}</ul>${more}`;
  } catch {
    // ignore enrichment failures
  }
}

function wireForm(ids) {
  const startBtn = document.getElementById("start-btn");
  const dryBtn = document.getElementById("dry-run-btn");
  const ack = document.getElementById("ack-window");
  const form = document.getElementById("migrate-form");

  ack.addEventListener("change", () => {
    startBtn.disabled = !ack.checked;
  });

  dryBtn.addEventListener("click", async () => {
    const jobName = form.jobName.value.trim();
    const dir = form.dataset.direction || "source-to-dest";
    if (!jobName) {
      toast("Enter a job name first.", "info");
      return;
    }
    if (!ids.length) {
      toast("No endpoints selected.", "info");
      return;
    }
    showResult("info", `<span class="spin"></span> Running the dry-run preflight`);
    try {
      const res = await api.post("/api/migrate/devices?dryRun=true", {
        jobName,
        endpointIds: ids,
        direction: dir,
      });
      if (res.dryRun && res.plan) {
        showPlan(res.plan, dir);
      } else {
        showResult("ok", "Dry run complete.");
      }
    } catch (err) {
      if (err.body?.preflightFailures) {
        showFailures(err.body.preflightFailures);
      } else {
        showResult("err", migrationErrorHint(err, "Dry run failed"));
      }
    }
  });

  startBtn.addEventListener("click", async () => {
    const jobName = form.jobName.value.trim();
    if (!jobName) {
      toast("Enter a job name.", "info");
      return;
    }
    if (!confirm(`Create migration jobs for ${ids.length} endpoint(s)?\n\nThis is a real production action.`)) return;

    showResult("info", `<span class="spin"></span> Creating migration jobs`);
    try {
      const dir = form.dataset.direction || "source-to-dest";
      const res = await api.post("/api/migrate/devices", { jobName, endpointIds: ids, direction: dir });
      if (res.ok && res.job) {
        sessionStorage.removeItem("endpointSelection");
        window.location.href = `/migrate-job-detail.html?id=${encodeURIComponent(res.job.localJobId)}`;
      }
    } catch (err) {
      if (err.body?.preflightFailures) {
        showFailures(err.body.preflightFailures);
      } else {
        showResult("err", migrationErrorHint(err, "Migration start failed"));
      }
    }
  });
}

function showResult(variant, html) {
  document.getElementById("result-area").innerHTML =
    `<div class="banner banner-${variant}">${html}</div>`;
}

// Dry-run result as the list of steps the real run would take.
function showPlan(plan, dir) {
  const count = plan.receiverBody?.endpoints?.length ?? 0;
  const toLabel = dir === "dest-to-source" ? "source" : "destination";
  const fromLabel = dir === "dest-to-source" ? "destination" : "source";
  const steps = [
    { title: "Preflight passed", body: `${count} device${count === 1 ? "" : "s"} checked in within the last 14 days.` },
    { title: `Receiver job on the ${toLabel} tenant`, body: `<code>POST /endpoint/v1/migrations</code> on <code>${escapeHtml(plan.destApiHost)}</code> with the sending tenant and ${count} device ID${count === 1 ? "" : "s"}.` },
    { title: `Sender trigger on the ${fromLabel} tenant`, body: `<code>${escapeHtml(plan.senderTrigger?.method ?? "PUT")}</code> on <code>${escapeHtml(plan.sourceApiHost)}</code> with the handshake token from the receiver job.` },
    { title: "Live status", body: "The job page polls both tenants every 10 seconds until every device has moved or failed." },
  ];
  if (plan.groups) {
    const named = plan.groups.map((g) => `${escapeHtml(g.name)} (${g.count})`).join(", ");
    steps.push({
      title: "Group membership recorded",
      body: `${named ? `Groups: ${named}.` : "None of the devices is in a group."}${plan.ungrouped && named ? ` ${plan.ungrouped} device${plan.ungrouped === 1 ? " is" : "s are"} in no group.` : ""} After the move, the job page can add each device to the destination group with the same name.`,
    });
  }
  if (plan.tamperProtection) {
    const t = plan.tamperProtection;
    steps.push({
      title: "Tamper protection recorded",
      body: `${t.on} device${t.on === 1 ? " has" : "s have"} it on and ${t.off} off${t.unsupported ? `; ${t.unsupported} ${t.unsupported === 1 ? "has" : "have"} none` : ""}. A moved device takes the receiving tenant's setting. The job page flags a device that had it on and arrives without it.`,
    });
  }
  document.getElementById("result-area").innerHTML = `
    <div class="plan-box">
      <div class="plan-head">${icon("checkCircle")}<strong>Dry run passed.</strong><span class="hint">Nothing was created. The real run would do this:</span></div>
      <ol class="plan-list">${steps.map((st, i) => `
        <li class="plan-step"><span class="plan-n">${i + 1}</span><div><strong>${st.title}</strong><p>${st.body}</p></div></li>`).join("")}
      </ol>
    </div>`;
}

function showFailures(failures) {
  document.getElementById("result-area").innerHTML = `
    <div class="plan-box is-bad">
      <div class="plan-head">${icon("xCircle")}<strong>Preflight failed for ${failures.length} device${failures.length === 1 ? "" : "s"}.</strong><span class="hint">Nothing was created.</span></div>
      <ul class="plan-list">${failures.map((f) => `
        <li class="plan-step"><span class="plan-n">${icon("x")}</span><div><strong>${escapeHtml(f.hostname || f.endpointId)}</strong><p>${escapeHtml(f.reason)}</p></div></li>`).join("")}
      </ul>
    </div>`;
}

/**
 * A failed start or dry run, with a fix only where the error says what it is.
 * Device Migration being off or expired is reported by the server as
 * migration_not_allowed, after it reads the setting on both tenants; its
 * message names the tenant. Any other error, a 403 included, is shown as it
 * is: by then the setting was not found off, and a 403 can mean other things,
 * such as a read-back refused or a role without rights.
 */
function migrationErrorHint(err, fallback) {
  const m = String(err?.message || fallback);
  if (err?.body?.error === "migration_not_allowed") {
    return `${escapeHtml(m)}<br/><br/><strong>Fix:</strong> In Sophos Fusion on each tenant named above, go to <strong>Overview &gt; Global Settings &gt; Device Migration</strong> and turn on <strong>Allow device migration</strong>. Then retry.`;
  }
  if (/must not match the current tenant/i.test(m)) {
    return `${escapeHtml(m)}<br/><br/><strong>Fix:</strong> The source and destination appear to be the same tenant. Check your credential configuration.`;
  }
  return escapeHtml(m);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;",
  }[c]));
}

boot();
