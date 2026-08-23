// AI Agent Faz 2 — retrieval: embed the student's message and pull the top-K
// most relevant chunks from ACTIVE, ready file/url/text/academy/dormbooking sources.
// Never touches program_scope/webhook/conversation source types — those stay
// on their own dedicated paths (searchPrograms tool / future integrations).
//
// Faz 2b: production Postgres (Hostinger) has no pgvector extension
// available, so embeddings are stored as plain JSONB float arrays and
// similarity is computed with brute-force cosine in Node. This is entirely
// fast enough for a knowledge base of a few thousand chunks — do not
// reintroduce the `vector` type, `<=>` operator, or ivfflat/hnsw indexes.
//
// Hybrid retrieval: vector channel (embedding cosine) + lexical channel
// (ILIKE keyword match). Lexical ensures rare terms, acronyms, and proper
// nouns (e.g. "NAWA") are never missed by cosine distance alone.
import { db, knowledgeChunksTable, knowledgeSourcesTable } from "@workspace/db";
import { and, eq, inArray, ilike, or, sql } from "drizzle-orm";
import { embedQuery } from "./knowledgeEmbed";

export interface RetrievedChunk {
  sourceId: number;
  sourceName: string;
  content: string;
  distance: number;
  metadata: Record<string, unknown>;
}

export const RAG_SOURCE_TYPES = ["file", "url", "text", "academy", "dormbooking"] as const;
export type RetrievalSourceType = (typeof RAG_SOURCE_TYPES)[number];
// Vector channel: how many top cosine-scored chunks to keep.
const TOP_K = 8;
// Cosine distance (1 - cosine similarity) ranges 0 (identical) to 2
// (opposite). Chunks farther than this are considered irrelevant noise and
// dropped. Raised from 0.6 → 0.75 to improve recall for paraphrased queries.
const MAX_DISTANCE = 0.75;
// Lexical channel: how many ILIKE hits to add before merging.
const LEXICAL_LIMIT = 8;
// After merging both channels (deduped), cap the final prompt injection.
const MERGED_LIMIT = 8;

function cosineDistance(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 2;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 2;
  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return 1 - similarity;
}

/**
 * Deduplicate chunks by (sourceId, content prefix) — keeps the first
 * occurrence (vector results have priority, being better scored).
 */
function dedupeChunks(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const seen = new Set<string>();
  return chunks.filter((c) => {
    const key = `${c.sourceId}::${c.content.slice(0, 120)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Tokenise a query into search terms for the lexical channel.
 * Removes punctuation, keeps words ≥ 3 chars, limits to 6 terms.
 */
function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3)
    .slice(0, 6);
}

/**
 * Retrieve the top-K relevant knowledge chunks for a query message using
 * hybrid retrieval (vector cosine + ILIKE lexical). Returns an empty array
 * (never throws) on any failure — embeddings being unavailable
 * (e.g. missing OPENAI_API_KEY) or the DB being unreachable must never break
 * the bot reply; retrieval is an enhancement, not a hard dependency.
 */
export async function retrieveKnowledgeChunks(
  query: string,
  options: {
    sourceTypes?: readonly RetrievalSourceType[];
    academyCountryCode?: string;
    aiBotId?: number | null;
  } = {},
): Promise<RetrievedChunk[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const sourceTypes = options.sourceTypes?.length
    ? [...options.sourceTypes]
    : [...RAG_SOURCE_TYPES];
  const academyCountryCode = options.academyCountryCode?.trim().toUpperCase() ?? "";
  const aiBotId = options.aiBotId;
  if (!Number.isInteger(aiBotId) || Number(aiBotId) <= 0) return [];
  if (academyCountryCode && !/^[A-Z]{2,3}$/.test(academyCountryCode)) return [];
  // Country scoping applies only to the curated Academy source. Mixing it with
  // admin file/url/text sources could reintroduce cross-university knowledge.
  if (academyCountryCode && sourceTypes.some((type) => type !== "academy")) return [];

  try {
    const activeSourceIds = await db
      .select({ id: knowledgeSourcesTable.id, name: knowledgeSourcesTable.name })
      .from(knowledgeSourcesTable)
      .where(
        and(
          inArray(knowledgeSourcesTable.type, sourceTypes),
          eq(knowledgeSourcesTable.aiBotId, Number(aiBotId)),
          eq(knowledgeSourcesTable.isActive, true),
          eq(knowledgeSourcesTable.status, "ready"),
        ),
      );
    if (activeSourceIds.length === 0) return [];
    const idSet = new Set(activeSourceIds.map((s) => s.id));
    const nameById = new Map(activeSourceIds.map((s) => [s.id, s.name]));
    const sourceIdList = [...idSet];
    const chunkScope = academyCountryCode
      ? sql`upper(coalesce(${knowledgeChunksTable.metadata}->>'academyCountryCode', '')) = ${academyCountryCode}`
      : undefined;

    // ── A) Vector channel ──────────────────────────────────────────────────
    // Embed the query, brute-force cosine against all active chunks, keep
    // the top TOP_K results under MAX_DISTANCE.
    let vectorScored: RetrievedChunk[] = [];
    try {
      const embedding = await embedQuery(trimmed);
      const rows = await db
        .select({
          sourceId: knowledgeChunksTable.sourceId,
          content: knowledgeChunksTable.content,
          embedding: knowledgeChunksTable.embedding,
          metadata: knowledgeChunksTable.metadata,
        })
        .from(knowledgeChunksTable)
        .where(and(inArray(knowledgeChunksTable.sourceId, sourceIdList), chunkScope));

      vectorScored = rows
        .map((r) => ({
          sourceId: r.sourceId,
          sourceName: nameById.get(r.sourceId) ?? "Knowledge source",
          content: r.content,
          distance: cosineDistance(embedding, (r.embedding as number[] | null) ?? []),
          metadata: (r.metadata as Record<string, unknown> | null) ?? {},
        }))
        .filter((r) => r.distance <= MAX_DISTANCE)
        .sort((a, b) => a.distance - b.distance)
        .slice(0, TOP_K);
    } catch (embedErr) {
      // Embedding may fail (key missing, quota, etc.) — lexical still runs.
      console.error("[knowledge-retrieval] vector channel failed:", embedErr);
    }

    // ── B) Lexical channel ─────────────────────────────────────────────────
    // ILIKE keyword match — guarantees rare terms/acronyms/proper nouns are
    // found even when cosine distance is too high. Independent of embedding.
    let lexical: RetrievedChunk[] = [];
    const terms = queryTerms(trimmed);
    if (terms.length > 0) {
      const orClauses = terms.map((t) => ilike(knowledgeChunksTable.content, `%${t}%`));
      const lexRows = await db
        .select({
          sourceId: knowledgeChunksTable.sourceId,
          content: knowledgeChunksTable.content,
          metadata: knowledgeChunksTable.metadata,
        })
        .from(knowledgeChunksTable)
        .where(and(
          inArray(knowledgeChunksTable.sourceId, sourceIdList),
          chunkScope,
          or(...orClauses),
        ))
        .limit(LEXICAL_LIMIT);
      lexical = lexRows.map((r) => ({
        sourceId: r.sourceId,
        sourceName: nameById.get(r.sourceId) ?? "Knowledge source",
        content: r.content,
        distance: 0.35, // neutral near score — lexical hits are always relevant
        metadata: (r.metadata as Record<string, unknown> | null) ?? {},
      }));
    }

    // ── C) Merge + dedupe ──────────────────────────────────────────────────
    // Vector results first (better ranked), lexical fills gaps.
    const merged = dedupeChunks([...vectorScored, ...lexical]).slice(0, MERGED_LIMIT);
    return merged;
  } catch (err) {
    console.error("[knowledge-retrieval] failed, continuing without RAG context:", err);
    return [];
  }
}
