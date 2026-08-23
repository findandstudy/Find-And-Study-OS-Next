/**
 * Lossless JSON export/import primitives.
 *
 * Each export is wrapped in an envelope `{ kind, version, exportedAt, items }`
 * so that imports can validate provenance before persisting. Volatile fields
 * (auto-increment ids, server timestamps, foreign-key references that cannot
 * be portable across installations) are stripped on the way out and never
 * trusted on the way in.
 *
 * Used by the embed widget and website Web-to-Lead form admin endpoints to
 * provide lossless round-tripping of every editable field — see Task #202.
 */

export const EXPORT_VERSION = 1;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024; // 2 MiB

export type ConflictStrategy = "skip" | "overwrite" | "rename";
const VALID_CONFLICTS: readonly ConflictStrategy[] = ["skip", "overwrite", "rename"] as const;

export function isValidConflictStrategy(v: unknown): v is ConflictStrategy {
  return typeof v === "string" && (VALID_CONFLICTS as readonly string[]).includes(v);
}

export interface ExportEnvelope<T = Record<string, unknown>> {
  kind: string;
  version: number;
  exportedAt: string;
  items: T[];
}

export function buildEnvelope<T>(kind: string, items: T[]): ExportEnvelope<T> {
  return {
    kind,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    items,
  };
}

/**
 * Strip a row down to only the fields whose names appear in `keep`.
 * Used both on export and as a sanitizer on import — the import side never
 * trusts client-supplied ids, timestamps, or extra keys.
 */
export function pickFields<T extends Record<string, unknown>>(
  row: T,
  keep: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keep) {
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      out[k] = (row as Record<string, unknown>)[k];
    }
  }
  return out;
}

const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * Recursively walk a value and reject any object that contains a
 * prototype-polluting key. JSON.parse already turns "__proto__" into a
 * regular own property, but assigning that property to a real object can
 * still pollute prototypes downstream, so we hard-fail at the boundary.
 */
export function assertNoPrototypePollution(value: unknown, path = "root"): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoPrototypePollution(v, `${path}[${i}]`));
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      throw new ImportValidationError(`Disallowed property "${key}" at ${path}`);
    }
    assertNoPrototypePollution((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

export class ImportValidationError extends Error {
  status: number;
  constructor(msg: string, status = 400) {
    super(msg);
    this.name = "ImportValidationError";
    this.status = status;
  }
}

export interface ParseEnvelopeOptions {
  expectedKind: string;
  maxBytes?: number;
}

/**
 * Validate a raw payload received from the admin UI is a well-formed export
 * envelope of the expected kind. Returns the items array. Throws
 * `ImportValidationError` on any structural problem.
 */
export function parseEnvelope<T = Record<string, unknown>>(
  raw: unknown,
  opts: ParseEnvelopeOptions,
): T[] {
  const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;
  // Cheap size guard: stringify once to bound the payload. We do this after
  // express-json has already accepted the body (express enforces its own
  // limit too), so this is defense in depth.
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    throw new ImportValidationError("Payload is not serializable");
  }
  if (serialized.length > maxBytes) {
    throw new ImportValidationError(
      `Import payload exceeds ${Math.floor(maxBytes / 1024)} KiB limit`,
      413,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ImportValidationError("Envelope must be a JSON object");
  }
  const env = raw as Record<string, unknown>;
  if (env.kind !== opts.expectedKind) {
    throw new ImportValidationError(
      `Wrong envelope kind: expected "${opts.expectedKind}", got "${String(env.kind)}"`,
    );
  }
  if (env.version !== EXPORT_VERSION) {
    throw new ImportValidationError(
      `Unsupported envelope version: ${String(env.version)} (expected ${EXPORT_VERSION})`,
    );
  }
  if (!Array.isArray(env.items)) {
    throw new ImportValidationError("Envelope.items must be an array");
  }
  assertNoPrototypePollution(env.items, "items");
  return env.items as T[];
}

/**
 * Per-item outcome surfaced to the admin UI in the import response.
 */
export type ImportItemStatus = "created" | "updated" | "renamed" | "skipped" | "error";

export interface ImportItemResult {
  index: number;
  slug: string | null;
  status: ImportItemStatus;
  finalSlug?: string;
  error?: string;
}

export interface ImportSummary {
  total: number;
  created: number;
  updated: number;
  renamed: number;
  skipped: number;
  errors: number;
  results: ImportItemResult[];
}

export function emptySummary(total: number): ImportSummary {
  return { total, created: 0, updated: 0, renamed: 0, skipped: 0, errors: 0, results: [] };
}

export function tallyResult(summary: ImportSummary, r: ImportItemResult): void {
  summary.results.push(r);
  switch (r.status) {
    case "created": summary.created++; break;
    case "updated": summary.updated++; break;
    case "renamed": summary.renamed++; break;
    case "skipped": summary.skipped++; break;
    case "error": summary.errors++; break;
  }
}

/**
 * Produce a non-conflicting slug by appending "-copy", "-copy-2", ... until
 * `isTaken` returns false. Used by the "rename" conflict strategy.
 */
export async function nextAvailableSlug(
  base: string,
  isTaken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const trimmed = base.replace(/-+copy(-\d+)?$/i, ""); // collapse repeated -copy suffixes
  let candidate = `${trimmed}-copy`;
  let i = 2;
  while (await isTaken(candidate)) {
    candidate = `${trimmed}-copy-${i}`;
    i++;
    if (i > 1000) throw new ImportValidationError("Could not find a free slug");
  }
  return candidate;
}
