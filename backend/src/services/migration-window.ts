/**
 * Device Migration pre-flight: reads GET /endpoint/v1/settings/migration on
 * both tenants and says whether the sending tenant will let devices leave.
 * Read only.
 */

import { requireContext } from "../state.js";
import { getMigrationSettings, type SophosMigrationSettings } from "../sophos/api/migration-settings.js";
import type { TenantLabel } from "../sophos/tenant-context.js";
import type { MigrationDirection } from "./device-migrator.js";

export type WindowStatus = "open" | "closing" | "closed" | "off" | "unknown";

export interface MigrationWindowCheck {
  side: TenantLabel;
  role: "sending" | "receiving";
  tenantName: string | null;
  status: WindowStatus;
  enabled: boolean | null;
  expiresAt: string | null;
  /** True when the window has no end date, or one so far out it has none in practice. */
  noTimeLimit: boolean;
  /** Hours until the window closes, when it closes within the next day. */
  hoursLeft: number | null;
  message: string;
  error?: string;
}

export interface MigrationWindowResult {
  direction: MigrationDirection;
  checkedAt: string;
  sending: MigrationWindowCheck;
  receiving: MigrationWindowCheck;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** An expiry more than ten years out is treated as "no time limit". */
const NO_LIMIT_AFTER_MS = 10 * 365 * DAY_MS;

/**
 * Turn the raw setting into a status and a sentence. Pure, so it is unit tested.
 * A window closing within a day is flagged, because devices that have not
 * checked in by then will not move.
 */
export function evaluateMigrationWindow(
  settings: SophosMigrationSettings,
  now: Date = new Date(),
): Pick<MigrationWindowCheck, "status" | "enabled" | "expiresAt" | "noTimeLimit" | "hoursLeft" | "message"> {
  const enabled = typeof settings.enabled === "boolean" ? settings.enabled : null;
  const expiresAt = settings.expiresAt ?? null;
  const base = { enabled, expiresAt, noTimeLimit: false, hoursLeft: null as number | null };

  if (enabled === false) {
    return { ...base, status: "off", message: "Device migration is turned off on this tenant." };
  }
  if (enabled === null) {
    return { ...base, status: "unknown", message: "The API did not say whether device migration is on." };
  }
  if (!expiresAt) {
    return { ...base, noTimeLimit: true, status: "open", message: "Device migration is on, with no end date." };
  }
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) {
    return { ...base, status: "unknown", message: `Device migration is on, but the end date "${expiresAt}" could not be read.` };
  }
  const msLeft = expiry.getTime() - now.getTime();
  if (msLeft <= 0) {
    return { ...base, status: "closed", message: `The migration window closed on ${formatDate(expiry)}.` };
  }
  if (msLeft > NO_LIMIT_AFTER_MS) {
    return { ...base, noTimeLimit: true, status: "open", message: "Device migration is on, with no practical time limit." };
  }
  if (msLeft < DAY_MS) {
    const hoursLeft = Math.max(1, Math.round(msLeft / 3_600_000));
    return {
      ...base,
      hoursLeft,
      status: "closing",
      message: `The window closes in about ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"}. Devices that have not checked in by then will not move.`,
    };
  }
  return { ...base, status: "open", message: `Device migration is on until ${formatDate(expiry)}.` };
}

export async function checkMigrationWindow(direction: MigrationDirection): Promise<MigrationWindowResult> {
  const sendingSide: TenantLabel = direction === "dest-to-source" ? "dest" : "source";
  const receivingSide: TenantLabel = sendingSide === "source" ? "dest" : "source";
  const [sending, receiving] = await Promise.all([
    checkSide(sendingSide, "sending"),
    checkSide(receivingSide, "receiving"),
  ]);
  return { direction, checkedAt: new Date().toISOString(), sending, receiving };
}

async function checkSide(side: TenantLabel, role: "sending" | "receiving"): Promise<MigrationWindowCheck> {
  const ctx = requireContext(side);
  const tenantName = ctx.summary.displayName;
  try {
    const settings = await getMigrationSettings(ctx.client, ctx.tenantId);
    return { side, role, tenantName, ...evaluateMigrationWindow(settings) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      side,
      role,
      tenantName,
      status: "unknown",
      enabled: null,
      expiresAt: null,
      noTimeLimit: false,
      hoursLeft: null,
      message: "Could not read the Device Migration setting.",
      error,
    };
  }
}

export function formatDate(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
