/**
 * Unified JSON error response for uncaught route errors. An error Sophos
 * answered with an HTTP status (a 404 for a policy that is gone, a 400 for a
 * body it refused) is passed on with that status; anything else is a 500.
 */

import type { Request, Response, NextFunction } from "express";
import { log, maskSecrets } from "../log.js";
import { SophosHttpError, UnclearWriteError } from "../sophos/client/sophos-client.js";

/** The status Sophos answered with, when the error carries one. */
function sophosStatus(err: unknown): number | undefined {
  if (err instanceof SophosHttpError || err instanceof UnclearWriteError) {
    return err.status !== undefined && err.status >= 400 && err.status <= 599 ? err.status : undefined;
  }
  return undefined;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  const message = maskSecrets(err instanceof Error ? err.message : String(err));
  log.error(`[${req.method} ${req.path}] ${message}`);
  if (res.headersSent) return;
  const status = sophosStatus(err);
  if (status) {
    res.status(status).json({ error: "sophos_error", status, message });
    return;
  }
  res.status(500).json({ error: "internal_error", message });
}
