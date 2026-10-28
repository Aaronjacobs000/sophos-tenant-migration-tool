/**
 * Tamper protection pre-flight for a device migration. Read only.
 *
 * A move doesn't need tamper protection turned off (Sophos lists no such
 * prerequisite, and moves with it on worked on 26/09/2026). A moved device
 * takes the receiving tenant's tamper protection, so this reads the global
 * setting on both tenants (GET /endpoint/v1/settings/tamper-protection) and
 * counts the selected devices that have it on now. It warns and never blocks.
 */

import { requireContext } from "../state.js";
import { getEndpointsByIds } from "../sophos/api/endpoints.js";
import { getGlobalTamperProtection } from "../sophos/api/tamper-protection.js";
import type { TenantLabel } from "../sophos/tenant-context.js";
import { uniqueDeviceIds, type MigrationDirection } from "./device-migrator.js";
import { tamperReading } from "./device-check-in.js";

export interface TenantTamperSetting {
  side: TenantLabel;
  role: "sending" | "receiving";
  tenantName: string | null;
  /** The tenant's global setting; null when it could not be read. */
  enabled: boolean | null;
  error?: string;
}

export interface SelectedTamper {
  total: number;
  on: number;
  off: number;
  /** Devices with no tamper protection to set, such as Linux. */
  unsupported: number;
  /** Devices that could not be read. */
  unknown: number;
}

export interface TamperCheckResult {
  direction: MigrationDirection;
  checkedAt: string;
  sending: TenantTamperSetting;
  receiving: TenantTamperSetting;
  selected: SelectedTamper;
  warnings: string[];
  selectedError?: string;
}

/** The warnings for a check. Pure, so it is unit tested. */
export function tamperWarnings(receiving: TenantTamperSetting, selected: SelectedTamper): string[] {
  const warnings: string[] = [];
  const name = receiving.tenantName ? ` (${receiving.tenantName})` : "";
  if (receiving.enabled === false) {
    warnings.push(
      `Tamper protection is off for the whole receiving tenant${name}, so moved devices will arrive without it` +
        `${selected.on ? `, including the ${selected.on} selected device${selected.on === 1 ? " that has" : "s that have"} it on now` : ""}. ` +
        "Turn it on there in Sophos Fusion under Global Settings > Tamper Protection; the API can only read this setting.",
    );
  } else if (receiving.enabled === null) {
    warnings.push(`The receiving tenant's tamper protection setting could not be read${receiving.error ? `: ${receiving.error}` : "."}`);
  }
  if (selected.unknown) {
    warnings.push(`${selected.unknown} selected device${selected.unknown === 1 ? "" : "s"} could not be read, so ${selected.unknown === 1 ? "it is" : "they are"} not counted.`);
  }
  return warnings;
}

export async function checkTamperProtection(req: { endpointIds: string[]; direction: MigrationDirection }): Promise<TamperCheckResult> {
  const sendingSide: TenantLabel = req.direction === "dest-to-source" ? "dest" : "source";
  const receivingSide: TenantLabel = sendingSide === "source" ? "dest" : "source";
  const ids = uniqueDeviceIds(req.endpointIds);
  const from = requireContext(sendingSide);

  const [sending, receiving, read] = await Promise.all([
    tenantSetting(sendingSide, "sending"),
    tenantSetting(receivingSide, "receiving"),
    ids.length ? getEndpointsByIds(from.client, from.tenantId, ids) : Promise.resolve({ records: [], failed: [] }),
  ]);

  const byId = new Map(read.records.map((ep) => [ep.id.toLowerCase(), ep]));
  const selected: SelectedTamper = { total: ids.length, on: 0, off: 0, unsupported: 0, unknown: 0 };
  for (const id of ids) {
    const ep = byId.get(id.toLowerCase());
    if (!ep) {
      selected.unknown++;
      continue;
    }
    const tp = tamperReading(ep as typeof ep & { tamperProtectionSupported?: boolean | null }, "");
    if (tp.supported === false) selected.unsupported++;
    else if (tp.enabled === true) selected.on++;
    else selected.off++;
  }

  return {
    direction: req.direction,
    checkedAt: new Date().toISOString(),
    sending,
    receiving,
    selected,
    warnings: tamperWarnings(receiving, selected),
    ...(read.failed.length ? { selectedError: read.failed[0]!.error } : {}),
  };
}

async function tenantSetting(side: TenantLabel, role: "sending" | "receiving"): Promise<TenantTamperSetting> {
  const ctx = requireContext(side);
  const tenantName = ctx.summary.displayName;
  try {
    const setting = await getGlobalTamperProtection(ctx.client, ctx.tenantId);
    return { side, role, tenantName, enabled: typeof setting.enabled === "boolean" ? setting.enabled : null };
  } catch (err) {
    return { side, role, tenantName, enabled: null, error: err instanceof Error ? err.message : String(err) };
  }
}
