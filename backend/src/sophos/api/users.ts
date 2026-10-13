/**
 * Sophos /common/v1/directory/users wrappers. Read-only: used to resolve
 * user IDs to names when exporting policy assignments, and to match the users
 * a policy is assigned to when it is cloned.
 */

import type { SophosClient } from "../client/sophos-client.js";
import { listAllPages } from "./paging.js";

export interface SophosUser {
  id: string;
  name?: string;
  email?: string;
  source?: string; // e.g. "custom", "activeDirectory"
  createdAt?: string;
  updatedAt?: string;
}

const USERS_PATH = "/common/v1/directory/users";

/** Every user, reading all pages: without pageTotal the API gives no page count, so it asks for one. */
export async function listUsers(
  client: SophosClient,
  tenantId: string,
): Promise<SophosUser[]> {
  return listAllPages<SophosUser>(client, tenantId, USERS_PATH);
}
