/**
 * Read-only pre-flight checks for the Start migration page.
 *   GET  /api/checks/migration-window?direction=source-to-dest
 *   POST /api/checks/licenses            { endpointIds, direction }
 *   POST /api/checks/tamper-protection   { endpointIds, direction }
 *   POST /api/checks/known-issues        { endpointIds, direction }
 * All only read from Sophos. The licence, tamper protection and known issues
 * checks are POSTs because the selection can be long.
 */

import { Router } from "express";
import { requireConfigured } from "../middleware/require-configured.js";
import { checkMigrationWindow } from "../services/migration-window.js";
import { checkLicenses } from "../services/license-check.js";
import { checkTamperProtection } from "../services/tamper-check.js";
import { checkKnownIssues } from "../services/known-issues.js";
import type { MigrationDirection } from "../services/device-migrator.js";

export const checksRouter = Router();

checksRouter.use("/checks", requireConfigured);

function direction(value: unknown): MigrationDirection {
  return value === "dest-to-source" ? "dest-to-source" : "source-to-dest";
}

checksRouter.get("/checks/migration-window", async (req, res, next) => {
  try {
    res.json(await checkMigrationWindow(direction(req.query.direction)));
  } catch (err) {
    next(err);
  }
});

function endpointIds(body: unknown): string[] {
  const ids = (body as { endpointIds?: unknown } | undefined)?.endpointIds;
  return Array.isArray(ids) ? ids.filter((id: unknown): id is string => typeof id === "string") : [];
}

checksRouter.post("/checks/licenses", async (req, res, next) => {
  try {
    res.json(await checkLicenses({ endpointIds: endpointIds(req.body), direction: direction(req.body?.direction) }));
  } catch (err) {
    next(err);
  }
});

checksRouter.post("/checks/tamper-protection", async (req, res, next) => {
  try {
    res.json(await checkTamperProtection({ endpointIds: endpointIds(req.body), direction: direction(req.body?.direction) }));
  } catch (err) {
    next(err);
  }
});

checksRouter.post("/checks/known-issues", async (req, res, next) => {
  try {
    res.json(await checkKnownIssues({ endpointIds: endpointIds(req.body), direction: direction(req.body?.direction) }));
  } catch (err) {
    next(err);
  }
});
