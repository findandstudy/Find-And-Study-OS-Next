/**
 * scripts/backfill-education-extract.ts
 *
 * Catch-up backfill: run AI education extraction for all students who:
 *   1. Have at least one education-trigger document (transcript/diploma/degree/other)
 *      attached directly to them (documents.studentId IS NOT NULL), AND
 *   2. Have NO filled education records (student_education_records row with any
 *      data-bearing field set).
 *
 * This covers the historical gap where ~450 students received documents via
 * the public embed widget / lead-to-student conversion path but never had AI
 * extraction triggered (the trigger only fired on direct staff uploads).
 *
 * The fix (maybeTriggerAutoEducationExtractForStudent in embed.ts + leads.ts)
 * prevents this going forward.  This script backfills the existing population.
 *
 * Safety:
 *   - skipIfFilled: true  — never overwrites existing education records.
 *   - Sequential with DELAY_MS between students — rate-limits Claude API calls.
 *   - DRY_RUN=1 env var — prints candidates without making any AI call.
 *   - LIMIT env var — cap how many students to process (default: unlimited).
 *   - STUDENT_IDS env var — comma-separated list to process specific students only.
 *
 * Usage:
 *   # Dry run — show which students would be processed
 *   DRY_RUN=1 pnpm --filter @workspace/api-server exec tsx scripts/backfill-education-extract.ts
 *
 *   # Live run — process up to 50 students
 *   LIMIT=50 pnpm --filter @workspace/api-server exec tsx scripts/backfill-education-extract.ts
 *
 *   # Live run — process specific students
 *   STUDENT_IDS=123,456,789 pnpm --filter @workspace/api-server exec tsx scripts/backfill-education-extract.ts
 *
 *   # Full run — all eligible students
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-education-extract.ts
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import {
  db,
  documentsTable,
  studentEducationRecordsTable,
  studentsTable,
} from "@workspace/db";
import {
  educationRecordHasData,
  hasRequiredEducationCoverage,
  type EducationRecordOutput,
} from "../src/lib/educationExtraction";
import {
  runEducationExtraction,
  educationDocTypeCondition,
  resolveAppliedLevelKey,
} from "../src/lib/educationAutoExtract";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : null;
const STUDENT_IDS_RAW = process.env.STUDENT_IDS
  ? process.env.STUDENT_IDS.split(",").map((s) => parseInt(s.trim(), 10)).filter(Number.isFinite)
  : null;

// Delay between sequential AI calls to avoid rate-limiting.
const DELAY_MS = parseInt(process.env.DELAY_MS || "1200", 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function hasRequiredEducationRecord(studentId: number): Promise<boolean> {
  const levelKey = await resolveAppliedLevelKey(studentId);
  if (!levelKey) return false;

  const rows = await db
    .select({
      level: studentEducationRecordsTable.level,
      institution: studentEducationRecordsTable.institution,
      program: studentEducationRecordsTable.program,
      graduationYear: studentEducationRecordsTable.graduationYear,
      gpa: studentEducationRecordsTable.gpa,
      gpaRaw: studentEducationRecordsTable.gpaRaw,
      gpaScale: studentEducationRecordsTable.gpaScale,
      languageScore: studentEducationRecordsTable.languageScore,
    })
    .from(studentEducationRecordsTable)
    .where(
      and(
        eq(studentEducationRecordsTable.studentId, studentId),
        isNull(studentEducationRecordsTable.deletedAt),
      ),
    );
  const dataBearingRows = rows.filter((r) =>
    educationRecordHasData(r as EducationRecordOutput),
  ) as EducationRecordOutput[];
  return hasRequiredEducationCoverage(levelKey, dataBearingRows);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(
    `[backfill-education-extract] Starting. DRY_RUN=${DRY_RUN} LIMIT=${LIMIT ?? "none"} DELAY_MS=${DELAY_MS}`,
  );

  // -- Step 1: find eligible student IDs ----------------------------------------
  let candidateStudentIds: number[];

  if (STUDENT_IDS_RAW && STUDENT_IDS_RAW.length > 0) {
    // Specific students requested — validate they have education-trigger docs.
    const { inArray } = await import("drizzle-orm");
    const docRows = await db
      .selectDistinct({ studentId: documentsTable.studentId })
      .from(documentsTable)
      .where(
        and(
          isNotNull(documentsTable.studentId),
          inArray(documentsTable.studentId, STUDENT_IDS_RAW as number[]),
          educationDocTypeCondition(),
          isNull(documentsTable.deletedAt),
        ),
      );
    candidateStudentIds = docRows
      .map((r) => r.studentId!)
      .filter((id): id is number => id != null);
    console.log(
      `[backfill-education-extract] Specific students requested: ${STUDENT_IDS_RAW.length}, have education-trigger docs: ${candidateStudentIds.length}`,
    );
  } else {
    // All students who have at least one education-trigger document.
    const docRows = await db
      .selectDistinct({ studentId: documentsTable.studentId })
      .from(documentsTable)
      .where(
        and(
          isNotNull(documentsTable.studentId),
          educationDocTypeCondition(),
          isNull(documentsTable.deletedAt),
        ),
      );
    candidateStudentIds = docRows
      .map((r) => r.studentId!)
      .filter((id): id is number => id != null);
    console.log(
      `[backfill-education-extract] Total students with education-trigger docs: ${candidateStudentIds.length}`,
    );
  }

  // -- Step 2: filter to those with NO filled education records -----------------
  // We do this in-process (not SQL) to reuse educationRecordHasData which is the
  // canonical definition — same check used by runEducationExtraction itself.
  console.log(`[backfill-education-extract] Checking for already-filled education records…`);
  const eligible: number[] = [];
  for (const studentId of candidateStudentIds) {
    const filled = await hasRequiredEducationRecord(studentId);
    if (!filled) eligible.push(studentId);
  }
  console.log(
    `[backfill-education-extract] Eligible (no filled records): ${eligible.length} / ${candidateStudentIds.length}`,
  );

  const toProcess = LIMIT != null ? eligible.slice(0, LIMIT) : eligible;
  console.log(`[backfill-education-extract] Will process: ${toProcess.length}`);

  if (DRY_RUN) {
    console.log("[backfill-education-extract] DRY_RUN=1 — no AI calls will be made.");
    console.log("[backfill-education-extract] Eligible student IDs:", toProcess.join(", "));
    process.exit(0);
  }

  // -- Step 3: process each student sequentially with rate-limiting -------------
  let processed = 0;
  let skippedFilled = 0;
  let ok = 0;
  let errored = 0;

  for (const studentId of toProcess) {
    try {
      const result = await runEducationExtraction({
        studentId,
        actorUserId: null,
        skipIfFilled: true,
        auditAction: "auto_education_extract_backfill",
      });

      if (result.status === "ok") {
        ok++;
        console.log(
          `[backfill-education-extract] [${processed + 1}/${toProcess.length}]` +
          ` student=${studentId} status=ok level=${result.levelKey ?? "unresolved"}` +
          ` upserted=${result.upserted}` +
          `${result.warnings.length ? ` warnings=${result.warnings.join(",")}` : ""}`,
        );
      } else if (result.status === "skipped_filled") {
        skippedFilled++;
        console.log(
          `[backfill-education-extract] [${processed + 1}/${toProcess.length}]` +
          ` student=${studentId} status=skipped_filled (filled between scan and run)`,
        );
      } else {
        errored++;
        const errMsg = "error" in result ? ` error=${result.error}` : "";
        console.warn(
          `[backfill-education-extract] [${processed + 1}/${toProcess.length}]` +
          ` student=${studentId} status=${result.status}${errMsg}`,
        );
      }
    } catch (err) {
      errored++;
      console.error(
        `[backfill-education-extract] [${processed + 1}/${toProcess.length}]` +
        ` student=${studentId} threw:`,
        err,
      );
    }

    processed++;

    // Rate-limit: pause between students to avoid Claude API quota exhaustion.
    if (processed < toProcess.length) {
      await sleep(DELAY_MS);
    }
  }

  // -- Step 4: summary ----------------------------------------------------------
  console.log("\n[backfill-education-extract] ── Summary ──────────────────────────────");
  console.log(`  Total candidates (had edu-trigger docs): ${candidateStudentIds.length}`);
  console.log(`  Already filled (skipped at scan time):  ${candidateStudentIds.length - eligible.length}`);
  console.log(`  Processed this run:                     ${toProcess.length}`);
  console.log(`  → ok (records upserted):                ${ok}`);
  console.log(`  → skipped_filled (race):                ${skippedFilled}`);
  console.log(`  → errors:                               ${errored}`);
  console.log("[backfill-education-extract] ─────────────────────────────────────────");

  process.exit(errored > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[backfill-education-extract] Fatal:", err);
  process.exit(1);
});
