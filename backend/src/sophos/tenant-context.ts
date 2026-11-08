/**
 * Constructs an isolated Sophos client stack for a single tenant side
 * (either "source" or "dest").
 *
 * Two modes:
 *   "direct" — each side has its own tenant-scoped credentials.
 *   "partner" — one partner credential set is shared; each side just
 *               selects a different tenant ID from the partner's list.
 */

import { TokenManager } from "./auth/token-manager.js";
import {
  TenantResolver,
  type CallerIdentity,
  type TenantInfo,
} from "./client/tenant-resolver.js";
import { SophosClient } from "./client/sophos-client.js";
import { FusionClient } from "./client/fusion-client.js";

export type TenantLabel = "source" | "dest";

/** Credentials for direct-tenant mode. */
export interface DirectCredentials {
  clientId: string;
  clientSecret: string;
  label?: string;
}

/** Credentials for partner mode. */
export interface PartnerCredentials {
  clientId: string;
  clientSecret: string;
  label?: string;
}

/** A fully-resolved context for one side of the migration. The rest of the
 *  codebase only uses this interface — it's agnostic about whether the
 *  underlying credentials are direct-tenant or partner-scoped. */
export interface TenantContext {
  label: TenantLabel;
  client: SophosClient;
  /** The Sophos Fusion GraphQL client, with the same credential (AI Defense policies). */
  fusion: FusionClient;
  tenantId: string;
  summary: TenantSummary;
}

export interface TenantSummary {
  tenantId: string;
  tenantName: string | null;
  userLabel: string | null;
  displayName: string | null;
  apiHost: string;
  region: string | null;
}

/**
 * Create a context for one side using direct-tenant credentials.
 * Calls /whoami to validate and resolve the regional host.
 */
export async function createDirectContext(
  label: TenantLabel,
  creds: DirectCredentials,
): Promise<TenantContext> {
  const tm = new TokenManager(creds.clientId, creds.clientSecret);
  const tr = new TenantResolver(tm);
  const identity = await tr.init();

  if (identity.idType !== "tenant") {
    throw new Error(
      `These credentials are ${identity.idType}-scoped, not tenant-scoped. ` +
        "Use the Partner mode if you want to use partner/organization credentials.",
    );
  }

  const client = new SophosClient(tm, tr);
  const tenantId = identity.id;
  const apiHost = identity.apiHosts.dataRegion ?? "";
  const userLabel = creds.label?.trim() || null;

  return {
    label,
    client,
    fusion: new FusionClient(tm),
    tenantId,
    summary: {
      tenantId,
      tenantName: null,
      userLabel,
      displayName: userLabel,
      apiHost,
      region: parseRegion(apiHost),
    },
  };
}

/** Shared resources created once for partner mode. */
export interface PartnerContext {
  tokenManager: TokenManager;
  tenantResolver: TenantResolver;
  client: SophosClient;
  fusion: FusionClient;
  identity: CallerIdentity;
  tenants: TenantInfo[];
  label?: string;
}

/**
 * Initialise partner-level access: authenticate, discover identity,
 * and load all managed tenants.
 */
export async function createPartnerContext(
  creds: PartnerCredentials,
): Promise<PartnerContext> {
  const tm = new TokenManager(creds.clientId, creds.clientSecret);
  const tr = new TenantResolver(tm);
  const identity = await tr.init();

  if (identity.idType !== "partner" && identity.idType !== "organization") {
    throw new Error(
      `These credentials are ${identity.idType}-scoped. ` +
        "Partner mode requires partner or organization API credentials.",
    );
  }

  const tenants = await tr.loadTenants();
  const client = new SophosClient(tm, tr);

  return {
    tokenManager: tm,
    tenantResolver: tr,
    client,
    fusion: new FusionClient(tm),
    identity,
    tenants,
    label: creds.label?.trim() || undefined,
  };
}

/**
 * Wrap a partner context + a selected tenant ID into a side-specific
 * TenantContext so the rest of the app can use it identically to a
 * direct-tenant context.
 */
export function partnerSideContext(
  pctx: PartnerContext,
  label: TenantLabel,
  tenantId: string,
  userLabel?: string,
): TenantContext {
  const info = pctx.tenantResolver.getTenantInfo(tenantId);
  const apiHost = info?.apiHost ?? "";
  const tenantName = info?.name && info.name !== "self" ? info.name : null;
  const displayName = userLabel?.trim() || tenantName || null;

  return {
    label,
    client: pctx.client,
    fusion: pctx.fusion,
    tenantId,
    summary: {
      tenantId,
      tenantName,
      userLabel: userLabel?.trim() || null,
      displayName,
      apiHost,
      region: parseRegion(apiHost),
    },
  };
}

function parseRegion(apiHost: string): string | null {
  const match = apiHost.match(/api-([a-z0-9]+)\.central\.sophos\.com/i);
  return match ? match[1]!.toLowerCase() : null;
}
