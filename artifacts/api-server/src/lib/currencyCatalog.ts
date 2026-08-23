import { db, catalogOptionsTable } from "@workspace/db";
import { eq, and, asc } from "drizzle-orm";

/**
 * Live cache of currency codes configured under
 * catalog_options (category='currency'). 60s TTL, in-flight dedupe.
 * Falls back to the static seed set if the DB is unreachable so the
 * app keeps running.
 */

const FALLBACK = ["USD", "EUR", "GBP", "TRY", "AED"];

type CacheEntry = { ordered: string[]; set: Set<string>; expiresAt: number };
let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;
const TTL_MS = 60_000;

async function refresh(): Promise<CacheEntry> {
  try {
    const rows = await db
      .select({ value: catalogOptionsTable.value })
      .from(catalogOptionsTable)
      .where(and(eq(catalogOptionsTable.category, "currency"), eq(catalogOptionsTable.isActive, true)))
      .orderBy(asc(catalogOptionsTable.sortOrder), asc(catalogOptionsTable.id));
    const ordered = rows.map(r => String(r.value).toUpperCase()).filter(Boolean);
    if (ordered.length === 0) {
      return { ordered: [...FALLBACK], set: new Set(FALLBACK), expiresAt: Date.now() + TTL_MS };
    }
    return { ordered, set: new Set(ordered), expiresAt: Date.now() + TTL_MS };
  } catch {
    return { ordered: cache?.ordered ?? [...FALLBACK], set: new Set(cache?.ordered ?? FALLBACK), expiresAt: Date.now() + TTL_MS };
  }
}

export async function loadCurrencyCatalog(): Promise<CacheEntry> {
  if (cache && cache.expiresAt > Date.now()) return cache;
  if (inflight) return inflight;
  inflight = refresh().then(c => { cache = c; inflight = null; return c; });
  return inflight;
}

export function invalidateCurrencyCatalog(): void {
  cache = null;
}
