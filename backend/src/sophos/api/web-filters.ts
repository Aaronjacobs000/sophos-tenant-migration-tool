/**
 * Web Filtering API (/web-filters/v1, regional host): site lists and web
 * filtering profiles. A profile refers to site lists by ID in its
 * siteListActions, and web control policies refer to a profile by ID in
 * the endpoint.web-control.web-profile-id setting.
 */

import type { SophosClient } from "../client/sophos-client.js";
import { listAllPages } from "./paging.js";

const SITE_LISTS_PATH = "/web-filters/v1/site-lists";
const PROFILES_PATH = "/web-filters/v1/profiles";

/** Most site lists a tenant can have (Sophos web filtering guide, 14/10/2026). */
export const MAX_SITE_LISTS = 20;
/** Most sites one list can hold; the API refuses more with 400 (measured 29/10/2026). */
export const MAX_SITES_PER_LIST = 750;

export interface WebFilterRef {
  id: string;
  name?: string;
}

export interface SophosSiteList {
  id: string;
  name: string;
  description?: string;
  numberOfSites?: number;
  sites?: string[];
  updatedAt?: string;
  usedBy?: WebFilterRef[];
}

export interface SophosSite {
  id?: string;
  site: string;
  siteType?: string;
  createdAt?: string;
}

export type WebFilterAction = "allow" | "block" | "warn";

export interface SophosWebProfile {
  id: string;
  name: string;
  description?: string;
  updatedAt?: string;
  consumers?: Array<{ type: string; id: string }>;
  filterByCategory?: boolean;
  preset?: string;
  categoryGroupActions?: Array<{ name: string; action: WebFilterAction }>;
  categoryActions?: Array<{ name: string; action: WebFilterAction }>;
  filterBySiteList?: boolean;
  siteListActions?: Array<{ id: string; action: WebFilterAction; priority: number }>;
}

export const listSiteLists = (c: SophosClient, t: string) =>
  listAllPages<SophosSiteList>(c, t, SITE_LISTS_PATH);

export const listSites = (c: SophosClient, t: string, siteListId: string) =>
  listAllPages<SophosSite>(c, t, `${SITE_LISTS_PATH}/${encodeURIComponent(siteListId)}/sites`);

export async function createSiteList(
  client: SophosClient,
  tenantId: string,
  body: { name: string; description?: string; sites: string[] },
): Promise<SophosSiteList> {
  return client.tenantRequest<SophosSiteList>(tenantId, SITE_LISTS_PATH, { method: "POST", body });
}

/** The API refuses (409) while a profile still uses the list. */
export async function deleteSiteList(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<{ deleted?: boolean }> {
  return client.tenantRequest(tenantId, `${SITE_LISTS_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export const listProfiles = (c: SophosClient, t: string) =>
  listAllPages<SophosWebProfile>(c, t, PROFILES_PATH);

/** The API refuses (409) while a policy still uses the profile. */
export async function deleteProfile(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<{ deleted?: boolean }> {
  return client.tenantRequest(tenantId, `${PROFILES_PATH}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function getProfile(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<SophosWebProfile> {
  return client.tenantRequest<SophosWebProfile>(tenantId, `${PROFILES_PATH}/${encodeURIComponent(id)}`);
}

export async function createProfile(
  client: SophosClient,
  tenantId: string,
  body: Omit<SophosWebProfile, "id" | "updatedAt" | "consumers">,
): Promise<SophosWebProfile> {
  return client.tenantRequest<SophosWebProfile>(tenantId, PROFILES_PATH, { method: "POST", body });
}

/** PUT replaces the whole list: its name, description and every site (measured 29/10/2026). */
export async function updateSiteList(
  client: SophosClient,
  tenantId: string,
  id: string,
  body: { name: string; description?: string; sites: string[] },
): Promise<SophosSiteList> {
  return client.tenantRequest<SophosSiteList>(tenantId, `${SITE_LISTS_PATH}/${encodeURIComponent(id)}`, { method: "PUT", body });
}

/** PUT replaces the whole profile, so the body carries every filtering field. */
export async function updateProfile(
  client: SophosClient,
  tenantId: string,
  id: string,
  body: Omit<SophosWebProfile, "id" | "updatedAt" | "consumers">,
): Promise<SophosWebProfile> {
  return client.tenantRequest<SophosWebProfile>(tenantId, `${PROFILES_PATH}/${encodeURIComponent(id)}`, { method: "PUT", body });
}

/** The preset, category and category group names a tenant accepts in a profile. */
export interface WebProfileMetadata {
  presets?: Array<{ name: string }>;
  categories?: Array<{ name: string; group?: string; label?: string }>;
}

/**
 * GET /web-filters/v1/profiles/metadata. The names can differ between
 * tenants (the guide). It refuses an Accept-Language it can't read with 400,
 * including the "*" Node sends by default and "en-US"; "en" works (measured
 * 29/10/2026). Category group names are the categories' `group` values.
 */
export async function getProfileMetadata(client: SophosClient, tenantId: string): Promise<WebProfileMetadata> {
  return client.tenantRequest<WebProfileMetadata>(tenantId, `${PROFILES_PATH}/metadata`, { headers: { "Accept-Language": "en" } });
}
