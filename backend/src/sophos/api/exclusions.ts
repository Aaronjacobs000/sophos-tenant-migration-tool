/**
 * Wrappers for Sophos endpoint settings: scanning exclusions, allowed
 * items (allow list), blocked items (block list).
 */

import type { SophosClient } from "../client/sophos-client.js";
import { listAllPages } from "./paging.js";
import type {
  SophosScanningExclusion,
  SophosScanningExclusionPage,
  SophosAllowedItem,
  SophosAllowedItemPage,
  SophosBlockedItem,
  SophosBlockedItemPage,
} from "../types/migration.js";

const SCANNING_PATH = "/endpoint/v1/settings/exclusions/scanning";
const ALLOWED_PATH = "/endpoint/v1/settings/allowed-items";
const BLOCKED_PATH = "/endpoint/v1/settings/blocked-items";

/** Every item, reading all pages: without pageTotal these lists give no page count, so it asks for one. */
const listAll = <T>(client: SophosClient, tenantId: string, path: string): Promise<T[]> =>
  listAllPages<T>(client, tenantId, path);

export const listScanningExclusions = (c: SophosClient, t: string) =>
  listAll<SophosScanningExclusion>(c, t, SCANNING_PATH);

export const listAllowedItems = (c: SophosClient, t: string) =>
  listAll<SophosAllowedItem>(c, t, ALLOWED_PATH);

export const listBlockedItems = (c: SophosClient, t: string) =>
  listAll<SophosBlockedItem>(c, t, BLOCKED_PATH);

export async function createScanningExclusion(
  client: SophosClient,
  tenantId: string,
  body: Partial<SophosScanningExclusion>,
): Promise<SophosScanningExclusion> {
  return client.tenantRequest<SophosScanningExclusion>(tenantId, SCANNING_PATH, {
    method: "POST",
    body,
  });
}

export async function createAllowedItem(
  client: SophosClient,
  tenantId: string,
  body: Partial<SophosAllowedItem>,
): Promise<SophosAllowedItem> {
  return client.tenantRequest<SophosAllowedItem>(tenantId, ALLOWED_PATH, {
    method: "POST",
    body,
  });
}

export async function createBlockedItem(
  client: SophosClient,
  tenantId: string,
  body: Partial<SophosBlockedItem>,
): Promise<SophosBlockedItem> {
  return client.tenantRequest<SophosBlockedItem>(tenantId, BLOCKED_PATH, {
    method: "POST",
    body,
  });
}

export async function deleteScanningExclusion(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${SCANNING_PATH}/${id}`, {
    method: "DELETE",
  });
}

export async function deleteAllowedItem(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${ALLOWED_PATH}/${id}`, {
    method: "DELETE",
  });
}

export async function deleteBlockedItem(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${BLOCKED_PATH}/${id}`, {
    method: "DELETE",
  });
}

// --- Global exclusions added in 0.2.0: isolation, intrusion prevention,
// exploit mitigation applications, and websites excluded from TLS decryption.


const ISOLATION_PATH = "/endpoint/v1/settings/exclusions/isolation";
const IPS_PATH = "/endpoint/v1/settings/exclusions/intrusion-prevention";
const EXPLOIT_APPS_PATH = "/endpoint/v1/settings/exploit-mitigation/applications";
const TLS_EXCLUDED_PATH = "/endpoint/v1/settings/web-control/tls-decryption/excluded-websites";

/** Isolation and intrusion prevention exclusions share one shape. */
export interface SophosNetworkExclusion {
  id: string;
  type?: string;
  direction: "inbound" | "outbound" | "both" | string;
  localPorts?: number[];
  remotePorts?: number[];
  remoteAddresses?: string[];
  comment?: string;
}

export interface SophosExploitMitigationApp {
  id: string;
  name?: string;
  paths?: string[];
  category?: string;
  type?: "detected" | "custom" | string;
}

export interface SophosTlsExcludedWebsite {
  value: string;
  comment?: string;
}

export const listIsolationExclusions = (c: SophosClient, t: string) =>
  listAllPages<SophosNetworkExclusion>(c, t, ISOLATION_PATH);

export const listIntrusionPreventionExclusions = (c: SophosClient, t: string) =>
  listAllPages<SophosNetworkExclusion>(c, t, IPS_PATH);

/** Only custom applications: detected ones are found by the agent, not added by an admin. */
export const listCustomExploitMitigationApps = (c: SophosClient, t: string) =>
  listAllPages<SophosExploitMitigationApp>(c, t, EXPLOIT_APPS_PATH, { type: "custom" });

export const listTlsExcludedWebsites = (c: SophosClient, t: string) =>
  listAllPages<SophosTlsExcludedWebsite>(c, t, TLS_EXCLUDED_PATH);

export async function createIsolationExclusion(
  client: SophosClient,
  tenantId: string,
  body: Omit<SophosNetworkExclusion, "id" | "type">,
): Promise<SophosNetworkExclusion> {
  return client.tenantRequest<SophosNetworkExclusion>(tenantId, ISOLATION_PATH, { method: "POST", body });
}

export async function createIntrusionPreventionExclusion(
  client: SophosClient,
  tenantId: string,
  body: Omit<SophosNetworkExclusion, "id" | "type">,
): Promise<SophosNetworkExclusion> {
  return client.tenantRequest<SophosNetworkExclusion>(tenantId, IPS_PATH, { method: "POST", body });
}

export async function createExploitMitigationApp(
  client: SophosClient,
  tenantId: string,
  body: { paths: string[] },
): Promise<SophosExploitMitigationApp> {
  return client.tenantRequest<SophosExploitMitigationApp>(tenantId, EXPLOIT_APPS_PATH, { method: "POST", body });
}

/** PATCH with { add } adds websites to the TLS decryption exclusion list (at most 500 per call). */
export async function addTlsExcludedWebsites(
  client: SophosClient,
  tenantId: string,
  add: SophosTlsExcludedWebsite[],
): Promise<{ added?: SophosTlsExcludedWebsite[]; removed?: SophosTlsExcludedWebsite[] }> {
  return client.tenantRequest(tenantId, TLS_EXCLUDED_PATH, { method: "PATCH", body: { add } });
}
