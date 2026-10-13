/**
 * Sophos /endpoint/v1/endpoint-groups wrappers.
 */

import type { SophosClient } from "../client/sophos-client.js";
import { listAllPages } from "./paging.js";
import type { SophosEndpoint, SophosEndpointPage } from "../types/sophos.js";
import type { SophosEndpointGroup } from "../types/migration.js";

const GROUPS_PATH = "/endpoint/v1/endpoint-groups";

/** Every endpoint group, reading all pages: without pageTotal the API gives no page count, so it asks for one. */
export async function listGroups(
  client: SophosClient,
  tenantId: string,
): Promise<SophosEndpointGroup[]> {
  return listAllPages<SophosEndpointGroup>(client, tenantId, GROUPS_PATH);
}

export async function getGroup(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<SophosEndpointGroup> {
  return client.tenantRequest<SophosEndpointGroup>(tenantId, `${GROUPS_PATH}/${id}`);
}

export async function createGroup(
  client: SophosClient,
  tenantId: string,
  body: { name: string; description?: string; type?: string; endpointType?: string },
): Promise<SophosEndpointGroup> {
  return client.tenantRequest<SophosEndpointGroup>(tenantId, GROUPS_PATH, {
    method: "POST",
    body,
  });
}

export async function deleteGroup(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${GROUPS_PATH}/${id}`, {
    method: "DELETE",
  });
}

export async function listGroupMembers(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<SophosEndpoint[]> {
  const items: SophosEndpoint[] = [];
  let page = 1;
  while (true) {
    const res = await client.tenantRequest<SophosEndpointPage>(
      tenantId,
      `${GROUPS_PATH}/${id}/endpoints`,
      { params: { page: String(page), pageSize: "100" } },
    );
    items.push(...res.items);
    const total = res.pages?.total;
    if (!total || page >= total) break;
    page++;
  }
  return items;
}

// --- Group membership after a device move (0.2.0) ---

/** Every endpoint group, reading all pages. */
export async function listAllGroups(
  client: SophosClient,
  tenantId: string,
): Promise<SophosEndpointGroup[]> {
  return listAllPages<SophosEndpointGroup>(client, tenantId, GROUPS_PATH);
}

/** IDs of the endpoints in a group. This list uses cursor paging. */
export async function listGroupEndpointIds(
  client: SophosClient,
  tenantId: string,
  groupId: string,
): Promise<string[]> {
  const ids: string[] = [];
  let pageFromKey: string | undefined;
  do {
    const res = await client.tenantRequest<{ items?: Array<{ id: string }>; pages?: { nextKey?: string } }>(
      tenantId,
      `${GROUPS_PATH}/${encodeURIComponent(groupId)}/endpoints`,
      { params: { pageSize: "500", fields: "id", ...(pageFromKey ? { pageFromKey } : {}) } },
    );
    ids.push(...(res.items ?? []).map((e) => e.id));
    pageFromKey = res.pages?.nextKey;
  } while (pageFromKey);
  return ids;
}

export interface AddToGroupResponse {
  addedEndpoints?: Array<{ id: string; hostname?: string }>;
  errors?: { endpointsNotFound?: string[]; endpointsOfWrongType?: string[] };
}

/** POST /endpoint/v1/endpoint-groups/{id}/endpoints with at most 1000 IDs. */
export async function addEndpointsToGroup(
  client: SophosClient,
  tenantId: string,
  groupId: string,
  ids: string[],
): Promise<AddToGroupResponse> {
  return client.tenantRequest<AddToGroupResponse>(
    tenantId,
    `${GROUPS_PATH}/${encodeURIComponent(groupId)}/endpoints`,
    { method: "POST", body: { ids } },
  );
}
