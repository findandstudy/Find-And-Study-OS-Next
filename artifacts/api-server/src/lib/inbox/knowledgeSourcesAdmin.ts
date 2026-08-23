// AI Agent Faz 2 — admin CRUD for external knowledge sources (file/url/text).
// Distinct from knowledgeSources.ts (which owns the single program_scope
// row) — these are the admin-managed RAG sources whose extracted text is
// chunked + embedded into knowledge_chunks (see knowledgeIngest.ts).
import { db, knowledgeSourcesTable, knowledgeChunksTable } from "@workspace/db";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { triggerKnowledgeIngest } from "./knowledgeIngest";

export const RAG_SOURCE_TYPES = ["file", "url", "text", "academy", "dormbooking"] as const;
export type RagSourceType = (typeof RAG_SOURCE_TYPES)[number];

export interface RagSourceListItem {
  id: number;
  aiBotId: number;
  type: RagSourceType;
  name: string;
  isActive: boolean;
  status: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
  chunkCount: number;
  config: Record<string, unknown>;
}

/** List all admin-managed RAG sources (file/url/text), newest first, with chunk counts. */
export async function listRagSources(aiBotId: number): Promise<RagSourceListItem[]> {
  const rows = await db
    .select()
    .from(knowledgeSourcesTable)
    .where(and(
      eq(knowledgeSourcesTable.aiBotId, aiBotId),
      inArray(knowledgeSourcesTable.type, [...RAG_SOURCE_TYPES]),
    ))
    .orderBy(desc(knowledgeSourcesTable.createdAt));
  if (rows.length === 0) return [];

  const counts = await db
    .select({ sourceId: knowledgeChunksTable.sourceId, n: count() })
    .from(knowledgeChunksTable)
    .where(inArray(knowledgeChunksTable.sourceId, rows.map((r) => r.id)))
    .groupBy(knowledgeChunksTable.sourceId);
  const countBySource = new Map(counts.map((c) => [c.sourceId, Number(c.n)]));

  return rows.map((r) => ({
    id: r.id,
    aiBotId: r.aiBotId,
    type: r.type as RagSourceType,
    name: r.name,
    isActive: r.isActive,
    status: r.status,
    lastSyncedAt: r.lastSyncedAt,
    createdAt: r.createdAt,
    chunkCount: countBySource.get(r.id) ?? 0,
    config: (r.config ?? {}) as Record<string, unknown>,
  }));
}

/** Create a new RAG source row and fire the (async, non-blocking) ingestion pipeline. */
export async function createRagSource(input: {
  aiBotId: number;
  type: RagSourceType;
  name: string;
  config: Record<string, unknown>;
}): Promise<RagSourceListItem> {
  if (input.type === "dormbooking") {
    const [existing] = await db
      .select()
      .from(knowledgeSourcesTable)
      .where(and(
        eq(knowledgeSourcesTable.aiBotId, input.aiBotId),
        eq(knowledgeSourcesTable.type, "dormbooking"),
      ));
    if (existing) {
      const [{ n }] = await db
        .select({ n: count() })
        .from(knowledgeChunksTable)
        .where(eq(knowledgeChunksTable.sourceId, existing.id));
      return {
        id: existing.id,
        aiBotId: existing.aiBotId,
        type: "dormbooking",
        name: existing.name,
        isActive: existing.isActive,
        status: existing.status,
        lastSyncedAt: existing.lastSyncedAt,
        createdAt: existing.createdAt,
        chunkCount: Number(n),
        config: (existing.config ?? {}) as Record<string, unknown>,
      };
    }
  }
  const [row] = await db
    .insert(knowledgeSourcesTable)
    .values({
      aiBotId: input.aiBotId,
      type: input.type,
      name: input.name,
      config: input.config,
      isActive: true,
      status: "pending",
    })
    .returning();
  triggerKnowledgeIngest(row.id);
  return {
    id: row.id,
    aiBotId: row.aiBotId,
    type: row.type as RagSourceType,
    name: row.name,
    isActive: row.isActive,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    chunkCount: 0,
    config: (row.config ?? {}) as Record<string, unknown>,
  };
}

/** Toggle active state or rename a RAG source. Inactive sources are excluded from retrieval. */
export async function updateRagSource(
  id: number,
  aiBotId: number,
  patch: { isActive?: boolean; name?: string },
): Promise<RagSourceListItem | null> {
  const [existing] = await db
    .select()
    .from(knowledgeSourcesTable)
    .where(and(
      eq(knowledgeSourcesTable.id, id),
      eq(knowledgeSourcesTable.aiBotId, aiBotId),
      inArray(knowledgeSourcesTable.type, [...RAG_SOURCE_TYPES]),
    ));
  if (!existing) return null;

  const [row] = await db
    .update(knowledgeSourcesTable)
    .set({
      ...(patch.isActive !== undefined ? { isActive: patch.isActive } : {}),
      ...(patch.name !== undefined ? { name: patch.name } : {}),
    })
    .where(and(eq(knowledgeSourcesTable.id, id), eq(knowledgeSourcesTable.aiBotId, aiBotId)))
    .returning();

  const [{ n }] = await db
    .select({ n: count() })
    .from(knowledgeChunksTable)
    .where(eq(knowledgeChunksTable.sourceId, id));

  return {
    id: row.id,
    aiBotId: row.aiBotId,
    type: row.type as RagSourceType,
    name: row.name,
    isActive: row.isActive,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
    createdAt: row.createdAt,
    chunkCount: Number(n),
    config: (row.config ?? {}) as Record<string, unknown>,
  };
}

/** Delete a RAG source; its chunks cascade-delete via the FK. */
export async function deleteRagSource(id: number, aiBotId: number): Promise<boolean> {
  const result = await db
    .delete(knowledgeSourcesTable)
    .where(and(
      eq(knowledgeSourcesTable.id, id),
      eq(knowledgeSourcesTable.aiBotId, aiBotId),
      inArray(knowledgeSourcesTable.type, [...RAG_SOURCE_TYPES]),
    ))
    .returning({ id: knowledgeSourcesTable.id });
  return result.length > 0;
}

/** Re-run extraction + chunking + embedding for an existing source. */
export async function reprocessRagSource(id: number, aiBotId: number): Promise<boolean> {
  const [existing] = await db
    .select({ id: knowledgeSourcesTable.id })
    .from(knowledgeSourcesTable)
    .where(and(
      eq(knowledgeSourcesTable.id, id),
      eq(knowledgeSourcesTable.aiBotId, aiBotId),
      inArray(knowledgeSourcesTable.type, [...RAG_SOURCE_TYPES]),
    ));
  if (!existing) return false;
  triggerKnowledgeIngest(id);
  return true;
}
