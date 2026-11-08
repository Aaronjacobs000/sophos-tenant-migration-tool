/**
 * Copies Sophos AI Defense policies from source to destination, compares
 * them, and deletes a copy on the destination (the undo).
 *
 * What carries across:
 *   - Rules, the base rule (the Generative AI and app control category
 *     actions), description, tags, the starter template a policy came from
 *     (builtInKey and builtInVersion) and its state. Rules name applications,
 *     categories, risk levels and compliance from Sophos's AI catalog, which
 *     is the same on every tenant, so they carry as they are.
 *   - The Endpoint sensor's scope names users, user groups, devices and
 *     device groups by ID. Like an endpoint policy's assignments
 *     (policy-assignments.ts), each is matched on the destination: groups by
 *     name, users by email then name, devices by hostname, and a device that
 *     has not moved yet is pending. The scope also holds each target's name,
 *     which stands in for one the source no longer lists. Matched targets are
 *     added to what the destination policy applies to and none is removed, so
 *     copying again after devices move adds the pending ones.
 *
 * What doesn't:
 *   - The Firewall, DNS Protection and Protected Browser sensors. The
 *     Firewall scope names firewall groups and the firewalls' own web policy
 *     IDs, and the tool doesn't move firewalls; the tool can't map what the
 *     other two scopes name. The result says so.
 *   - Partner policies: the partner's console sets them and they are read
 *     only on the tenant.
 *   - A base policy where the destination has none. Each tenant has at most
 *     one (kind TENANT_BASE); it applies to everyone and can't be turned off,
 *     moved or deleted. The source's pairs with the destination's whatever
 *     their names, and an overwrite brings its rules, base rule, description
 *     and tags. The tool doesn't create one, because it could never be deleted.
 *
 * Pairing is by name, ignoring case and surrounding spaces, ordinary policies
 * with ordinary ones. Sophos accepts two policies with the same name
 * (measured 08/11/2026), so a name more than one policy has on either side is
 * ambiguous and nothing is sent.
 *
 * Order and state: Sophos puts a new policy at the top of the order, so a copy
 * is created turned off, moved to the bottom (straight after the
 * destination's last ordinary policy, then after the copy before it in the
 * run, so a batch keeps its source order and the destination's own policies
 * keep precedence), and then turned on if the source's is on. Sophos refuses
 * to turn on a policy whose scope names nobody, because it would apply to
 * everyone, so such a copy stays off and the result says why. An overwrite
 * keeps the destination policy's place.
 *
 * A same-name policy is compared: rules, base rule, description, tags, state
 * and whether the Endpoint sensor is on. It is "already there" when they
 * match and "differs" when they don't; with overwrite it is updated in place,
 * keeping the destination's name. An update replaces the whole sensors map,
 * so the destination's other sensors are sent back as they are.
 *
 * Supports dry run. Every write is audited, and each copy, overwrite and
 * scope addition is read back by ID.
 */

import { requireContext } from "../state.js";
import { auditOrWarn } from "./audit-log.js";
import { createChecked, earlierUnclear, foundNote, isUnclearWrite, notFound, readBack } from "./write-check.js";
import {
  matchEndpoint,
  matchEndpointGroup,
  matchUser,
  matchUserGroup,
  tenantDirectory,
  type AssignmentKind,
  type AssignmentRow,
  type Directory,
  type Match,
} from "./policy-assignments.js";
import {
  AI_SENSORS,
  createAiPolicy,
  disableAiPolicy,
  enableAiPolicy,
  getAiPolicy,
  listAiPolicies,
  moveAiPolicy,
  updateAiPolicy,
  type AiPolicy,
  type AiPolicyCreateInput,
  type AiPolicyUpdateInput,
  type AiRule,
  type AiRuleInput,
  type AiSensor,
  type AiSensorName,
} from "../sophos/api/ai-defense.js";
import type { TenantContext } from "../sophos/tenant-context.js";
import type { SophosUser } from "../sophos/api/users.js";
import type { SophosUserGroup } from "../sophos/api/user-groups.js";
import type { SophosEndpointGroup } from "../sophos/types/migration.js";
import type { SophosEndpoint } from "../sophos/types/sophos.js";

export const AI_POLICY_RESOURCE = "ai-defense-policy";

export interface CopyAiPoliciesRequest {
  policyIds: string[];
  dryRun?: boolean;
  /** Replace a same-name destination policy whose content differs. */
  overwrite?: boolean;
}

/** A policy's scope targets on the destination: each set, already there, pending or not matched. */
export interface ScopeReport {
  rows: AssignmentRow[];
  notes?: string[];
}

export interface AiPolicyCopyResult {
  sourceId: string;
  sourceName: string;
  destId?: string;
  destName?: string;
  ok: boolean;
  action: "create" | "skip-exists" | "dry-run-create" | "differs" | "overwrite" | "dry-run-overwrite";
  error?: string;
  /** For a same-name policy whose content differs: what differs. */
  differences?: string[];
  /** What was changed or left out to fit the destination. */
  adjustments?: string[];
  /** Notes for the results list: placement, state, a write Sophos answered unclearly but a read-back found. */
  notes?: string[];
  /** The Endpoint sensor's scope on the destination, in the shape the Policies page uses for assignments. */
  assignments?: ScopeReport;
}

export type AiPolicyMatchStatus = "match" | "differ" | "source-only" | "dest-only" | "ambiguous" | "not-copied";

export interface AiPolicyMatch {
  sourceId: string | null;
  destId: string | null;
  name: string;
  status: AiPolicyMatchStatus;
  differences?: string[];
  /** Why a source policy is not copied, or why it is ambiguous. */
  reason?: string;
}

export const PARTNER_NOT_COPIED =
  "not copied: a partner policy is set in the partner's own console and is read only on the tenant. If the partner manages the destination, it sends the policy there";
export const NO_DEST_BASE =
  "not sent: the destination has no AI Defense base policy, and the tool doesn't create one, because a base policy can't be turned off or deleted afterwards. Create it in Sophos Fusion, then copy again to bring this one's rules across";
export const ENDPOINT_OFF =
  "not sent: its Endpoint sensor is off, the tool copies only the Endpoint sensor, and Sophos needs at least one sensor on";
export const LEFT_OFF_EMPTY =
  "created turned off: none of the users, groups or devices it applies to are on the destination yet, and Sophos won't turn on a policy that names nobody (it would apply to everyone). Copy it again once they are, then overwrite it to turn it on";
const PARTNER_DEST = "the destination policy with this name is a partner policy, which is read only";
/** Sophos ignores tags sent as {} or null, so the API can't clear a policy's tags (measured 08/11/2026). */
export const TAGS_STAY =
  "the destination policy's tags stay: the source policy has none, and Sophos ignores an empty tag list, so the API can't clear them. Remove them in Sophos Fusion";

const SENSOR_NOT_COPIED: Record<Exclude<AiSensorName, "endpoint">, string> = {
  firewall:
    "the Firewall sensor is not copied: its scope names firewall groups and the firewalls' own web policies by ID, and the tool doesn't move firewalls. Set it on the destination in Sophos Fusion",
  dns: "the DNS Protection sensor is not copied: the tool can't map what its scope names to the destination. Set it there in Sophos Fusion",
  browser: "the Protected Browser sensor is not copied: the tool can't map what its scope names to the destination. Set it there in Sophos Fusion",
};

const nameKey = (name: string | undefined | null) => String(name ?? "").trim().toLowerCase();
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? [...v] : []);
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
const isBase = (p: AiPolicy) => p.kind === "TENANT_BASE";

// --- Scope ---

export interface ScopeTarget {
  kind: AssignmentKind;
  id: string;
  name?: string;
}

const targetKey = (t: { kind: AssignmentKind; id?: string; destId?: string }) => `${t.kind}:${t.id ?? t.destId}`;

/** Where each kind sits in an Endpoint scope: an ID list (except users) and a list of { id, name }. */
const DIMENSIONS: Record<AssignmentKind, { ids?: string; rich: string }> = {
  user: { rich: "users" },
  userGroup: { ids: "group_ids", rich: "groups" },
  endpoint: { ids: "device_ids", rich: "devices" },
  endpointGroup: { ids: "device_group_ids", rich: "device_groups" },
};

/**
 * The users, user groups, devices and device groups an Endpoint scope names,
 * each once, with the name the scope holds for it. Both forms of each
 * dimension count, and the legacy user_ids too, as the API reads them.
 */
export function scopeTargets(scope: unknown): ScopeTarget[] {
  const s = (scope && typeof scope === "object" ? scope : {}) as Record<string, unknown>;
  const out = new Map<string, ScopeTarget>();
  const add = (kind: AssignmentKind, id: unknown, name?: unknown) => {
    if (typeof id !== "string" || !id) return;
    const key = `${kind}:${id}`;
    const named = typeof name === "string" && name ? name : undefined;
    const prev = out.get(key);
    if (!prev) out.set(key, { kind, id, ...(named ? { name: named } : {}) });
    else if (!prev.name && named) prev.name = named;
  };
  for (const [kind, d] of Object.entries(DIMENSIONS) as Array<[AssignmentKind, { ids?: string; rich: string }]>) {
    for (const e of arr(s[d.rich])) {
      const o = e as { id?: unknown; name?: unknown } | null;
      add(kind, o?.id, o?.name);
    }
    if (d.ids) for (const id of arr(s[d.ids])) add(kind, id);
  }
  for (const id of arr(s.user_ids)) add("user", id);
  return [...out.values()];
}

/**
 * The scope with targets added: each new one goes on the dimension's ID list
 * and its { id, name } list, the two forms the console writes. What the scope
 * holds already, and any other key, is kept as it is.
 */
export function addToScope(scope: unknown, targets: ScopeTarget[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...((scope && typeof scope === "object" ? scope : {}) as Record<string, unknown>) };
  const have = new Set(scopeTargets(scope).map(targetKey));
  for (const t of targets) {
    if (have.has(targetKey(t))) continue;
    have.add(targetKey(t));
    const d = DIMENSIONS[t.kind];
    if (d.ids) out[d.ids] = [...arr(out[d.ids]), t.id];
    out[d.rich] = [...arr(out[d.rich]), { id: t.id, ...(t.name ? { name: t.name } : {}) }];
  }
  return out;
}

const KINDS: AssignmentKind[] = ["user", "userGroup", "endpointGroup", "endpoint"];
const KIND_LABEL: Record<AssignmentKind, [string, string]> = {
  user: ["user", "users"],
  userGroup: ["user group", "user groups"],
  endpoint: ["device", "devices"],
  endpointGroup: ["device group", "device groups"],
};

type DirectoryObject = SophosUser | SophosUserGroup | SophosEndpointGroup | SophosEndpoint;

function listOf(dir: Directory, kind: AssignmentKind, ids?: string[]): Promise<DirectoryObject[]> {
  if (kind === "user") return dir.users();
  if (kind === "userGroup") return dir.userGroups();
  if (kind === "endpointGroup") return dir.endpointGroups();
  return dir.endpoints(ids);
}

/** How a target is shown in the results, and the name a destination scope entry carries. */
function labelOf(kind: AssignmentKind, obj: DirectoryObject): string {
  if (kind === "user") {
    const u = obj as SophosUser;
    return u.email && u.name && nameKey(u.email) !== nameKey(u.name) ? `${u.name} (${u.email})` : u.email || u.name || u.id;
  }
  if (kind === "endpoint") return (obj as SophosEndpoint).hostname || obj.id;
  return (obj as SophosUserGroup).name || obj.id;
}

function scopeName(kind: AssignmentKind, obj: DirectoryObject): string | undefined {
  if (kind === "user") return (obj as SophosUser).name || (obj as SophosUser).email;
  if (kind === "endpoint") return (obj as SophosEndpoint).hostname;
  return (obj as SophosUserGroup).name;
}

export interface ScopePlan {
  rows: AssignmentRow[];
  /** The name each matched destination object goes into the scope with, by kind and destination ID. */
  destNames: Map<string, string>;
}

/** Match each target of a source scope on the destination. Nothing is written. */
export async function planScope(scope: unknown, source: Directory, dest: Directory): Promise<ScopePlan> {
  const rows: AssignmentRow[] = [];
  const destNames = new Map<string, string>();
  const targets = scopeTargets(scope);
  for (const kind of KINDS) {
    const mine = targets.filter((t) => t.kind === kind);
    if (!mine.length) continue;
    const [one, many] = KIND_LABEL[kind];
    const fail = (reason: string) =>
      rows.push(...mine.map((t) => ({ kind, sourceId: t.id, name: t.name ?? t.id, status: "not-matched" as const, reason })));
    let src: DirectoryObject[];
    let dst: DirectoryObject[];
    try {
      src = await listOf(source, kind, mine.map((t) => t.id));
    } catch (err) {
      fail(`the tool could not read the source's ${many} (${errMsg(err)})`);
      continue;
    }
    try {
      dst = await listOf(dest, kind);
    } catch (err) {
      fail(`the tool could not read the destination's ${many} (${errMsg(err)})`);
      continue;
    }
    const byId = new Map(src.map((o) => [o.id, o]));
    for (const t of mine) {
      let obj = byId.get(t.id);
      let standIn = false;
      if (!obj && t.name) {
        obj = (kind === "endpoint" ? { id: t.id, hostname: t.name } : { id: t.id, name: t.name }) as DirectoryObject;
        standIn = true;
      }
      if (!obj) {
        rows.push({ kind, sourceId: t.id, name: t.id, status: "not-matched", reason: `no ${one} with this ID on the source` });
        continue;
      }
      const m: Match =
        kind === "user" ? matchUser(obj as SophosUser, dst as SophosUser[])
        : kind === "userGroup" ? matchUserGroup(obj as SophosUserGroup, dst as SophosUserGroup[])
        : kind === "endpointGroup" ? matchEndpointGroup(obj as SophosEndpointGroup, dst as SophosEndpointGroup[])
        : matchEndpoint(obj as SophosEndpoint, dst as SophosEndpoint[]);
      const extra = standIn ? `the source no longer lists this ${one}, so it was matched by the name the policy holds` : undefined;
      if ("destId" in m) {
        const found = dst.find((o) => o.id === m.destId);
        destNames.set(`${kind}:${m.destId}`, (found && scopeName(kind, found)) || labelOf(kind, obj));
        const note = [m.note, extra].filter(Boolean).join("; ");
        rows.push({ kind, sourceId: t.id, name: labelOf(kind, obj), destId: m.destId, status: "will-set", ...(note ? { note } : {}) });
      } else {
        // The matchers' advice is worded for endpoint policies.
        const reason = m.reason.replace(/clone again/g, "copy the policy again");
        rows.push({ kind, sourceId: t.id, name: labelOf(kind, obj), status: m.status, reason: extra ? `${reason} (${extra})` : reason });
      }
    }
  }
  return { rows, destNames };
}

const matchedTargets = (rows: AssignmentRow[], plan: ScopePlan): ScopeTarget[] =>
  rows.map((r) => ({ kind: r.kind, id: r.destId!, name: plan.destNames.get(`${r.kind}:${r.destId}`) }));

// --- Content ---

/** A rule as compared: conditions in any order, values in any order, read-only fields left out. */
function ruleKey(rule: AiRule): string {
  const conditions = (rule.target?.conditions ?? [])
    .map((c) => `${c.dimension}|${c.operator}|${[...(c.values ?? [])].sort().join(",")}`)
    .sort();
  const dc = rule.dataControls
    ? ["clipboardCopy", "clipboardPaste", "upload", "download"].map((k) => String((rule.dataControls as Record<string, unknown>)[k] ?? "")).join(",")
    : null;
  const mech = Array.isArray(rule.enforcementMechanismOverride) ? [...rule.enforcementMechanismOverride].sort().join(",") : null;
  return JSON.stringify([rule.action, conditions, mech, (rule.note ?? "").trim(), dc]);
}

const tagsKey = (tags: Record<string, string> | null | undefined) =>
  JSON.stringify(Object.entries(tags ?? {}).sort(([a], [b]) => a.localeCompare(b)));

const genAi = (p: AiPolicy) => p.baseRule?.generativeAiCategoryAction ?? "ALLOW";
const appControl = (p: AiPolicy) => p.baseRule?.appControlCategoryAction ?? null;
const onOff = (on: boolean) => (on ? "on" : "off");

/**
 * What differs between a source policy and the destination's, field by
 * field. Left out by design: the name (paired by it), the scope (added to,
 * see planScope), the sensors the tool doesn't copy, and the place in the
 * order, which differs because a copy goes to the bottom.
 */
export function aiPolicyDifferences(source: AiPolicy, dest: AiPolicy): string[] {
  const out: string[] = [];
  if ((source.description ?? "").trim() !== (dest.description ?? "").trim()) out.push("description");
  const a = (source.rules ?? []).map(ruleKey);
  const b = (dest.rules ?? []).map(ruleKey);
  if (a.length !== b.length) {
    out.push(`rules: ${a.length} on the source, ${b.length} on the destination`);
  } else {
    const at = a.map((k, i) => (k === b[i] ? 0 : i + 1)).filter(Boolean);
    if (at.length) out.push(`rules: rule ${at.join(", ")} ${at.length === 1 ? "differs" : "differ"}`);
  }
  if (genAi(source) !== genAi(dest)) out.push(`Generative AI category action: ${genAi(source)} on the source, ${genAi(dest)} on the destination`);
  if (appControl(source) !== appControl(dest)) out.push("app control category action");
  if (tagsKey(source.tags) !== tagsKey(dest.tags)) out.push("tags");
  if (!isBase(source) && !isBase(dest)) {
    if (source.state !== dest.state) out.push(`state: ${source.state === "ENABLED" ? "on" : "off"} on the source, ${dest.state === "ENABLED" ? "on" : "off"} on the destination`);
    const se = !!source.sensors?.endpoint?.enabled;
    const de = !!dest.sensors?.endpoint?.enabled;
    if (se !== de) out.push(`Endpoint sensor: ${onOff(se)} on the source, ${onOff(de)} on the destination`);
  }
  return out;
}

/** The destination policy a source policy pairs with: a base policy with the base policy, others by name. */
export function pairAiPolicy(policy: AiPolicy, sources: AiPolicy[], dests: AiPolicy[]): { dest?: AiPolicy; ambiguous?: boolean } {
  if (isBase(policy)) return { dest: dests.find(isBase) };
  const key = nameKey(policy.name);
  const same = (list: AiPolicy[]) => list.filter((p) => !isBase(p) && nameKey(p.name) === key);
  const d = same(dests);
  if (same(sources).length > 1 || d.length > 1) return { ambiguous: true };
  return { dest: d[0] };
}

const ambiguousError = (name: string) =>
  `more than one AI Defense policy matches "${name}" ignoring case, so the tool can't tell which destination policy is its copy and sent nothing: rename them so each name is unique ignoring case, then try again`;

/** What a source policy's sensors the tool doesn't copy, one note each. */
function sensorNotes(policy: AiPolicy): string[] {
  return (["firewall", "dns", "browser"] as const).filter((n) => policy.sensors?.[n]?.enabled).map((n) => SENSOR_NOT_COPIED[n]);
}

/** A rule in the shape createPolicy and updatePolicy take: read-only fields left out. */
export function toRuleInput(rule: AiRule): AiRuleInput {
  const input: AiRuleInput = {
    target: { conditions: (rule.target?.conditions ?? []).map((c) => ({ dimension: c.dimension, operator: c.operator, values: [...(c.values ?? [])] })) },
    action: rule.action,
  };
  if (Array.isArray(rule.enforcementMechanismOverride)) input.enforcementMechanismOverride = [...rule.enforcementMechanismOverride];
  if (rule.note) input.note = rule.note;
  if (rule.dataControls) {
    const { clipboardCopy, clipboardPaste, upload, download } = rule.dataControls;
    input.dataControls = { clipboardCopy, clipboardPaste, upload, download };
  }
  return input;
}

/** The create input for a copy: always turned off, with the Endpoint sensor only. */
export function createInput(policy: AiPolicy, scope: Record<string, unknown>): AiPolicyCreateInput {
  const input: AiPolicyCreateInput = {
    name: policy.name,
    rules: (policy.rules ?? []).map(toRuleInput),
    baseRule: { generativeAiCategoryAction: genAi(policy), ...(appControl(policy) ? { appControlCategoryAction: appControl(policy) } : {}) },
    sensors: { endpoint: { enabled: true, scope } },
    state: "DISABLED",
  };
  if (policy.description) input.description = policy.description;
  if (policy.tags && Object.keys(policy.tags).length) input.tags = { ...policy.tags };
  if (policy.builtInKey && policy.builtInVersion !== null && policy.builtInVersion !== undefined) {
    input.builtInKey = policy.builtInKey;
    input.builtInVersion = policy.builtInVersion;
  }
  return input;
}

/** A policy's sensors in the shape an update takes, because an update replaces the whole map. */
function sensorInputs(policy: AiPolicy): Partial<Record<AiSensorName, AiSensor>> {
  const out: Partial<Record<AiSensorName, AiSensor>> = {};
  for (const n of AI_SENSORS) {
    const s = policy.sensors?.[n];
    if (s) out[n] = { enabled: s.enabled, scope: s.scope };
  }
  return out;
}

// --- Compare ---

/** Each source policy's match on the destination, and the destination's own. Reads only. */
export async function compareAiPolicies(): Promise<AiPolicyMatch[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");
  const [sources, dests] = await Promise.all([listAiPolicies(src.fusion, src.tenantId), listAiPolicies(dst.fusion, dst.tenantId)]);
  const paired = new Set<string>();
  const out: AiPolicyMatch[] = [];
  for (const p of sources) {
    const row = { sourceId: p.id, name: p.name };
    if (p.origin === "PARTNER") {
      out.push({ ...row, destId: null, status: "not-copied", reason: PARTNER_NOT_COPIED });
      continue;
    }
    const { dest, ambiguous } = pairAiPolicy(p, sources, dests);
    if (ambiguous) {
      out.push({ ...row, destId: null, status: "ambiguous", reason: ambiguousError(p.name) });
      continue;
    }
    if (!dest) {
      out.push(isBase(p) ? { ...row, destId: null, status: "not-copied", reason: NO_DEST_BASE } : { ...row, destId: null, status: "source-only" });
      continue;
    }
    paired.add(dest.id);
    const differences = aiPolicyDifferences(p, dest);
    out.push({ ...row, destId: dest.id, status: differences.length ? "differ" : "match", ...(differences.length ? { differences } : {}) });
  }
  for (const d of dests) if (!paired.has(d.id)) out.push({ sourceId: null, destId: d.id, name: d.name, status: "dest-only" });
  return out;
}

// --- Copy ---

interface ReadBackOutcome {
  policy?: AiPolicy;
  /** Rows the read-back did not find in the scope. */
  missing: AssignmentRow[];
  /** What still differs from the source policy the write sent, apart from its state. */
  contentLeft: string[];
  /** Every read worked, and none found the policy. */
  gone?: boolean;
  /** Set when no read worked. */
  unread?: string;
}

/**
 * Reads the destination policy back by ID: at once, then a few times over
 * about 10 seconds while a scope target, the state, or (given content) the
 * source policy's rules, base rule, description and tags are not showing.
 */
async function readPolicyBack(
  dst: TenantContext,
  id: string,
  rows: AssignmentRow[],
  expect: { state?: AiPolicy["state"]; content?: AiPolicy; ignore?: string[] } = {},
): Promise<ReadBackOutcome> {
  let last: AiPolicy | undefined;
  let missing = rows;
  let contentLeft: string[] = [];
  let read = false;
  let readError = "";
  const check = async () => {
    const p = await getAiPolicy(dst.fusion, dst.tenantId, id);
    read = true;
    if (!p) return undefined;
    last = p;
    const have = new Set(scopeTargets(p.sensors?.endpoint?.scope).map(targetKey));
    missing = rows.filter((r) => !have.has(targetKey(r)));
    const ignore = ["state:", ...(expect.ignore ?? [])];
    contentLeft = expect.content ? aiPolicyDifferences(expect.content, p).filter((d) => !ignore.some((x) => d.startsWith(x))) : [];
    return missing.length === 0 && contentLeft.length === 0 && (!expect.state || p.state === expect.state) ? p : undefined;
  };
  try {
    if (await check()) return { policy: last, missing: [], contentLeft: [] };
  } catch (err) {
    readError = errMsg(err);
  }
  const back = await readBack(check);
  if (back.value) return { policy: back.value, missing: [], contentLeft: [] };
  if (!read) return { missing: rows, contentLeft: [], unread: back.unread ?? readError };
  if (!last) return { missing: rows, contentLeft: [], gone: true };
  return { policy: last, missing, contentLeft };
}

/** Settles the scope rows from a read-back: set when the scope shows them, failed when it doesn't. */
function settleRows(rows: AssignmentRow[], outcome: ReadBackOutcome, where: string): void {
  for (const r of rows) {
    if (outcome.unread) {
      r.status = "failed";
      r.reason = `Sophos accepted the scope, but the tool could not read ${where} back to check (${outcome.unread}): check it in Sophos Fusion`;
    } else if (outcome.gone) {
      r.status = "failed";
      r.reason = `Sophos accepted the scope, but a read-back by ID did not find ${where}`;
    } else if (outcome.missing.includes(r)) {
      r.status = "failed";
      r.reason = `Sophos accepted the scope, but a read-back of ${where} by ID did not show this one`;
    } else {
      r.status = "set";
      delete r.reason;
    }
  }
}

/** ok, or failed with what a read-back by ID still shows differing (or could not read). */
function confirmed(outcome: ReadBackOutcome, what: string): { ok: boolean; error?: string } {
  if (outcome.unread) return { ok: false, error: `Sophos accepted ${what}, but the tool could not read it back to check (${outcome.unread}): check it in Sophos Fusion` };
  if (outcome.gone) return { ok: false, error: `Sophos accepted ${what}, but a read-back by ID did not find the policy: check it in Sophos Fusion` };
  if (outcome.contentLeft.length) return { ok: false, error: `Sophos accepted ${what}, but a read-back by ID still shows a difference: ${outcome.contentLeft.join(", ")}` };
  return { ok: true };
}

export async function copyAiPolicies(req: CopyAiPoliciesRequest): Promise<AiPolicyCopyResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");
  const dryRun = req.dryRun === true;
  const overwrite = req.overwrite === true;
  const ids = req.policyIds ?? [];

  const [sources, dests] = await Promise.all([listAiPolicies(src.fusion, src.tenantId), listAiPolicies(dst.fusion, dst.tenantId)]);
  const srcById = new Map(sources.map((p) => [p.id, p]));
  const destIdsBefore = new Set(dests.map((p) => p.id));
  const srcDir = tenantDirectory(src);
  const dstDir = tenantDirectory(dst);
  // Names whose create got no clear answer: a second one could be a duplicate.
  const unclearNames = new Set<string>();
  // Destination policies this run made (or, in a dry run, would make): nothing to compare.
  const madeHere = new Set<string>(["planned"]);
  // Where the next copy goes: after the destination's last ordinary policy, then after each copy this run makes.
  const ordinary = dests.filter((p) => !isBase(p));
  let anchor: { id: string; name: string } | undefined = ordinary.length ? { id: ordinary.at(-1)!.id, name: ordinary.at(-1)!.name } : undefined;

  const audit = (action: string, ok: boolean, resourceId: string | undefined, detail: Record<string, unknown>, error?: string) =>
    auditOrWarn({ side: "dest", tenantId: dst.tenantId, action, resource: AI_POLICY_RESOURCE, ...(resourceId ? { resourceId } : {}), ok, ...(error ? { error } : {}), detail });

  const withLists = (r: AiPolicyCopyResult, adjustments: string[], notes: string[], rows?: AssignmentRow[]): AiPolicyCopyResult => ({
    ...r,
    ...(adjustments.length ? { adjustments } : {}),
    ...(notes.length ? { notes } : {}),
    ...(rows?.length ? { assignments: { rows } } : {}),
  });

  async function create(policy: AiPolicy, plan: ScopePlan, adjustments: string[]): Promise<AiPolicyCopyResult> {
    const base = { sourceId: policy.id, sourceName: policy.name };
    const action = dryRun ? "dry-run-create" : "create";
    if (unclearNames.has(nameKey(policy.name))) return { ...base, ok: false, action, error: earlierUnclear() };
    const rows = plan.rows;
    const matched = rows.filter((r) => r.status === "will-set");
    const scope = addToScope({}, matchedTargets(matched, plan));
    const turnOn = policy.state === "ENABLED" && matched.length > 0;
    if (policy.state === "ENABLED" && !turnOn) adjustments.push(LEFT_OFF_EMPTY);
    const notes: string[] = [];
    const placed = anchor ? `straight after "${anchor.name}"` : "at the top, as the destination's only ordinary policy";

    if (dryRun) {
      notes.push(`would be created turned off and placed ${placed}${turnOn ? ", then turned on" : ""}`);
      dests.push({ ...policy, id: "planned" });
      anchor = { id: "planned", name: policy.name };
      return withLists({ ...base, ok: true, action }, adjustments, notes, rows);
    }

    const input = createInput(policy, scope);
    const detail = { sourceId: policy.id, name: policy.name, scope: matched.map((r) => ({ kind: r.kind, name: r.name, destId: r.destId })), ...(adjustments.length ? { adjustments } : {}) };
    let created: AiPolicy;
    let checked: string | undefined;
    try {
      ({ value: created, note: checked } = await createChecked(
        () => createAiPolicy(dst.fusion, dst.tenantId, input),
        async () =>
          (await listAiPolicies(dst.fusion, dst.tenantId)).find((p) => !destIdsBefore.has(p.id) && !madeHere.has(p.id) && nameKey(p.name) === nameKey(policy.name)),
        "the policy",
        { where: "the destination's AI Defense policies", found: `no new policy named "${policy.name}"` },
      ));
    } catch (err) {
      const msg = errMsg(err);
      if (isUnclearWrite(err)) unclearNames.add(nameKey(policy.name));
      await audit("create", false, undefined, detail, msg);
      return withLists({ ...base, ok: false, action, error: msg }, adjustments, []);
    }
    madeHere.add(created.id);
    dests.push(created);
    await audit("create", true, created.id, { ...detail, state: "DISABLED", ...(checked ? { note: checked } : {}) });
    if (checked) notes.push(checked);

    if (anchor) {
      const after = anchor;
      try {
        await moveAiPolicy(dst.fusion, dst.tenantId, created.id, after.id);
        await audit("move", true, created.id, { sourceId: policy.id, name: policy.name, afterId: after.id, afterName: after.name });
        notes.push(`placed straight after "${after.name}"`);
      } catch (err) {
        const msg = errMsg(err);
        await audit("move", false, created.id, { sourceId: policy.id, name: policy.name, afterId: after.id, afterName: after.name }, msg);
        notes.push(`left at the top of the destination's order: moving it below "${after.name}" failed (${msg}). Move it in Sophos Fusion${turnOn ? "; it was left turned off" : ""}`);
        anchor = { id: created.id, name: created.name };
        const outcome = await readPolicyBack(dst, created.id, matched, { content: policy });
        settleRows(matched, outcome, `the destination policy "${created.name}"`);
        return withLists({ ...base, destId: created.id, destName: created.name, action, ...confirmed(outcome, "the copy") }, adjustments, notes, rows);
      }
    }
    anchor = { id: created.id, name: created.name };

    let want: AiPolicy["state"] = "DISABLED";
    if (turnOn) {
      try {
        await enableAiPolicy(dst.fusion, dst.tenantId, created.id);
        await audit("enable", true, created.id, { sourceId: policy.id, name: policy.name });
        want = "ENABLED";
      } catch (err) {
        const msg = errMsg(err);
        await audit("enable", false, created.id, { sourceId: policy.id, name: policy.name }, msg);
        notes.push(`created turned off: turning it on failed (${msg}). Turn it on in Sophos Fusion`);
      }
    }

    const outcome = await readPolicyBack(dst, created.id, matched, { state: want, content: policy });
    settleRows(matched, outcome, `the destination policy "${created.name}"`);
    if (want === "ENABLED" && outcome.policy && outcome.policy.state !== "ENABLED") {
      notes.push("Sophos accepted turning it on, but a read-back by ID shows it off: check it in Sophos Fusion");
    } else if (want === "ENABLED" && !outcome.unread) {
      notes.push("turned on, as on the source");
    }
    return withLists({ ...base, destId: created.id, destName: created.name, action, ...confirmed(outcome, "the copy") }, adjustments, notes, rows);
  }

  /**
   * Adds matched scope targets to a destination policy, or overwrites it.
   * The policy is read fresh first, for its version and current scope.
   */
  async function existing(policy: AiPolicy, dest: AiPolicy, plan: ScopePlan | undefined, adjustments: string[]): Promise<AiPolicyCopyResult> {
    const base = { sourceId: policy.id, sourceName: policy.name, destId: dest.id, destName: dest.name };
    const differences = aiPolicyDifferences(policy, dest);
    const rows = plan?.rows ?? [];
    const readOnly = dest.origin === "PARTNER";
    const destHas = new Set(scopeTargets(dest.sensors?.endpoint?.scope).map(targetKey));
    for (const r of rows) {
      if (r.status !== "will-set") continue;
      if (destHas.has(targetKey(r))) r.status = "already-set";
      else if (readOnly) Object.assign(r, { status: "not-matched", reason: PARTNER_DEST });
      else if (!dest.sensors?.endpoint) Object.assign(r, { status: "not-matched", reason: "the destination policy has no Endpoint sensor to add it to: overwrite the policy to bring the source's across" });
    }
    const adding = rows.filter((r) => r.status === "will-set");
    const diff = differences.length ? { differences } : {};
    const write = overwrite && differences.length > 0;
    if (write && !readOnly && !Object.keys(policy.tags ?? {}).length && tagsKey(policy.tags) !== tagsKey(dest.tags)) adjustments.push(TAGS_STAY);

    if (!write) {
      const action = differences.length ? "differs" : "skip-exists";
      if (!adding.length || dryRun) return withLists({ ...base, ok: true, action, ...diff }, [], [], rows);
    } else {
      if (readOnly) return withLists({ ...base, ok: false, action: dryRun ? "dry-run-overwrite" : "overwrite", ...diff, error: `${PARTNER_DEST}, so it can't be overwritten` }, adjustments, [], rows);
      if (dryRun) {
        const notes: string[] = [];
        if (!isBase(policy) && !isBase(dest) && policy.state !== dest.state) {
          const nobody = scopeTargets(addToScope(dest.sensors?.endpoint?.scope ?? {}, matchedTargets(adding, plan!))).length === 0;
          notes.push(policy.state === "ENABLED" && nobody ? "would stay turned off: none of the users, groups or devices it applies to are on the destination yet" : `would be turned ${policy.state === "ENABLED" ? "on" : "off"}`);
        }
        return withLists({ ...base, ok: true, action: "dry-run-overwrite", ...diff }, adjustments, notes, rows);
      }
    }

    const where = `the destination policy "${dest.name}"`;
    const action = write ? "overwrite" : differences.length ? "differs" : "skip-exists";
    const notes: string[] = [];
    let fresh: AiPolicy | null;
    try {
      fresh = await getAiPolicy(dst.fusion, dst.tenantId, dest.id);
      if (!fresh) throw new Error("Sophos Fusion answered without the policy");
    } catch (err) {
      const reason = `the tool could not read ${where} to update it (${errMsg(err)})`;
      for (const r of adding) Object.assign(r, { status: "failed", reason });
      return withLists({ ...base, ok: !write, action, ...diff, ...(write ? { error: reason } : {}) }, write ? adjustments : [], [], rows);
    }

    const targets = matchedTargets(adding, plan ?? { rows: [], destNames: new Map() });
    const input: AiPolicyUpdateInput = { version: fresh.version };
    if (write) {
      input.rules = (policy.rules ?? []).map(toRuleInput);
      input.baseRule = { generativeAiCategoryAction: genAi(policy), appControlCategoryAction: appControl(policy) };
      if ((policy.description ?? "").trim() !== (fresh.description ?? "").trim()) input.description = policy.description ?? "";
      if (tagsKey(policy.tags) !== tagsKey(fresh.tags)) {
        if (Object.keys(policy.tags ?? {}).length) input.tags = { ...policy.tags };
        else if (!adjustments.includes(TAGS_STAY)) adjustments.push(TAGS_STAY);
      }
    }
    // The base policy's sensors stay as they are: it applies to everyone.
    if (!isBase(fresh) && (targets.length || (write && (policy.sensors?.endpoint || fresh.sensors?.endpoint)))) {
      const sensors = sensorInputs(fresh);
      const current = fresh.sensors?.endpoint;
      const enabled = write ? (policy.sensors?.endpoint?.enabled ?? current?.enabled ?? false) : (current?.enabled ?? false);
      sensors.endpoint = { enabled, scope: addToScope(current?.scope ?? {}, targets) };
      input.sensors = sensors;
    }
    const scopeNamesNobody = !isBase(fresh) && scopeTargets(input.sensors?.endpoint?.scope ?? fresh.sensors?.endpoint?.scope).length === 0;

    const detail = {
      sourceId: policy.id,
      name: dest.name,
      ...(write ? { overwrite: true, differences } : {}),
      ...(adding.length ? { scopeAdded: adding.map((r) => ({ kind: r.kind, name: r.name, destId: r.destId })) } : {}),
      ...(write && adjustments.length ? { adjustments } : {}),
    };
    let unclear: unknown;
    try {
      await updateAiPolicy(dst.fusion, dst.tenantId, dest.id, input);
    } catch (err) {
      if (!isUnclearWrite(err)) {
        const msg = errMsg(err);
        await audit("update", false, dest.id, detail, msg);
        for (const r of adding) Object.assign(r, { status: "failed", reason: `Sophos refused the update: ${msg}` });
        return withLists({ ...base, ok: !write, action, ...diff, ...(write ? { error: msg } : {}) }, write ? adjustments : [], [], rows);
      }
      unclear = err;
    }
    if (!unclear) await audit("update", true, dest.id, detail);

    // State: an overwrite turns the policy on or off to match the source.
    let want: AiPolicy["state"] | undefined;
    if (write && !isBase(policy) && !isBase(fresh) && !unclear && policy.state !== fresh.state) {
      if (policy.state === "ENABLED" && scopeNamesNobody) {
        notes.push("left turned off: none of the users, groups or devices it applies to are on the destination yet, and Sophos won't turn on a policy that names nobody");
      } else {
        const on = policy.state === "ENABLED";
        try {
          await (on ? enableAiPolicy : disableAiPolicy)(dst.fusion, dst.tenantId, dest.id);
          await audit(on ? "enable" : "disable", true, dest.id, { sourceId: policy.id, name: dest.name });
          want = policy.state;
          notes.push(`turned ${on ? "on" : "off"}, as on the source`);
        } catch (err) {
          const msg = errMsg(err);
          await audit(on ? "enable" : "disable", false, dest.id, { sourceId: policy.id, name: dest.name }, msg);
          notes.push(`the content was updated, but turning it ${on ? "on" : "off"} failed (${msg}): do it in Sophos Fusion`);
        }
      }
    }

    const ignore = adjustments.includes(TAGS_STAY) ? ["tags"] : [];
    const outcome = await readPolicyBack(dst, dest.id, adding, { state: want, ...(write ? { content: policy, ignore } : {}) });
    if (unclear && isUnclearWrite(unclear)) {
      // Sophos gave no clear answer: what the read-back shows decides.
      const landed = !!outcome.policy && outcome.missing.length === 0 && outcome.contentLeft.length === 0;
      if (!landed) {
        const miss = outcome.unread
          ? notFound(unclear, { where, found: "", check: where }, outcome.unread)
          : notFound(unclear, { where, found: write ? "the old content still there" : "the new scope not there yet", advice: "Wait a minute, then preview again: a change there by then shows as already there.", check: where });
        await audit("update", false, dest.id, detail, miss.message);
        for (const r of adding) Object.assign(r, { status: "failed", reason: miss.message });
        return withLists({ ...base, ok: !write, action, ...diff, ...(write ? { error: miss.message } : {}) }, write ? adjustments : [], notes, rows);
      }
      notes.unshift(foundNote(unclear, write ? "the new content" : "the new scope", `on ${where}`));
    }
    settleRows(adding, outcome, where);
    if (unclear) await audit("update", true, dest.id, { ...detail, note: notes[0] });
    if (want && outcome.policy && outcome.policy.state !== want) {
      notes.push(`Sophos accepted turning it ${want === "ENABLED" ? "on" : "off"}, but a read-back by ID shows it ${want === "ENABLED" ? "off" : "on"}: check it in Sophos Fusion`);
    }
    const result = write ? confirmed(outcome, "the overwrite") : { ok: true };
    return withLists({ ...base, action, ...diff, ...result }, write ? adjustments : [], notes, rows);
  }

  // Top of the source order first: each copy goes below the one before it, so a batch keeps its order.
  const order = ids.map((_, i) => i).sort((a, b) => (srcById.get(ids[a]!)?.rank ?? Infinity) - (srcById.get(ids[b]!)?.rank ?? Infinity));
  const results: AiPolicyCopyResult[] = new Array(ids.length);
  for (const i of order) {
    const id = ids[i]!;
    const policy = srcById.get(id);
    const act = dryRun ? "dry-run-create" : "create";
    if (!policy) {
      results[i] = { sourceId: id, sourceName: "(unknown)", ok: false, action: act, error: "source policy not found" };
      continue;
    }
    const base = { sourceId: policy.id, sourceName: policy.name };
    if (policy.origin === "PARTNER") {
      results[i] = { ...base, ok: false, action: act, error: PARTNER_NOT_COPIED };
      continue;
    }
    const { dest, ambiguous } = pairAiPolicy(policy, sources, dests);
    if (ambiguous) {
      results[i] = { ...base, ok: false, action: act, error: ambiguousError(policy.name) };
      continue;
    }
    if (isBase(policy) && !dest) {
      results[i] = { ...base, ok: false, action: act, error: NO_DEST_BASE };
      continue;
    }
    if (dest && madeHere.has(dest.id)) {
      results[i] = { ...base, destId: dest.id, destName: dest.name, ok: true, action: "skip-exists" };
      continue;
    }
    const adjustments = sensorNotes(policy);
    if (!dest && !policy.sensors?.endpoint?.enabled) {
      results[i] = withLists({ ...base, ok: false, action: act, error: ENDPOINT_OFF }, adjustments, []);
      continue;
    }
    const plan = isBase(policy) ? undefined : await planScope(policy.sensors?.endpoint?.scope, srcDir, dstDir);
    results[i] = dest ? await existing(policy, dest, plan, adjustments) : await create(policy, plan!, adjustments);
  }
  return results;
}
