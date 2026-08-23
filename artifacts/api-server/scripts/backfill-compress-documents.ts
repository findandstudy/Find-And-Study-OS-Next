/**
 * scripts/backfill-compress-documents.ts
 *
 * Backfill: shrink any EXISTING stored document that is over the
 * portal-ready target size (TARGET_MAX_BYTES, default 2MB) using the same
 * `processUpload()` chokepoint used at ingest time (sharp for images,
 * ghostscript for PDFs). Covers all three places documents currently live:
 *   - documents.fileKey        (object storage, local or GCS driver)
 *   - documents.fileData       (legacy base64 blob)
 *   - application_stage_documents.fileData (legacy base64 blob)
 *   - staff_documents.objectPath (object storage)
 *
 * Idempotent: `processUpload` is a no-op for files already <= target, and a
 * file that fails to compress below the target keeps its original bytes
 * (never deleted, never corrupted) — hard-cap rejections are logged and
 * skipped, not thrown, so one bad row can't abort the whole run.
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-compress-documents.ts            # apply
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-compress-documents.ts --dry-run   # report only
 */

import {
  db,
  documentsTable,
  applicationStageDocumentsTable,
  staffDocumentsTable,
} from "@workspace/db";
import { and, eq, gt, isNotNull, or, sql } from "drizzle-orm";
import {
  processUpload,
  UploadTooLargeError,
  getTargetMaxBytes,
} from "../src/lib/uploads/processUpload";
import { recompressStoredObjectIfNeeded } from "../src/lib/documentBytes";

const BATCH = 100;
const TARGET = getTargetMaxBytes();

interface Totals {
  scanned: number;
  compressed: number;
  alreadySmall: number;
  rejected: number;
  failed: number;
  bytesBefore: number;
  bytesAfter: number;
}

function freshTotals(): Totals {
  return { scanned: 0, compressed: 0, alreadySmall: 0, rejected: 0, failed: 0, bytesBefore: 0, bytesAfter: 0 };
}

function logTotals(label: string, t: Totals) {
  const savedMb = ((t.bytesBefore - t.bytesAfter) / 1024 / 1024).toFixed(2);
  console.log(
    `[backfill:${label}] scanned=${t.scanned} compressed=${t.compressed} already_small=${t.alreadySmall} ` +
    `rejected(hard-cap)=${t.rejected} failed=${t.failed} saved=${savedMb}MB`,
  );
}

// ---------------------------------------------------------------------------
// documents.fileKey (object storage — local or GCS driver, same code path
// used at registration time for POST /api/documents, staff-card, etc.)
// ---------------------------------------------------------------------------
async function backfillDocumentsFileKey(dryRun: boolean, totals: Totals) {
  let lastId = 0;
  while (true) {
    const batch = await db
      .select({ id: documentsTable.id, fileKey: documentsTable.fileKey, mimeType: documentsTable.mimeType, sizeBytes: documentsTable.sizeBytes })
      .from(documentsTable)
      .where(and(isNotNull(documentsTable.fileKey), gt(documentsTable.id, lastId)))
      .orderBy(documentsTable.id)
      .limit(BATCH);
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;

    for (const row of batch) {
      if (!row.fileKey) continue;
      totals.scanned++;
      if (dryRun) {
        // Dry run: only object metadata size is known cheaply via declared
        // sizeBytes; skip actual download/compress to keep dry-run fast.
        if ((row.sizeBytes ?? 0) > TARGET) totals.compressed++; else totals.alreadySmall++;
        continue;
      }
      try {
        const result = await recompressStoredObjectIfNeeded(row.fileKey, row.mimeType);
        if (!result) { totals.failed++; continue; }
        totals.bytesBefore += row.sizeBytes ?? result.sizeBytes;
        totals.bytesAfter += result.sizeBytes;
        if (result.recompressed) {
          totals.compressed++;
          await db.update(documentsTable)
            .set({ sizeBytes: result.sizeBytes, mimeType: result.mimeType })
            .where(eq(documentsTable.id, row.id));
        } else {
          totals.alreadySmall++;
        }
      } catch (err) {
        if (err instanceof UploadTooLargeError) {
          totals.rejected++;
          console.error(`[backfill:documents.fileKey] #${row.id} exceeds hard cap, left untouched:`, err.message);
        } else {
          totals.failed++;
          console.error(`[backfill:documents.fileKey] #${row.id} failed:`, err);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// documents.fileData (legacy base64) and application_stage_documents.fileData
// ---------------------------------------------------------------------------
async function backfillBase64Table(
  label: string,
  table: typeof documentsTable | typeof applicationStageDocumentsTable,
  dryRun: boolean,
  totals: Totals,
) {
  let lastId = 0;
  while (true) {
    const batch = await db
      .select({
        id: (table as any).id,
        fileData: (table as any).fileData,
        mimeType: (table as any).mimeType,
      })
      .from(table as any)
      .where(and(isNotNull((table as any).fileData), gt((table as any).id, lastId)))
      .orderBy((table as any).id)
      .limit(BATCH);
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;

    for (const row of batch as any[]) {
      if (!row.fileData) continue;
      totals.scanned++;
      let buffer: Buffer;
      try {
        buffer = Buffer.from(row.fileData, "base64");
      } catch {
        totals.failed++;
        continue;
      }
      totals.bytesBefore += buffer.length;
      if (buffer.length <= TARGET) {
        totals.alreadySmall++;
        totals.bytesAfter += buffer.length;
        continue;
      }
      if (dryRun) {
        totals.compressed++;
        totals.bytesAfter += buffer.length; // unknown until actually run
        continue;
      }
      try {
        const mime = row.mimeType || "application/octet-stream";
        const processed = await processUpload(buffer, `document-${row.id}`, mime);
        totals.bytesAfter += processed.buffer.length;
        if (processed.meta.compressed) {
          totals.compressed++;
          await db.update(table as any)
            .set({
              fileData: processed.buffer.toString("base64"),
              mimeType: processed.mime,
              ...("sizeBytes" in (table as any) ? { sizeBytes: processed.buffer.length } : {}),
            })
            .where(eq((table as any).id, row.id));
        } else {
          totals.alreadySmall++;
        }
      } catch (err) {
        if (err instanceof UploadTooLargeError) {
          totals.rejected++;
          console.error(`[backfill:${label}] #${row.id} exceeds hard cap, left untouched:`, err.message);
        } else {
          totals.failed++;
          console.error(`[backfill:${label}] #${row.id} failed:`, err);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// staff_documents.objectPath (object storage, private staff-card docs)
// ---------------------------------------------------------------------------
async function backfillStaffDocuments(dryRun: boolean, totals: Totals) {
  let lastId = 0;
  while (true) {
    const batch = await db
      .select({ id: staffDocumentsTable.id, objectPath: staffDocumentsTable.objectPath, mimeType: staffDocumentsTable.mimeType, sizeBytes: staffDocumentsTable.sizeBytes })
      .from(staffDocumentsTable)
      .where(gt(staffDocumentsTable.id, lastId))
      .orderBy(staffDocumentsTable.id)
      .limit(BATCH);
    if (batch.length === 0) break;
    lastId = batch[batch.length - 1].id;

    for (const row of batch) {
      totals.scanned++;
      if (dryRun) {
        if (row.sizeBytes > TARGET) totals.compressed++; else totals.alreadySmall++;
        continue;
      }
      try {
        const result = await recompressStoredObjectIfNeeded(row.objectPath, row.mimeType);
        if (!result) { totals.failed++; continue; }
        totals.bytesBefore += row.sizeBytes ?? result.sizeBytes;
        totals.bytesAfter += result.sizeBytes;
        if (result.recompressed) {
          totals.compressed++;
          await db.update(staffDocumentsTable)
            .set({ sizeBytes: result.sizeBytes, mimeType: result.mimeType })
            .where(eq(staffDocumentsTable.id, row.id));
        } else {
          totals.alreadySmall++;
        }
      } catch (err) {
        if (err instanceof UploadTooLargeError) {
          totals.rejected++;
          console.error(`[backfill:staff_documents] #${row.id} exceeds hard cap, left untouched:`, err.message);
        } else {
          totals.failed++;
          console.error(`[backfill:staff_documents] #${row.id} failed:`, err);
        }
      }
    }
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  console.log(`[backfill] target=${(TARGET / 1024 / 1024).toFixed(1)}MB dryRun=${dryRun}`);

  const docsFileKeyTotals = freshTotals();
  await backfillDocumentsFileKey(dryRun, docsFileKeyTotals);
  logTotals("documents.fileKey", docsFileKeyTotals);

  const docsFileDataTotals = freshTotals();
  await backfillBase64Table("documents.fileData", documentsTable, dryRun, docsFileDataTotals);
  logTotals("documents.fileData", docsFileDataTotals);

  const stageDocsTotals = freshTotals();
  await backfillBase64Table("application_stage_documents.fileData", applicationStageDocumentsTable, dryRun, stageDocsTotals);
  logTotals("application_stage_documents.fileData", stageDocsTotals);

  const staffDocsTotals = freshTotals();
  await backfillStaffDocuments(dryRun, staffDocsTotals);
  logTotals("staff_documents", staffDocsTotals);

  const totalFailed = docsFileKeyTotals.failed + docsFileDataTotals.failed + stageDocsTotals.failed + staffDocsTotals.failed;
  console.log(dryRun ? "[backfill] dry run complete — no changes written." : "[backfill] done.");
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
