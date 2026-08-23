import { db, knowledgeSourcesTable } from "@workspace/db";
import { and, eq, isNull, ne, or } from "drizzle-orm";
import { DORMBOOKING_KNOWLEDGE_SOURCE_TYPE } from "./dormBookingKnowledge";
import { ingestKnowledgeSource } from "./knowledgeIngest";

const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
const STALE_PROCESSING_MS = 30 * 60 * 1000;

const runningSourceIds = new Set<number>();
let timer: ReturnType<typeof setInterval> | null = null;

async function syncSource(sourceId: number, force = false): Promise<boolean> {
  if (runningSourceIds.has(sourceId)) return false;
  runningSourceIds.add(sourceId);
  try {
    const [source] = await db.select().from(knowledgeSourcesTable).where(and(
      eq(knowledgeSourcesTable.id, sourceId),
      eq(knowledgeSourcesTable.type, DORMBOOKING_KNOWLEDGE_SOURCE_TYPE),
      eq(knowledgeSourcesTable.isActive, true),
    ));
    if (!source) return false;
    const dueBefore = new Date(Date.now() - SYNC_INTERVAL_MS);
    if (!force && source.status === "ready" && source.lastSyncedAt && source.lastSyncedAt > dueBefore) return false;

    const config = (source.config ?? {}) as Record<string, unknown>;
    const processingStartedAt = typeof config.processingStartedAt === "string" ? new Date(config.processingStartedAt) : null;
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const processingIsFresh = source.status === "processing" && processingStartedAt && processingStartedAt > staleBefore;
    if (!force && processingIsFresh) return false;

    if (source.status === "processing" && !processingIsFresh) {
      await db.update(knowledgeSourcesTable).set({ status: "pending" }).where(and(
        eq(knowledgeSourcesTable.id, sourceId),
        eq(knowledgeSourcesTable.status, "processing"),
      ));
    }

    const [claimed] = await db.update(knowledgeSourcesTable).set({
      status: "processing",
      config: { ...config, processingStartedAt: new Date().toISOString() },
    }).where(and(
      eq(knowledgeSourcesTable.id, sourceId),
      eq(knowledgeSourcesTable.isActive, true),
      or(ne(knowledgeSourcesTable.status, "processing"), isNull(knowledgeSourcesTable.status)),
    )).returning({ id: knowledgeSourcesTable.id });
    if (!claimed) return false;
    await ingestKnowledgeSource(sourceId);
    return true;
  } finally {
    runningSourceIds.delete(sourceId);
  }
}

export async function syncDormBookingKnowledgeIfDue(force = false): Promise<boolean> {
  const sources = await db.select({ id: knowledgeSourcesTable.id }).from(knowledgeSourcesTable).where(and(
    eq(knowledgeSourcesTable.type, DORMBOOKING_KNOWLEDGE_SOURCE_TYPE),
    eq(knowledgeSourcesTable.isActive, true),
  ));
  const results = await Promise.all(sources.map(({ id }) => syncSource(id, force).catch((error) => {
    console.error(`[dormbooking-knowledge] source #${id} sync failed:`, error);
    return false;
  })));
  return results.some(Boolean);
}

export function startDormBookingKnowledgeSync(): () => Promise<void> {
  if (timer) return stopDormBookingKnowledgeSync;
  void syncDormBookingKnowledgeIfDue().catch((error) => console.error("[dormbooking-knowledge] initial sync failed:", error));
  timer = setInterval(() => {
    void syncDormBookingKnowledgeIfDue().catch((error) => console.error("[dormbooking-knowledge] periodic sync failed:", error));
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  return stopDormBookingKnowledgeSync;
}

export async function stopDormBookingKnowledgeSync(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  const deadline = Date.now() + 10_000;
  while (runningSourceIds.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
