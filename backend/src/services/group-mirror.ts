/**
 * Mirrors endpoint groups and user groups from source to destination by name
 * + metadata.
 *
 * IMPORTANT: membership is NOT copied. Source endpoint IDs are meaningless
 * in the destination tenant. Devices reconstitute group membership after
 * migration based on destination policies.
 */

import { getGroup, listGroups, createGroup } from "../sophos/api/groups.js";
import { listUserGroups, createUserGroup } from "../sophos/api/user-groups.js";
import { requireContext } from "../state.js";
import { auditOrWarn } from "./audit-log.js";
import { createChecked, earlierUnclear, isUnclearWrite } from "./write-check.js";
import type { SophosEndpointGroup } from "../sophos/types/migration.js";

export interface MirrorGroupsRequest {
  groupIds: string[];
  dryRun?: boolean;
}

export interface MirrorGroupResult {
  sourceId: string;
  sourceName: string;
  destId?: string;
  ok: boolean;
  action: "create" | "skip-exists" | "dry-run-create";
  error?: string;
  /** Notes for the results list, such as a create Sophos answered unclearly but a read-back found. */
  notes?: string[];
}

export async function mirrorGroups(req: MirrorGroupsRequest): Promise<MirrorGroupResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");

  const destExisting = await listGroups(dst.client, dst.tenantId);
  const destNames = new Set(destExisting.map((g) => g.name.toLowerCase()));
  // Names whose create got no clear answer: a second one could be a duplicate.
  const unclearNames = new Set<string>();
  const results: MirrorGroupResult[] = [];

  for (const sourceId of req.groupIds) {
    let sourceGroup: SophosEndpointGroup;
    try {
      sourceGroup = await getGroup(src.client, src.tenantId, sourceId);
    } catch (err) {
      results.push({
        sourceId,
        sourceName: "(unknown)",
        ok: false,
        action: "create",
        error: errMsg(err),
      });
      continue;
    }

    if (destNames.has(sourceGroup.name.toLowerCase())) {
      results.push({
        sourceId,
        sourceName: sourceGroup.name,
        ok: true,
        action: "skip-exists",
      });
      continue;
    }
    if (unclearNames.has(sourceGroup.name.toLowerCase())) {
      results.push({ sourceId, sourceName: sourceGroup.name, ok: false, action: "create", error: earlierUnclear() });
      continue;
    }
    // The name is how groups are matched, so it is never changed; one Sophos would refuse is not sent.
    const refusedInName = REFUSED_GROUP_CHARS.filter((c) => sourceGroup.name.includes(c));
    if (refusedInName.length) {
      results.push({
        sourceId,
        sourceName: sourceGroup.name,
        ok: false,
        action: req.dryRun ? "dry-run-create" : "create",
        error: `not sent: Sophos refuses ${charNames(refusedInName)} in endpoint group names through its API, and the tool matches groups by name, so it does not change it: rename the group on the source, then mirror it again`,
      });
      continue;
    }

    if (req.dryRun) {
      destNames.add(sourceGroup.name.toLowerCase());
      results.push({
        sourceId,
        sourceName: sourceGroup.name,
        ok: true,
        action: "dry-run-create",
      });
      continue;
    }

    try {
      // The create API rejects an empty description with 400 "Validation
      // failure" (measured 25/09/2026), and GET returns "" for groups made
      // without one, so only send a description that has text. It refuses
      // some characters too (endpointGroupDescription), which are taken out.
      const name = sourceGroup.name.toLowerCase();
      const { description, changed } = endpointGroupDescription(sourceGroup.description);
      const { value: created, note } = await createChecked(
        () => createGroup(dst.client, dst.tenantId, {
          name: sourceGroup.name,
          ...(description ? { description } : {}),
          type: sourceGroup.type,
          endpointType: sourceGroup.endpointType,
        }),
        async () => (await listGroups(dst.client, dst.tenantId)).find((g) => g.name.toLowerCase() === name),
        "the group",
        { where: "the destination's endpoint groups", found: `no group named "${sourceGroup.name}"` },
      );
      // A second source group with this name ignoring case is then already there.
      destNames.add(name);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "endpoint-group",
        resourceId: created.id,
        ok: true,
        detail: { sourceId, name: sourceGroup.name, ...(note ? { note } : {}) },
      });
      const notes = [...(changed ? [changed] : []), ...(note ? [note] : [])];
      results.push({
        sourceId,
        sourceName: sourceGroup.name,
        destId: created.id,
        ok: true,
        action: "create",
        ...(notes.length ? { notes } : {}),
      });
    } catch (err) {
      const msg = errMsg(err);
      if (isUnclearWrite(err)) unclearNames.add(sourceGroup.name.toLowerCase());
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "endpoint-group",
        ok: false,
        error: msg,
        detail: { sourceId, name: sourceGroup.name },
      });
      results.push({
        sourceId,
        sourceName: sourceGroup.name,
        ok: false,
        action: "create",
        error: msg,
      });
    }
  }

  return results;
}

export interface MirrorUserGroupsRequest {
  userGroupIds: string[];
  dryRun?: boolean;
}

/**
 * Mirrors user groups by name and description, skipping any whose name is
 * already on the destination, and audits each create, as for endpoint groups.
 */
export async function mirrorUserGroups(req: MirrorUserGroupsRequest): Promise<MirrorGroupResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");

  const [sourceGroups, destExisting] = await Promise.all([
    listUserGroups(src.client, src.tenantId),
    listUserGroups(dst.client, dst.tenantId),
  ]);
  const sourceById = new Map(sourceGroups.map((g) => [g.id, g]));
  const destNames = new Set(destExisting.map((g) => g.name.toLowerCase()));
  const unclearNames = new Set<string>();
  const results: MirrorGroupResult[] = [];

  for (const sourceId of req.userGroupIds) {
    const group = sourceById.get(sourceId);
    if (!group) {
      results.push({ sourceId, sourceName: "(unknown)", ok: false, action: "create", error: "source user group not found" });
      continue;
    }
    if (destNames.has(group.name.toLowerCase())) {
      results.push({ sourceId, sourceName: group.name, ok: true, action: "skip-exists" });
      continue;
    }
    if (unclearNames.has(group.name.toLowerCase())) {
      results.push({ sourceId, sourceName: group.name, ok: false, action: "create", error: earlierUnclear() });
      continue;
    }
    if (req.dryRun) {
      destNames.add(group.name.toLowerCase());
      results.push({ sourceId, sourceName: group.name, ok: true, action: "dry-run-create" });
      continue;
    }
    const body = { name: group.name, ...(group.description?.trim() ? { description: group.description } : {}) };
    try {
      const name = group.name.toLowerCase();
      const { value: created, note } = await createChecked(
        () => createUserGroup(dst.client, dst.tenantId, body),
        async () => (await listUserGroups(dst.client, dst.tenantId)).find((g) => g.name.toLowerCase() === name),
        "the user group",
        { where: "the destination's user groups", found: `no user group named "${group.name}"` },
      );
      destNames.add(name);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "user-group",
        resourceId: created.id,
        ok: true,
        detail: { sourceId, name: group.name, ...(note ? { note } : {}) },
      });
      results.push({ sourceId, sourceName: group.name, destId: created.id, ok: true, action: "create", ...(note ? { notes: [note] } : {}) });
    } catch (err) {
      const msg = errMsg(err);
      if (isUnclearWrite(err)) unclearNames.add(group.name.toLowerCase());
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "user-group",
        ok: false,
        error: msg,
        detail: { sourceId, name: group.name },
      });
      results.push({ sourceId, sourceName: group.name, ok: false, action: "create", error: msg });
    }
  }

  return results;
}

/**
 * Characters Sophos refuses in an endpoint group's name and description
 * through its API, with 400 "Validation failure": measured on a live tenant
 * on 13/10/2026, one create per character. User groups take them all.
 */
export const REFUSED_GROUP_CHARS = [",", ";", "#", '"'];

/** "commas, semicolons, #, double quotes", for the ones found. */
function charNames(found: string[]): string {
  const names: Record<string, string> = { ",": "commas", ";": "semicolons", "#": "#", '"': "double quotes" };
  return found.map((c) => names[c] ?? c).join(", ");
}

/**
 * The description to send for an endpoint group: each refused character
 * becomes a space, and spaces are tidied. `changed` is the note for the
 * results list when anything was taken out.
 */
export function endpointGroupDescription(raw: string | undefined): { description: string; changed?: string } {
  const text = (raw ?? "").trim();
  const found = REFUSED_GROUP_CHARS.filter((c) => text.includes(c));
  if (!found.length) return { description: text };
  const description = text.replace(/[,;#"]/g, " ").replace(/\s+/g, " ").trim();
  return {
    description,
    changed: `description changed: Sophos refuses ${charNames(found)} in endpoint group descriptions through its API, so they were replaced with spaces`,
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
