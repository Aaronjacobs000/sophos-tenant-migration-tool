/**
 * Sophos AI Defense Policy GraphQL API v1 (released 15/10/2026), on the
 * Sophos Fusion GraphQL endpoint. The documents follow the ones in sophos-mcp
 * (src/fusion/queries/ai-defense-policy.ts @ a66babeb).
 *
 * Measured on live tenants, 07/11 and 08/11/2026:
 *   - A new policy lands at rank 1, the top of the order, DISABLED unless it
 *     is created ENABLED, and the policy list shows it at once.
 *   - Names need not be unique: a second policy with the same name is accepted.
 *   - On an update, `sensors` replaces the whole map: a sensor left out is
 *     removed (a DNS sensor read back null). `rules` and `tags` replace too;
 *     `baseRule` merges, and appControlCategoryAction null clears it.
 *   - An ordinary policy whose Endpoint scope names nobody applies to
 *     everyone, which only the base policy may. Created ENABLED, or enabled
 *     later, it is refused ("only the base policy can apply to everyone");
 *     created DISABLED it is accepted.
 *   - At least one sensor must be on ("at least one sensor must be enabled").
 *   - Every write raises `version`, and an update needs the current one.
 *   - The Endpoint scope names users ({ id, name }, the directory user's ID
 *     and name), user groups (group_ids and groups), devices (device_ids and
 *     devices, named by hostname) and device groups (device_group_ids and
 *     device_groups), all by their Sophos Fusion IDs. The console writes each
 *     dimension in both forms, and the API takes the union of the two.
 *   - Every tenant answers, set up for AI Defense or not; one that never
 *     started onboarding reads secureAITenantSettings as null and still takes
 *     policy writes.
 */

import type { FusionClient } from "../client/fusion-client.js";

export type AiAction = "BLOCK" | "WARN" | "ALLOW";
export type AiSensorName = "endpoint" | "firewall" | "dns" | "browser";
export const AI_SENSORS: AiSensorName[] = ["endpoint", "firewall", "dns", "browser"];

export interface AiCondition {
  dimension: string;
  operator: string;
  values: string[];
}

export interface AiDataControls {
  clipboardCopy?: string;
  clipboardPaste?: string;
  upload?: string;
  download?: string;
}

export interface AiRule {
  /** Read only: a rule's place comes from its place in the list. */
  position?: number;
  target: { conditions: AiCondition[] };
  action: AiAction;
  enforcementMechanismOverride?: string[] | null;
  note?: string | null;
  dataControls?: AiDataControls | null;
}

export interface AiSensor {
  enabled: boolean;
  scope: Record<string, unknown> | null;
}

export interface AiBaseRule {
  generativeAiCategoryAction?: AiAction | null;
  appControlCategoryAction?: AiAction | null;
}

export interface AiPolicy {
  id: string;
  tenantId?: string;
  name: string;
  description?: string | null;
  priority?: number;
  rank: number;
  state: "ENABLED" | "DISABLED";
  enforcementStatus?: string;
  origin: "CUSTOM" | "BUILT_IN" | "PARTNER";
  kind: "TENANT" | "TENANT_BASE";
  partnerPolicyId?: string | null;
  builtInKey?: string | null;
  builtInVersion?: number | null;
  rules: AiRule[];
  baseRule: AiBaseRule;
  sensors: Partial<Record<AiSensorName, AiSensor | null>>;
  tags: Record<string, string> | null;
  createdAt?: string;
  updatedAt?: string;
  version: number | string;
}

/** The tenant's AI Defense setup, or null when it has never started onboarding. */
export interface AiSettings {
  onboarding: { status: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED" };
  licenseState: "ACTIVE" | "GRACE_PERIOD" | "EXPIRED" | null;
  licenseExpiryDate?: string | null;
}

export interface AiRuleInput {
  target: { conditions: AiCondition[] };
  action: AiAction;
  enforcementMechanismOverride?: string[];
  note?: string;
  dataControls?: AiDataControls;
}

export interface AiPolicyCreateInput {
  name: string;
  description?: string;
  rules: AiRuleInput[];
  baseRule?: AiBaseRule;
  sensors: Partial<Record<AiSensorName, AiSensor>>;
  tags?: Record<string, string>;
  state?: "ENABLED" | "DISABLED";
  builtInKey?: string;
  builtInVersion?: number;
}

export interface AiPolicyUpdateInput {
  version: number | string;
  name?: string;
  description?: string;
  rules?: AiRuleInput[];
  baseRule?: AiBaseRule;
  sensors?: Partial<Record<AiSensorName, AiSensor>>;
  tags?: Record<string, string>;
}

const POLICY_FIELDS = `
    id
    tenantId
    name
    description
    priority
    rank
    state
    enforcementStatus
    origin
    kind
    partnerPolicyId
    builtInKey
    builtInVersion
    rules {
      position
      target { conditions { dimension operator values } }
      action
      enforcementMechanismOverride
      note
      dataControls { clipboardCopy clipboardPaste upload download }
    }
    baseRule { generativeAiCategoryAction appControlCategoryAction }
    sensors {
      endpoint { enabled scope }
      firewall { enabled scope }
      dns { enabled scope }
      browser { enabled scope }
    }
    tags
    createdAt
    updatedAt
    version`;

const LIST = `query MigrationAiDefensePolicies($first: Int64, $after: String) {
  policies(first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    policies {${POLICY_FIELDS}
    }
  }
}`;

const GET = `query MigrationAiDefensePolicy($id: ID!) {
  policy(id: $id) {${POLICY_FIELDS}
  }
}`;

const SETTINGS = `query MigrationAiDefenseSettings {
  secureAITenantSettings {
    onboarding { status }
    licenseState
    licenseExpiryDate
  }
}`;

const CREATE = `mutation MigrationAiDefenseCreatePolicy($input: PolicyCreateInput!) {
  createPolicy(input: $input) {${POLICY_FIELDS}
  }
}`;

const UPDATE = `mutation MigrationAiDefenseUpdatePolicy($id: ID!, $input: PolicyUpdateInput!) {
  updatePolicy(id: $id, input: $input) {${POLICY_FIELDS}
  }
}`;

const ENABLE = `mutation MigrationAiDefenseEnablePolicy($id: ID!) {
  enablePolicy(id: $id) {${POLICY_FIELDS}
  }
}`;

const DISABLE = `mutation MigrationAiDefenseDisablePolicy($id: ID!) {
  disablePolicy(id: $id) {${POLICY_FIELDS}
  }
}`;

const MOVE = `mutation MigrationAiDefenseMovePolicy($id: ID!, $afterId: ID) {
  movePolicy(id: $id, afterId: $afterId) {${POLICY_FIELDS}
  }
}`;

const DELETE = `mutation MigrationAiDefenseDeletePolicy($id: ID!) {
  deletePolicy(id: $id)
}`;

/** Policies per page: the API's maximum. */
const PAGE = 100;

/** Every AI Defense policy on the tenant, in priority order (rank 1 is evaluated first). */
export async function listAiPolicies(fusion: FusionClient, tenantId: string): Promise<AiPolicy[]> {
  const out: AiPolicy[] = [];
  let after: string | null = null;
  // A cursor that never moves would loop for ever; 100 pages is 10,000 policies.
  for (let page = 0; page < 100; page++) {
    const vars: Record<string, unknown> = { first: PAGE, ...(after ? { after } : {}) };
    const data: { policies: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; policies: AiPolicy[] } } =
      await fusion.query(tenantId, LIST, vars);
    out.push(...data.policies.policies);
    const next = data.policies.pageInfo;
    if (!next.hasNextPage || !next.endCursor || next.endCursor === after) break;
    after = next.endCursor;
  }
  return out.sort((a, b) => a.rank - b.rank);
}

/** One policy by ID, or null. An ID the tenant doesn't hold throws "policy not found". */
export async function getAiPolicy(fusion: FusionClient, tenantId: string, id: string): Promise<AiPolicy | null> {
  return (await fusion.query<{ policy: AiPolicy | null }>(tenantId, GET, { id })).policy;
}

export async function getAiSettings(fusion: FusionClient, tenantId: string): Promise<AiSettings | null> {
  return (await fusion.query<{ secureAITenantSettings: AiSettings | null }>(tenantId, SETTINGS)).secureAITenantSettings;
}

async function mutate(fusion: FusionClient, tenantId: string, doc: string, field: string, variables: Record<string, unknown>): Promise<AiPolicy> {
  const data = await fusion.query<Record<string, AiPolicy | null>>(tenantId, doc, variables);
  const policy = data[field];
  if (!policy) throw new Error(`Sophos Fusion answered ${field} without the policy`);
  return policy;
}

export const createAiPolicy = (f: FusionClient, t: string, input: AiPolicyCreateInput) =>
  mutate(f, t, CREATE, "createPolicy", { input });

export const updateAiPolicy = (f: FusionClient, t: string, id: string, input: AiPolicyUpdateInput) =>
  mutate(f, t, UPDATE, "updatePolicy", { id, input });

export const enableAiPolicy = (f: FusionClient, t: string, id: string) => mutate(f, t, ENABLE, "enablePolicy", { id });

export const disableAiPolicy = (f: FusionClient, t: string, id: string) => mutate(f, t, DISABLE, "disablePolicy", { id });

/** Puts the policy straight after afterId, or at the top when afterId is null. Only the moved policy changes. */
export const moveAiPolicy = (f: FusionClient, t: string, id: string, afterId: string | null) =>
  mutate(f, t, MOVE, "movePolicy", { id, afterId });

/** Deletes a policy and its enforcement. There is no undo. The base policy and partner policies are refused. */
export async function deleteAiPolicy(fusion: FusionClient, tenantId: string, id: string): Promise<void> {
  const data = await fusion.query<{ deletePolicy: boolean | null }>(tenantId, DELETE, { id });
  if (data.deletePolicy !== true) throw new Error(`Sophos Fusion answered deletePolicy with ${String(data.deletePolicy)}`);
}
