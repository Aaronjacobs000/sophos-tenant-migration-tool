/**
 * Sophos /common/v1/directory/user-groups wrappers.
 */

import type { SophosClient } from "../client/sophos-client.js";
import type { SophosPagedResponse } from "../types/sophos.js";
import { listAllPages } from "./paging.js";

export interface SophosUserGroup {
  id: string;
  name: string;
  description?: string;
  source?: string; // e.g. "custom", "activeDirectory"
  createdAt?: string;
  updatedAt?: string;
  usersCount?: number;
}

const USER_GROUPS_PATH = "/common/v1/directory/user-groups";

export async function listUserGroups(
  client: SophosClient,
  tenantId: string,
): Promise<SophosUserGroup[]> {
  const items: SophosUserGroup[] = [];
  let page = 1;
  while (true) {
    const res = await client.tenantRequest<SophosPagedResponse<SophosUserGroup>>(
      tenantId,
      USER_GROUPS_PATH,
      { params: { page: String(page), pageSize: "100" } },
    );
    items.push(...res.items);
    const total = res.pages?.total;
    if (!total || page >= total) break;
    page++;
  }
  return items;
}

/** Every user group, reading all pages: without pageTotal the API gives no page count. */
export async function listAllUserGroups(
  client: SophosClient,
  tenantId: string,
): Promise<SophosUserGroup[]> {
  return listAllPages<SophosUserGroup>(client, tenantId, USER_GROUPS_PATH);
}

export async function createUserGroup(
  client: SophosClient,
  tenantId: string,
  body: { name: string; description?: string },
): Promise<SophosUserGroup> {
  return client.tenantRequest<SophosUserGroup>(tenantId, USER_GROUPS_PATH, {
    method: "POST",
    body,
  });
}

export async function deleteUserGroup(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${USER_GROUPS_PATH}/${id}`, {
    method: "DELETE",
  });
}
