/**
 * Vendored from sophos-central-mcp @ 1b10f6d3aa3f2d5ed3dce70533688b2a0f4dbe4d
 * Upstream: https://github.com/Aaronjacobs000/sophos-mcp/blob/main/src/client/tenant-resolver.ts
 * License: MIT
 *
 * Local modifications:
 *   - Import of SOPHOS_GLOBAL_API redirected from "../config/config.js" to "../constants.js".
 *   - Added getTenantInfo(tenantId) helper.
 *   - Updated error messages to remove MCP tool references.
 *   - whoami and the tenant list refuse a redirect instead of following it.
 *
 * Discovers the caller's identity type via /whoami/v1 and resolves
 * tenant IDs to their regional API hosts. Caches the mapping.
 * Supports tenant, partner, and organization credential types.
 */

import { SOPHOS_GLOBAL_API } from "../constants.js";
import { refuseRedirect } from "../redirect.js";
import type { TokenManager } from "../auth/token-manager.js";
import type { SophosWhoamiResponse } from "../types/sophos.js";

export interface TenantInfo {
  id: string;
  name: string;
  apiHost: string;
  dataRegion: string;
  dataGeography: string;
}

export type CallerIdType = "partner" | "organization" | "tenant";

export interface CallerIdentity {
  id: string;
  idType: CallerIdType;
  apiHosts: {
    global: string;
    dataRegion?: string;
  };
}

interface TenantPage {
  pages: { current: number; size: number; total: number; maxSize: number };
  items: Array<{
    id: string;
    name: string;
    dataGeography: string;
    dataRegion: string;
    apiHost: string;
    status?: string;
  }>;
}

export class TenantResolver {
  private identity: CallerIdentity | null = null;
  private tenantCache = new Map<string, TenantInfo>();
  private tenantsLoaded = false;

  constructor(private tokenManager: TokenManager) {}

  /**
   * Initialise: calls /whoami/v1 and discovers the caller identity.
   */
  async init(): Promise<CallerIdentity> {
    const token = await this.tokenManager.getToken();
    const whoamiUrl = `${SOPHOS_GLOBAL_API}/whoami/v1`;
    const response = await fetch(whoamiUrl, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
    });
    refuseRedirect(response, whoamiUrl);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Whoami failed (${response.status}): ${errorText}`);
    }

    const data = (await response.json()) as SophosWhoamiResponse;
    this.identity = {
      id: data.id,
      idType: data.idType as CallerIdType,
      apiHosts: data.apiHosts,
    };

    // For tenant-level callers, the data region host is returned directly
    if (data.idType === "tenant" && data.apiHosts.dataRegion) {
      this.tenantCache.set(data.id, {
        id: data.id,
        name: "self",
        apiHost: data.apiHosts.dataRegion,
        dataRegion: "self",
        dataGeography: "unknown",
      });
      this.tenantsLoaded = true;
    }

    return this.identity;
  }

  getIdentity(): CallerIdentity {
    if (!this.identity) {
      throw new Error("TenantResolver not initialised. Call init() first.");
    }
    return this.identity;
  }

  getIdHeader(): { name: string; value: string } {
    const identity = this.getIdentity();
    switch (identity.idType) {
      case "partner":
        return { name: "X-Partner-ID", value: identity.id };
      case "organization":
        return { name: "X-Organization-ID", value: identity.id };
      case "tenant":
        return { name: "X-Tenant-ID", value: identity.id };
    }
  }

  /**
   * Loads all tenants for partner/org callers. Paginates through all pages.
   */
  async loadTenants(): Promise<TenantInfo[]> {
    const identity = this.getIdentity();

    if (identity.idType === "tenant") {
      return Array.from(this.tenantCache.values());
    }

    if (this.tenantsLoaded) {
      return Array.from(this.tenantCache.values());
    }

    const apiPath =
      identity.idType === "partner"
        ? "/partner/v1/tenants"
        : "/organization/v1/tenants";

    const idHeader = this.getIdHeader();
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const token = await this.tokenManager.getToken();
      const url = new URL(`${SOPHOS_GLOBAL_API}${apiPath}`);
      url.searchParams.set("page", String(page));
      if (page === 1) {
        url.searchParams.set("pageTotal", "true");
      }

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${token}`,
          [idHeader.name]: idHeader.value,
        },
        redirect: "manual",
      });
      refuseRedirect(response, url.toString());

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `List tenants failed (${response.status}): ${errorText}`,
        );
      }

      const data = (await response.json()) as TenantPage;

      if (page === 1 && data.pages.total) {
        totalPages = data.pages.total;
      }

      for (const tenant of data.items) {
        this.tenantCache.set(tenant.id, {
          id: tenant.id,
          name: tenant.name,
          apiHost: tenant.apiHost,
          dataRegion: tenant.dataRegion,
          dataGeography: tenant.dataGeography,
        });
      }

      page++;
    }

    this.tenantsLoaded = true;
    return Array.from(this.tenantCache.values());
  }

  async resolveApiHost(tenantId: string): Promise<string> {
    if (this.tenantCache.has(tenantId)) {
      return this.tenantCache.get(tenantId)!.apiHost;
    }
    if (!this.tenantsLoaded) {
      await this.loadTenants();
    }
    const info = this.tenantCache.get(tenantId);
    if (!info) {
      throw new Error(`Tenant ${tenantId} not found in this account.`);
    }
    return info.apiHost;
  }

  resolveTenantId(providedTenantId?: string): string {
    const identity = this.getIdentity();
    if (identity.idType === "tenant") {
      return providedTenantId || identity.id;
    }
    if (!providedTenantId) {
      throw new Error("tenantId is required for partner/organization callers.");
    }
    return providedTenantId;
  }

  getTenantInfo(tenantId: string): TenantInfo | null {
    return this.tenantCache.get(tenantId) ?? null;
  }

  getCachedTenants(): TenantInfo[] {
    return Array.from(this.tenantCache.values());
  }
}
