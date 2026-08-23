---
name: AI Agent Faz 2 RAG pipeline
description: Knowledge-source ingestion (PDF/docx/xlsx/url/text) → chunk → embed → retrieval injected into bot system prompt. No pgvector — Hostinger prod PG doesn't have the extension.
---

Architecture: `knowledgeExtract.ts` (format-specific text extraction) → `knowledgeEmbed.ts` (chunk + OpenAI embeddings) → `knowledgeIngest.ts` (orchestrator, sets status pending/processing/ready/error) → `knowledgeChunksTable` (embeddings stored as plain `jsonb` `number[]`, NOT pgvector) → `knowledgeRetrieval.ts` (fetches all chunk embeddings, computes cosine distance brute-force in Node, top-K + MAX_DISTANCE cutoff, never throws) → `botBrain.ts` injects a guarded "Retrieved excerpts" block into the system prompt.

**pgvector removal (Faz 2b):** production Hostinger Postgres has no `vector` extension available at all, so the original pgvector-based schema/boot-DDL silently never created `knowledge_chunks` in prod — the whole RAG pipeline was dead in production while working fine in dev (which does have pgvector). Fix: never use `vector`/`<=>`/ivfflat/hnsw anywhere in this codebase; store embeddings as `jsonb number[]` and compute cosine similarity in Node (`cosineDistance()` helper in `knowledgeRetrieval.ts`). Brute-force cosine over all chunks is fine at this data volume; revisit only if chunk counts grow to the point Node-side scan becomes the bottleneck.

**Why:** keeps retrieval failure-safe (bot must still reply if RAG has no hits or embedding API is down) and keeps ingestion synchronous-enough for admins to see status without a queue.

**How to apply:** any new knowledge source type must go through the same extract→ingest pipeline, not a bespoke path; both live-reply (`maybeAutoReply`) and the admin test endpoint (`runBotReplyTest`) must call retrieval before building the prompt, or one path silently loses RAG context.

pdf-parse v2.x quirk: no default export — use `const { PDFParse } = await import("pdf-parse"); const p = new PDFParse({ data: buffer }); const { text } = await p.getText(); await p.destroy();`. The v1 `pdf(buffer)` functional API is gone.

jsdom needs `@types/jsdom` as an explicit devDependency for tsc — the runtime package doesn't ship its own types under this pnpm resolution.
