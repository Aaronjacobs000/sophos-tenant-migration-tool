import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import dotenv from "dotenv";

import { initState } from "./state.js";
import { log } from "./log.js";
import { errorHandler } from "./middleware/error-handler.js";
import { localHostOnly } from "./middleware/local-host.js";
import { allowedClientsOnly } from "./middleware/client-ip.js";
import { addressUrl, listenErrorMessage, networkSettings, type NetworkSettings } from "./config/network.js";
import { auditWarnings } from "./services/audit-log.js";
import { statusRouter } from "./routes/status.js";
import { credentialsRouter } from "./routes/credentials.js";
import { policiesRouter } from "./routes/policies.js";
import { groupsRouter } from "./routes/groups.js";
import { exclusionsRouter } from "./routes/exclusions.js";
import { endpointsRouter } from "./routes/endpoints.js";
import { compareRouter } from "./routes/compare.js";
import { migrateConfigRouter } from "./routes/migrate-config.js";
import { migrateDevicesRouter } from "./routes/migrate-devices.js";
import { preloadRouter } from "./routes/preload.js";
import { logsRouter } from "./routes/logs.js";
import { searchRouter } from "./routes/search.js";
import { checksRouter } from "./routes/checks.js";
import { webFiltersRouter, migrateWebFiltersRouter } from "./routes/web-filters.js";
import { aiDefenseRouter, migrateAiDefenseRouter } from "./routes/ai-defense.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root is two levels up from backend/dist/ at runtime.
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Load .env from the repo root. Missing file is fine - server boots in
// "unconfigured" state and the welcome wizard handles first-run setup.
dotenv.config({ path: path.join(REPO_ROOT, ".env"), quiet: true });

/** HOST and ALLOWED_IPS, or a clear message and exit when either is invalid. */
function readNetworkSettings(): NetworkSettings {
  try {
    return networkSettings();
  } catch (err) {
    log.error(`Not starting: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/** Startup lines: who can connect, and a warning when that is anyone on the network. */
function logNetwork(network: NetworkSettings, port: number): void {
  if (!network.beyondLoopback) {
    if (network.allowList) log.info("ALLOWED_IPS has no effect while HOST is a loopback address: only this computer can connect.");
    return;
  }
  const names = (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  log.info(`host names accepted: 127.0.0.1, localhost, [::1], this computer's IP addresses${names.length ? `, ${names.join(", ")}` : ""}`);
  if (network.allowList) {
    log.info(`clients allowed: this computer, ${network.allowList.entries.join(", ")} (ALLOWED_IPS)`);
  } else {
    log.warn(
      `WARNING: listening beyond this computer with no ALLOWED_IPS. Anyone who can reach port ${port} can use the tool, ` +
        "and the Sophos credentials it holds. Set ALLOWED_IPS to the addresses or subnets that may use it.",
    );
  }
}

async function main() {
  const network = readNetworkSettings();
  await initState(REPO_ROOT);

  const PORT = Number(process.env.PORT ?? 3100);
  const HOST = network.host;

  const app = express();
  // First, so a client outside ALLOWED_IPS gets nothing at all.
  app.use(allowedClientsOnly(network.allowList));
  // Next, so a page on another site that reaches the tool by DNS rebinding gets nothing.
  app.use(localHostOnly);
  app.use(express.json({ limit: "2mb" }));
  // After the body parser, so every route runs inside it.
  app.use(auditWarnings);

  // --- Always-available API (no requireConfigured guard) ---
  app.use("/api", statusRouter);
  app.use("/api", credentialsRouter);

  // --- Specific routers FIRST so /api/compare/* and /api/migrate/* don't
  //     get matched by the per-side resource routers (which would treat
  //     "compare" or "migrate" as a :side path param value).
  app.use("/api", compareRouter);
  app.use("/api", migrateConfigRouter);
  app.use("/api", migrateDevicesRouter);
  app.use("/api", preloadRouter);
  app.use("/api", logsRouter);
  app.use("/api", searchRouter);
  app.use("/api", checksRouter);
  app.use("/api", migrateWebFiltersRouter);
  app.use("/api", migrateAiDefenseRouter);

  // --- Per-side resource APIs (guarded by requireConfigured) ---
  app.use("/api", policiesRouter);
  app.use("/api", groupsRouter);
  app.use("/api", exclusionsRouter);
  app.use("/api", endpointsRouter);
  app.use("/api", webFiltersRouter);
  app.use("/api", aiDefenseRouter);

  // --- Static frontend ---
  const FRONTEND_DIR = path.join(REPO_ROOT, "frontend");
  app.use(express.static(FRONTEND_DIR, { index: "index.html" }));

  // SPA-ish fallback: any non-API GET falls through to index.html so the
  // client-side router can redirect to the welcome wizard when unconfigured.
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api/")) return next();
    res.sendFile(path.join(FRONTEND_DIR, "index.html"));
  });

  app.use(errorHandler);

  // A HOST that isn't this computer's, a busy port or a bad PORT: one line and exit, no stack trace.
  const stop = (err: unknown): never => {
    log.error(`Not starting: ${listenErrorMessage(err, HOST, PORT)}`);
    process.exit(1);
  };
  try {
    app.listen(PORT, HOST, () => {
      log.info(`listening on ${addressUrl(HOST, PORT)} (repo: ${REPO_ROOT})`);
      logNetwork(network, PORT);
    }).on("error", stop);
  } catch (err) {
    stop(err);
  }
}

main().catch((err) => {
  log.error("fatal startup error", err);
  process.exit(1);
});
