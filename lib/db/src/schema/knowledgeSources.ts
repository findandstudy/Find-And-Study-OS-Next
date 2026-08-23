import { index, pgTable, serial, integer, text, boolean, jsonb, timestamp } from "drizzle-orm/pg-core";
import { aiBotsTable } from "./aiBots";

// ---------------------------------------------------------------------------
// Table — knowledge_sources (AI Agent Faz 1 scaffold, extended in Faz 2)
//
// A generic registry of sources the AI intake agent may draw live information
// from. Faz 1 shipped exactly one row, type='program_scope', whose `config` is
// the { enabled, countries, universityTypes } scope object also mirrored onto
// AiAgentConfig.programScope (see aiAgentConfig.ts) for fast reads on the hot
// bot-reply path.
//
// Faz 2 (RAG) adds admin-managed external knowledge: type='file' (PDF/Word/
// Excel upload), type='url' (scraped web page), type='text' (free-text note).
// For these, `config` holds source-specific metadata (objectPath/url/rawText,
// mimeType, extractedChars) and the extracted text is chunked + embedded into
// the sibling `knowledge_chunks` table (never into `config` itself — jsonb is
// not the place for large blobs or vectors). `status` tracks the ingestion
// pipeline: pending → processing → ready | error. This file intentionally
// keeps `config` as untyped jsonb so future source types don't require a
// schema migration.
// ---------------------------------------------------------------------------

export const knowledgeSourceTypeValues = [
  "program_scope",
  "url",
  "file",
  "text",
  "academy",
  "webhook",
  "conversation",
] as const;
export type KnowledgeSourceType = (typeof knowledgeSourceTypeValues)[number];

export const knowledgeSourcesTable = pgTable("knowledge_sources", {
  id: serial("id").primaryKey(),
  aiBotId: integer("ai_bot_id")
    .notNull()
    .references(() => aiBotsTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  name: text("name").notNull(),
  config: jsonb("config").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  status: text("status"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("knowledge_sources_ai_bot_idx").on(table.aiBotId),
  index("knowledge_sources_ai_bot_type_idx").on(table.aiBotId, table.type),
]);

export type KnowledgeSource = typeof knowledgeSourcesTable.$inferSelect;
export type InsertKnowledgeSource = typeof knowledgeSourcesTable.$inferInsert;

// ---------------------------------------------------------------------------
// Table — knowledge_chunks (AI Agent Faz 2 — RAG)
//
// Chunked + embedded text extracted from a `file`/`url`/`text` knowledge
// source. Retrieval (knowledgeRetrieval.ts) embeds the student's message and
// pulls the top-K chunks by cosine similarity, computed in Node over the
// `embedding` column (a plain JSON array of floats), from ACTIVE sources
// only, injecting them into the bot system prompt as untrusted data (never
// as instructions). `embedding` uses OpenAI text-embedding-3-small (1536
// dims), called directly against the OpenAI API — the AI Integrations proxy
// does not support embeddings.
//
// NOTE: this intentionally does NOT use the Postgres `vector` type/pgvector
// extension — the production Hostinger Postgres instance does not have
// pgvector available (`CREATE EXTENSION vector` fails, extension isn't even
// listed in pg_available_extensions). Storing embeddings as jsonb keeps this
// portable across any plain Postgres; similarity search is brute-force
// cosine in Node, which is entirely fast enough for a knowledge base of a
// few thousand chunks. Do not reintroduce `vector`, `<=>`, or ivfflat/hnsw
// indexes here.
// ---------------------------------------------------------------------------

export const knowledgeChunksTable = pgTable("knowledge_chunks", {
  id: serial("id").primaryKey(),
  sourceId: integer("source_id")
    .notNull()
    .references(() => knowledgeSourcesTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  embedding: jsonb("embedding").$type<number[]>().notNull().default([]),
  tokenCount: integer("token_count").notNull().default(0),
  chunkIndex: integer("chunk_index").notNull().default(0),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type KnowledgeChunk = typeof knowledgeChunksTable.$inferSelect;
export type InsertKnowledgeChunk = typeof knowledgeChunksTable.$inferInsert;
