/**
 * Sophos /endpoint/v1/endpoints wrappers (list/get only - mutations are
 * handled via the migration job flow, not direct endpoint edits).
 */

import type { SophosClient } from "../client/sophos-client.js";
import type {
  SophosEndpoint,
  SophosEndpointPage,
} from "../types/sophos.js";

const ENDPOINTS_PATH = "/endpoint/v1/endpoints";

export interface ListEndpointsOptions {
  pageSize?: number;
  /** Cursor-based pagination key from the previous page. */
  pageFromKey?: string;
  /** Optional Sophos-side filters; passed through to query string. */
  hostnameContains?: string;
  /** Only these endpoint IDs (sent comma separated). */
  ids?: string[];
  ipAddresses?: string;
  type?: "computer" | "server";
  healthStatus?: string;
}

export async function listEndpoints(
  client: SophosClient,
  tenantId: string,
  opts: ListEndpointsOptions = {},
): Promise<SophosEndpointPage> {
  const params: Record<string, string> = {
    pageSize: String(opts.pageSize ?? 100),
  };
  if (opts.pageFromKey) params.pageFromKey = opts.pageFromKey;
  if (opts.hostnameContains) params.hostnameContains = opts.hostnameContains;
  if (opts.ids?.length) params.ids = opts.ids.join(",");
  if (opts.ipAddresses) params.ipAddresses = opts.ipAddresses;
  if (opts.type) params.type = opts.type;
  if (opts.healthStatus) params.healthStatus = opts.healthStatus;

  return client.tenantRequest<SophosEndpointPage>(tenantId, ENDPOINTS_PATH, {
    params,
  });
}

/**
 * List ALL endpoints by walking the cursor-based pagination. Use sparingly:
 * tenants with thousands of devices may take a while.
 */
export async function listAllEndpoints(
  client: SophosClient,
  tenantId: string,
  opts: Omit<ListEndpointsOptions, "pageFromKey"> = {},
): Promise<SophosEndpoint[]> {
  const all: SophosEndpoint[] = [];
  let pageFromKey: string | undefined;
  while (true) {
    const page = await listEndpoints(client, tenantId, { ...opts, pageFromKey });
    all.push(...page.items);
    pageFromKey = page.pages?.nextKey;
    if (!pageFromKey) break;
  }
  return all;
}

/**
 * Most IDs sent in one GET /endpoints?ids= call. The API gateway refuses a
 * request line over 7,168 bytes (414, measured 29/10/2026), which is about
 * 180 IDs; 100 stays well under it.
 */
export const MAX_IDS_PER_LIST = 100;

/**
 * The endpoint records for these IDs, read with GET /endpoints?ids= in
 * batches of MAX_IDS_PER_LIST. An ID with no record is left out. A batch that
 * fails is returned in `failed` with its IDs and the error, so the caller can
 * say which devices were not read.
 */
export async function getEndpointsByIds(
  client: SophosClient,
  tenantId: string,
  ids: string[],
): Promise<{ records: SophosEndpoint[]; failed: Array<{ ids: string[]; error: string }> }> {
  const records: SophosEndpoint[] = [];
  const failed: Array<{ ids: string[]; error: string }> = [];
  for (let i = 0; i < ids.length; i += MAX_IDS_PER_LIST) {
    const batch = ids.slice(i, i + MAX_IDS_PER_LIST);
    try {
      records.push(...(await listAllEndpoints(client, tenantId, { ids: batch, pageSize: MAX_IDS_PER_LIST })));
    } catch (err) {
      failed.push({ ids: batch, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { records, failed };
}

export async function getEndpoint(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<SophosEndpoint> {
  return client.tenantRequest<SophosEndpoint>(tenantId, `${ENDPOINTS_PATH}/${id}`);
}
