import { db, campaignsTable, type Campaign } from "@workspace/db";
import { and, eq, isNull, lte, gte, desc } from "drizzle-orm";

export interface CampaignAdjustableFees {
  tuitionFee?: number | null;
  discountedFee?: number | null;
  serviceFeeAmount?: number | null;
  applicationFee?: number | null;
  depositFee?: number | null;
  advancedFee?: number | null;
  languageFee?: number | null;
}

function todayDateString(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Find the active campaign that applies to the given university and agent country.
 * Returns null if no campaign matches.
 *
 * Matching rules:
 * - isActive=true and not archived
 * - today is within [startDate, endDate]
 * - campaign.universityIds contains the universityId
 * - if campaign.agentCountries is empty -> applies to all agents (and direct apps)
 * - if campaign.agentCountries has items -> only matches when agentCountry is in that list
 *
 * If multiple campaigns match, the most recently created one wins.
 */
export async function findActiveCampaign(
  universityId: number | null | undefined,
  agentCountry: string | null | undefined,
  asOfDate?: string,
): Promise<Campaign | null> {
  if (!universityId) return null;
  const today = asOfDate || todayDateString();

  const candidates = await db
    .select()
    .from(campaignsTable)
    .where(
      and(
        eq(campaignsTable.isActive, true),
        isNull(campaignsTable.archivedAt),
        lte(campaignsTable.startDate, today),
        gte(campaignsTable.endDate, today),
      ),
    )
    .orderBy(desc(campaignsTable.createdAt), desc(campaignsTable.id));

  for (const c of candidates) {
    const unis = Array.isArray(c.universityIds) ? c.universityIds : [];
    if (!unis.includes(universityId)) continue;
    const countries: string[] = Array.isArray(c.agentCountries) ? (c.agentCountries as string[]) : [];
    if (countries.length > 0) {
      // Country-restricted campaign — must match agent country (case-insensitive).
      if (!agentCountry) continue;
      const ac = agentCountry.trim().toLowerCase();
      const ok = countries.some(cc => cc.trim().toLowerCase() === ac);
      if (!ok) continue;
    }
    return c;
  }
  return null;
}

/**
 * Apply a campaign's percentage change to a set of fee values.
 * - "discount" multiplies by (1 - p/100)
 * - "markup"   multiplies by (1 + p/100)
 * Null/undefined values are passed through unchanged.
 */
export function applyCampaignToFees<T extends CampaignAdjustableFees>(
  fees: T,
  campaign: Campaign | null,
): T {
  if (!campaign) return fees;
  const pct = Number(campaign.changePercent) || 0;
  if (pct === 0) return fees;
  const factor = campaign.changeType === "markup" ? (1 + pct / 100) : (1 - pct / 100);
  const adjust = (v: number | null | undefined): number | null | undefined => {
    if (v == null) return v;
    if (typeof v !== "number" || isNaN(v)) return v;
    return Math.round(v * factor * 100) / 100;
  };
  return {
    ...fees,
    tuitionFee: adjust(fees.tuitionFee),
    discountedFee: adjust(fees.discountedFee),
    serviceFeeAmount: adjust(fees.serviceFeeAmount),
    applicationFee: adjust(fees.applicationFee),
    depositFee: adjust(fees.depositFee),
    advancedFee: adjust(fees.advancedFee),
    languageFee: adjust(fees.languageFee),
  };
}
