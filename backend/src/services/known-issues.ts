/**
 * Known Sophos issues that affect a device move. Read only.
 *
 * Each entry in KNOWN_ISSUES is an issue from the Sophos Known Issues list
 * that the pre-flight can spot from the two tenants and the selection. When
 * Sophos fixes one, delete its entry and its tests: the Start migration page
 * then says no known issue applies. Every finding warns and never blocks.
 */

import { requireContext } from "../state.js";
import { getEndpointsByIds } from "../sophos/api/endpoints.js";
import type { TenantLabel, TenantSummary } from "../sophos/tenant-context.js";
import type { SophosEndpoint } from "../sophos/types/sophos.js";
import { uniqueDeviceIds, type MigrationDirection } from "./device-migrator.js";

/** The Sophos Known Issues list. */
export const KNOWN_ISSUES_URL = "https://docs.sophos.com/support/kil/index.html";

export interface TenantRegion {
  side: TenantLabel;
  role: "sending" | "receiving";
  tenantName: string | null;
  /** The data region, such as eu01, or the API host when no region can be read from it; null when unknown. */
  region: string | null;
}

export interface SelectionRead {
  /** The selected devices' records, read from the sending tenant. */
  records: SophosEndpoint[];
  /** Selected devices that could not be read. */
  unread: number;
}

export interface MoveContext {
  sending: TenantRegion;
  receiving: TenantRegion;
  /** True when the tenants are in different data regions; null when either region is unknown. */
  crossRegion: boolean | null;
  /** The selected devices, read once on first use. */
  selection(): Promise<SelectionRead>;
}

export interface KnownIssue {
  /** The reference on the Known Issues list, such as MACEP-11452. */
  reference: string;
  /** The Known Issues list, opened at the issue's product. */
  url: string;
  /** The warning for this move, or null when the issue does not apply. */
  warning(move: MoveContext): Promise<string | null>;
}

export interface KnownIssueFinding {
  reference: string;
  url: string;
  warning: string;
}

export interface KnownIssuesResult {
  direction: MigrationDirection;
  checkedAt: string;
  sending: TenantRegion;
  receiving: TenantRegion;
  crossRegion: boolean | null;
  /** The reference of every issue checked. */
  checked: string[];
  findings: KnownIssueFinding[];
}

/** A Mac by its OS platform, or by its OS name when the platform is missing. */
export function isMac(ep: Pick<SophosEndpoint, "os">): boolean {
  const platform = ep.os?.platform ?? "";
  return platform ? /^mac/i.test(platform) : /\bmac ?os\b|\bos x\b/i.test(ep.os?.name ?? "");
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const KNOWN_ISSUES: KnownIssue[] = [
  {
    // Fusion Endpoint - Mac, listed on 05/10/2026 with the planned fixed version TBD.
    // A Mac moved through the API to another data region only partly migrates.
    reference: "MACEP-11452",
    url: `${KNOWN_ISSUES_URL}?product=MACEP`,
    async warning(move) {
      if (move.crossRegion === false) return null;
      const { records, unread } = await move.selection();
      const macs = records.filter(isMac).length;
      if (!macs && !unread) return null;
      const route = `(${move.sending.region} to ${move.receiving.region})`;
      const mayBe = plural(unread, "it may be a Mac", "they may be Macs");
      const unreadNote = unread ? ` ${unread} more selected ${plural(unread, "device", "devices")} could not be read, so ${mayBe}.` : "";
      let lead: string;
      if (move.crossRegion && macs) {
        lead = `${macs} selected ${plural(macs, "Mac is", "Macs are")} moving to another data region ${route}.${unreadNote}`;
      } else if (move.crossRegion) {
        lead = `This move goes to another data region ${route}, and ${unread} selected ${plural(unread, "device", "devices")} could not be read, so ${mayBe}.`;
      } else if (macs) {
        lead = `The tenants' data regions could not be compared, so check whether the ${macs} selected ${plural(macs, "Mac is", "Macs are")} moving to another region.${unreadNote}`;
      } else {
        lead = `The tenants' data regions could not be compared, and ${unread} selected ${plural(unread, "device", "devices")} could not be read, so ${mayBe}.`;
      }
      const target = macs && !unread ? plural(macs, "that Mac", "those Macs") : "any Macs";
      const fix = move.crossRegion
        ? `After the move, uninstall Sophos from ${target} and reinstall it from the receiving tenant.`
        : `If the regions differ, uninstall Sophos from ${target} after the move and reinstall it from the receiving tenant.`;
      return `MACEP-11452: ${lead} A Mac moved through the API to another region only partly migrates: updates, Live Query and Live Connect fail. ${fix}`;
    },
  },
];

/** The tenant's data region, or its API host when the host names no region. */
export function regionOf(summary: Pick<TenantSummary, "region" | "apiHost">): string | null {
  if (summary.region) return summary.region;
  try {
    return summary.apiHost ? new URL(summary.apiHost).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

export async function checkKnownIssues(req: { endpointIds: string[]; direction: MigrationDirection }): Promise<KnownIssuesResult> {
  const sendingSide: TenantLabel = req.direction === "dest-to-source" ? "dest" : "source";
  const receivingSide: TenantLabel = sendingSide === "source" ? "dest" : "source";
  const from = requireContext(sendingSide);
  const to = requireContext(receivingSide);
  const sending: TenantRegion = { side: sendingSide, role: "sending", tenantName: from.summary.displayName, region: regionOf(from.summary) };
  const receiving: TenantRegion = { side: receivingSide, role: "receiving", tenantName: to.summary.displayName, region: regionOf(to.summary) };
  const crossRegion = sending.region && receiving.region ? sending.region !== receiving.region : null;

  // Read only when an issue asks, and once for all of them.
  let read: Promise<SelectionRead> | null = null;
  const selection = () => (read ??= readSelection(from.client, from.tenantId, uniqueDeviceIds(req.endpointIds)));
  const move: MoveContext = { sending, receiving, crossRegion, selection };

  const findings: KnownIssueFinding[] = [];
  for (const issue of KNOWN_ISSUES) {
    const warning = await issue.warning(move);
    if (warning) findings.push({ reference: issue.reference, url: issue.url, warning });
  }

  return {
    direction: req.direction,
    checkedAt: new Date().toISOString(),
    sending,
    receiving,
    crossRegion,
    checked: KNOWN_ISSUES.map((i) => i.reference),
    findings,
  };
}

async function readSelection(client: Parameters<typeof getEndpointsByIds>[0], tenantId: string, ids: string[]): Promise<SelectionRead> {
  if (!ids.length) return { records: [], unread: 0 };
  const read = await getEndpointsByIds(client, tenantId, ids);
  const wanted = new Set(ids.map((id) => id.toLowerCase()));
  const records = read.records.filter((ep) => wanted.delete(ep.id.toLowerCase()));
  return { records, unread: wanted.size };
}
