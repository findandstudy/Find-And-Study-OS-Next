import { db, knowledgeSourcesTable } from "@workspace/db";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import {
  ACADEMY_KNOWLEDGE_SOURCE_NAME,
  ACADEMY_KNOWLEDGE_SOURCE_TYPE,
  ACADEMY_PUBLIC_BASE_URL,
} from "./academyKnowledge";
import { ingestKnowledgeSource } from "./knowledgeIngest";
import { listActiveAiBotIds, requireAiBotId } from "./aiBotRuntime";

const SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const STALE_PROCESSING_MS = 30 * 60 * 1000;

const runningBotIds = new Set<number>();
let timer: ReturnType<typeof setInterval> | null = null;

export async function seedAcademyKnowledgeSource(aiBotId?: number | null): Promise<number> {
  const resolvedBotId = await requireAiBotId(aiBotId, { activeOnly: true });
  const [existing] = await db
    .select({ id: knowledgeSourcesTable.id })
    .from(knowledgeSourcesTable)
    .where(and(
      eq(knowledgeSourcesTable.aiBotId, resolvedBotId),
      eq(knowledgeSourcesTable.type, ACADEMY_KNOWLEDGE_SOURCE_TYPE),
    ));
  if (existing) return existing.id;

  const [created] = await db
    .insert(knowledgeSourcesTable)
    .values({
      aiBotId: resolvedBotId,
      type: ACADEMY_KNOWLEDGE_SOURCE_TYPE,
      name: ACADEMY_KNOWLEDGE_SOURCE_NAME,
      config: {
        sourceUrl: ACADEMY_PUBLIC_BASE_URL,
        studentSafeOnly: true,
        syncIntervalHours: 6,
      },
      isActive: true,
      status: "pending",
    })
    .returning({ id: knowledgeSourcesTable.id });
  console.log(`[academy-knowledge] source #${created.id} seeded`);
  return created.id;
}

async function syncAcademyKnowledgeForBot(aiBotId: number, force = false): Promise<boolean> {
  if (runningBotIds.has(aiBotId)) return false;
  runningBotIds.add(aiBotId);
  try {
    const sourceId = await seedAcademyKnowledgeSource(aiBotId);
    const dueBefore = new Date(Date.now() - SYNC_INTERVAL_MS);
    const staleProcessingBefore = new Date(Date.now() - STALE_PROCESSING_MS);

    const [source] = await db
      .select()
      .from(knowledgeSourcesTable)
      .where(
        and(
          eq(knowledgeSourcesTable.id, sourceId),
          eq(knowledgeSourcesTable.isActive, true),
        ),
      );
    if (!source) return false;

    const config = (source.config ?? {}) as Record<string, unknown>;
    const processingStartedAt = typeof config.processingStartedAt === "string"
      ? new Date(config.processingStartedAt)
      : null;
    const processingIsFresh =
      source.status === "processing" &&
      processingStartedAt !== null &&
      Number.isFinite(processingStartedAt.getTime()) &&
      processingStartedAt > staleProcessingBefore;
    if (!force && processingIsFresh) return false;
    if (!force && source.status === "ready" && source.lastSyncedAt && source.lastSyncedAt > dueBefore) {
      return false;
    }

    if (source.status === "processing" && !processingIsFresh) {
      await db
        .update(knowledgeSourcesTable)
        .set({ status: "pending" })
        .where(
          and(
            eq(knowledgeSourcesTable.id, sourceId),
            eq(knowledgeSourcesTable.status, "processing"),
          ),
        );
    }

    // Cross-process claim: VPS/Replit or multiple API instances may share the
    // same database. Only one of them may fetch/embed a due Academy snapshot.
    const [claimed] = await db
      .update(knowledgeSourcesTable)
      .set({
        status: "processing",
        config: { ...config, processingStartedAt: new Date().toISOString() },
      })
      .where(
        and(
          eq(knowledgeSourcesTable.id, sourceId),
          eq(knowledgeSourcesTable.isActive, true),
          or(
            ne(knowledgeSourcesTable.status, "processing"),
            isNull(knowledgeSourcesTable.status),
          ),
        ),
      )
      .returning({ id: knowledgeSourcesTable.id });
    if (!claimed) return false;
    await ingestKnowledgeSource(sourceId);
    return true;
  } finally {
    runningBotIds.delete(aiBotId);
  }
}

export async function syncAcademyKnowledgeIfDue(force = false): Promise<boolean> {
  const botIds = await listActiveAiBotIds();
  const results = await Promise.all(botIds.map((aiBotId) =>
    syncAcademyKnowledgeForBot(aiBotId, force).catch((error) => {
      console.error(`[academy-knowledge] bot #${aiBotId} sync failed:`, error);
      return false;
    }),
  ));
  return results.some(Boolean);
}

export function startAcademyKnowledgeSync(): () => Promise<void> {
  if (timer) return stopAcademyKnowledgeSync;
  void syncAcademyKnowledgeIfDue().catch((error) => {
    console.error("[academy-knowledge] initial sync failed:", error);
  });
  timer = setInterval(() => {
    void syncAcademyKnowledgeIfDue().catch((error) => {
      console.error("[academy-knowledge] periodic sync failed:", error);
    });
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  return stopAcademyKnowledgeSync;
}

export async function stopAcademyKnowledgeSync(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  const deadline = Date.now() + 10_000;
  while (runningBotIds.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
