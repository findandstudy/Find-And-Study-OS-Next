import { db, settingsTable } from "@workspace/db";

export type YearDetail = { year: number; startDate: string; endDate: string };

export function normalizeYears(raw: unknown): YearDetail[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(item => {
      if (typeof item === "number" && Number.isFinite(item)) {
        const y = Math.trunc(item);
        return { year: y, startDate: `${y}-01-01`, endDate: `${y}-12-31` };
      }
      if (item && typeof item === "object") {
        const obj = item as Record<string, unknown>;
        const y = typeof obj.year === "number" ? obj.year : parseInt(String(obj.year), 10);
        if (!Number.isFinite(y)) return null;
        const startDate = typeof obj.startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.startDate)
          ? obj.startDate
          : `${y}-01-01`;
        const endDate = typeof obj.endDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(obj.endDate)
          ? obj.endDate
          : `${y}-12-31`;
        return { year: Math.trunc(y), startDate, endDate };
      }
      return null;
    })
    .filter((x): x is YearDetail => x !== null)
    .sort((a, b) => a.year - b.year);
}

let cache: { ts: number; details: YearDetail[] } | null = null;
const TTL_MS = 30_000;

export async function getYearDetails(): Promise<YearDetail[]> {
  const now = Date.now();
  if (cache && now - cache.ts < TTL_MS) return cache.details;
  try {
    const [row] = await db.select({ availableYears: settingsTable.availableYears }).from(settingsTable);
    const details = normalizeYears(row?.availableYears ?? null);
    cache = { ts: now, details };
    return details;
  } catch {
    return [];
  }
}

export function invalidateSeasonCache() {
  cache = null;
}

function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function getCurrentSeason(): Promise<string> {
  const today = todayIso();
  const details = await getYearDetails();
  const match = details.find(d => d.startDate <= today && today <= d.endDate);
  if (match) return String(match.year);
  return String(new Date().getFullYear());
}
