/**
 * dbLoader.ts — loads DB-defined declarative portal adapters at runtime.
 *
 * The declarative engine (`createDeclarativeAdapter`) can build a fully
 * functional UniversityAdapter from a JSON-serialisable config. Historically
 * the only source of those configs was the hardcoded `declarativeConfigs`
 * array. This loader makes the `portal_adapters` DB table a live source:
 * active rows with kind="declarative" are validated (zod + SSRF/allowlist),
 * converted via `createDeclarativeAdapter`, and merged into adapter resolution.
 *
 * Priority: code-based adapters ALWAYS win on a key/name conflict. A row whose
 * key collides with a code adapter is skipped. A malformed/empty config is
 * skipped with a warning — one bad row never blocks the others, and the loader
 * never throws to its callers (the worker keeps polling).
 *
 * Caching: the resolved list is cached for a short TTL. `portalMgmt.ts` calls
 * `invalidateDeclarativeAdapterCache()` after admin CRUD so api-server picks up
 * changes immediately; the separate worker process refreshes within the TTL.
 */

import { z } from "zod";
import { db, portalAdaptersTable } from "@workspace/db";

import type { UniversityAdapter } from "./types.js";
import {
  createDeclarativeAdapter,
  type DeclarativeConfig,
} from "./declarativeAdapter.js";
import { adapters, adapterByKey, adapterForUniversity } from "./registry.js";
import { logger } from "./browser.js";
import { PROFILE_FIELDS, FILE_FIELDS, isSafePortalUrl } from "./shared.js";
import {
  resolveSpecAdapterByKey,
  resolveSpecAdapterForUniversity,
  resolveOverrideSpecAdapterByKey,
  resolveOverrideSpecAdapterForUniversity,
} from "./specLoader.js";

// PROFILE_FIELDS / FILE_FIELDS / isSafePortalUrl moved to ./shared.js (a leaf
// module) so the richer spec engine can reuse them without an import cycle.
// Re-exported here so existing `@workspace/portal-adapters` consumers keep
// importing them from this module unchanged.
export { PROFILE_FIELDS, FILE_FIELDS, isSafePortalUrl } from "./shared.js";

const profileFieldSchema = z.enum(PROFILE_FIELDS);
const fileFieldSchema = z.enum(FILE_FIELDS);

const safeUrlSchema = z
  .string()
  .url()
  .refine(isSafePortalUrl, {
    message:
      "URL must be https and must not target a private/loopback/link-local/metadata host",
  });

// ---------------------------------------------------------------------------
// Step schema — union mirrors the DeclarativeStep type from the engine.
// (z.union, not discriminatedUnion: the "fill" variant is a refined effect.)
// ---------------------------------------------------------------------------

const navigateStep = z.object({
  type: z.literal("navigate"),
  url: safeUrlSchema,
});

const fillStep = z
  .object({
    type: z.literal("fill"),
    selector: z.string().min(1),
    field: profileFieldSchema.optional(),
    value: z.string().optional(),
  })
  .refine((s) => (s.field == null) !== (s.value == null), {
    message: 'fill step requires exactly one of "field" or "value"',
  });

const selectStep = z.object({
  type: z.literal("select"),
  selector: z.string().min(1),
  field: profileFieldSchema,
});

const clickStep = z.object({
  type: z.literal("click"),
  selector: z.string().min(1),
  final: z.boolean().optional(),
});

const checkStep = z.object({
  type: z.literal("check"),
  selector: z.string().min(1),
  value: z.boolean().optional(),
});

const radioStep = z.object({
  type: z.literal("radio"),
  field: profileFieldSchema,
  map: z.record(z.string().min(1), z.string().min(1)),
  fallback: z.string().min(1).optional(),
});

const selectLabelStep = z.object({
  type: z.literal("selectLabel"),
  selector: z.string().min(1),
  field: profileFieldSchema,
});

const phoneStep = z.object({
  type: z.literal("phone"),
  selector: z.string().min(1),
  field: profileFieldSchema,
  hiddenSelector: z.string().min(1).optional(),
});

const uploadStep = z.object({
  type: z.literal("upload"),
  selector: z.string().min(1),
  fileField: fileFieldSchema,
});

const waitStep = z.object({
  type: z.literal("wait"),
  selector: z.string().min(1),
});

const screenshotStep = z.object({
  type: z.literal("screenshot"),
});

const stepSchema = z.union([
  navigateStep,
  fillStep,
  selectStep,
  clickStep,
  uploadStep,
  waitStep,
  screenshotStep,
  checkStep,
  radioStep,
  selectLabelStep,
  phoneStep,
]);

const credentialsSchema = z.object({
  userSelector: z.string().min(1),
  passSelector: z.string().min(1),
  submitSelector: z.string().min(1),
  afterSelector: z.string().min(1).optional(),
});

const submitCheckSchema = z
  .object({
    successSelector: z.string().min(1).optional(),
    successText: z.string().min(1).optional(),
    alreadyExistsText: z.string().min(1).optional(),
    programMissingText: z.string().min(1).optional(),
  })
  .default({});

/**
 * zod schema mirroring DeclarativeConfig. MUST stay in lockstep with the
 * engine's `DeclarativeConfig` / `DeclarativeStep` types.
 */
export const declarativeConfigSchema = z.object({
  key: z.string().min(1).regex(/^[a-z0-9_-]+$/, {
    message: "key must be lowercase letters, digits, underscores or hyphens",
  }),
  label: z.string().min(1),
  matches: z.array(z.string().min(1)).min(1),
  loginUrl: safeUrlSchema,
  credentials: credentialsSchema,
  steps: z.array(stepSchema).min(1),
  submitCheck: submitCheckSchema,
});

// ---------------------------------------------------------------------------
// parseDeclarativeConfig — validate a raw config object
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; config: DeclarativeConfig }
  | { ok: false; error: string };

/**
 * Validates a raw (untyped) config object against the declarative schema.
 * Returns a typed config on success, or a descriptive error string on failure
 * (including empty `{}` and partial/malformed objects).
 */
export function parseDeclarativeConfig(raw: unknown): ParseResult {
  const res = declarativeConfigSchema.safeParse(raw);
  if (!res.success) {
    const error = res.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error };
  }
  // Runtime shape matches DeclarativeConfig; the cast bridges zod's wider
  // fill-step type (field?+value?) to the engine's xor union.
  return { ok: true, config: res.data as unknown as DeclarativeConfig };
}

// ---------------------------------------------------------------------------
// Row → adapter conversion (pure, DB-independent — unit testable)
// ---------------------------------------------------------------------------

/** Minimal structural row shape consumed by the loader (subset of PortalAdapter). */
export interface DeclarativeAdapterRow {
  key: string;
  label: string;
  baseUrl: string;
  matchNames: string;
  kind: "code" | "declarative";
  configJson: Record<string, unknown> | null;
  isActive: boolean;
  deletedAt: Date | null;
}

function splitMatchNames(s: string): string[] {
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Builds the raw config object validated by the schema. config_json is the
 * source of truth; the row's columns (key/label/matchNames/baseUrl) act as
 * fallbacks so the authoring tool may store the full config in config_json or
 * lean on the dedicated columns.
 */
export function rowToRawConfig(row: DeclarativeAdapterRow): Record<string, unknown> {
  const cj = (row.configJson ?? {}) as Record<string, unknown>;
  return {
    key: cj.key ?? row.key,
    label: cj.label ?? row.label,
    matches: cj.matches ?? splitMatchNames(row.matchNames),
    loginUrl: cj.loginUrl ?? row.baseUrl,
    credentials: cj.credentials,
    steps: cj.steps,
    submitCheck: cj.submitCheck ?? {},
  };
}

/** Keys of the statically registered (code + in-repo declarative) adapters. */
export function staticAdapterKeys(): string[] {
  return adapters.map((a) => a.key);
}

/**
 * Converts DB rows into adapters, applying all resilience rules:
 *  - only active, non-deleted, kind="declarative" rows are considered
 *  - a key reserved by a code adapter is skipped (code wins)
 *  - a duplicate key within the DB rows is skipped
 *  - an invalid/empty config is skipped with a warning
 *  - a single bad row never blocks the others, and nothing throws
 */
export function buildDeclarativeAdaptersFromRows(
  rows: DeclarativeAdapterRow[],
  reservedKeys: ReadonlySet<string> = new Set(staticAdapterKeys()),
): UniversityAdapter[] {
  const out: UniversityAdapter[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (row.kind !== "declarative") continue;
    if (!row.isActive || row.deletedAt != null) continue;

    if (reservedKeys.has(row.key)) {
      logger.warn(
        `[dbLoader] skip DB adapter "${row.key}" — key reserved by a code adapter (code wins)`,
      );
      continue;
    }
    if (seen.has(row.key)) {
      logger.warn(`[dbLoader] skip DB adapter "${row.key}" — duplicate key`);
      continue;
    }

    const parsed = parseDeclarativeConfig(rowToRawConfig(row));
    if (!parsed.ok) {
      logger.warn(
        `[dbLoader] skip DB adapter "${row.key}" — invalid config: ${parsed.error}`,
      );
      continue;
    }

    try {
      out.push(createDeclarativeAdapter(parsed.config));
      seen.add(row.key);
    } catch (err) {
      logger.warn(
        `[dbLoader] skip DB adapter "${row.key}" — adapter build failed: ${String(err)}`,
      );
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// DB load + TTL cache
// ---------------------------------------------------------------------------

const TTL_MS = (() => {
  const n = parseInt(process.env.PORTAL_ADAPTER_CACHE_TTL_MS ?? "30000", 10);
  return Number.isFinite(n) && n >= 0 ? n : 30000;
})();

let cache: { at: number; list: UniversityAdapter[] } | null = null;
let inflight: Promise<UniversityAdapter[]> | null = null;

/** Drops the cached DB adapter list so the next resolution re-reads the DB. */
export function invalidateDeclarativeAdapterCache(): void {
  cache = null;
}

/**
 * Loads + caches the declarative adapters defined in the DB. Never throws:
 * on a DB error it logs and returns the last cached list (or an empty list),
 * so code adapters keep working and the worker keeps polling.
 */
export async function loadDeclarativeAdaptersFromDb(
  force = false,
): Promise<UniversityAdapter[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return cache.list;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const rows = (await db
        .select()
        .from(portalAdaptersTable)) as DeclarativeAdapterRow[];
      const list = buildDeclarativeAdaptersFromRows(rows);
      cache = { at: Date.now(), list };
      return list;
    } catch (err) {
      logger.warn(
        `[dbLoader] failed to load declarative adapters from DB: ${String(err)}`,
      );
      return cache?.list ?? [];
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

// ---------------------------------------------------------------------------
// Merged resolution — explicitly-approved v2 override, then code, then DB
// ---------------------------------------------------------------------------

/**
 * Resolves an adapter by key. An enabled v2 spec may replace a code adapter
 * only when it requests meta.resolution="override" AND its stored version has
 * super-admin privileged approval. Otherwise the historical priority remains.
 */
export async function resolveAdapterByKey(
  key: string,
): Promise<UniversityAdapter | null> {
  const override = await resolveOverrideSpecAdapterByKey(key);
  if (override) return override;
  const code = adapterByKey(key);
  if (code) return code;
  const dbList = await loadDeclarativeAdaptersFromDb();
  const fromDb = dbList.find((a) => a.key === key);
  if (fromDb) return fromDb;
  // Lowest priority: DB-backed declarative SPECs (opt-in parallel system).
  return resolveSpecAdapterByKey(key);
}

/**
 * Resolves an adapter by university name. Code adapters take priority; DB
 * declarative adapters are consulted only when no code adapter matches.
 */
export async function resolveAdapterForUniversity(
  name: string,
): Promise<UniversityAdapter | null> {
  const override = await resolveOverrideSpecAdapterForUniversity(name);
  if (override) return override;
  const code = adapterForUniversity(name);
  if (code) return code;
  const dbList = await loadDeclarativeAdaptersFromDb();
  const fromDb = dbList.find((a) => a.matches(name));
  if (fromDb) return fromDb;
  // Lowest priority: DB-backed declarative SPECs (opt-in parallel system).
  return resolveSpecAdapterForUniversity(name);
}
