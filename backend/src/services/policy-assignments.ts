/**
 * Policy assignments: the users, user groups, devices and device groups a
 * policy applies to (its `appliesTo`).
 *
 * A source policy names them by ID, and those IDs mean nothing on the
 * destination, so each one is matched to the destination object it stands for:
 *   - endpoint groups by name and type (computer or server),
 *   - user groups by name,
 *   - users by email, then by name,
 *   - devices by hostname and type. A device with no record of that hostname
 *     on the destination is pending, not failed: its move has not landed yet.
 * Anything that matches nothing, or more than one object, is reported with the
 * reason, and Export assignments (CSV) on the Policies page lists every source
 * assignment for setting by hand.
 *
 * Matched targets are added to what the destination policy already applies to;
 * none is removed. So cloning again after devices move is safe, and adds the
 * ones that were pending.
 *
 * What Sophos accepts, measured on live tenants on 13/10/2026 (create and PATCH):
 *   - Plain ID arrays under users, userGroups, endpoints and endpointGroups.
 *     `{ id }` objects are refused with 400.
 *   - endpointGroups on its own is refused with 500 "Error processing data"
 *     and changes nothing. With `endpoints: []` beside it, it works, so a
 *     device body always carries endpoints.
 *   - User keys and device keys together are refused with 400. A computer
 *     policy is a user policy or a device policy, and which one follows the
 *     keys its appliesTo carries. Server policies take device keys only.
 *   - GET by ID shows a write at once; the policy list can lag by about 22 s.
 * Each write sends the policy's whole list, what it had plus what is added,
 * and is read back by GET by ID.
 */

import { getPolicy, updatePolicy } from "../sophos/api/policies.js";
import { listUsers, type SophosUser } from "../sophos/api/users.js";
import { listUserGroups, type SophosUserGroup } from "../sophos/api/user-groups.js";
import { listAllGroups } from "../sophos/api/groups.js";
import { listAllEndpoints } from "../sophos/api/endpoints.js";
import { auditOrWarn } from "./audit-log.js";
import { foundNote, isUnclearWrite, notFound, readBack } from "./write-check.js";
import type { TenantContext } from "../sophos/tenant-context.js";
import type { SophosEndpointGroup, SophosPolicy } from "../sophos/types/migration.js";
import type { SophosEndpoint } from "../sophos/types/sophos.js";

export type AssignmentKind = "user" | "userGroup" | "endpoint" | "endpointGroup";
export type AssignmentMode = "user" | "device";
/**
 * will-set: matched, and a run that is not a dry run adds it.
 * set: added, and the read-back found it. already-set: the destination policy
 * applies to it already. pending: a device not on the destination yet.
 * not-matched: nothing (or more than one thing) on the destination matches,
 * or the destination policy can't take it. failed: the write or its read-back
 * did not confirm it.
 */
export type AssignmentStatus = "will-set" | "set" | "already-set" | "pending" | "not-matched" | "failed";
export type AppliesToKey = "users" | "userGroups" | "endpoints" | "endpointGroups";
export type AppliesTo = NonNullable<SophosPolicy["appliesTo"]>;

export interface AssignmentRow {
  kind: AssignmentKind;
  /** The target's ID on the source. */
  sourceId: string;
  /** How the source knows the target: a user's email or name, a group's name, a device's hostname. */
  name: string;
  /** The matching object on the destination. */
  destId?: string;
  status: AssignmentStatus;
  reason?: string;
}

export interface AssignmentReport {
  /** Whether the source policy applies to users or to devices. */
  mode: AssignmentMode;
  rows: AssignmentRow[];
  /** Notes, such as a write Sophos answered unclearly that a read-back found made. */
  notes?: string[];
}

export const APPLIES_TO_KEY: Record<AssignmentKind, AppliesToKey> = {
  user: "users",
  userGroup: "userGroups",
  endpoint: "endpoints",
  endpointGroup: "endpointGroups",
};
const KINDS: AssignmentKind[] = ["user", "userGroup", "endpointGroup", "endpoint"];
const MODE_OF: Record<AssignmentKind, AssignmentMode> = { user: "user", userGroup: "user", endpoint: "device", endpointGroup: "device" };
const KIND_LABEL: Record<AssignmentKind, [string, string]> = {
  user: ["user", "users"],
  userGroup: ["user group", "user groups"],
  endpoint: ["device", "devices"],
  endpointGroup: ["device group", "device groups"],
};

/** The IDs under one appliesTo key, as strings. The API returns strings; `{ id }` is tolerated. */
export function idsOf(appliesTo: SophosPolicy["appliesTo"], key: AppliesToKey): string[] {
  return (appliesTo?.[key] ?? [])
    .map((ref) => (typeof ref === "string" ? ref : ref?.id))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** User or device policy, from the keys that hold IDs. Undefined when it applies to nothing. */
export function modeOf(appliesTo: SophosPolicy["appliesTo"]): AssignmentMode | undefined {
  if (idsOf(appliesTo, "users").length || idsOf(appliesTo, "userGroups").length) return "user";
  if (idsOf(appliesTo, "endpoints").length || idsOf(appliesTo, "endpointGroups").length) return "device";
  return undefined;
}

/**
 * The appliesTo for a write. A device body always carries endpoints, empty
 * or not, because endpointGroups on its own is refused with a 500. A user
 * body carries only the keys that hold IDs. Both are shapes measured to work.
 */
export function appliesToBody(mode: AssignmentMode, ids: Partial<Record<AppliesToKey, string[]>>): AppliesTo {
  if (mode === "device") {
    return {
      endpoints: [...(ids.endpoints ?? [])],
      ...(ids.endpointGroups?.length ? { endpointGroups: [...ids.endpointGroups] } : {}),
    };
  }
  return {
    ...(ids.users?.length ? { users: [...ids.users] } : {}),
    ...(ids.userGroups?.length ? { userGroups: [...ids.userGroups] } : {}),
  };
}

// --- Matching ---

export type Match = { destId: string } | { status: "pending" | "not-matched"; reason: string };

const norm = (s: string | undefined | null) => String(s ?? "").trim().toLowerCase();

/** The one destination object with this key, or why there isn't one. */
function single<T extends { id: string }>(found: T[], none: Match, many: (n: number) => string): Match {
  if (found.length === 1) return { destId: found[0]!.id };
  if (found.length === 0) return none;
  return { status: "not-matched", reason: many(found.length) };
}

/** A user by email, then by name. */
export function matchUser(user: SophosUser, dest: SophosUser[]): Match {
  const email = norm(user.email);
  if (email) {
    const byEmail = dest.filter((u) => norm(u.email) === email);
    if (byEmail.length) {
      return single(byEmail, { status: "not-matched", reason: "" }, (n) => `${n} users on the destination have the email ${user.email}, so the tool can't tell which one it is`);
    }
  }
  const name = norm(user.name);
  const byName = name ? dest.filter((u) => norm(u.name) === name) : [];
  const none = email && name
    ? `no user on the destination has the email ${user.email} or the name "${user.name}"`
    : email
      ? `no user on the destination has the email ${user.email}`
      : `no user on the destination has the name "${user.name ?? ""}"`;
  return single(byName, { status: "not-matched", reason: none }, (n) => `${n} users on the destination are named "${user.name}", so the tool can't tell which one it is`);
}

/** A user group by name. */
export function matchUserGroup(group: SophosUserGroup, dest: SophosUserGroup[]): Match {
  const name = norm(group.name);
  return single(
    dest.filter((g) => norm(g.name) === name),
    { status: "not-matched", reason: `no user group named "${group.name}" on the destination: mirror it on the Groups page, then clone again` },
    (n) => `${n} user groups on the destination are named "${group.name}", so the tool can't tell which one it is`,
  );
}

/** A device group by name, among the destination's groups of the same type (computer or server). */
export function matchEndpointGroup(group: SophosEndpointGroup, dest: SophosEndpointGroup[]): Match {
  const name = norm(group.name);
  const sameType = (g: SophosEndpointGroup) => !group.type || !g.type || g.type === group.type;
  const what = group.type ? `${group.type} group` : "device group";
  return single(
    dest.filter((g) => norm(g.name) === name && sameType(g)),
    { status: "not-matched", reason: `no ${what} named "${group.name}" on the destination: mirror it on the Groups page, then clone again` },
    (n) => `${n} ${what}s on the destination are named "${group.name}", so the tool can't tell which one it is`,
  );
}

/**
 * A device by hostname, among the destination's devices of the same type.
 * None there is pending: the device has not moved yet. More than one is not
 * matched, because the destination can keep an old record of a device that
 * moved away and back.
 */
export function matchEndpoint(endpoint: SophosEndpoint, dest: SophosEndpoint[]): Match {
  const host = norm(endpoint.hostname);
  if (!host) return { status: "not-matched", reason: "the device has no hostname on the source to match by" };
  const sameType = (e: SophosEndpoint) => !endpoint.type || !e.type || e.type === endpoint.type;
  return single(
    dest.filter((e) => norm(e.hostname) === host && sameType(e)),
    { status: "pending", reason: `no device named "${endpoint.hostname}" on the destination yet: once its move lands, clone again to add it` },
    (n) => `${n} devices named "${endpoint.hostname}" on the destination, so the tool can't tell which one it is`,
  );
}

/** How the source knows a target, for the results list. */
function labelOf(kind: AssignmentKind, obj: DirectoryObject): string {
  if (kind === "user") {
    const u = obj as SophosUser;
    return u.email && u.name && norm(u.email) !== norm(u.name) ? `${u.name} (${u.email})` : u.email || u.name || u.id;
  }
  if (kind === "endpoint") return (obj as SophosEndpoint).hostname || obj.id;
  return (obj as SophosUserGroup).name || obj.id;
}

// --- Directories ---

/** A tenant's users, groups and devices, each read at most once per run. */
export interface Directory {
  users(): Promise<SophosUser[]>;
  userGroups(): Promise<SophosUserGroup[]>;
  endpointGroups(): Promise<SophosEndpointGroup[]>;
  /** The devices with these IDs, or every device when no IDs are given. */
  endpoints(ids?: string[]): Promise<SophosEndpoint[]>;
}

/** Devices per call when looking up by ID, and per page when listing them all (the API's maximum). */
const ID_BATCH = 100;
const ENDPOINT_PAGE = 500;

export function tenantDirectory(ctx: TenantContext): Directory {
  const once = <T>(load: () => Promise<T>) => {
    let p: Promise<T> | undefined;
    return () => (p ??= load());
  };
  const allEndpoints = once(() => listAllEndpoints(ctx.client, ctx.tenantId, { pageSize: ENDPOINT_PAGE }));
  const byId = new Map<string, SophosEndpoint | null>();
  return {
    users: once(() => listUsers(ctx.client, ctx.tenantId)),
    userGroups: once(() => listUserGroups(ctx.client, ctx.tenantId)),
    endpointGroups: once(() => listAllGroups(ctx.client, ctx.tenantId)),
    async endpoints(ids?: string[]) {
      if (!ids) return allEndpoints();
      const wanted = [...new Set(ids)].filter((id) => !byId.has(id));
      for (let i = 0; i < wanted.length; i += ID_BATCH) {
        const batch = wanted.slice(i, i + ID_BATCH);
        const got = await listAllEndpoints(ctx.client, ctx.tenantId, { ids: batch });
        for (const id of batch) byId.set(id, null);
        for (const e of got) byId.set(e.id, e);
      }
      return ids.map((id) => byId.get(id)).filter((e): e is SophosEndpoint => !!e);
    },
  };
}

type DirectoryObject = SophosUser | SophosUserGroup | SophosEndpointGroup | SophosEndpoint;

function listOf(dir: Directory, kind: AssignmentKind, ids?: string[]): Promise<DirectoryObject[]> {
  if (kind === "user") return dir.users();
  if (kind === "userGroup") return dir.userGroups();
  if (kind === "endpointGroup") return dir.endpointGroups();
  return dir.endpoints(ids);
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Match each target of a source policy's appliesTo on the destination.
 * Undefined when the policy applies to nothing. Nothing is written.
 */
export async function planAssignments(
  appliesTo: SophosPolicy["appliesTo"],
  source: Directory,
  dest: Directory,
): Promise<AssignmentReport | undefined> {
  const mode = modeOf(appliesTo);
  if (!mode) return;
  const rows: AssignmentRow[] = [];
  for (const kind of KINDS) {
    const ids = [...new Set(idsOf(appliesTo, APPLIES_TO_KEY[kind]))];
    if (!ids.length) continue;
    const [one, many] = KIND_LABEL[kind];
    const fail = (reason: string) => rows.push(...ids.map((id) => ({ kind, sourceId: id, name: id, status: "not-matched" as const, reason })));
    if (MODE_OF[kind] !== mode) {
      fail(`the source policy also applies to ${mode === "user" ? "users" : "devices"}, and Sophos can't assign users and devices on one policy`);
      continue;
    }
    let src: DirectoryObject[];
    let dst: DirectoryObject[];
    try {
      // Only the source's devices this policy names; every device on the destination, to match by hostname.
      src = await listOf(source, kind, ids);
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
    const srcById = new Map(src.map((o) => [o.id, o]));
    for (const id of ids) {
      const obj = srcById.get(id);
      if (!obj) {
        rows.push({ kind, sourceId: id, name: id, status: "not-matched", reason: `no ${one} with this ID on the source` });
        continue;
      }
      const m =
        kind === "user" ? matchUser(obj as SophosUser, dst as SophosUser[])
        : kind === "userGroup" ? matchUserGroup(obj as SophosUserGroup, dst as SophosUserGroup[])
        : kind === "endpointGroup" ? matchEndpointGroup(obj as SophosEndpointGroup, dst as SophosEndpointGroup[])
        : matchEndpoint(obj as SophosEndpoint, dst as SophosEndpoint[]);
      rows.push({
        kind,
        sourceId: id,
        name: labelOf(kind, obj),
        ...("destId" in m ? { destId: m.destId, status: "will-set" as const } : { status: m.status, reason: m.reason }),
      });
    }
  }
  return { mode, rows };
}

/** The rows whose destination ID the policy's appliesTo does not show under its key. */
function missingFrom(appliesTo: SophosPolicy["appliesTo"], rows: AssignmentRow[]): AssignmentRow[] {
  return rows.filter((r) => !idsOf(appliesTo, APPLIES_TO_KEY[r.kind]).includes(r.destId!));
}

export interface ApplyOptions {
  dryRun: boolean;
  /** The source policy's ID and the destination policy's name, for the audit log and messages. */
  sourceId: string;
  name: string;
}

/**
 * Add a plan's matched targets to the destination policy, or, in a dry run,
 * say which would be added. destPolicyId is undefined for a policy a dry run
 * would create, which applies to nothing yet. Targets the policy applies to
 * already are marked so and not sent again; when nothing is left to add,
 * nothing is written. After a write the policy is read back by ID until every
 * added target shows, about 10 seconds at most, and each row says what the
 * read-back found.
 */
export async function applyAssignments(
  dst: TenantContext,
  destPolicyId: string | undefined,
  report: AssignmentReport,
  opts: ApplyOptions,
): Promise<AssignmentReport> {
  const adding = () => report.rows.filter((r) => r.status === "will-set");
  const settle = (rows: AssignmentRow[], status: AssignmentStatus, reason?: string) => {
    for (const r of rows) {
      r.status = status;
      if (reason) r.reason = reason;
      else delete r.reason;
    }
  };
  if (!adding().length) return report;
  if (!destPolicyId) {
    if (!opts.dryRun) settle(adding(), "failed", "the tool did not get the destination policy's ID back, so it could not add the assignments");
    return report;
  }

  let current: SophosPolicy["appliesTo"];
  try {
    const policy = await getPolicy(dst.client, dst.tenantId, destPolicyId);
    if (policy.priority === 0) {
      settle(adding(), "not-matched", "the destination policy is a base policy, which applies to everything and takes no assignments");
      return report;
    }
    current = policy.appliesTo;
  } catch (err) {
    settle(adding(), "failed", `the tool could not read the destination policy to add its assignments (${errMsg(err)})`);
    return report;
  }

  const currentMode = modeOf(current);
  if (currentMode && currentMode !== report.mode) {
    const has = currentMode === "user" ? "users" : "devices";
    settle(adding(), "not-matched", `the destination policy applies to ${has}, and Sophos can't assign users and devices on one policy`);
    return report;
  }
  for (const r of adding()) {
    if (idsOf(current, APPLIES_TO_KEY[r.kind]).includes(r.destId!)) settle([r], "already-set");
  }
  const rows = adding();
  if (!rows.length || opts.dryRun) return report;

  // The whole list: what the policy has, plus what is added.
  const ids: Partial<Record<AppliesToKey, string[]>> = {};
  for (const kind of KINDS.filter((k) => MODE_OF[k] === report.mode)) {
    const key = APPLIES_TO_KEY[kind];
    ids[key] = [...new Set([...idsOf(current, key), ...rows.filter((r) => r.kind === kind).map((r) => r.destId!)])];
  }
  const body = appliesToBody(report.mode, ids);
  const where = `the destination policy "${opts.name}"`;

  let unclear: unknown;
  try {
    await updatePolicy(dst.client, dst.tenantId, destPolicyId, { appliesTo: body });
  } catch (err) {
    if (!isUnclearWrite(err)) {
      settle(rows, "failed", `Sophos refused the assignments: ${errMsg(err)}`);
      await audit(dst, destPolicyId, opts, body, [], rows, errMsg(err));
      return report;
    }
    unclear = err;
  }

  // Read back by ID: at once, then a few times over about 10 seconds while anything is missing.
  let missing: AssignmentRow[] = rows;
  let read = false;
  let readError = "";
  const check = async () => {
    const policy = await getPolicy(dst.client, dst.tenantId, destPolicyId);
    read = true;
    missing = missingFrom(policy.appliesTo, rows);
    return missing.length === 0 ? true : undefined;
  };
  try {
    await check();
  } catch (err) {
    readError = errMsg(err);
  }
  if (missing.length) {
    const back = await readBack(check);
    if (back.unread) readError = back.unread;
  }

  const found = rows.filter((r) => !missing.includes(r));
  if (!read) {
    // No read worked: the write is unconfirmed either way.
    const reason = unclear && isUnclearWrite(unclear)
      ? notFound(unclear, { where, found: "", check: where }, readError).message
      : `Sophos accepted the assignments, but the tool could not read ${where} back to check (${readError}): check it in Sophos Fusion`;
    settle(rows, "failed", reason);
  } else {
    settle(found, "set");
    if (missing.length) {
      const reason = unclear && isUnclearWrite(unclear)
        ? notFound(unclear, {
            where,
            found: found.length ? `${found.length} of the ${rows.length} assignments, but not this one` : "none of the assignments",
            advice: "Wait a minute, then preview again: an assignment there by then shows as already assigned.",
            check: where,
          }).message
        : `Sophos accepted the assignments, but a read-back of ${where} by ID did not show this one`;
      settle(missing, "failed", reason);
    }
    if (unclear && isUnclearWrite(unclear) && found.length) {
      report.notes = [...(report.notes ?? []), foundNote(unclear, found.length === 1 ? "the assignment" : "the assignments", `on ${where}`)];
    }
  }
  await audit(dst, destPolicyId, opts, body, report.rows.filter((r) => r.status === "set"), report.rows.filter((r) => r.status === "failed"), unclear ? errMsg(unclear) : undefined);
  return report;
}

async function audit(
  dst: TenantContext,
  destPolicyId: string,
  opts: ApplyOptions,
  appliesTo: AppliesTo,
  set: AssignmentRow[],
  failed: AssignmentRow[],
  error: string | undefined,
): Promise<void> {
  await auditOrWarn({
    side: "dest",
    tenantId: dst.tenantId,
    action: "update",
    resource: "policy-assignments",
    resourceId: destPolicyId,
    ok: failed.length === 0,
    ...(failed.length ? { error: error ?? failed[0]!.reason ?? "not confirmed by the read-back" } : {}),
    detail: {
      sourceId: opts.sourceId,
      name: opts.name,
      appliesTo,
      set: set.map((r) => ({ kind: r.kind, name: r.name, destId: r.destId })),
      ...(failed.length ? { failed: failed.map((r) => ({ kind: r.kind, name: r.name, destId: r.destId })) } : {}),
      ...(error ? { answer: error } : {}),
    },
  });
}
