/**
 * scripts/migrate-document-blobs.ts
 *
 * Backfill: copy legacy `documents.fileData` (base64) blobs into object
 * storage, then set `documents.fileKey` and clear `documents.fileData`.
 *
 * Idempotent — only touches rows where `fileData IS NOT NULL AND file_key IS NULL`.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx scripts/migrate-document-blobs.ts            # apply
 *   pnpm --filter @workspace/api-server exec tsx scripts/migrate-document-blobs.ts --dry-run  # report only
 */

import { db, documentsTable } from "@workspace/db";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { ObjectStorageService } from "../src/lib/objectStorage";

const BATCH = 100;

function extOf(mime: string | null | undefined): string {
  if (!mime) return "bin";
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "application/pdf": "pdf",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };
  if (map[mime]) return map[mime];
  const slash = mime.indexOf("/");
  return slash >= 0 ? mime.slice(slash + 1).replace(/[^a-z0-9]/gi, "") || "bin" : "bin";
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const storage = new ObjectStorageService();

  const [{ pendingCount }] = await db
    .select({ pendingCount: sql<number>`count(*)::int` })
    .from(documentsTable)
    .where(and(isNotNull(documentsTable.fileData), isNull(documentsTable.fileKey)));

  console.log(`[backfill] pending rows: ${pendingCount}${dryRun ? " (dry run)" : ""}`);
  if (pendingCount === 0) { console.log("[backfill] nothing to do."); return; }
  if (dryRun) { console.log("[backfill] dry run — no changes will be written."); return; }

  let migrated = 0;
  let failed = 0;

  while (true) {
    const batch = await db
      .select({
        id: documentsTable.id,
        name: documentsTable.name,
        fileData: documentsTable.fileData,
        mimeType: documentsTable.mimeType,
      })
      .from(documentsTable)
      .where(and(isNotNull(documentsTable.fileData), isNull(documentsTable.fileKey)))
      .limit(BATCH);

    if (batch.length === 0) break;

    let progressed = 0;
    for (const row of batch) {
      try {
        if (!row.fileData) continue;
        const buffer = Buffer.from(row.fileData, "base64");
        const contentType = row.mimeType || "application/octet-stream";
        const filename = (row.name && row.name.trim())
          ? row.name
          : `document-${row.id}.${extOf(row.mimeType)}`;
        const fileKey = await storage.uploadBuffer({
          subdir: "documents",
          filename,
          buffer,
          contentType,
        });
        await db.update(documentsTable)
          .set({ fileKey, fileData: null })
          .where(eq(documentsTable.id, row.id));
        migrated++;
        progressed++;
        if (migrated % 25 === 0) console.log(`[backfill] migrated ${migrated}…`);
      } catch (err) {
        failed++;
        console.error(`[backfill] failed for document #${row.id}:`, err);
      }
    }

    if (progressed === 0) {
      console.error(`[backfill] no progress in last batch of ${batch.length}; stopping to avoid infinite loop.`);
      break;
    }
    if (batch.length < BATCH) break;
  }

  console.log(`[backfill] done. migrated=${migrated} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
