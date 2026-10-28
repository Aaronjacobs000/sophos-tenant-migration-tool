/**
 * Tamper protection (endpoint v1).
 *
 *   GET  /endpoint/v1/settings/tamper-protection       the tenant's global setting (read only through the API)
 *   POST /endpoint/v1/endpoints/tamper-protection      many devices at once, at most 200 IDs
 *   GET  /endpoint/v1/endpoints/{id}/tamper-protection one device, with its password
 *
 * Measured 29/10/2026: the bulk call takes { ids, enabled, regeneratePassword }
 * (the reference shows only ids and enabled), answers 202 with per-device
 * `items` (status "requested") and `errors`, leaves `errors` out when there are
 * none, and refuses more than 200 IDs with 400. The endpoint record's
 * tamperProtectionEnabled and the password changed at once on a device that
 * was offline. A device's TP can be turned on only while the tenant's global
 * setting is on.
 *
 * The per-device read returns the password. readTamperPasswordState keeps
 * only when it last changed, so a password never leaves this module.
 */

import type { SophosClient } from "../client/sophos-client.js";

/** Most IDs the bulk call takes ("size must be between 1 and 200"). */
export const MAX_IDS_PER_TAMPER_REQUEST = 200;

export interface GlobalTamperProtection {
  enabled?: boolean;
}

export async function getGlobalTamperProtection(client: SophosClient, tenantId: string): Promise<GlobalTamperProtection> {
  return client.tenantRequest<GlobalTamperProtection>(tenantId, "/endpoint/v1/settings/tamper-protection");
}

/** Per-device answer of the bulk endpoint calls (tamper protection and scans). */
export interface BulkEndpointResponse {
  items?: Array<{ id: string; status?: string; requestedAt?: string }>;
  errors?: Array<{ id: string; errorCode?: string; endpointErrorCode?: string; errorMessage?: string }>;
}

export interface BulkTamperBody {
  ids: string[];
  enabled?: boolean;
  regeneratePassword?: boolean;
}

export async function requestTamperProtection(client: SophosClient, tenantId: string, body: BulkTamperBody): Promise<BulkEndpointResponse> {
  return client.tenantRequest<BulkEndpointResponse>(tenantId, "/endpoint/v1/endpoints/tamper-protection", { method: "POST", body });
}

/** A device's tamper protection without its passwords: on or off, and when its password last changed. */
export interface TamperPasswordState {
  enabled: boolean | null;
  /** The newest invalidatedAt among the previous passwords, or null when the password never changed. */
  passwordChangedAt: string | null;
  previousCount: number;
}

export async function readTamperPasswordState(client: SophosClient, tenantId: string, endpointId: string): Promise<TamperPasswordState> {
  const raw = await client.tenantRequest<{ enabled?: boolean; previousPasswords?: Array<{ invalidatedAt?: string }> }>(
    tenantId,
    `/endpoint/v1/endpoints/${encodeURIComponent(endpointId)}/tamper-protection`,
  );
  const times = (raw.previousPasswords ?? []).map((p) => p.invalidatedAt ?? "").filter((t) => Number.isFinite(Date.parse(t))).sort();
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : null,
    passwordChangedAt: times.length ? times[times.length - 1]! : null,
    previousCount: raw.previousPasswords?.length ?? 0,
  };
}
