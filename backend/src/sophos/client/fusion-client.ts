/**
 * Ported from sophos-mcp @ a66babeb (src/client/fusion-client.ts)
 * Upstream: https://github.com/Aaronjacobs000/sophos-mcp/blob/main/src/client/fusion-client.ts
 * License: MIT
 *
 * Local modifications:
 *   - Attribution header added. Only what the AI Defense policy copy needs is
 *     kept: no presigned uploads, and no partnerPreferences retry, which is a
 *     fault on the case write path.
 *   - Retries follow this tool's SophosClient. A query is tried up to three
 *     times after a 5xx, a timeout or a network error (waits of 1 s, then
 *     2 s). A mutation is sent once: a 5xx, no answer within the timeout, a
 *     dropped connection or an answer that can't be read throws
 *     UnclearWriteError, because the change may have been made (an enable
 *     once answered 200 with an empty body, 08/11/2026). A 429 waits for
 *     Retry-After and sends either again, because Sophos did not act on it.
 *   - A 4xx throws SophosHttpError with its status. The 503 Fusion gives for
 *     a tenant it does not hold throws FusionNotAvailableError, never retried.
 *   - A redirect is refused (SophosRedirectError), and never retried.
 *
 * GraphQL client for the Sophos Fusion APIs. One endpoint for every tenant,
 * with the same bearer token and X-Tenant-ID header the REST client sends; a
 * partner or organization credential sends the managed tenant's ID there and
 * nothing else (an X-Partner-ID beside it is refused with 400, measured
 * 08/11/2026). A GraphQL-layer failure comes back as HTTP 200 with an
 * `errors` array, so a 200 is not success until its body has been read.
 */

import type { TokenManager } from "../auth/token-manager.js";
import { refuseRedirect } from "../redirect.js";
import { SOPHOS_FUSION_GRAPHQL_URL } from "../constants.js";
import { NOT_SENT, SophosHttpError, UnclearWriteError, networkCode } from "./sophos-client.js";

/** One entry of a GraphQL response's `errors` array. */
export interface GraphQLErrorEntry {
  message: string;
  path?: Array<string | number>;
  extensions?: Record<string, unknown>;
}

/** The GraphQL layer refused the request: errors and no usable data. */
export class FusionGraphQLError extends Error {
  constructor(
    message: string,
    readonly errors: GraphQLErrorEntry[],
  ) {
    super(message);
    this.name = "FusionGraphQLError";
  }

  /** True when every error says the record does not exist ("policy not found"). */
  get notFound(): boolean {
    return this.errors.length > 0 && this.errors.every((e) => /\bnot found\b/i.test(e.message ?? ""));
  }
}

/**
 * The 503 Fusion answers for a tenant it does not hold, or one this
 * credential can't reach there: "tenant <id> not found or not accessible"
 * (measured on a partner's managed tenant, 08/11/2026). The answer is the
 * same every time, so it is never retried.
 */
export class FusionNotAvailableError extends SophosHttpError {
  constructor(readonly tenantId: string) {
    super(
      `Sophos Fusion does not hold tenant ${tenantId}, or this credential can't reach it there, so its AI Defense policies can't be read or written.`,
      503,
    );
    this.name = "FusionNotAvailableError";
  }
}

const NOT_ON_FUSION = /\btenant (\S+) not found or not accessible\b/i;

/** The attempts for a query, and the waits between them. */
const ATTEMPTS = 3;
const TIMEOUT_MS = 30_000;

export class FusionClient {
  constructor(
    private readonly tokenManager: TokenManager,
    private readonly url: string = SOPHOS_FUSION_GRAPHQL_URL,
  ) {}

  /**
   * Runs a query or mutation for a tenant and returns its `data`. Throws
   * FusionGraphQLError when the answer carries errors and no usable data.
   */
  async query<T extends object>(tenantId: string, document: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = await this.tokenManager.getToken();
    const init: globalThis.RequestInit = {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "X-Tenant-ID": tenantId,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ query: document, variables }),
    };
    const body = await this.send(init, /^\s*mutation\b/.test(document), tenantId);
    return interpretGraphQLBody<T>(body);
  }

  private async send(init: globalThis.RequestInit, mutation: boolean, tenantId: string): Promise<unknown> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const canRetry = attempt < ATTEMPTS - 1;
      const retryQuery = async (error: Error): Promise<void> => {
        if (mutation || !canRetry) throw error;
        lastError = error;
        const backoff = Math.pow(2, attempt) * 1000;
        console.error(`[fusion-client] Request failed, retrying in ${backoff}ms: ${error.message}`);
        await sleep(backoff);
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        let response: globalThis.Response;
        try {
          // A redirect is refused rather than followed: the request carries the tenant's ID and the query to the new host.
          response = await fetch(this.url, { ...init, redirect: "manual", signal: controller.signal });
        } catch (error) {
          const code = networkCode(error);
          const reason = controller.signal.aborted
            ? `Sophos Fusion request got no answer within ${TIMEOUT_MS / 1000} s`
            : `Sophos Fusion request failed: ${error instanceof Error ? error.message : String(error)}${code ? ` (${code})` : ""}`;
          // A connection that never opened sent nothing, so a mutation is known not to have happened.
          if (mutation) throw code && NOT_SENT.has(code) ? new Error(reason) : new UnclearWriteError(reason, "POST");
          await retryQuery(new Error(reason));
          continue;
        }

        refuseRedirect(response, this.url);

        if (response.status === 429) {
          const retryAfter = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
          const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 5000;
          if (!canRetry) {
            throw new SophosHttpError(`Sophos Fusion API error 429: rate limited after ${ATTEMPTS} attempts`, 429);
          }
          console.error(`[fusion-client] Rate limited, waiting ${waitMs}ms (attempt ${attempt + 1})`);
          await sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          if (response.status === 503) {
            const notOnFusion = NOT_ON_FUSION.exec(text);
            if (notOnFusion) throw new FusionNotAvailableError(notOnFusion[1] ?? tenantId);
          }
          const msg = `Sophos Fusion API error ${response.status}: ${errorDetail(text)}`;
          if (response.status < 500) throw new SophosHttpError(msg, response.status);
          if (mutation) throw new UnclearWriteError(msg, "POST", response.status);
          await retryQuery(new SophosHttpError(msg, response.status));
          continue;
        }

        const text = await response.text();
        try {
          return JSON.parse(text);
        } catch {
          const reason = `Sophos Fusion answered ${response.status} with a body that could not be read${text.trim() ? "" : " (it was empty)"}`;
          if (mutation) throw new UnclearWriteError(reason, "POST", response.status);
          await retryQuery(new Error(reason));
        }
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error("Sophos Fusion request failed after retries");
  }
}

/** The messages of a refused request: the GraphQL errors when there are any, else the start of the body. */
function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { errors?: GraphQLErrorEntry[]; message?: string; error?: string };
    if (Array.isArray(parsed.errors) && parsed.errors.length) return parsed.errors.map((e) => e.message).join("; ");
    const plain = [parsed.error, parsed.message].filter(Boolean).join(" - ");
    if (plain) return plain;
  } catch {
    // Not JSON.
  }
  return text.slice(0, 500) || "no detail";
}

/**
 * What a 200 means. Errors with no usable data throw, with every message.
 * Usable data is returned, with any errors beside it written to the log.
 */
export function interpretGraphQLBody<T extends object>(body: unknown): T {
  const b = (body ?? {}) as { data?: unknown; errors?: unknown };
  const errors = Array.isArray(b.errors) ? (b.errors as GraphQLErrorEntry[]) : [];
  const data = b.data;
  const usable = data !== null && typeof data === "object" && Object.values(data as object).some((v) => v !== null && v !== undefined);
  if (errors.length && !usable) {
    throw new FusionGraphQLError(errors.map((e) => e.message ?? "unknown error").join("; "), errors);
  }
  if (data === null || typeof data !== "object") {
    throw new Error("Sophos Fusion answered without data or errors");
  }
  if (errors.length) console.error(`[fusion-client] Partial answer: ${errors.map((e) => e.message).join("; ")}`);
  return data as T;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
