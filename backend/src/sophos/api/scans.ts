/**
 * POST /endpoint/v1/endpoints/scans: ask devices to run a scan. The body
 * takes the endpoint IDs only (1 to 500); the reference's "perform or
 * configure a scan" offers no scan options. It answers 202 with per-device
 * `items` (status "requested") and `errors`. A finished scan shows as an
 * event on the device; the API says only that it was requested.
 */

import type { SophosClient } from "../client/sophos-client.js";
import type { BulkEndpointResponse } from "./tamper-protection.js";

/** Most IDs one scan request takes. */
export const MAX_IDS_PER_SCAN_REQUEST = 500;

export async function requestScans(client: SophosClient, tenantId: string, ids: string[]): Promise<BulkEndpointResponse> {
  return client.tenantRequest<BulkEndpointResponse>(tenantId, "/endpoint/v1/endpoints/scans", { method: "POST", body: { ids } });
}
