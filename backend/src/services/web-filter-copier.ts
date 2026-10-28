/**
 * Copies web filtering site lists and profiles from source to destination.
 *
 * Order matters: site lists first, then profiles, because a profile's
 * siteListActions refer to site lists by ID. Each list ID is mapped to the
 * destination list with the same name, including lists created earlier in
 * the same run. A rule whose list has no destination counterpart is dropped
 * and reported. Profile consumers (the policies using a profile) are not
 * copied; cloning a web control policy maps its web profile ID instead.
 *
 * Names are matched without regard to case. Supports dry run, and every
 * write is audited.
 *
 * From the web filtering guide (14/10/2026):
 *   - A tenant holds at most 20 site lists, and a list at most 750 sites. A
 *     copy that would pass either limit is not sent, and the result says so.
 *   - Preset, category and category group names can differ between tenants.
 *     A profile is checked against the destination's names
 *     (GET /web-filters/v1/profiles/metadata) and not sent with a name the
 *     destination doesn't have.
 *   - A list or profile with the same name but different content shows as
 *     "differs", with what differs. With overwrite, it is replaced with the
 *     source version by PUT, keeping the destination's name.
 */

import { requireContext } from "../state.js";
import { auditOrWarn } from "./audit-log.js";
import { createChecked, earlierUnclear, foundNote, isUnclearWrite, notFound, readBack } from "./write-check.js";
import {
  listSiteLists,
  listSites,
  createSiteList,
  updateSiteList,
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  getProfileMetadata,
  MAX_SITE_LISTS,
  MAX_SITES_PER_LIST,
  type SophosSiteList,
  type SophosWebProfile,
  type WebProfileMetadata,
} from "../sophos/api/web-filters.js";

export interface CopyWebFiltersRequest {
  siteListIds?: string[];
  profileIds?: string[];
  dryRun?: boolean;
  /** Replace a same-name destination list or profile whose content differs. */
  overwrite?: boolean;
}

export interface WebFilterCopyResult {
  kind: "site-list" | "profile";
  sourceId: string;
  sourceName: string;
  destId?: string;
  ok: boolean;
  action: "create" | "skip-exists" | "dry-run-create" | "differs" | "overwrite" | "dry-run-overwrite";
  error?: string;
  /** For a same-name item whose content differs: what differs. */
  differences?: string[];
  /** Rules changed or dropped to fit the destination. */
  adjustments?: string[];
  /** Extra detail for the results list, such as the number of sites. */
  note?: string;
  /** Notes for the results list, such as a create Sophos answered unclearly but a read-back found. */
  notes?: string[];
}

const nameKey = (name: string | undefined) => String(name ?? "").trim().toLowerCase();

export async function copyWebFilters(req: CopyWebFiltersRequest): Promise<WebFilterCopyResult[]> {
  const src = requireContext("source");
  const dst = requireContext("dest");
  const siteListIds = req.siteListIds ?? [];
  const profileIds = req.profileIds ?? [];
  const dryRun = req.dryRun === true;
  const results: WebFilterCopyResult[] = [];

  const [srcLists, dstLists] = await Promise.all([
    listSiteLists(src.client, src.tenantId),
    listSiteLists(dst.client, dst.tenantId),
  ]);
  const srcListById = new Map(srcLists.map((l) => [l.id, l]));
  const dstListByName = new Map(dstLists.map((l) => [nameKey(l.name), l]));
  // Source list ID -> destination list ID, or "planned" for a list a dry run would create.
  const listMap = new Map<string, string>();
  for (const l of srcLists) {
    const match = dstListByName.get(nameKey(l.name));
    if (match) listMap.set(l.id, match.id);
  }

  // Names whose create got no clear answer: a second one could be a duplicate.
  const unclearNames = new Set<string>();
  // Destination items this run made (or, in a dry run, would make): nothing to compare.
  const madeHere = new Set<string>(["planned"]);
  let dstListCount = dstLists.length;

  /**
   * A source list whose name is already on the destination: already there
   * when the content matches, differs when it doesn't, and with overwrite,
   * replaced with the source version.
   */
  async function sameNameList(list: SophosSiteList, existing: SophosSiteList): Promise<WebFilterCopyResult> {
    const base = { kind: "site-list" as const, sourceId: list.id, sourceName: list.name, destId: existing.id };
    let sites: string[];
    let destSites: string[];
    try {
      [sites, destSites] = await Promise.all([
        listSites(src.client, src.tenantId, list.id).then((l) => l.map((x) => x.site).filter(Boolean)),
        listSites(dst.client, dst.tenantId, existing.id).then((l) => l.map((x) => x.site).filter(Boolean)),
      ]);
    } catch (err) {
      return { ...base, ok: true, action: "skip-exists", notes: [`the content could not be compared: ${errMsg(err)}`] };
    }
    const differences = siteListDifferences(sites, list.description, destSites, existing.description);
    if (!differences.length) return { ...base, ok: true, action: "skip-exists" };
    if (!req.overwrite) return { ...base, ok: true, action: "differs", differences };
    if (!sites.length) return { ...base, ok: false, action: "overwrite", differences, error: "the source list has no sites, and the API needs at least one" };
    if (sites.length > MAX_SITES_PER_LIST) return { ...base, ok: false, action: "overwrite", differences, error: tooManySites(sites.length) };
    const note = `${sites.length} site${sites.length === 1 ? "" : "s"}`;
    if (dryRun) return { ...base, ok: true, action: "dry-run-overwrite", differences, note };
    // PUT replaces the list. The destination keeps its own name.
    const body = { name: existing.name, sites, ...(list.description ? { description: list.description } : {}) };
    const detail = { sourceId: list.id, name: existing.name, siteCount: sites.length, differences };
    try {
      let checked: string | undefined;
      try {
        await updateSiteList(dst.client, dst.tenantId, existing.id, body);
      } catch (err) {
        if (!isUnclearWrite(err)) throw err;
        const back = await readBack(async () => {
          const now = (await listSites(dst.client, dst.tenantId, existing.id)).map((x) => x.site);
          return siteListDifferences(sites, list.description, now, list.description).length ? undefined : true;
        });
        if (!back.value) throw notFound(err, { where: `the destination's site list "${existing.name}"`, found: "the old sites still there", advice: "Wait a minute, then preview again: a list that matches by then shows as already there." }, back.unread);
        checked = foundNote(err, "the new sites", "on the destination");
      }
      await auditOrWarn({ side: "dest", tenantId: dst.tenantId, action: "update", resource: "web-filter-site-list", resourceId: existing.id, ok: true, detail: { ...detail, ...(checked ? { note: checked } : {}) } });
      return { ...base, ok: true, action: "overwrite", differences, note, ...(checked ? { notes: [checked] } : {}) };
    } catch (err) {
      const msg = errMsg(err);
      await auditOrWarn({ side: "dest", tenantId: dst.tenantId, action: "update", resource: "web-filter-site-list", resourceId: existing.id, ok: false, error: msg, detail });
      return { ...base, ok: false, action: "overwrite", differences, error: msg };
    }
  }

  /** The same for a profile: compared after mapping its site lists to the destination. */
  async function sameNameProfile(summary: SophosWebProfile, existing: SophosWebProfile): Promise<WebFilterCopyResult> {
    const base = { kind: "profile" as const, sourceId: summary.id, sourceName: summary.name, destId: existing.id };
    let profile: SophosWebProfile;
    let dest: SophosWebProfile;
    try {
      [profile, dest] = await Promise.all([getProfile(src.client, src.tenantId, summary.id), getProfile(dst.client, dst.tenantId, existing.id)]);
    } catch (err) {
      return { ...base, ok: true, action: "skip-exists", notes: [`the content could not be compared: ${errMsg(err)}`] };
    }
    const { body, adjustments } = profileBody(profile, srcListById, listMap);
    const differences = profileDifferences(body, dest);
    if (!differences.length) return { ...base, ok: true, action: "skip-exists" };
    const adj = adjustments.length ? { adjustments } : {};
    if (!req.overwrite) return { ...base, ok: true, action: "differs", differences, ...adj };
    const named = await checkNames(body);
    if (named.note) adjustments.push(named.note);
    if (named.error) return { ...base, ok: false, action: "overwrite", differences, error: named.error, ...(adjustments.length ? { adjustments } : {}) };
    if (dryRun) return { ...base, ok: true, action: "dry-run-overwrite", differences, ...(adjustments.length ? { adjustments } : {}) };
    const put = { ...body, name: dest.name };
    const detail = { sourceId: summary.id, name: dest.name, differences, ...(adjustments.length ? { adjustments } : {}) };
    try {
      let checked: string | undefined;
      try {
        await updateProfile(dst.client, dst.tenantId, existing.id, put);
      } catch (err) {
        if (!isUnclearWrite(err)) throw err;
        const back = await readBack(async () => (profileDifferences(put, await getProfile(dst.client, dst.tenantId, existing.id)).length ? undefined : true));
        if (!back.value) throw notFound(err, { where: `the destination's profile "${dest.name}"`, found: "its old settings still there", advice: "Wait a minute, then preview again: a profile that matches by then shows as already there." }, back.unread);
        checked = foundNote(err, "the new settings", "on the destination");
      }
      await auditOrWarn({ side: "dest", tenantId: dst.tenantId, action: "update", resource: "web-filter-profile", resourceId: existing.id, ok: true, detail: { ...detail, ...(checked ? { note: checked } : {}) } });
      return { ...base, ok: true, action: "overwrite", differences, ...(adjustments.length ? { adjustments } : {}), ...(checked ? { notes: [checked] } : {}) };
    } catch (err) {
      const msg = errMsg(err);
      await auditOrWarn({ side: "dest", tenantId: dst.tenantId, action: "update", resource: "web-filter-profile", resourceId: existing.id, ok: false, error: msg, detail });
      return { ...base, ok: false, action: "overwrite", differences, error: msg, ...(adjustments.length ? { adjustments } : {}) };
    }
  }

  // ---- site lists ----
  for (const id of siteListIds) {
    const list = srcListById.get(id);
    if (!list) {
      results.push({ kind: "site-list", sourceId: id, sourceName: "(unknown)", ok: false, action: "create", error: "source site list not found" });
      continue;
    }
    const existing = dstListByName.get(nameKey(list.name));
    if (existing) {
      results.push(madeHere.has(existing.id)
        ? { kind: "site-list", sourceId: id, sourceName: list.name, destId: existing.id, ok: true, action: "skip-exists" }
        : await sameNameList(list, existing));
      continue;
    }
    if (unclearNames.has(`list:${nameKey(list.name)}`)) {
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, ok: false, action: "create", error: earlierUnclear() });
      continue;
    }
    let sites: string[];
    try {
      sites = (await listSites(src.client, src.tenantId, id)).map((s) => s.site).filter(Boolean);
    } catch (err) {
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, ok: false, action: "create", error: `could not read the source sites: ${errMsg(err)}` });
      continue;
    }
    if (sites.length === 0) {
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, ok: false, action: "create", error: "the list has no sites, and the API needs at least one" });
      continue;
    }
    if (sites.length > MAX_SITES_PER_LIST) {
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, ok: false, action: "create", error: tooManySites(sites.length) });
      continue;
    }
    if (dstListCount >= MAX_SITE_LISTS) {
      results.push({
        kind: "site-list", sourceId: id, sourceName: list.name, ok: false, action: "create",
        error: `not sent: the destination ${dryRun && dstListCount > dstLists.length ? "would then have" : "has"} ${dstListCount} site lists, and Sophos allows at most ${MAX_SITE_LISTS} in a tenant`,
      });
      continue;
    }
    dstListCount++;
    const body = { name: list.name, sites, ...(list.description ? { description: list.description } : {}) };
    if (dryRun) {
      listMap.set(id, "planned");
      dstListByName.set(nameKey(list.name), { id: "planned", name: list.name });
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, ok: true, action: "dry-run-create", note: `${sites.length} site${sites.length === 1 ? "" : "s"}` });
      continue;
    }
    try {
      const { value: created, note: checked } = await createChecked(
        () => createSiteList(dst.client, dst.tenantId, body),
        async () => (await listSiteLists(dst.client, dst.tenantId)).find((l) => nameKey(l.name) === nameKey(list.name)),
        "the site list",
        { where: "the destination's site lists", found: `no site list named "${list.name}"` },
      );
      listMap.set(id, created.id);
      dstListByName.set(nameKey(list.name), created);
      madeHere.add(created.id);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "web-filter-site-list",
        resourceId: created.id,
        ok: true,
        detail: { sourceId: id, name: list.name, siteCount: sites.length, ...(checked ? { note: checked } : {}) },
      });
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, destId: created.id, ok: true, action: "create", note: `${sites.length} site${sites.length === 1 ? "" : "s"}`, ...(checked ? { notes: [checked] } : {}) });
    } catch (err) {
      const msg = errMsg(err);
      if (isUnclearWrite(err)) unclearNames.add(`list:${nameKey(list.name)}`);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "web-filter-site-list",
        ok: false,
        error: msg,
        detail: { sourceId: id, name: list.name, siteCount: sites.length },
      });
      results.push({ kind: "site-list", sourceId: id, sourceName: list.name, ok: false, action: "create", error: msg });
    }
  }

  if (profileIds.length === 0) return results;

  // ---- profiles ----
  const [srcProfiles, dstProfiles] = await Promise.all([
    listProfiles(src.client, src.tenantId),
    listProfiles(dst.client, dst.tenantId),
  ]);
  const srcProfileById = new Map(srcProfiles.map((p) => [p.id, p]));
  const dstProfileByName = new Map(dstProfiles.map((p) => [nameKey(p.name), p]));
  // The destination's preset and category names, read once, when a profile is about to be sent.
  let metadata: WebProfileMetadata | null | undefined;
  let metadataError = "";
  const destNames = async (): Promise<WebProfileMetadata | null> => {
    if (metadata === undefined) {
      try {
        metadata = await getProfileMetadata(dst.client, dst.tenantId);
        if (!Array.isArray(metadata.categories)) {
          metadata = null;
          metadataError = "the answer listed no categories";
        }
      } catch (err) {
        metadata = null;
        metadataError = errMsg(err);
      }
    }
    return metadata;
  };
  /** Why a profile body can't go to the destination, or a note when the names could not be checked. */
  const checkNames = async (body: ProfileBody): Promise<{ error?: string; note?: string }> => {
    const names = await destNames();
    if (!names) return { note: `the destination's category names could not be read, so they were not checked (${metadataError.replace(/\.$/, "")})` };
    const unknown = unknownNames(body, names);
    return unknown.length
      ? { error: `not sent: the destination has no ${unknown.join(", ")}. Names can differ between tenants; change the profile on the source, or set it up on the destination by hand` }
      : {};
  };

  for (const id of profileIds) {
    const summary = srcProfileById.get(id);
    if (!summary) {
      results.push({ kind: "profile", sourceId: id, sourceName: "(unknown)", ok: false, action: "create", error: "source profile not found" });
      continue;
    }
    const existing = dstProfileByName.get(nameKey(summary.name));
    if (existing) {
      results.push(madeHere.has(existing.id)
        ? { kind: "profile", sourceId: id, sourceName: summary.name, destId: existing.id, ok: true, action: "skip-exists" }
        : await sameNameProfile(summary, existing));
      continue;
    }
    if (unclearNames.has(`profile:${nameKey(summary.name)}`)) {
      results.push({ kind: "profile", sourceId: id, sourceName: summary.name, ok: false, action: "create", error: earlierUnclear() });
      continue;
    }
    let profile: SophosWebProfile;
    try {
      profile = await getProfile(src.client, src.tenantId, id);
    } catch (err) {
      results.push({ kind: "profile", sourceId: id, sourceName: summary.name, ok: false, action: "create", error: `could not read the source profile: ${errMsg(err)}` });
      continue;
    }
    const { body, adjustments } = profileBody(profile, srcListById, listMap);
    const named = await checkNames(body);
    if (named.note) adjustments.push(named.note);
    if (named.error) {
      results.push({ kind: "profile", sourceId: id, sourceName: profile.name, ok: false, action: "create", error: named.error, ...(adjustments.length ? { adjustments } : {}) });
      continue;
    }
    if (dryRun) {
      dstProfileByName.set(nameKey(profile.name), { id: "planned", name: profile.name });
      results.push({ kind: "profile", sourceId: id, sourceName: profile.name, ok: true, action: "dry-run-create", ...(adjustments.length ? { adjustments } : {}) });
      continue;
    }
    try {
      const { value: created, note: checked } = await createChecked(
        () => createProfile(dst.client, dst.tenantId, body),
        async () => (await listProfiles(dst.client, dst.tenantId)).find((p) => nameKey(p.name) === nameKey(profile.name)),
        "the profile",
        { where: "the destination's web filtering profiles", found: `no profile named "${profile.name}"` },
      );
      dstProfileByName.set(nameKey(profile.name), created);
      madeHere.add(created.id);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "web-filter-profile",
        resourceId: created.id,
        ok: true,
        detail: { sourceId: id, name: profile.name, ...(adjustments.length ? { adjustments } : {}), ...(checked ? { note: checked } : {}) },
      });
      results.push({ kind: "profile", sourceId: id, sourceName: profile.name, destId: created.id, ok: true, action: "create", ...(adjustments.length ? { adjustments } : {}), ...(checked ? { notes: [checked] } : {}) });
    } catch (err) {
      const msg = errMsg(err);
      if (isUnclearWrite(err)) unclearNames.add(`profile:${nameKey(profile.name)}`);
      await auditOrWarn({
        side: "dest",
        tenantId: dst.tenantId,
        action: "create",
        resource: "web-filter-profile",
        ok: false,
        error: msg,
        detail: { sourceId: id, name: profile.name, ...(adjustments.length ? { adjustments } : {}) },
      });
      results.push({ kind: "profile", sourceId: id, sourceName: profile.name, ok: false, action: "create", error: msg, ...(adjustments.length ? { adjustments } : {}) });
    }
  }

  return results;
}

/**
 * The create body for a profile on the destination: every filtering field,
 * site list IDs mapped to the destination, consumers left out.
 */
export function profileBody(
  profile: SophosWebProfile,
  srcListById: Map<string, SophosSiteList>,
  listMap: Map<string, string>,
): { body: Omit<SophosWebProfile, "id" | "updatedAt" | "consumers">; adjustments: string[] } {
  const adjustments: string[] = [];
  const body: Omit<SophosWebProfile, "id" | "updatedAt" | "consumers"> = { name: profile.name };
  if (profile.description) body.description = profile.description;
  if (profile.filterByCategory !== undefined) body.filterByCategory = profile.filterByCategory;
  if (profile.preset) body.preset = profile.preset;
  if (profile.categoryGroupActions?.length) body.categoryGroupActions = profile.categoryGroupActions;
  if (profile.categoryActions?.length) body.categoryActions = profile.categoryActions;
  if (profile.filterBySiteList !== undefined) body.filterBySiteList = profile.filterBySiteList;

  if (profile.siteListActions?.length) {
    const mapped: NonNullable<SophosWebProfile["siteListActions"]> = [];
    for (const rule of profile.siteListActions) {
      const listName = srcListById.get(rule.id)?.name ?? rule.id;
      const destId = listMap.get(rule.id);
      if (!destId) {
        adjustments.push(`dropped the "${rule.action}" rule for site list "${listName}": that list is not on the destination (copy the site list first)`);
        continue;
      }
      if (destId === "planned") {
        adjustments.push(`site list "${listName}" would map to the copy made in this run`);
        mapped.push({ ...rule });
        continue;
      }
      mapped.push({ ...rule, id: destId });
    }
    if (mapped.length) body.siteListActions = mapped;
  }
  if (profile.consumers?.length) {
    adjustments.push(`${profile.consumers.length} linked polic${profile.consumers.length === 1 ? "y is" : "ies are"} not copied; cloning a web control policy links it to this profile by name`);
  }
  return { body, adjustments };
}

type ProfileBody = Omit<SophosWebProfile, "id" | "updatedAt" | "consumers">;

function tooManySites(n: number): string {
  return `not sent: the list has ${n} sites, and Sophos allows at most ${MAX_SITES_PER_LIST} in a list`;
}

const siteKey = (site: string) => site.trim().toLowerCase();

/** What differs between a source site list and the destination's: its sites (in any order, any case) and its description. */
export function siteListDifferences(sites: string[], description: string | undefined, destSites: string[], destDescription: string | undefined): string[] {
  const a = new Set(sites.map(siteKey));
  const b = new Set(destSites.map(siteKey));
  const onlySource = [...a].filter((x) => !b.has(x)).length;
  const onlyDest = [...b].filter((x) => !a.has(x)).length;
  const out: string[] = [];
  if (onlySource || onlyDest) {
    out.push(`sites: ${onlySource} only on the source, ${onlyDest} only on the destination`);
  }
  if ((description ?? "").trim() !== (destDescription ?? "").trim()) out.push("description");
  return out;
}

/** What differs between the profile the copy would send and the destination's, field by field. */
export function profileDifferences(body: ProfileBody, dest: SophosWebProfile): string[] {
  const actions = (list?: Array<{ name: string; action: string }>) => (list ?? []).map((x) => `${x.name.toLowerCase()}=${x.action}`).sort().join(",");
  const rules = (list?: SophosWebProfile["siteListActions"]) => (list ?? []).map((x) => `${x.id}:${x.action}:${x.priority}`).sort().join(",");
  const out: string[] = [];
  if ((body.description ?? "").trim() !== (dest.description ?? "").trim()) out.push("description");
  if (!!body.filterByCategory !== !!dest.filterByCategory) out.push("filter by category");
  if ((body.preset ?? "") !== (dest.preset ?? "")) out.push("preset");
  if (actions(body.categoryGroupActions) !== actions(dest.categoryGroupActions)) out.push("category group actions");
  if (actions(body.categoryActions) !== actions(dest.categoryActions)) out.push("category actions");
  if (!!body.filterBySiteList !== !!dest.filterBySiteList) out.push("filter by site list");
  if (rules(body.siteListActions) !== rules(dest.siteListActions)) out.push("site list rules");
  return out;
}

/** The preset, category group and category names in a profile that the destination does not have. */
export function unknownNames(body: ProfileBody, names: WebProfileMetadata): string[] {
  const presets = new Set((names.presets ?? []).map((p) => p.name.toLowerCase()));
  const categories = new Set((names.categories ?? []).map((c) => c.name.toLowerCase()));
  const groups = new Set((names.categories ?? []).map((c) => c.group?.toLowerCase()).filter((g): g is string => !!g));
  const out: string[] = [];
  if (body.preset && !presets.has(body.preset.toLowerCase())) out.push(`preset "${body.preset}"`);
  for (const g of body.categoryGroupActions ?? []) if (!groups.has(g.name.toLowerCase())) out.push(`category group "${g.name}"`);
  for (const c of body.categoryActions ?? []) if (!categories.has(c.name.toLowerCase())) out.push(`category "${c.name}"`);
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
