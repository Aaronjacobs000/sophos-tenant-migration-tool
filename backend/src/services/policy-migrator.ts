/**
 * Reads policies from source and creates them on destination.
 * Supports dry-run mode that returns the plan without touching dest.
 *
 * After the policies are written, each one's assignments (`appliesTo`) are
 * added on the destination: every policy created, overwritten or already
 * there, and in a dry run the plan. Targets are matched by name, email or
 * hostname, written in the shape Sophos accepts and read back by ID (see
 * policy-assignments.ts). Mirror the groups first. Anything not matched is
 * listed with the reason; Export assignments (CSV) lists every assignment.
 *
 * A clone goes to the bottom of the destination's priority order, just
 * above the base policy, whatever its priority on the source; an overwrite
 * leaves the destination policy where it is.
 *
 * Web control policies name their web filtering profile by ID. The source
 * tenant's IDs mean nothing on the destination, so the ID is mapped to the
 * destination profile with the same name. When there is none the policy is
 * not written, and the result says which profile to copy first.
 *
 * Linux runtime detection policies name their detection profile by ID and
 * version. The ID is mapped the same way, and the version is set to the
 * destination profile's latest, because each tenant counts its own versions.
 * The tool does not copy these profiles, so when the destination has none of
 * that name the policy is not written, and the result names the profile.
 *
 * An application control list longer than the API accepts is not written
 * either, and the result gives the count (see oversizedAppLists). Nor is a
 * policy whose name matches more than one policy ignoring case (pairPolicy's
 * "ambiguous"): the destination may hold it under another case already.
 */

import { getPolicy, listPolicies, createPolicy, updatePolicy } from "../sophos/api/policies.js";
import { listLocalSites } from "../sophos/api/web-control.js";
import { listProfiles } from "../sophos/api/web-filters.js";
import { listRuntimeDetectionProfiles } from "../sophos/api/runtime-detection.js";
import { requireContext } from "../state.js";
import { auditOrWarn } from "./audit-log.js";
import { createChecked, earlierUnclear, isUnclearWrite } from "./write-check.js";
import { pairPolicy } from "../compare/policy-pairing.js";
import { applyAssignments, planAssignments, tenantDirectory, type AssignmentReport } from "./policy-assignments.js";
import type { SophosPolicy } from "../sophos/types/migration.js";

export interface MigratePoliciesRequest {
  policyIds: string[];
  /** If true, overwrite the destination policy each one pairs with (see pairPolicy). */
  overwrite?: boolean;
  dryRun?: boolean;
}

export interface MigratePolicyResult {
  sourceId: string;
  sourceName: string;
  destId?: string;
  destName?: string;
  ok: boolean;
  action: "create" | "overwrite" | "skip-exists" | "dry-run-create" | "dry-run-overwrite";
  error?: string;
  /**
   * Human-readable notes about settings that had to be changed or dropped to
   * fit the destination tenant (e.g. website tag rules whose tag doesn't
   * exist there, or settings the destination API refused to accept).
   */
  adjustments?: string[];
  /** Notes for the results list, such as a create Sophos answered unclearly but a read-back found. */
  notes?: string[];
  /**
   * The source policy's assignments on the destination: each target set, already
   * there, pending or not matched, with the reason. Absent when it has none.
   */
  assignments?: AssignmentReport;
}

export async function migratePolicies(
  req: MigratePoliciesRequest,
): Promise<MigratePolicyResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");

  // List both tenants' policies once, so each source policy pairs with the
  // destination policy the Policies page and Compare pair it with.
  const [sourceExisting, destExisting] = await Promise.all([
    listPolicies(src.client, src.tenantId),
    listPolicies(dst.client, dst.tenantId),
  ]);
  const destIds = new Set(destExisting.map((p) => p.id));
  // Type and name of each clone that got no clear answer: a second one could be a duplicate.
  const unclearClones = new Set<string>();

  // Website tags available in the destination (from its local-site list),
  // fetched at most once per run. Web-control policies reference these tags by
  // name and the API rejects policies naming tags the tenant doesn't have.
  let destTagsPromise: Promise<Set<string>> | undefined;
  const destWebsiteTags = () =>
    (destTagsPromise ??= (async () => {
      const tags = new Set<string>();
      for (const site of await listLocalSites(dst.client, dst.tenantId)) {
        for (const t of site.tags ?? []) tags.add(t);
      }
      return tags;
    })());

  // Web filtering profiles on both sides, looked up at most once per run and
  // only when a policy refers to one.
  let profileMapPromise: Promise<WebProfileMap> | undefined;
  const webProfiles = () =>
    (profileMapPromise ??= (async () => {
      const [s, d] = await Promise.all([
        listProfiles(src.client, src.tenantId),
        listProfiles(dst.client, dst.tenantId),
      ]);
      return {
        sourceNameById: new Map(s.map((p) => [p.id, p.name])),
        destIdByName: new Map(d.map((p) => [p.name.trim().toLowerCase(), p.id])),
      };
    })());

  // Linux runtime detection profiles on both sides, looked up at most once per
  // run and only when a policy refers to one.
  let runtimeMapPromise: Promise<RuntimeProfileMap> | undefined;
  const runtimeProfiles = () =>
    (runtimeMapPromise ??= (async () => {
      const [s, d] = await Promise.all([
        listRuntimeDetectionProfiles(src.client, src.tenantId),
        listRuntimeDetectionProfiles(dst.client, dst.tenantId),
      ]);
      return {
        sourceNameById: new Map(s.map((p) => [p.id, p.name])),
        destByName: new Map(d.map((p) => [p.name.trim().toLowerCase(), { id: p.id, version: p.version }])),
      };
    })());

  // Read every source policy first so a batch can be written from the top
  // of the source order down: each create asks for the bottom, so a later
  // create lands beneath an earlier one and the batch keeps its source order.
  // Results still come back in request order.
  const fetched: Array<SophosPolicy | Error> = [];
  for (const sourceId of req.policyIds) {
    try {
      fetched.push(await getPolicy(src.client, src.tenantId, sourceId));
    } catch (err) {
      fetched.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  const priorityOf = (p: SophosPolicy | Error) => (p instanceof Error ? 0 : p.priority ?? 0);
  const order = req.policyIds.map((_, i) => i).sort((a, b) => priorityOf(fetched[b]!) - priorityOf(fetched[a]!));

  const results: MigratePolicyResult[] = new Array(req.policyIds.length);

  for (const i of order) {
    const sourceId = req.policyIds[i]!;
    const got = fetched[i]!;
    if (got instanceof Error) {
      results[i] = {
        sourceId,
        sourceName: "(unknown)",
        ok: false,
        action: "create",
        error: got.message,
      };
      continue;
    }
    const sourcePolicy = got;

    const { dest: match, ambiguous } = pairPolicy(sourcePolicy, sourceExisting, destExisting);

    // Several policies share the name ignoring case, so the destination may
    // already hold this policy under another case. A clone would add yet
    // another; nothing is sent.
    if (ambiguous) {
      results[i] = {
        sourceId,
        sourceName: sourcePolicy.name,
        ok: false,
        action: req.dryRun ? "dry-run-create" : "create",
        error: `more than one policy of this type matches "${sourcePolicy.name}" ignoring case, so the tool can't tell which destination policy is its copy and did not clone it: rename them so each name is unique ignoring case, then try again`,
      };
      continue;
    }

    if (match && !req.overwrite) {
      results[i] = {
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match.id,
        destName: match.name,
        ok: true,
        action: "skip-exists",
      };
      continue;
    }

    // A base policy (priority 0) cannot be renamed or turned off, and the API
    // refuses the whole update when name or enabled is in the body ("Cannot
    // update the enabled of a base policy", measured 25/09/2026). Overwriting
    // one sends its settings only.
    const overwritingBase = match?.priority === 0;
    const body: Partial<SophosPolicy> = {
      ...(overwritingBase ? {} : { name: sourcePolicy.name }),
      type: sourcePolicy.type,
      ...(overwritingBase ? {} : { enabled: sourcePolicy.enabled }),
      ...(match ? {} : { priority: BOTTOM_PRIORITY }),
      enforced: sourcePolicy.enforced,
      settings: sanitizeSettings(sourcePolicy.settings),
    };

    // Notes about anything we had to change to make the policy writable on
    // the destination, surfaced in the result so nothing is silently lost.
    const adjustments: string[] = [];

    // Web-control policies reference Website Management tags by name inside
    // endpoint.web-control.tags.settings. A tag the destination doesn't have
    // makes the whole create fail (an opaque 500), so keep only the rules
    // whose tag exists there and report every dropped rule.
    const tagsSetting = body.settings?.[WEB_TAGS_SETTING] as
      | { value?: Array<{ tag?: string; action?: string }> }
      | undefined;
    if (Array.isArray(tagsSetting?.value) && tagsSetting.value.length) {
      try {
        const available = await destWebsiteTags();
        const dropped = tagsSetting.value.filter((rule) => !available.has(rule?.tag ?? ""));
        if (dropped.length) {
          tagsSetting.value = tagsSetting.value.filter((rule) => available.has(rule?.tag ?? ""));
          for (const rule of dropped) {
            adjustments.push(
              `dropped website tag rule "${rule?.tag}": that tag doesn't exist in the destination tenant (create its Website Management entries first, then re-migrate)`,
            );
          }
        }
      } catch {
        // Tag lookup is best-effort; if it fails we attempt the write as-is.
      }
    }

    const unwritable =
      oversizedAppLists(body.settings) ??
      (await remapWebProfiles(body.settings, webProfiles, adjustments)) ??
      (await remapRuntimeProfiles(body.settings, runtimeProfiles, adjustments));
    if (unwritable) {
      // Nothing is sent: the destination would refuse the policy.
      results[i] = {
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match?.id,
        destName: match?.name,
        ok: false,
        action: req.dryRun ? (match ? "dry-run-overwrite" : "dry-run-create") : match ? "overwrite" : "create",
        error: unwritable,
        adjustments: adjustments.length ? adjustments : undefined,
      };
      continue;
    }

    if (!match && unclearClones.has(`${sourcePolicy.type}:${sourcePolicy.name}`)) {
      results[i] = { sourceId, sourceName: sourcePolicy.name, ok: false, action: req.dryRun ? "dry-run-create" : "create", error: earlierUnclear() };
      continue;
    }

    if (req.dryRun) {
      results[i] = {
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match?.id,
        destName: match?.name,
        ok: true,
        action: match ? "dry-run-overwrite" : "dry-run-create",
        adjustments: adjustments.length ? adjustments : undefined,
      };
      continue;
    }

    try {
      let result: SophosPolicy;
      let note: string | undefined;
      // The write API rejects some settings the GET happily returns. When the
      // error names the offending settings ("… for setting (X)"), drop just
      // those settings and retry so they don't sink the policy. One error can
      // name many settings (ten web control file types that read back as
      // "inherit", measured 25/09/2026), so every named setting is dropped at
      // once. Every drop is recorded in `adjustments`. Only a clear refusal is
      // sent again: after an unclear answer the policy may have been written.
      // A create Sophos answered unclearly is read back by name (write-check.ts).
      for (let attempt = 0; ; attempt++) {
        try {
          if (match) {
            result = await updatePolicy(dst.client, dst.tenantId, match.id, body);
          } else {
            ({ value: result, note } = await createChecked(
              () => createPolicy(dst.client, dst.tenantId, body),
              async () => (await listPolicies(dst.client, dst.tenantId))
                .find((p) => p.type === body.type && p.name === body.name && !destIds.has(p.id)),
              "the policy",
              { where: "the destination's policies", found: `no new ${body.type} policy named "${body.name}"` },
            ));
          }
          // A later read-back in this run must not take this clone for its own.
          if (!match && result.id) destIds.add(result.id);
          break;
        } catch (err) {
          const msg = errMsg(err);
          const named = isUnclearWrite(err) ? [] : rejectedSettings(msg).filter(
            ({ key }) => body.settings !== undefined && key in body.settings,
          );
          if (attempt < MAX_SETTING_RETRIES && named.length > 0) {
            for (const { key, reason } of named) {
              delete body.settings![key];
              adjustments.push(`dropped setting ${key}: destination rejected it (${reason})`);
            }
            continue;
          }
          throw err;
        }
      }
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: match ? "update" : "create",
        resource: "policy",
        resourceId: match?.id ?? result.id,
        ok: true,
        detail: {
          sourceId,
          name: sourcePolicy.name,
          type: sourcePolicy.type,
          ...(adjustments.length ? { adjustments } : {}),
          ...(note ? { note } : {}),
        },
      });
      results[i] = {
        sourceId,
        sourceName: sourcePolicy.name,
        destId: result.id,
        destName: result.name,
        ok: true,
        action: match ? "overwrite" : "create",
        adjustments: adjustments.length ? adjustments : undefined,
        ...(note ? { notes: [note] } : {}),
      };
    } catch (err) {
      const msg = errMsg(err);
      if (!match && isUnclearWrite(err)) unclearClones.add(`${sourcePolicy.type}:${sourcePolicy.name}`);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: match ? "update" : "create",
        resource: "policy",
        resourceId: match?.id,
        ok: false,
        error: msg,
        detail: {
          sourceId,
          name: sourcePolicy.name,
          type: sourcePolicy.type,
          ...(adjustments.length ? { adjustments } : {}),
        },
      });
      results[i] = {
        sourceId,
        sourceName: sourcePolicy.name,
        destId: match?.id,
        destName: match?.name,
        ok: false,
        action: match ? "overwrite" : "create",
        error: msg,
        adjustments: adjustments.length ? adjustments : undefined,
      };
    }
  }

  // Assignments go on once the policies are written, in the same order. A
  // policy that was not written, or could not be, gets none.
  const srcDir = tenantDirectory(src);
  const dstDir = tenantDirectory(dst);
  for (const i of order) {
    const r = results[i]!;
    const sourcePolicy = fetched[i]!;
    if (!r.ok || sourcePolicy instanceof Error) continue;
    const plan = await planAssignments(sourcePolicy.appliesTo, srcDir, dstDir);
    if (!plan) continue;
    r.assignments = await applyAssignments(dst, r.destId, plan, {
      dryRun: req.dryRun === true,
      sourceId: r.sourceId,
      name: r.destName ?? r.sourceName,
    });
  }

  return results;
}

export interface WebProfileMap {
  sourceNameById: Map<string, string>;
  destIdByName: Map<string, string>;
}

export const WEB_PROFILE_ID_SUFFIX = ".web-profile-id";
export const WEB_PROFILE_SCHEDULES_SUFFIX = ".web-profile-schedules";

/**
 * Point a policy's web profile at the destination. The profile ID setting
 * (endpoint.web-control.web-profile-id) is mapped by profile name. Any source
 * profile ID inside the schedules setting is mapped the same way. A schedule
 * profile with no destination counterpart drops the schedule, and every
 * change is added to adjustments.
 *
 * A profile ID with no destination counterpart returns the reason the policy
 * can't be written: the destination refuses a web control policy that filters
 * by web profile without a valid profile ID ("Invalid Web Profile Id",
 * measured 26/09/2026), and every policy with a profile ID filters by one.
 */
export async function remapWebProfiles(
  settings: Record<string, unknown> | undefined,
  loadMap: () => Promise<WebProfileMap>,
  adjustments: string[],
): Promise<string | undefined> {
  if (!settings) return;
  const idKeys = Object.keys(settings).filter((k) => {
    const v = (settings[k] as { value?: unknown } | undefined)?.value;
    return k.endsWith(WEB_PROFILE_ID_SUFFIX) && typeof v === "string" && v.length > 0;
  });
  const scheduleKeys = Object.keys(settings).filter((k) => {
    if (!k.endsWith(WEB_PROFILE_SCHEDULES_SUFFIX)) return false;
    const v = (settings[k] as { value?: unknown } | undefined)?.value;
    return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== "";
  });
  if (idKeys.length === 0 && scheduleKeys.length === 0) return;

  let map: WebProfileMap;
  try {
    map = await loadMap();
  } catch (err) {
    adjustments.push(`could not look up web filtering profiles, so the web profile ID was sent unchanged (${errMsg(err)})`);
    return;
  }
  const destIdFor = (sourceId: string) => {
    const name = map.sourceNameById.get(sourceId);
    return { name, destId: name ? map.destIdByName.get(name.trim().toLowerCase()) : undefined };
  };

  for (const key of idKeys) {
    const setting = settings[key] as { value: string };
    const { name, destId } = destIdFor(setting.value);
    if (!destId) {
      return name
        ? `web profile "${name}" is not on the destination: copy it on the Web filtering page first, then clone again`
        : `web profile ${setting.value} was not found on the source, so there is no destination profile to point the policy at`;
    }
    settings[key] = { ...setting, value: destId };
    adjustments.push(`mapped web profile "${name}" to the destination profile with the same name`);
  }

  for (const key of scheduleKeys) {
    const missing: string[] = [];
    let changed = false;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string" && map.sourceNameById.has(v)) {
        const { name, destId } = destIdFor(v);
        if (destId) {
          changed = changed || destId !== v;
          return destId;
        }
        missing.push(name ?? v);
        return v;
      }
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, inner]) => [k, walk(inner)]));
      }
      return v;
    };
    const next = walk(settings[key]);
    if (missing.length) {
      delete settings[key];
      adjustments.push(`dropped the web profile schedule: ${missing.map((n) => `"${n}"`).join(", ")} ${missing.length === 1 ? "is" : "are"} not on the destination`);
    } else if (changed) {
      settings[key] = next;
      adjustments.push("mapped the profiles in the web profile schedule to the destination");
    }
  }
}

export interface RuntimeProfileMap {
  sourceNameById: Map<string, string>;
  destByName: Map<string, { id: string; version: number }>;
}

export const RUNTIME_PROFILE_ID_SUFFIX = "runtime-detection.profile-id";
export const RUNTIME_PROFILE_VERSION_SUFFIX = "runtime-detection.profile-version";

/** The version setting that goes with a runtime detection profile ID setting. */
export const runtimeVersionKey = (idKey: string) =>
  idKey.slice(0, -RUNTIME_PROFILE_ID_SUFFIX.length) + RUNTIME_PROFILE_VERSION_SUFFIX;

/**
 * Point a Linux runtime detection policy at the destination profile with the
 * same name, at that profile's latest version. Each tenant counts its own
 * versions, and the API takes a missing version as 1, not the latest, and
 * refuses a version the profile doesn't have (all measured 26/09/2026).
 *
 * A profile ID with no destination counterpart returns the reason the policy
 * can't be written: the destination refuses the source's profile ID ("Error
 * processing data"), and a blank one while detection is on ("Bad request",
 * both measured 26/09/2026). The tool does not copy these profiles.
 */
export async function remapRuntimeProfiles(
  settings: Record<string, unknown> | undefined,
  loadMap: () => Promise<RuntimeProfileMap>,
  adjustments: string[],
): Promise<string | undefined> {
  if (!settings) return;
  const idKeys = Object.keys(settings).filter((k) => {
    const v = (settings[k] as { value?: unknown } | undefined)?.value;
    return k.endsWith(RUNTIME_PROFILE_ID_SUFFIX) && typeof v === "string" && v.length > 0;
  });
  if (idKeys.length === 0) return;

  let map: RuntimeProfileMap;
  try {
    map = await loadMap();
  } catch (err) {
    adjustments.push(`could not look up Linux runtime detection profiles, so the profile ID was sent unchanged (${errMsg(err)})`);
    return;
  }

  for (const key of idKeys) {
    const setting = settings[key] as { value: string };
    const name = map.sourceNameById.get(setting.value);
    const dest = name ? map.destByName.get(name.trim().toLowerCase()) : undefined;
    if (!dest) {
      return name
        ? `Linux runtime detection profile "${name}" is not on the destination: create a profile with that name there first, then clone again`
        : `Linux runtime detection profile ${setting.value} was not found on the source, so there is no destination profile to point the policy at`;
    }
    settings[key] = { ...setting, value: dest.id };
    const versionKey = runtimeVersionKey(key);
    settings[versionKey] = { ...(settings[versionKey] as object | undefined), value: dest.version };
    adjustments.push(`mapped Linux runtime detection profile "${name}" to the destination profile with the same name, at its latest version (${dest.version})`);
  }
}

/**
 * Sophos refuses a policy write that lists more than 1000 applications in an
 * application control list, with a bare 400 "BadRequest". Measured 26/09/2026
 * on create, PATCH and the settings PATCH alike: 1000 is accepted and 1001 is
 * not, whatever the size of the body, and each list counts on its own. Every
 * write replaces the whole list, so the rest can't be added in batches.
 */
export const APP_LIST_LIMIT = 1000;
const APP_LIST_SETTINGS: Record<string, string> = {
  "endpoint.application-control.controlled-applications": "controlled applications",
  "endpoint.application-control.allowed-applications": "allowed applications",
};

/** Why the policy can't be written, when an application list is over the limit. */
export function oversizedAppLists(settings: Record<string, unknown> | undefined): string | undefined {
  if (!settings) return;
  const over = Object.entries(APP_LIST_SETTINGS).flatMap(([key, label]) => {
    const v = (settings[key] as { value?: unknown } | undefined)?.value;
    return Array.isArray(v) && v.length > APP_LIST_LIMIT ? [`${v.length} ${label}`] : [];
  });
  if (!over.length) return;
  return `the policy lists ${over.join(" and ")}, and Sophos accepts at most ${APP_LIST_LIMIT} per list through its API, so it was not sent: cut the list to ${APP_LIST_LIMIT} or fewer on the source and clone again, or build this policy on the destination in Sophos Fusion`;
}

/**
 * Priorities count up from the base policy (0), and a larger number wins:
 * a policy created without one gets the next number up, which the API docs
 * call the highest priority. Asking for 1 puts the new policy at the bottom,
 * just above the base policy, and the API moves the existing policies of
 * that type up by one, keeping their order. Both measured on a live tenant
 * on 24/09/2026; deleting the clone moves them back down. For some types
 * Sophos also stamps a new updatedAt on each policy it moves, though nothing
 * else changes: peripheral control does, application control does not
 * (measured with direct API calls on 27/09/2026). That is Sophos's doing;
 * the clone sends one POST.
 */
const BOTTOM_PRIORITY = 1;

/** Setting key holding a web-control policy's Website Management tag rules. */
const WEB_TAGS_SETTING = "endpoint.web-control.tags.settings";

/** Max drop-and-retry attempts when the destination rejects named settings. */
const MAX_SETTING_RETRIES = 5;

/**
 * The settings a write error names, each with the sentence that names it,
 * e.g. "Must provide an allowed value for setting (X)". Each key once.
 */
export function rejectedSettings(message: string): Array<{ key: string; reason: string }> {
  const out: Array<{ key: string; reason: string }> = [];
  for (const m of message.matchAll(/([^.()]*for setting \(([^)]+)\))/g)) {
    const key = m[2]!;
    if (out.some((x) => x.key === key)) continue;
    out.push({ key, reason: m[1]!.replace(/^.*? - /, "").trim() });
  }
  return out;
}

/**
 * The policy GET shape is not write-safe verbatim: settings may carry a
 * read-only `unit` field that create/update rejects ("Must not provide a
 * unit for setting …"). Strip it, keeping everything else intact.
 */
function sanitizeSettings(
  settings: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!settings) return settings;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(settings)) {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const { unit: _unit, ...rest } = raw as Record<string, unknown>;
      out[key] = rest;
    } else {
      out[key] = raw;
    }
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
