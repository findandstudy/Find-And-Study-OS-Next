// Knowledge Sources (AI Agent Faz 1 scaffold) — a generic registry the AI
// intake agent draws live information from. Faz 1 ships exactly one row,
// type='program_scope', kept in sync with AiAgentConfig.programScope (the
// hot-path copy the bot reads on every reply). Faz 2/3 will add url/file/
// webhook/conversation rows to the same table; this module only manages the
// program_scope row today.
import { db, knowledgeSourcesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_PROGRAM_SCOPE,
  writeAiAgentConfig,
  type ProgramScope,
} from "./aiAgentConfig";
import { listActiveAiBotIds, requireAiBotId } from "./aiBotRuntime";

export const PROGRAM_SCOPE_SOURCE_TYPE = "program_scope";
const PROGRAM_SCOPE_SOURCE_NAME = "Programlar (Course Finder)";

function coerceProgramScope(raw: unknown): ProgramScope {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_PROGRAM_SCOPE };
  const r = raw as Partial<ProgramScope>;
  const pickListOrAll = (v: unknown, fallback: string[] | "all"): string[] | "all" => {
    if (v === "all") return "all";
    if (Array.isArray(v)) return v.map((s) => String(s));
    return fallback;
  };
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_PROGRAM_SCOPE.enabled,
    countries: pickListOrAll(r.countries, DEFAULT_PROGRAM_SCOPE.countries),
    universityTypes: pickListOrAll(r.universityTypes, DEFAULT_PROGRAM_SCOPE.universityTypes),
  };
}

export interface ProgramScopeSource {
  id: number;
  isActive: boolean;
  scope: ProgramScope;
  lastSyncedAt: Date | null;
}

/**
 * Read the program_scope knowledge_sources row. Returns null when the row is
 * missing (pre-seed / DB unavailable) so callers can fall back to safe
 * defaults instead of throwing on the bot hot path.
 */
export async function getProgramScopeSource(aiBotId?: number | null): Promise<ProgramScopeSource | null> {
  try {
    const resolvedBotId = await requireAiBotId(aiBotId);
    const [row] = await db
      .select()
      .from(knowledgeSourcesTable)
      .where(and(
        eq(knowledgeSourcesTable.aiBotId, resolvedBotId),
        eq(knowledgeSourcesTable.type, PROGRAM_SCOPE_SOURCE_TYPE),
      ));
    if (!row) return null;
    return {
      id: row.id,
      isActive: row.isActive,
      scope: coerceProgramScope(row.config),
      lastSyncedAt: row.lastSyncedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Validate + persist the program_scope source: updates knowledge_sources AND
 * AiAgentConfig.programScope together (single admin action, two mirrored
 * reads) so the tool gate (knowledge_sources.is_active) and the scope filter
 * (AiAgentConfig.programScope) can never drift apart.
 */
export async function writeProgramScopeSource(input: {
  isActive: boolean;
  scope: ProgramScope;
}, aiBotId?: number | null): Promise<ProgramScopeSource> {
  const resolvedBotId = await requireAiBotId(aiBotId);
  const now = new Date();
  const [existing] = await db
    .select({ id: knowledgeSourcesTable.id })
    .from(knowledgeSourcesTable)
    .where(and(
      eq(knowledgeSourcesTable.aiBotId, resolvedBotId),
      eq(knowledgeSourcesTable.type, PROGRAM_SCOPE_SOURCE_TYPE),
    ));

  if (existing) {
    await db
      .update(knowledgeSourcesTable)
      .set({
        isActive: input.isActive,
        config: input.scope,
        status: input.isActive ? "active" : "disabled",
        lastSyncedAt: now,
      })
      .where(eq(knowledgeSourcesTable.id, existing.id));
  } else {
    await db.insert(knowledgeSourcesTable).values({
      aiBotId: resolvedBotId,
      type: PROGRAM_SCOPE_SOURCE_TYPE,
      name: PROGRAM_SCOPE_SOURCE_NAME,
      config: input.scope,
      isActive: input.isActive,
      status: input.isActive ? "active" : "disabled",
      lastSyncedAt: now,
    });
  }

  // Mirror onto AiAgentConfig.programScope — the field the live bot-reply tool
  // actually reads. `enabled` on programScope means "the toggle is on"; the
  // master is_active gate for the whole source lives on knowledge_sources and
  // is combined with it by isProgramSearchToolEnabled() below.
  await writeAiAgentConfig({ programScope: input.scope }, resolvedBotId);

  return {
    id: existing?.id ?? (await getProgramScopeSource(resolvedBotId))!.id,
    isActive: input.isActive,
    scope: input.scope,
    lastSyncedAt: now,
  };
}

/**
 * Idempotently seed the program_scope source row if it does not exist yet.
 * Runs on api-server boot, mirroring seedAiAgentConfig.
 */
export async function seedProgramScopeSource(aiBotId?: number | null): Promise<void> {
  try {
    const resolvedBotId = await requireAiBotId(aiBotId);
    const [existing] = await db
      .select({ id: knowledgeSourcesTable.id })
      .from(knowledgeSourcesTable)
      .where(and(
        eq(knowledgeSourcesTable.aiBotId, resolvedBotId),
        eq(knowledgeSourcesTable.type, PROGRAM_SCOPE_SOURCE_TYPE),
      ));
    if (existing) return;
    await db.insert(knowledgeSourcesTable).values({
      aiBotId: resolvedBotId,
      type: PROGRAM_SCOPE_SOURCE_TYPE,
      name: PROGRAM_SCOPE_SOURCE_NAME,
      config: DEFAULT_PROGRAM_SCOPE,
      isActive: true,
      status: "active",
      lastSyncedAt: new Date(),
    });
    console.log(`[seed] knowledge_sources: program_scope row seeded for bot #${resolvedBotId}`);
  } catch (err) {
    console.error("[seed] seedProgramScopeSource error:", err);
  }
}

export async function seedProgramScopeSources(): Promise<void> {
  const botIds = await listActiveAiBotIds();
  await Promise.all(botIds.map((aiBotId) => seedProgramScopeSource(aiBotId)));
}

/**
 * Combined gate the searchPrograms tool uses: the knowledge_sources row must
 * exist AND be active AND its own scope.enabled flag must be true. Any
 * missing/unreachable state fails CLOSED (tool disabled, bot falls back to
 * static knowledgeBase) rather than silently exposing unscoped programs.
 */
export async function isProgramSearchToolEnabled(aiBotId?: number | null): Promise<{ enabled: boolean; scope: ProgramScope }> {
  const source = await getProgramScopeSource(aiBotId);
  if (!source || !source.isActive || !source.scope.enabled) {
    return { enabled: false, scope: source?.scope ?? DEFAULT_PROGRAM_SCOPE };
  }
  return { enabled: true, scope: source.scope };
}
