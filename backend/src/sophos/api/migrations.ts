/**
 * Sophos /endpoint/v1/migrations wrappers: the actual two-tenant device
 * migration API.
 *
 * API flow (from Sophos docs):
 *   1. POST /endpoint/v1/migrations on the RECEIVING tenant
 *      Body: { fromTenant, endpoints }
 *      → returns job with id + token
 *   2. PUT /endpoint/v1/migrations/{jobId} on the SENDING tenant
 *      Body: { token, endpoints }
 *      → triggers the migration, returns same job id with mode "sending"
 *   3. GET /endpoint/v1/migrations/{jobId}/endpoints on either tenant
 *      → per-endpoint status
 *
 * The sender does NOT create a new job; it triggers the existing receiver
 * job via PUT using the same migration job ID.
 */

import type { SophosClient } from "../client/sophos-client.js";
import { listAllPages } from "./paging.js";
import type {
  SophosMigrationJob,
  SophosMigrationEndpointPage,
} from "../types/migration.js";

const MIGRATIONS_PATH = "/endpoint/v1/migrations";

/** Every job, reading all pages: without pageTotal the API gives no page count, so it asks for one. */
export async function listMigrationJobs(
  client: SophosClient,
  tenantId: string,
): Promise<SophosMigrationJob[]> {
  return listAllPages<SophosMigrationJob>(client, tenantId, MIGRATIONS_PATH);
}

export async function getMigrationJob(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<SophosMigrationJob> {
  return client.tenantRequest<SophosMigrationJob>(
    tenantId,
    `${MIGRATIONS_PATH}/${id}`,
  );
}

/** Body for creating a receiver job (POST) on the destination tenant. */
export interface CreateReceiverBody {
  /** The sending tenant's ID (where endpoints currently live). */
  fromTenant: string;
  /** The endpoint UUIDs to migrate. */
  endpoints: string[];
}

/** Body for triggering the sender (PUT) on the source tenant. */
export interface TriggerSenderBody {
  /** The handshake token from the receiver job response. */
  token: string;
  /** The endpoint UUIDs eligible for migration. */
  endpoints: string[];
}

/**
 * Step 2: Create a receiver migration job on the destination tenant.
 * POST /endpoint/v1/migrations
 */
export async function createReceiverJob(
  client: SophosClient,
  tenantId: string,
  body: CreateReceiverBody,
): Promise<SophosMigrationJob> {
  return client.tenantRequest<SophosMigrationJob>(tenantId, MIGRATIONS_PATH, {
    method: "POST",
    body,
  });
}

/**
 * Step 3: Trigger the migration from the sending tenant.
 * PUT /endpoint/v1/migrations/{jobId}
 * Uses the SAME job ID returned by createReceiverJob.
 */
export async function triggerSenderJob(
  client: SophosClient,
  tenantId: string,
  jobId: string,
  body: TriggerSenderBody,
): Promise<SophosMigrationJob> {
  return client.tenantRequest<SophosMigrationJob>(
    tenantId,
    `${MIGRATIONS_PATH}/${jobId}`,
    { method: "PUT", body },
  );
}

export async function deleteMigrationJob(
  client: SophosClient,
  tenantId: string,
  id: string,
): Promise<void> {
  await client.tenantRequest(tenantId, `${MIGRATIONS_PATH}/${id}`, {
    method: "DELETE",
  });
}

/** Every device in a job, reading all pages: without pageTotal the API gives no page count, so it asks for one. */
export async function listMigrationJobEndpoints(
  client: SophosClient,
  tenantId: string,
  jobId: string,
): Promise<SophosMigrationEndpointPage["items"]> {
  return listAllPages<SophosMigrationEndpointPage["items"][number]>(client, tenantId, `${MIGRATIONS_PATH}/${jobId}/endpoints`);
}

/** One device in a migration job, with the ID it has on the receiving tenant once moved. */
export interface MigrationEndpointStatus {
  id: string;
  status?: string;
  newId?: string;
  migratedAt?: string;
  failedAt?: string;
  reason?: string;
}

/** Every device in a job, reading all pages (asks for pageTotal). */
export async function listMigrationEndpointStatuses(
  client: SophosClient,
  tenantId: string,
  jobId: string,
): Promise<MigrationEndpointStatus[]> {
  return listAllPages<MigrationEndpointStatus>(client, tenantId, `${MIGRATIONS_PATH}/${encodeURIComponent(jobId)}/endpoints`);
}
