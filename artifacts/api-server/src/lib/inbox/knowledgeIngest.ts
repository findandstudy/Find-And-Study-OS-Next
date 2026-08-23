// AI Agent Faz 2 — ingestion orchestrator: extract → chunk → embed → store.
// Runs for a single knowledge_sources row
// (type='file'|'url'|'text'|'academy'|'dormbooking') and is
// safe to re-run (reprocess replaces the row's chunks). Best-effort: any
// failure is recorded as status='error' with a message, never thrown to a
// caller that fired this fire-and-forget after an admin create/reprocess call.
import { db, knowledgeSourcesTable, knowledgeChunksTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  extractFileText,
  extractUrlText,
  extractPlainText,
  type FileSourceConfig,
  type UrlSourceConfig,
  type TextSourceConfig,
} from "./knowledgeExtract";
import { chunkText, embedTexts, estimateTokenCount } from "./knowledgeEmbed";
import { extractAcademyDestinations } from "./academyKnowledge";
import { extractDormBookingCatalog } from "./dormBookingKnowledge";
import { count } from "drizzle-orm";

const MAX_SOURCE_CHARS = 400_000; // guard against runaway ingestion cost

export async function ingestKnowledgeSource(sourceId: number): Promise<void> {
  const [source] = await db
    .select()
    .from(knowledgeSourcesTable)
    .where(eq(knowledgeSourcesTable.id, sourceId));
  if (!source) return;

  await db
    .update(knowledgeSourcesTable)
    .set({ status: "processing" })
    .where(eq(knowledgeSourcesTable.id, sourceId));

  try {
    const config = (source.config ?? {}) as Record<string, unknown>;
    let text = "";
    let extra: Record<string, unknown> = {};
    let preparedChunks: Array<{
      content: string;
      metadata: Record<string, unknown>;
    }> | null = null;

    if (source.type === "file") {
      const fileConfig = config as unknown as FileSourceConfig;
      text = await extractFileText(fileConfig);
    } else if (source.type === "url") {
      const urlConfig = config as unknown as UrlSourceConfig;
      const result = await extractUrlText(urlConfig);
      text = result.text;
      extra = { title: result.title };
    } else if (source.type === "text") {
      const textConfig = config as unknown as TextSourceConfig;
      text = extractPlainText(textConfig);
    } else if (source.type === "academy") {
      const result = await extractAcademyDestinations();
      text = result.text;
      let remainingChars = MAX_SOURCE_CHARS;
      preparedChunks = [];
      for (const document of result.documents) {
        if (remainingChars <= 0) break;
        const boundedText = document.text.slice(0, remainingChars);
        remainingChars -= boundedText.length;
        for (const content of chunkText(boundedText)) {
          preparedChunks.push({
            content,
            metadata: {
              academyCountryCode: document.countryCode,
              academyCountryName: document.countryName,
              academyTitle: document.title,
            },
          });
        }
      }
      extra = {
        sourceVersion: result.sourceVersion,
        fetchedAt: result.fetchedAt,
        countryCount: result.countryCount,
        contentCount: result.contentCount,
        sourceUrl: "https://academy.findandstudy.com",
        studentSafeOnly: true,
        error: null,
        lastSyncError: null,
        lastSyncErrorAt: null,
      };

      // Academy exposes stable ETags. A periodic sync that sees the same
      // version only refreshes freshness metadata; it must not spend money or
      // time re-embedding identical content.
      const [{ n: existingChunkCount }] = await db
        .select({ n: count() })
        .from(knowledgeChunksTable)
        .where(eq(knowledgeChunksTable.sourceId, sourceId));
      if (
        Number(existingChunkCount) > 0 &&
        typeof config.sourceVersion === "string" &&
        config.sourceVersion === result.sourceVersion
      ) {
        await db
          .update(knowledgeSourcesTable)
          .set({
            status: "ready",
            lastSyncedAt: new Date(),
            config: { ...config, ...extra },
          })
          .where(eq(knowledgeSourcesTable.id, sourceId));
        return;
      }
    } else if (source.type === "dormbooking") {
      const result = await extractDormBookingCatalog();
      text = result.text;
      let remainingChars = MAX_SOURCE_CHARS;
      preparedChunks = [];
      for (const document of result.documents) {
        if (remainingChars <= 0) break;
        const boundedText = document.text.slice(0, remainingChars);
        remainingChars -= boundedText.length;
        for (const content of chunkText(boundedText)) {
          preparedChunks.push({
            content,
            metadata: {
              dormBookingDormId: document.dormId,
              dormBookingDormName: document.dormName,
              dormBookingCity: document.city,
              dormBookingNearbyUniversities: document.nearbyUniversities,
              dormBookingGenderEligibility: document.genderEligibility,
              dormBookingContractStart: document.contractStart || null,
              dormBookingContractEnd: document.contractEnd || null,
              dormBookingMinPrice: document.minPrice,
              dormBookingMinPriceCurrency: document.minPriceCurrency || null,
              dormBookingMinPriceFeePeriod: document.minPriceFeePeriod || null,
              dormBookingMinPriceRoomType: document.minPriceRoomType || null,
              sourceUrl: document.sourceUrl,
            },
          });
        }
      }
      extra = {
        sourceVersion: result.sourceVersion,
        fetchedAt: result.fetchedAt,
        dormCount: result.dormCount,
        roomCount: result.roomCount,
        sourceUrl: "https://dormbooking.com/wp-json/dormbooking/v1/ai-catalog",
        studentSafeOnly: true,
        error: null,
        lastSyncError: null,
        lastSyncErrorAt: null,
      };

      const [{ n: existingChunkCount }] = await db
        .select({ n: count() })
        .from(knowledgeChunksTable)
        .where(eq(knowledgeChunksTable.sourceId, sourceId));
      if (
        Number(existingChunkCount) > 0 &&
        typeof config.sourceVersion === "string" &&
        config.sourceVersion === result.sourceVersion
      ) {
        await db.update(knowledgeSourcesTable).set({
          status: "ready",
          lastSyncedAt: new Date(),
          config: { ...config, ...extra },
        }).where(eq(knowledgeSourcesTable.id, sourceId));
        return;
      }
    } else {
      throw new Error(`ingestKnowledgeSource called for unsupported type: ${source.type}`);
    }

    text = text.trim();
    if (!text) {
      throw new Error("No extractable text found in this source.");
    }
    if (text.length > MAX_SOURCE_CHARS) {
      text = text.slice(0, MAX_SOURCE_CHARS);
    }

    const chunkRecords = preparedChunks ?? chunkText(text).map((content) => ({
      content,
      metadata: {},
    }));
    const chunks = chunkRecords.map((chunk) => chunk.content);
    if (chunks.length === 0) {
      throw new Error("Text could not be split into chunks.");
    }

    const embeddings = await embedTexts(chunks);

    await db.transaction(async (tx) => {
      await tx.delete(knowledgeChunksTable).where(eq(knowledgeChunksTable.sourceId, sourceId));
      for (let i = 0; i < chunks.length; i++) {
        await tx.insert(knowledgeChunksTable).values({
          sourceId,
          content: chunks[i],
          embedding: embeddings[i],
          tokenCount: estimateTokenCount(chunks[i]),
          chunkIndex: i,
          metadata: chunkRecords[i].metadata,
        });
      }
      await tx
        .update(knowledgeSourcesTable)
        .set({
          status: "ready",
          lastSyncedAt: new Date(),
          config: { ...config, ...extra, extractedChars: text.length, chunkCount: chunks.length },
        })
        .where(eq(knowledgeSourcesTable.id, sourceId));
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown ingestion error";
    console.error(`[knowledge-ingest] source #${sourceId} failed:`, message);
    if (source.type === "academy" || source.type === "dormbooking") {
      const [{ n }] = await db
        .select({ n: count() })
        .from(knowledgeChunksTable)
        .where(eq(knowledgeChunksTable.sourceId, sourceId));
      if (Number(n) > 0) {
        // Last-known-good policy: a temporary upstream outage must not remove
        // already verified knowledge from the AI. Keep the source ready and
        // expose the failed refresh in admin metadata.
        await db
          .update(knowledgeSourcesTable)
          .set({
            status: "ready",
            config: {
              ...(source.config as Record<string, unknown>),
              lastSyncError: message,
              lastSyncErrorAt: new Date().toISOString(),
            },
          })
          .where(eq(knowledgeSourcesTable.id, sourceId));
        return;
      }
    }
    await db
      .update(knowledgeSourcesTable)
      .set({ status: "error", config: { ...(source.config as Record<string, unknown>), error: message } })
      .where(eq(knowledgeSourcesTable.id, sourceId));
  }
}

/**
 * Fire-and-forget wrapper for use in request handlers — never delays the HTTP
 * response on extraction/embedding latency (a PDF or a slow URL can take
 * several seconds). Errors are already handled inside ingestKnowledgeSource.
 */
export function triggerKnowledgeIngest(sourceId: number): void {
  ingestKnowledgeSource(sourceId).catch((err) => {
    console.error(`[knowledge-ingest] unexpected top-level failure for source #${sourceId}:`, err);
  });
}
