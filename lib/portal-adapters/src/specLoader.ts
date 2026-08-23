/**
 * specLoader.ts — loads DB-backed declarative adapter SPECs at runtime.
 *
 * This is the richer, VERSIONED sibling of dbLoader.ts. Where dbLoader reads
 * the flat `portal_adapters` table, this reads `portal_adapter_specs` — one row
 * per (key, version), with a single `enabled` version per key. The enabled spec
 * for each key is validated (declarative/schema), turned into a UniversityAdapter
 * via the interpreter, and exposed for the lowest-priority resolution fallback.
 *
 * Trust model: jsHook steps execute only when the row is `source="builtin"` OR
 * `js_hook_approved=true` (a super_admin decision). Untrusted specs still load
 * and run — their jsHook steps are skipped with a warning by the interpreter.
 *
 * Resilience: never throws to callers. A malformed spec row is skipped with a
 * warning; a DB error returns the last cached list (or empty).
 */

import { db, portalAdapterSpecsTable, type PortalAdapterSpec } from "@workspace/db";
import { and, asc, desc, eq } from "drizzle-orm";

import type { UniversityAdapter } from "./types.js";
import { logger } from "./browser.js";
import { parseAdapterSpec } from "./declarative/schema.js";
import { createSpecAdapter } from "./declarative/interpreter.js";

// ---------------------------------------------------------------------------
// Row → adapter
// ---------------------------------------------------------------------------

/** Whether a spec row is trusted to execute jsHook steps. */
export function specRowAllowsJsHook(row: Pick<PortalAdapterSpec, "source" | "jsHookApproved">): boolean {
  return row.source === "builtin" || row.jsHookApproved;
}

/**
 * Defense-in-depth for code-adapter replacement. Merely uploading/enabling a
 * v2 spec is insufficient: the parsed spec must request override resolution
 * and the stored version must carry explicit super-admin privileged approval.
 */
export function specRowAllowsOverride(
  row: Pick<PortalAdapterSpec, "spec" | "privilegedApproved" | "enabled">,
): boolean {
  if (!row.enabled || !row.privilegedApproved) return false;
  const parsed = parseAdapterSpec(row.spec);
  return (
    parsed.ok &&
    parsed.spec.specVersion === 2 &&
    parsed.spec.meta.resolution === "override"
  );
}

/**
 * Validates + converts a single enabled spec row into a UniversityAdapter.
 * Returns null (with a warning) when the stored spec fails validation.
 */
export function buildSpecAdapterFromRow(row: PortalAdapterSpec): UniversityAdapter | null {
  const parsed = parseAdapterSpec(row.spec);
  if (!parsed.ok) {
    logger.warn(
      `[specLoader] skipping spec "${row.key}" v${row.version}: ${parsed.error}`,
    );
    return null;
  }
  return createSpecAdapter(parsed.spec, { allowJsHook: specRowAllowsJsHook(row) });
}

/** Builds adapters from a list of enabled spec rows, skipping invalid ones. */
export function buildSpecAdaptersFromRows(rows: PortalAdapterSpec[]): UniversityAdapter[] {
  const out: UniversityAdapter[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.key)) continue; // one enabled version per key (defensive)
    const adapter = buildSpecAdapterFromRow(row);
    if (adapter) {
      out.push(adapter);
      seen.add(row.key);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB load + TTL cache (mirrors dbLoader)
// ---------------------------------------------------------------------------

const TTL_MS = (() => {
  const n = parseInt(process.env.PORTAL_ADAPTER_CACHE_TTL_MS ?? "30000", 10);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
})();

let cache: {
  at: number;
  list: UniversityAdapter[];
  overrideKeys: ReadonlySet<string>;
} | null = null;
let inflight: Promise<UniversityAdapter[]> | null = null;

/** Drops the cached spec adapter list so the next resolution re-reads the DB. */
export function invalidateSpecAdapterCache(): void {
  cache = null;
}

// Test seam — override the DB select to simulate errors or empty results.
let _dbSelectOverrideForTests: (() => Promise<PortalAdapterSpec[]>) | null = null;
/** @internal — test use only */
export function __setDbSelectOverrideForTests(
  fn: (() => Promise<PortalAdapterSpec[]>) | null,
): void {
  _dbSelectOverrideForTests = fn;
  cache = null;
  inflight = null;
}

async function fetchEnabledSpecRows(): Promise<PortalAdapterSpec[]> {
  if (_dbSelectOverrideForTests) return _dbSelectOverrideForTests();
  try {
    return await db
      .select()
      .from(portalAdapterSpecsTable)
      .where(eq(portalAdapterSpecsTable.enabled, true))
      .orderBy(asc(portalAdapterSpecsTable.key));
  } catch (err) {
    logger.warn(`[specLoader] failed to load adapter specs from DB: ${String(err)}`);
    return [];
  }
}

/**
 * Loads + caches the enabled declarative SPEC adapters from the DB. Never
 * throws: on a DB error it logs and returns the last cached list (or empty).
 */
export async function loadSpecAdaptersFromDb(force = false): Promise<UniversityAdapter[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return cache.list;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const rows = await fetchEnabledSpecRows();
      const list = buildSpecAdaptersFromRows(rows);
      const overrideKeys = new Set(
        rows.filter(specRowAllowsOverride).map((row) => row.key),
      );
      cache = { at: Date.now(), list, overrideKeys };
      return list;
    } catch (err) {
      logger.warn(`[specLoader] failed to load spec adapters from DB: ${String(err)}`);
      return cache?.list ?? [];
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** Resolves an enabled spec adapter by key (null when none). */
export async function resolveSpecAdapterByKey(key: string): Promise<UniversityAdapter | null> {
  const list = await loadSpecAdaptersFromDb();
  return list.find((a) => a.key === key) ?? null;
}

/** Resolves an enabled spec adapter by university name (null when none). */
export async function resolveSpecAdapterForUniversity(
  name: string,
): Promise<UniversityAdapter | null> {
  const list = await loadSpecAdaptersFromDb();
  return list.find((a) => a.matches(name)) ?? null;
}

/** Resolves only explicitly-approved v2 specs allowed to replace code. */
export async function resolveOverrideSpecAdapterByKey(
  key: string,
): Promise<UniversityAdapter | null> {
  const list = await loadSpecAdaptersFromDb();
  if (!cache?.overrideKeys.has(key)) return null;
  return list.find((adapter) => adapter.key === key) ?? null;
}

/** Name-based counterpart of resolveOverrideSpecAdapterByKey(). */
export async function resolveOverrideSpecAdapterForUniversity(
  name: string,
): Promise<UniversityAdapter | null> {
  const list = await loadSpecAdaptersFromDb();
  return (
    list.find(
      (adapter) => cache?.overrideKeys.has(adapter.key) && adapter.matches(name),
    ) ?? null
  );
}

// ---------------------------------------------------------------------------
// Version management helpers (used by the admin endpoints)
// ---------------------------------------------------------------------------

/** All versions for a key, newest first. */
export async function listSpecVersions(key: string): Promise<PortalAdapterSpec[]> {
  return db
    .select()
    .from(portalAdapterSpecsTable)
    .where(eq(portalAdapterSpecsTable.key, key))
    .orderBy(desc(portalAdapterSpecsTable.version));
}

/** The highest existing version number for a key (0 when none). */
export async function maxSpecVersion(key: string): Promise<number> {
  const [row] = await db
    .select({ version: portalAdapterSpecsTable.version })
    .from(portalAdapterSpecsTable)
    .where(eq(portalAdapterSpecsTable.key, key))
    .orderBy(desc(portalAdapterSpecsTable.version))
    .limit(1);
  return row?.version ?? 0;
}

/** The currently-enabled version row for a key (null when none enabled). */
export async function enabledSpecVersion(key: string): Promise<PortalAdapterSpec | null> {
  const [row] = await db
    .select()
    .from(portalAdapterSpecsTable)
    .where(
      and(
        eq(portalAdapterSpecsTable.key, key),
        eq(portalAdapterSpecsTable.enabled, true),
      ),
    )
    .limit(1);
  return row ?? null;
}
