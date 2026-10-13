/**
 * Vendored from sophos-central-mcp @ 1b10f6d3aa3f2d5ed3dce70533688b2a0f4dbe4d
 * Upstream: https://github.com/Aaronjacobs000/sophos-mcp/blob/main/src/client/sophos-client.ts
 * License: MIT
 *
 * Local modifications:
 *   - Attribution header added.
 *   - globalRequest() skips the caller's identity header when the request
 *     carries its own X-Tenant-ID or X-Distributor-ID, ported from upstream
 *     89a43af. The Licensing API needs this.
 *   - Only GET requests are retried after a 5xx, a timeout or a network
 *     error. A write that ends that way throws UnclearWriteError instead,
 *     because Sophos can answer 500 and still make the change. Any request
 *     answered 429 still waits and is sent again: Sophos did not act on it.
 *   - An error Sophos answered with an HTTP status throws SophosHttpError,
 *     which keeps the status, so the tool's own API can pass it on.
 *
 * HTTP client for Sophos Central APIs. Handles region-aware routing, auth
 * headers, retries, and error mapping. Supports tenant-scoped requests
 * (tenantRequest) and global/partner-scoped requests (globalRequest).
 */

import type { TokenManager } from "../auth/token-manager.js";
import type { TenantResolver } from "./tenant-resolver.js";
import type { SophosApiError } from "../types/sophos.js";

/** The advice on a write that ended without a clear answer. */
export const UNCLEAR_WRITE_ADVICE = "The change may still have gone through: check the destination before trying again.";

/**
 * A write (anything but GET) that ended without a clear answer: a 5xx, no
 * answer within the timeout, or a dropped connection. Sophos can answer 500
 * and still make the change (seen live on 26/09/2026), so the write is not
 * sent again, and the message says to check the destination first, unless
 * a read-back has already looked and gives its own advice.
 */
export class UnclearWriteError extends Error {
  constructor(
    /** What Sophos or the network said, without the advice. */
    readonly reason: string,
    readonly method: string,
    /** The HTTP status, when Sophos answered. */
    readonly status?: number,
    advice: string = UNCLEAR_WRITE_ADVICE,
  ) {
    super(`${reason.replace(/\.$/, "")}. ${advice}`);
    this.name = "UnclearWriteError";
  }
}

/** Sophos answered with an HTTP error status: 4xx at once, or 5xx on a read after its retries. */
export class SophosHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    // The name stays "Error", so the error reads as it did before it kept its status.
    super(message);
  }
}

/** Network errors raised before a connection opens, when no request reached Sophos. */
const NOT_SENT = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);

/** The system error code behind a failed fetch, if there is one. */
function networkCode(error: unknown): string | undefined {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
}

export class SophosClient {
  constructor(
    private tokenManager: TokenManager,
    private tenantResolver: TenantResolver,
  ) {}

  /**
   * Make a request to a tenant-scoped API endpoint.
   * Automatically resolves the regional API host for the tenant.
   */
  async tenantRequest<T>(
    tenantId: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const apiHost = await this.tenantResolver.resolveApiHost(tenantId);
    const token = await this.tokenManager.getToken();

    const url = new URL(`${apiHost}${path}`);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "X-Tenant-ID": tenantId,
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    };

    const fetchOptions: globalThis.RequestInit = {
      method: options.method || "GET",
      headers,
    };

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    return this.executeWithRetry<T>(url.toString(), fetchOptions);
  }

  /**
   * Make a request to a global API endpoint (partner/org level).
   */
  async globalRequest<T>(
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const identity = this.tenantResolver.getIdentity();
    const token = await this.tokenManager.getToken();
    const idHeader = this.tenantResolver.getIdHeader();

    const url = new URL(`${identity.apiHosts.global}${path}`);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== "") {
          url.searchParams.set(key, value);
        }
      }
    }

    // Some global-host APIs (licensing, accounts, audit, business automation) are
    // scoped by an explicit X-Tenant-ID / X-Distributor-ID header. Sending the
    // caller's identity header alongside those can be rejected, so skip it when
    // the caller provides its own scope header.
    const hasOwnScopeHeader =
      options.headers &&
      Object.keys(options.headers).some((h) =>
        ["x-tenant-id", "x-distributor-id"].includes(h.toLowerCase())
      );

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(hasOwnScopeHeader ? {} : { [idHeader.name]: idHeader.value }),
      ...(options.body !== undefined
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    };

    const fetchOptions: globalThis.RequestInit = {
      method: options.method || "GET",
      headers,
    };

    if (options.body) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    return this.executeWithRetry<T>(url.toString(), fetchOptions);
  }

  /**
   * Sends a request. GET requests are tried up to three times: a 5xx, a
   * timeout or a network error waits 1 s, then 2 s, and tries again. Other
   * methods are sent once, and a 5xx, timeout or network error throws
   * UnclearWriteError. A 429 waits for Retry-After and sends the request again
   * whatever the method, because Sophos refused it without acting on it. A 4xx
   * is thrown at once.
   */
  private async executeWithRetry<T>(
    url: string,
    options: globalThis.RequestInit,
    attempts = 3,
  ): Promise<T> {
    const method = String(options.method ?? "GET").toUpperCase();
    const isRead = method === "GET";
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const canRetry = attempt < attempts - 1;
      const retryRead = async (error: Error): Promise<void> => {
        if (!isRead || !canRetry) throw error;
        lastError = error;
        const backoff = Math.pow(2, attempt) * 1000;
        console.error(
          `[sophos-client] Request failed, retrying in ${backoff}ms: ${error.message}`,
        );
        await this.sleep(backoff);
      };

      // The timeout covers the answer's body too, so a write whose body stalls ends as unclear, not hung.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        let response: globalThis.Response;
        try {
          response = await fetch(url, {
            ...options,
            signal: controller.signal,
          });
        } catch (error) {
          const code = networkCode(error);
          const reason = controller.signal.aborted
            ? "Sophos API request got no answer within 30 s"
            : `Sophos API request failed: ${error instanceof Error ? error.message : String(error)}${code ? ` (${code})` : ""}`;
          // A connection that never opened sent nothing, so a write is known not to have happened.
          if (!isRead) throw code && NOT_SENT.has(code) ? new Error(reason) : new UnclearWriteError(reason, method);
          await retryRead(new Error(reason));
          continue;
        }

        if (response.status === 429) {
          const retryAfter = response.headers.get("Retry-After");
          const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
          if (!canRetry) {
            const body = await response.text().catch(() => "");
            throw new SophosHttpError(`Sophos API error 429: rate limited after ${attempts} attempts${body.trim() ? `: ${body.slice(0, 300)}` : ""}`, 429);
          }
          console.error(
            `[sophos-client] Rate limited, waiting ${waitMs}ms (attempt ${attempt + 1})`,
          );
          await this.sleep(waitMs);
          continue;
        }

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          let parsed: SophosApiError | null = null;
          try {
            parsed = JSON.parse(errorBody) as SophosApiError;
          } catch {
            // Not JSON
          }

          const msg = parsed
            ? `Sophos API error ${response.status}: ${parsed.error ?? "UnknownError"}${parsed.message ? ` - ${parsed.message}` : ""}${parsed.correlationId ? ` (correlationId: ${parsed.correlationId})` : ""}`
            : `Sophos API error (${response.status}): ${errorBody.slice(0, 500)}`;

          if (response.status < 500) throw new SophosHttpError(msg, response.status);
          if (!isRead) throw new UnclearWriteError(msg, method, response.status);
          await retryRead(new SophosHttpError(msg, response.status));
          continue;
        }

        if (response.status === 204) {
          return {} as T;
        }

        try {
          const text = await response.text();
          // A write can succeed with an empty body; that is not a failure.
          return (text.trim() ? JSON.parse(text) : {}) as T;
        } catch (error) {
          const reason = `Sophos API answered ${response.status} with a body that could not be read: ${error instanceof Error ? error.message : String(error)}`;
          if (!isRead) throw new UnclearWriteError(reason, method, response.status);
          await retryRead(new Error(reason));
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw lastError || new Error("Request failed after retries");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
