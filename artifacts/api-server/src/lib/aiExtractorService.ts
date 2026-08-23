import { db, aiExtractorsTable, aiExtractorRunsTable, type AiExtractor, type ExtractorFieldDef } from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  HARDCODED_EXTRACTOR_FIELDS,
  HARDCODED_EXTRACTOR_RULES,
  readDefaultConfig,
} from "./aiDefaultConfigs";

export type ExtractorScope = "public_apply" | "embed" | "staff" | "agent";

export const FALLBACK_EXTRACTOR: AiExtractor = {
  id: 0,
  name: "Built-in default",
  slug: "_fallback",
  description: "Hardcoded fallback used when no DB extractor is configured.",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  systemPrompt: "",
  systemPromptByLang: {},
  fields: HARDCODED_EXTRACTOR_FIELDS,
  rules: { globalRules: HARDCODED_EXTRACTOR_RULES },
  scopes: ["public_apply", "embed", "staff", "agent"],
  documentTypes: ["passport", "diploma", "transcript", "photo", "other"],
  temperature: "0.20",
  maxTokens: 4096,
  isActive: true,
  isDefault: true,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as AiExtractor;

async function getFallbackExtractor(): Promise<AiExtractor> {
  try {
    const [systemPromptCfg, fieldsCfg, rulesCfg] = await Promise.all([
      readDefaultConfig("extractor.builtin.systemPrompt"),
      readDefaultConfig("extractor.builtin.fields"),
      readDefaultConfig("extractor.builtin.rules"),
    ]);
    return {
      ...FALLBACK_EXTRACTOR,
      systemPrompt: systemPromptCfg.text ?? "",
      fields: Array.isArray(fieldsCfg.fields) ? fieldsCfg.fields : HARDCODED_EXTRACTOR_FIELDS,
      rules: { globalRules: Array.isArray(rulesCfg.globalRules) ? rulesCfg.globalRules : HARDCODED_EXTRACTOR_RULES },
    };
  } catch {
    return FALLBACK_EXTRACTOR;
  }
}

/**
 * Pick the best extractor for a given scope. Only extractors that explicitly
 * include the requested scope are considered. Preference:
 *   1. Active + isDefault + scope in scopes
 *   2. Active + scope in scopes (most recently updated)
 *   3. DB-backed built-in defaults (then true FALLBACK_EXTRACTOR)
 *
 * Extractors that do not list the scope are NEVER applied to that scope —
 * this avoids leaking, say, a "staff" extractor onto "public_apply" traffic.
 */
export async function getActiveExtractor(scope: ExtractorScope, preferredId?: number | null): Promise<AiExtractor> {
  try {
    if (preferredId && Number.isInteger(preferredId) && preferredId > 0) {
      const [preferred] = await db
        .select()
        .from(aiExtractorsTable)
        .where(and(
          eq(aiExtractorsTable.id, preferredId),
          eq(aiExtractorsTable.isActive, true),
        ));
      if (
        preferred &&
        Array.isArray(preferred.scopes) &&
        (preferred.scopes as string[]).includes(scope)
      ) {
        return preferred;
      }
    }
    const rows = await db
      .select()
      .from(aiExtractorsTable)
      .where(eq(aiExtractorsTable.isActive, true))
      .orderBy(desc(aiExtractorsTable.isDefault), desc(aiExtractorsTable.updatedAt));
    const inScope = rows.filter((r) => Array.isArray(r.scopes) && (r.scopes as string[]).includes(scope));
    if (inScope.length === 0) return getFallbackExtractor();
    const def = inScope.find((r) => r.isDefault);
    return def ?? inScope[0];
  } catch {
    return getFallbackExtractor();
  }
}

/** True when the extractor is the in-memory fallback (no DB row). */
export function isFallbackExtractor(e: AiExtractor): boolean {
  return e.id === 0;
}

export async function getExtractorById(id: number): Promise<AiExtractor | null> {
  const [row] = await db.select().from(aiExtractorsTable).where(eq(aiExtractorsTable.id, id));
  return row ?? null;
}

function fieldLineForPrompt(f: ExtractorFieldDef, lang: string): string {
  const label = f.labelByLang?.[lang] ?? f.label;
  const parts: string[] = [];
  parts.push(`"${f.key}":`);
  switch (f.type) {
    case "number":
      parts.push("number or null");
      break;
    case "boolean":
      parts.push("boolean or null");
      break;
    case "date":
      parts.push(`"${f.format || "YYYY-MM-DD"} format" or null`);
      break;
    case "enum":
      parts.push(`one of [${(f.enumValues || []).map((v) => `"${v}"`).join(", ")}] or null`);
      break;
    default:
      parts.push("string or null");
  }
  if (label) parts.push(`// ${label}`);
  if (f.description) parts.push(`— ${f.description}`);
  return `  ${parts.join(" ")}`;
}

export function buildExtractionPrompt(extractor: AiExtractor, opts: { lang?: string } = {}): string {
  const lang = (opts.lang || "en").toLowerCase().slice(0, 2);
  const customPrompt = extractor.systemPromptByLang?.[lang] || extractor.systemPrompt;
  const fields = extractor.fields as ExtractorFieldDef[];
  const rules = (extractor.rules as { globalRules?: string[] })?.globalRules || [];

  const intro = customPrompt && customPrompt.trim().length > 0
    ? customPrompt.trim()
    : `You are an expert document analysis system for an education consultancy.
Analyze the provided document image(s) and extract student information.`;

  const fieldList = fields.map((f) => fieldLineForPrompt(f, lang)).join(",\n");
  const ruleLines = rules.length > 0 ? rules.map((r) => `- ${r}`).join("\n") : "";

  const langHint = lang !== "en"
    ? `\nReturn free-text fields (e.g. notes) in the user's language: ${lang}. Field KEYS must remain in English exactly as listed.`
    : "";

  return `${intro}

Return a JSON object with these exact keys:
{
${fieldList}
}

Rules:
${ruleLines}${langHint}`.trim();
}

export async function recordExtractorRun(input: {
  extractorId: number;
  scope: string;
  documentCount: number;
  documentTypes?: string[];
  model: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  latencyMs?: number | null;
  status: "success" | "error";
  errorMessage?: string | null;
  extractedPayload?: unknown;
  triggeredBy?: number | null;
}): Promise<void> {
  if (!input.extractorId || input.extractorId <= 0) return; // skip fallback runs
  try {
    await db.insert(aiExtractorRunsTable).values({
      extractorId: input.extractorId,
      scope: input.scope,
      documentCount: input.documentCount,
      documentTypes: input.documentTypes ?? [],
      model: input.model,
      promptTokens: input.promptTokens ?? null,
      completionTokens: input.completionTokens ?? null,
      latencyMs: input.latencyMs ?? null,
      status: input.status,
      errorMessage: input.errorMessage ?? null,
      extractedPayload: (input.extractedPayload as any) ?? null,
      triggeredBy: input.triggeredBy ?? null,
    });
  } catch (e) {
    // run logging must never block extraction
    console.error("[aiExtractorService] failed to record run", e);
  }
}

export async function getExtractorUsageStats(): Promise<Record<number, { runs: number; lastRunAt: string | null }>> {
  try {
    const rows = await db
      .select({
        extractorId: aiExtractorRunsTable.extractorId,
        runs: sql<number>`count(*)::int`,
        lastRunAt: sql<string | null>`max(${aiExtractorRunsTable.createdAt})`,
      })
      .from(aiExtractorRunsTable)
      .groupBy(aiExtractorRunsTable.extractorId);
    const out: Record<number, { runs: number; lastRunAt: string | null }> = {};
    for (const r of rows) {
      out[r.extractorId] = { runs: r.runs, lastRunAt: r.lastRunAt as any };
    }
    return out;
  } catch {
    return {};
  }
}
