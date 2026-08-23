import { db, knowledgeSourcesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { retrieveKnowledgeChunks } from "./knowledgeRetrieval";
import { resolveDormBookingCampusGuidance } from "./dormBookingCampusMap";

export const SEARCH_DORMBOOKING_CATALOG_TOOL_NAME = "searchDormBookingCatalog";

export const searchDormBookingCatalogToolDefinition = {
  name: SEARCH_DORMBOOKING_CATALOG_TOOL_NAME,
  description:
    "Search the bot's authoritative DormBooking Live Catalog. Use this before naming a dormitory, room, price, fee, gender eligibility, district or listing URL. An empty result means no catalog-backed answer is allowed.",
  input_schema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Student need or exact dormitory/room query" },
      orderBy: {
        type: "string",
        enum: ["relevance", "min_price_asc"],
        description: "Use min_price_asc when the student asks for cheapest, affordable, budget or price-ordered options",
      },
      includeUnpriced: {
        type: "boolean",
        description: "Include dorms without a published amount; they are always listed after priced dorms",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

export async function isDormBookingCatalogToolEnabled(aiBotId?: number | null): Promise<boolean> {
  if (!Number.isInteger(aiBotId) || Number(aiBotId) <= 0) return false;
  const [source] = await db.select({ id: knowledgeSourcesTable.id })
    .from(knowledgeSourcesTable)
    .where(and(
      eq(knowledgeSourcesTable.aiBotId, Number(aiBotId)),
      eq(knowledgeSourcesTable.type, "dormbooking"),
      eq(knowledgeSourcesTable.isActive, true),
      eq(knowledgeSourcesTable.status, "ready"),
    ));
  return Boolean(source);
}

export async function executeDormBookingCatalogTool(
  input: unknown,
  aiBotId?: number | null,
): Promise<{
  listings: Array<{
    dormId: number;
    dormName: string;
    city: string;
    genderEligibility: string;
    nearbyUniversities: string[];
    minPrice: number | null;
    currency: string;
    feePeriod: string;
    roomType: string;
    contractStart: string;
    contractEnd: string;
    sourceUrl: string;
  }>;
  matches: Array<{ source: string; content: string }>;
  authoritative: true;
}> {
  const request = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const query = typeof request.query === "string"
    ? request.query.trim()
    : "";
  if (!query || !(await isDormBookingCatalogToolEnabled(aiBotId))) {
    return { listings: [], matches: [], authoritative: true };
  }
  const chunks = await retrieveKnowledgeChunks(query, {
    aiBotId,
    sourceTypes: ["dormbooking"],
  });
  const campusGuidance = resolveDormBookingCampusGuidance(query);
  const byDorm = new Map<number, (typeof chunks)[number]>();
  for (const chunk of chunks) {
    const dormId = Number(chunk.metadata.dormBookingDormId);
    if (Number.isInteger(dormId) && dormId > 0 && !byDorm.has(dormId)) {
      byDorm.set(dormId, chunk);
    }
  }
  const includeUnpriced = request.includeUnpriced === true;
  const priceIntent = request.orderBy === "min_price_asc"
    || /cheap|cheapest|affordable|budget|lowest|price|cost|ucuz|bütçe|fiyat/i.test(query);
  const listings = [...byDorm.values()]
    .map((chunk) => {
      const metadata = chunk.metadata;
      const amount = Number(metadata.dormBookingMinPrice);
      const minPrice = Number.isFinite(amount) ? amount : null;
      return {
        dormId: Number(metadata.dormBookingDormId),
        dormName: String(metadata.dormBookingDormName ?? ""),
        city: String(metadata.dormBookingCity ?? ""),
        genderEligibility: String(metadata.dormBookingGenderEligibility ?? ""),
        nearbyUniversities: Array.isArray(metadata.dormBookingNearbyUniversities)
          ? metadata.dormBookingNearbyUniversities.map(String)
          : [],
        minPrice,
        currency: String(metadata.dormBookingMinPriceCurrency ?? ""),
        feePeriod: String(metadata.dormBookingMinPriceFeePeriod ?? ""),
        roomType: String(metadata.dormBookingMinPriceRoomType ?? ""),
        contractStart: String(metadata.dormBookingContractStart ?? ""),
        contractEnd: String(metadata.dormBookingContractEnd ?? ""),
        sourceUrl: String(metadata.sourceUrl ?? ""),
      };
    })
    .filter((listing) => listing.dormName && (!priceIntent || includeUnpriced || listing.minPrice !== null))
    .sort((a, b) => {
      if (!priceIntent) return 0;
      if (a.minPrice === null && b.minPrice === null) return a.dormName.localeCompare(b.dormName, "en");
      if (a.minPrice === null) return 1;
      if (b.minPrice === null) return -1;
      return a.minPrice - b.minPrice || a.dormName.localeCompare(b.dormName, "en");
    });
  return {
    listings,
    matches: [
      ...(campusGuidance ? [{ source: "DormBooking verified campus routing table", content: campusGuidance }] : []),
      ...chunks.map((chunk) => ({ source: chunk.sourceName, content: chunk.content })),
    ],
    authoritative: true,
  };
}
