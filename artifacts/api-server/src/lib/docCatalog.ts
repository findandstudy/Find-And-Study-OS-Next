import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

/**
 * Shared loader for the admin-managed document-type catalog
 * (`catalog_options` rows where `category='documents' AND is_active=true`).
 *
 * Why this module exists:
 *  - The embed widget needs the full metadata map (label, icon, accept) for
 *    rendering upload slots.
 *  - The bulk-program Excel import needs the same canonical key set to
 *    decide which columns in a row are document columns.
 *
 * Both used to bake their own list — embed had a 5-min in-memory cache,
 * import had a hardcoded ~100-entry constant (`PROGRAM_DOC_TYPES`) that
 * silently drifted whenever an admin added or removed a document type
 * (Task #179). Centralising here gives us one cache, one invalidation
 * hook, and one whitelist.
 *
 * Cache strategy:
 *  - 5-minute TTL.
 *  - In-flight promise dedupe so a stampede of cache-miss requests issues
 *    exactly one DB query.
 *  - On DB failure we serve the last good cache (or {}), keeping the
 *    widget and import alive instead of failing the whole request.
 *  - Warmed on module load (best-effort, errors swallowed).
 *  - `invalidateDocCatalog()` drops the cache instantly so admin
 *    create/update/delete is reflected on the very next read instead of
 *    waiting up to 5 minutes.
 */

export type DocCatalogEntry = { label: string; icon: string; accept: string };

const DOC_CATALOG_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ACCEPT = ".pdf,.jpg,.jpeg,.png";

const ACCEPT_RE = /^(\.[a-z0-9]{1,8})(,\.[a-z0-9]{1,8})*$/i;
// Catalog keys are admin-controlled but ultimately untrusted. Restrict
// shape so they're safe to use as object property names and as XLSX
// column headers (no spaces/punctuation that would break the import).
const KEY_RE = /^[a-z0-9_\-]{1,64}$/i;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export function isSafeDocKey(k: unknown): k is string {
  return typeof k === "string" && KEY_RE.test(k) && !RESERVED_KEYS.has(k.toLowerCase());
}

export function humaniseDocKey(k: string): string {
  return String(k || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function normaliseAccept(raw: unknown): string {
  const v = typeof raw === "string" ? raw.trim() : "";
  return ACCEPT_RE.test(v) ? v : DEFAULT_ACCEPT;
}

function normaliseShort(raw: unknown, fallback: string, max: number): string {
  const v = typeof raw === "string" ? raw.trim().slice(0, max) : "";
  return v || fallback;
}

// Catalog entries are kept in insertion order so the importer can derive a
// deterministic `sortOrder` that respects the admin-managed `sort_order`
// column (SELECT below ORDERs by it). Object.keys() preserves insertion
// order for string keys, so we don't need a separate ordered list.
let cache: Record<string, DocCatalogEntry> | null = null;
let cacheUntil = 0;
let inflight: Promise<Record<string, DocCatalogEntry>> | null = null;
// Generation token: bumped on invalidate(). Any in-flight load that
// completes against an old generation is discarded instead of overwriting
// the freshly invalidated cache — closes the race where an admin edits
// the catalog while a load is mid-flight.
let generation = 0;

const PHOTO_DOCUMENT_KEYS = new Set(["photo", "photograph", "passport_photo", "passport_size_photo_specifications"]);

function canonicalAccept(key: string, configured: unknown): string {
  return PHOTO_DOCUMENT_KEYS.has(key.trim().toLowerCase())
    ? ".pdf,.jpg,.jpeg,.png"
    : normaliseAccept(configured);
}

export async function loadDocCatalog(): Promise<Record<string, DocCatalogEntry>> {
  const now = Date.now();
  if (cache && now < cacheUntil) return cache;
  if (inflight) return inflight;
  const myGen = generation;
  inflight = (async () => {
    try {
      const result = await db.execute(sql`SELECT value, metadata FROM catalog_options WHERE category = 'documents' AND is_active = true ORDER BY sort_order ASC, id ASC`);
      const rows = (result as unknown as { rows?: Array<{ value: string; metadata: { label?: unknown; icon?: unknown; accept?: unknown } | null }> }).rows ?? [];
      // Null-prototype map so untrusted catalog keys can't shadow built-in
      // object properties (e.g. a row with value="__proto__" can't pollute).
      const map: Record<string, DocCatalogEntry> = Object.create(null);
      for (const row of rows) {
        const rawKey = String(row.value);
        if (!isSafeDocKey(rawKey)) continue;
        const md = row.metadata || {};
        map[rawKey] = {
          label: normaliseShort(md.label, humaniseDocKey(rawKey), 80),
          icon: normaliseShort(md.icon, "📎", 8),
          accept: canonicalAccept(rawKey, md.accept),
        };
      }
      // Only publish if no invalidation happened while we were loading.
      // Otherwise the freshly-busted cache would be silently re-filled
      // with stale data and TTL-extended.
      if (myGen === generation) {
        cache = map;
        cacheUntil = Date.now() + DOC_CATALOG_TTL_MS;
      }
      return map;
    } catch (err) {
      // Keep the widget and importer alive on transient DB errors. If
      // there's literally no cache yet (first call after boot, DB down),
      // return an empty map; the caller decides how to surface that.
      console.error("[docCatalog] load failed, serving previous cache:", (err as Error)?.message);
      if (myGen === generation) {
        cache = cache || Object.create(null);
        cacheUntil = Date.now() + DOC_CATALOG_TTL_MS;
      }
      return (cache ?? Object.create(null)) as Record<string, DocCatalogEntry>;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Cheap derived view used by the bulk-program importer: just the canonical
 * key set, no metadata. Backed by the same cache as `loadDocCatalog()`.
 * Ordering matches the catalog's `sort_order` (admin-managed) thanks to
 * Object.keys() insertion-order preservation.
 */
export async function loadDocCatalogKeySet(): Promise<Set<string>> {
  const map = await loadDocCatalog();
  return new Set(Object.keys(map));
}

/**
 * Drop the cache so the very next load hits the DB. Catalog mutation
 * routes call this after create/update/delete so admin changes show up
 * everywhere immediately instead of after the 5-minute TTL.
 *
 * Bumps the generation token so any concurrently-running load (started
 * before this call) will see its result discarded instead of clobbering
 * the freshly-invalidated cache.
 */
export function invalidateDocCatalog(): void {
  cache = null;
  cacheUntil = 0;
  generation++;
}

// Best-effort warm-up; failures are already logged inside loadDocCatalog.
void loadDocCatalog();
