/**
 * Sophos Central global endpoints. Referenced by the vendored token-manager
 * and tenant-resolver in place of the upstream MCP repo's config module.
 */

export const SOPHOS_AUTH_URL = "https://id.sophos.com/api/v2/oauth2/token";
export const SOPHOS_GLOBAL_API = "https://api.central.sophos.com";

/** The Sophos Fusion GraphQL endpoint: one for every tenant, with no regional host (AI Defense Policy API v1). */
export const SOPHOS_FUSION_GRAPHQL_URL = "https://api.taegis.sophos.com/graphql";
