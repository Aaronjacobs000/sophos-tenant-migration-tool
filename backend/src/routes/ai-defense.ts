/**
 * Sophos AI Defense policies.
 *   GET    /api/:side/ai-defense/policies         { items, settings } (settings null: AI Defense not set up)
 *   DELETE /api/dest/ai-defense/policies/:id      the undo for a copy; refuses the base policy and partner policies
 *   GET    /api/compare/ai-defense/policies       { matches }: each source policy's match on the destination
 *   POST   /api/migrate/ai-defense   { policyIds, dryRun, overwrite }
 *          overwrite: true replaces a same-name destination policy whose content differs
 */

import { Router } from "express";
import { sideParam } from "../middleware/side-param.js";
import { requireConfigured } from "../middleware/require-configured.js";
import { getAiPolicy, getAiSettings, listAiPolicies, deleteAiPolicy } from "../sophos/api/ai-defense.js";
import { FusionGraphQLError } from "../sophos/client/fusion-client.js";
import { AI_POLICY_RESOURCE, compareAiPolicies, copyAiPolicies } from "../services/ai-defense-copier.js";
import { auditedWrite } from "../services/audit-log.js";

export const aiDefenseRouter = Router();
export const migrateAiDefenseRouter = Router();

const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

aiDefenseRouter.use("/:side/ai-defense", requireConfigured, sideParam);

aiDefenseRouter.get("/:side/ai-defense/policies", async (_req, res, next) => {
  try {
    const ctx = res.locals.tenantContext!;
    const [items, settings] = await Promise.all([
      listAiPolicies(ctx.fusion, ctx.tenantId),
      getAiSettings(ctx.fusion, ctx.tenantId).then(
        (value) => ({ value }),
        (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
      ),
    ]);
    res.json({ items, ...("error" in settings ? { settingsError: settings.error } : { settings: settings.value }) });
  } catch (err) {
    next(err);
  }
});

// Deletes are the undo for a copy, so they are offered on the destination only.
aiDefenseRouter.delete("/:side/ai-defense/policies/:id", async (req, res, next) => {
  try {
    if (req.params.side !== "dest") {
      res.status(400).json({ error: "bad_request", message: "AI Defense policies can only be deleted on the destination" });
      return;
    }
    const ctx = res.locals.tenantContext!;
    const id = req.params.id!;
    let policy;
    try {
      policy = await getAiPolicy(ctx.fusion, ctx.tenantId, id);
    } catch (err) {
      if (err instanceof FusionGraphQLError && err.notFound) policy = null;
      else throw err;
    }
    if (!policy) {
      res.status(404).json({ error: "not_found", message: "no AI Defense policy with this ID on the destination" });
      return;
    }
    if (policy.kind === "TENANT_BASE") {
      res.status(400).json({ error: "bad_request", message: "the base policy can't be deleted" });
      return;
    }
    if (policy.origin === "PARTNER") {
      res.status(400).json({ error: "bad_request", message: "a partner policy is read only on the tenant and can't be deleted here" });
      return;
    }
    await auditedWrite(ctx, "delete", AI_POLICY_RESOURCE, id, () => deleteAiPolicy(ctx.fusion, ctx.tenantId, id), { name: policy.name });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

migrateAiDefenseRouter.use(["/migrate/ai-defense", "/compare/ai-defense"], requireConfigured);

migrateAiDefenseRouter.get("/compare/ai-defense/policies", async (_req, res, next) => {
  try {
    res.json({ matches: await compareAiPolicies() });
  } catch (err) {
    next(err);
  }
});

migrateAiDefenseRouter.post("/migrate/ai-defense", async (req, res, next) => {
  try {
    const policyIds = strings(req.body?.policyIds);
    if (!policyIds.length) {
      res.status(400).json({ error: "bad_request", message: "policyIds[] required" });
      return;
    }
    const dryRun = req.query?.dryRun === "true" || req.body?.dryRun === true;
    const overwrite = req.body?.overwrite === true;
    res.json({ results: await copyAiPolicies({ policyIds, dryRun, overwrite }) });
  } catch (err) {
    next(err);
  }
});
