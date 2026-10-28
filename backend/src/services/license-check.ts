/**
 * Destination licence check for a device migration. Read only.
 *
 * Reads GET /licenses/v1/licenses for both tenants, then:
 *   - compares free seats on the receiving tenant with the devices selected,
 *     split into computers and servers;
 *   - lists products the sending tenant has that the receiving tenant lacks
 *     (endpoint and server protection, XDR, MDR, Device Encryption).
 *
 * Product codes and names map loosely to features, so every finding is a
 * warning. Nothing here blocks a migration.
 */

import { requireContext } from "../state.js";
import { listLicenses, type SophosLicense } from "../sophos/api/licenses.js";
import { getEndpointsByIds } from "../sophos/api/endpoints.js";
import { getSectionData } from "./preloader.js";
import type { TenantLabel } from "../sophos/tenant-context.js";
import type { SophosEndpoint } from "../sophos/types/sophos.js";
import { uniqueDeviceIds, type MigrationDirection } from "./device-migrator.js";

export type DeviceClass = "computer" | "server";
export type Family = "computer" | "server" | "xdr" | "mdr" | "encryption";

export const FAMILY_LABELS: Record<Family, string> = {
  computer: "Endpoint protection",
  server: "Server protection",
  xdr: "XDR",
  mdr: "MDR",
  encryption: "Device Encryption",
};

export interface LicenseSummary {
  name: string;
  code: string;
  type: string | null;
  quantity: number | null;
  unlimited: boolean;
  used: number;
  /** Free seats; null when unlimited or when the API gave no quantity. */
  free: number | null;
  endDate: string | null;
  perpetual: boolean;
  expired: boolean;
  expiresSoon: boolean;
  deviceClass: DeviceClass | null;
  families: Family[];
}

export interface SeatCheck {
  name: string;
  code: string;
  deviceClass: DeviceClass;
  needed: number;
  free: number | null;
  short: boolean;
}

export interface FamilyCheck {
  family: Family;
  label: string;
  sending: string[];
  receiving: string[];
  missing: boolean;
}

export interface SelectedCounts {
  total: number;
  computers: number;
  servers: number;
  unknown: number;
}

export interface LicenseAnalysis {
  receiving: LicenseSummary[];
  sending: LicenseSummary[];
  seats: SeatCheck[];
  families: FamilyCheck[];
  warnings: string[];
}

export interface LicenseCheckResult extends LicenseAnalysis {
  direction: MigrationDirection;
  checkedAt: string;
  sendingSide: TenantLabel;
  receivingSide: TenantLabel;
  selected: SelectedCounts;
  sendingError?: string;
  receivingError?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY_WARNING_DAYS = 30;

// Products that are not endpoint protection even when their name mentions
// something that is (the firewall integration pack for MDR, mobile, and so on).
const NOT_ENDPOINT = /(mobile|firewall|network detection|email|phish|cloud optix|zero trust|ztna|switch|access point|wi-?fi|wireless|workspace|legacy)/i;
const ENDPOINT = /(intercept x|endpoint|\bxdr\b|\bmdr\b|\bmtr\b|server protection)/i;

export function summariseLicense(raw: SophosLicense, now: Date = new Date()): LicenseSummary {
  const name = raw.product?.name ?? raw.product?.code ?? "Unknown product";
  const code = raw.product?.code ?? "";
  const unlimited = raw.unlimited === true;
  const quantity = typeof raw.quantity === "number" ? raw.quantity : null;
  const used = raw.usage?.current?.count ?? 0;
  const free = unlimited || quantity === null ? null : Math.max(0, quantity - used);
  const endDate = raw.endDate ?? null;
  const perpetual = raw.perpetual === true;
  const end = endDate ? new Date(`${endDate.slice(0, 10)}T23:59:59Z`) : null;
  const expired = !!end && !perpetual && end.getTime() < now.getTime();
  const expiresSoon = !!end && !perpetual && !expired && end.getTime() - now.getTime() < EXPIRY_WARNING_DAYS * DAY_MS;

  const families: Family[] = [];
  let deviceClass: DeviceClass | null = null;
  if (ENDPOINT.test(name) && !NOT_ENDPOINT.test(name)) {
    deviceClass = /server/i.test(name) ? "server" : "computer";
    families.push(deviceClass);
  }
  if (/\bxdr\b/i.test(name)) families.push("xdr");
  if (/\b(mdr|mtr)\b/i.test(name) && !NOT_ENDPOINT.test(name)) families.push("mdr");
  if (/device encryption/i.test(name)) families.push("encryption");

  return {
    name,
    code,
    type: raw.type ?? null,
    quantity,
    unlimited,
    used,
    free,
    endDate,
    perpetual,
    expired,
    expiresSoon,
    deviceClass,
    families,
  };
}

/** Pure analysis over both tenants' licences and the selection. */
export function analyseLicenses(
  sendingRaw: SophosLicense[],
  receivingRaw: SophosLicense[],
  selected: SelectedCounts,
  now: Date = new Date(),
): LicenseAnalysis {
  const sending = sendingRaw.map((l) => summariseLicense(l, now));
  const receiving = receivingRaw.map((l) => summariseLicense(l, now));
  const warnings: string[] = [];

  // Seats: every live endpoint or server licence on the receiving side is
  // checked against the devices of its class. A device takes a seat on each
  // product it uses, so licences are not added together.
  const seats: SeatCheck[] = [];
  for (const cls of ["computer", "server"] as DeviceClass[]) {
    const needed = cls === "computer" ? selected.computers : selected.servers;
    const live = receiving.filter((l) => l.deviceClass === cls && !l.expired);
    if (needed > 0 && live.length === 0) {
      warnings.push(
        `The destination has no ${cls === "server" ? "server" : "endpoint"} protection licence for the ${needed} selected ${cls === "server" ? "server" : "computer"}${needed === 1 ? "" : "s"}.`,
      );
    }
    if (needed === 0) continue;
    for (const l of live) {
      const short = l.free !== null && l.free < needed;
      seats.push({ name: l.name, code: l.code, deviceClass: cls, needed, free: l.free, short });
      if (short) {
        warnings.push(`${l.name}: ${l.free} free seat${l.free === 1 ? "" : "s"} for ${needed} selected ${cls === "server" ? "server" : "computer"}${needed === 1 ? "" : "s"}.`);
      }
    }
  }

  // Features the source has that the destination does not.
  const families: FamilyCheck[] = (Object.keys(FAMILY_LABELS) as Family[]).map((family) => {
    const s = unique(sending.filter((l) => !l.expired && l.families.includes(family)).map((l) => l.name));
    const r = unique(receiving.filter((l) => !l.expired && l.families.includes(family)).map((l) => l.name));
    const missing = s.length > 0 && r.length === 0;
    if (missing) {
      warnings.push(`The source has ${FAMILY_LABELS[family]} and the destination does not (${s.join(", ")}).`);
    }
    return { family, label: FAMILY_LABELS[family], sending: s, receiving: r, missing };
  }).filter((f) => f.sending.length > 0 || f.receiving.length > 0);

  for (const l of receiving) {
    if (!l.deviceClass && !l.families.length) continue;
    if (l.expired) warnings.push(`${l.name} on the destination expired on ${l.endDate}.`);
    else if (l.expiresSoon) warnings.push(`${l.name} on the destination ends on ${l.endDate}.`);
  }

  if (selected.unknown > 0) {
    warnings.push(`${selected.unknown} selected device${selected.unknown === 1 ? "" : "s"} could not be read, so ${selected.unknown === 1 ? "it is" : "they are"} not counted.`);
  }

  return { receiving, sending, seats, families, warnings };
}

export async function checkLicenses(req: {
  endpointIds: string[];
  direction: MigrationDirection;
}): Promise<LicenseCheckResult> {
  const sendingSide: TenantLabel = req.direction === "dest-to-source" ? "dest" : "source";
  const receivingSide: TenantLabel = sendingSide === "source" ? "dest" : "source";
  const from = requireContext(sendingSide);
  const to = requireContext(receivingSide);

  // A device listed more than once is read and counted once, as in a move.
  const [selected, sendingRes, receivingRes] = await Promise.all([
    countSelected(sendingSide, uniqueDeviceIds(req.endpointIds)),
    settle(listLicenses(from.client, from.tenantId)),
    settle(listLicenses(to.client, to.tenantId)),
  ]);

  const analysis = analyseLicenses(sendingRes.value ?? [], receivingRes.value ?? [], selected);
  if (receivingRes.error) {
    analysis.warnings.unshift(`Could not read the destination licences: ${receivingRes.error}`);
  }
  if (sendingRes.error) {
    analysis.warnings.push(`Could not read the source licences, so missing products are not checked: ${sendingRes.error}`);
  }

  return {
    ...analysis,
    direction: req.direction,
    checkedAt: new Date().toISOString(),
    sendingSide,
    receivingSide,
    selected,
    ...(sendingRes.error ? { sendingError: sendingRes.error } : {}),
    ...(receivingRes.error ? { receivingError: receivingRes.error } : {}),
  };
}

/**
 * Count the selected devices by class. Uses the preload cache for the sending
 * side and reads the devices it does not hold, a batch of IDs per call.
 */
async function countSelected(side: TenantLabel, ids: string[]): Promise<SelectedCounts> {
  const counts: SelectedCounts = { total: ids.length, computers: 0, servers: 0, unknown: 0 };
  const cached = getSectionData(side, "endpoints");
  const byId = new Map<string, SophosEndpoint>();
  if (cached.status.state === "ok") {
    for (const ep of cached.items as SophosEndpoint[]) byId.set(ep.id.toLowerCase(), ep);
  }
  const missing = ids.filter((id) => !byId.has(id.toLowerCase()));
  if (missing.length) {
    const ctx = requireContext(side);
    const read = await getEndpointsByIds(ctx.client, ctx.tenantId, missing);
    for (const ep of read.records) byId.set(ep.id.toLowerCase(), ep);
  }
  for (const id of ids) {
    const ep = byId.get(id.toLowerCase());
    if (!ep) {
      counts.unknown++;
      continue;
    }
    if (ep.type === "server" || ep.os?.isServer) counts.servers++;
    else counts.computers++;
  }
  return counts;
}

async function settle<T>(p: Promise<T>): Promise<{ value: T | null; error?: string }> {
  try {
    return { value: await p };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : String(err) };
  }
}

function unique(list: string[]): string[] {
  return [...new Set(list)];
}
