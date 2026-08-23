import { createHash } from "node:crypto";
import { coalesceRead } from "./readPathCoalescing";
import { recordCacheEvent } from "./requestTelemetry";

type CacheEntry = { expiresAt: number; value: unknown };

const facetCache = new Map<string, CacheEntry>();
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function buildFacetFilterInput(
  query: Record<string, string>,
): Record<string, string> {
  const responseOnlyKeys = new Set([
    "page", "limit", "pageSize", "sortKey", "sortDir",
    "includeFacets", "includeTotals", "pipelineSummary",
  ]);
  return Object.fromEntries(
    Object.entries(query).filter(([key]) => !responseOnlyKeys.has(key)),
  );
}

export function buildScopeFingerprint(scope: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(scope)))
    .digest("hex");
}

function isFacetCacheEnabled(): boolean {
  return process.env.FACET_CACHE_ENABLED === "true";
}

function touch(key: string, entry: CacheEntry): void {
  facetCache.delete(key);
  facetCache.set(key, entry);
}

function setBounded(key: string, value: unknown): void {
  const ttlMs = positiveInt(process.env.FACET_CACHE_TTL_MS, DEFAULT_TTL_MS);
  touch(key, { expiresAt: Date.now() + ttlMs, value });
  const maxEntries = positiveInt(process.env.FACET_CACHE_MAX_ENTRIES, DEFAULT_MAX_ENTRIES);
  while (facetCache.size > maxEntries) {
    const oldest = facetCache.keys().next().value as string | undefined;
    if (!oldest) break;
    facetCache.delete(oldest);
  }
}

export async function loadFacetValue<T>(options: {
  namespace: string;
  scope: Record<string, unknown>;
  filters: Record<string, unknown>;
  load: () => Promise<T>;
}): Promise<T> {
  if (!isFacetCacheEnabled()) return options.load();

  const key = buildScopeFingerprint({
    namespace: options.namespace,
    scope: options.scope,
    filters: options.filters,
  });
  const cached = facetCache.get(`${options.namespace}:${key}`);
  if (cached && cached.expiresAt > Date.now()) {
    touch(`${options.namespace}:${key}`, cached);
    recordCacheEvent("facet", "hit");
    return structuredClone(cached.value) as T;
  }
  if (cached) facetCache.delete(`${options.namespace}:${key}`);
  recordCacheEvent("facet", "miss");

  const result = await coalesceRead({
    namespace: `facet-cache:${options.namespace}`,
    key,
    enabled: true,
    execute: options.load,
  });
  setBounded(`${options.namespace}:${key}`, structuredClone(result.value));
  return result.value;
}

export function clearFacetCacheForTests(): void {
  facetCache.clear();
}
