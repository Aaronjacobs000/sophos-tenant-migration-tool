/**
 * Sophos /common/v1/directory/user-groups wrappers.
 */

import type { SophosClient } from "../client/sophos-client.js";
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

/** Every user group, reading all pages: without pageTotal the API gives no page count, so it asks for one. */
export async function listUserGroups(
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
