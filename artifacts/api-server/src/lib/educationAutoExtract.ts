/**
 * educationAutoExtract — shared core of the FAZ 1 extract-education flow.
 *
 * The former POST /ai/students/:id/extract-education body moved here so it
 * can run in THREE ways with identical behavior:
 *  1. The staff endpoint (ai-extract.ts) — manual, always runs.
 *  2. The automatic document-upload trigger (documents route) — fires when a
 *     transcript/diploma/degree document is created AND the student's
 *     education records are still empty (idempotent, non-blocking).
 *  3. The lead-to-student conversion path (leads.ts + embed.ts) — fires when
 *     a lead's documents are adopted onto a student, ensuring documents that
 *     arrived via the public widget flow get the same AI treatment as
 *     staff-uploaded documents.  Uses maybeTriggerAutoEducationExtractForStudent
 *     which does not require a specific document type — it checks internally
 *     whether any education-trigger documents are present.
 *
 * Level is resolved SERVER-side (students.interestedLevel → latest
 * application's program degree). Low confidence never drops readable
 * records (LOW_CONFIDENCE_EDUCATION warning instead).
 */
import { eq, desc, and, isNull, or, ilike, asc, sql } from "drizzle-orm";
import {
  db,
  studentsTable,
  applicationsTable,
  programsTable,
  documentsTable,
  studentEducationRecordsTable,
  educationRecordsTable,
} from "@workspace/db";
import { logAudit } from "./auth";
import { loadDocumentBytes } from "./documentBytes";
import { EXTRACT_PROMPT } from "./extractPrompt";
import {
  AI_EDUCATION_RECORD_SOURCE,
  buildEducationPromptSection,
  decideEducationExtraction,
  EDUCATION_FUZZY_KEYWORDS,
  hasRequiredEducationCoverage,
  isEducationTriggerDocType,
  type EducationRecordOutput,
} from "./educationExtraction";
import { documentAiScheduler } from "./aiLaneScheduler";
import { getDocumentAiConnection } from "./documentAiConnection";

/**
 * Drizzle OR condition that matches any education-related document type
 * using case-insensitive substring matching.  Replaces the former exact
 * inArray(type, ["transcript","diploma","degree","other"]) filter so that
 * real-world labels such as "high school diploma translation", "class 12th
 * marks sheet", or "bachelor's transcript" are correctly included.
 *
 * Exported so the backfill script can reuse it without duplicating the list.
 * "other" is kept as an exact fallback (catch-all for mixed uploads).
 */
export function educationDocTypeCondition() {
  return or(
    ...EDUCATION_FUZZY_KEYWORDS.map((kw) => ilike(documentsTable.type, `%${kw}%`)),
    ilike(documentsTable.type, "other"),
  )!;
}

const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
// Defensive request-budget caps for the single messages.create call.
const MAX_EDUCATION_DOCS = 10;
const MAX_EDUCATION_TOTAL_BYTES = 15 * 1024 * 1024; // raw bytes (~20MB as base64)
const DEFAULT_VISION_MODEL = "claude-sonnet-4-6";

/** Resolve the applied study level server-side (never trust the client). */
export async function resolveAppliedLevelKey(studentId: number): Promise<string | null> {
  const [stu] = await db.select({ interestedLevel: studentsTable.interestedLevel })
    .from(studentsTable)
    .where(and(eq(studentsTable.id, studentId), isNull(studentsTable.deletedAt)));
  if (stu?.interestedLevel && stu.interestedLevel.trim()) return stu.interestedLevel.trim();
  const [appRow] = await db.select({ degree: programsTable.degree })
    .from(applicationsTable)
    .innerJoin(programsTable, eq(applicationsTable.programId, programsTable.id))
    .where(eq(applicationsTable.studentId, studentId))
    .orderBy(desc(applicationsTable.id))
    .limit(1);
  return appRow?.degree && appRow.degree.trim() ? appRow.degree.trim() : null;
}

export type EducationExtractionRunResult =
  | { status: "not_found" }
  | { status: "skipped_filled"; upserted: 0 }
  | { status: "ai_unavailable"; error: string }
  | { status: "ai_failed"; error: string }
  | {
      status: "ok";
      records: EducationRecordOutput[];
      warnings: string[];
      levelKey: string | null;
      upserted: number;
    };

export interface RunEducationExtractionOptions {
  studentId: number;
  /** Actor recorded in the audit log (uploader for the auto trigger). */
  actorUserId: number | null;
  ip?: string;
  /**
   * Auto-trigger idempotency: skip entirely (no AI call, no overwrite) when
   * the student already has at least one data-bearing education record.
   */
  skipIfFilled?: boolean;
  /**
   * Portal preflight mode: AI may complete only empty cells. Existing
   * staff-entered/previously-extracted education is never replaced.
   */
  mergeMissingOnly?: boolean;
  /** Audit action name — endpoint keeps "ai_extract_education". */
  auditAction?: string;
}

async function getExistingEducation(
  studentId: number,
): Promise<EducationRecordOutput[]> {
  const rows = await db.select({
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
    .where(and(
      eq(studentEducationRecordsTable.studentId, studentId),
      isNull(studentEducationRecordsTable.deletedAt),
    ));
  return rows as EducationRecordOutput[];
}

/**
 * The full extract-education core (moved verbatim from the FAZ 1 endpoint):
 * resolve level → collect education docs → ONE anthropic call →
 * decideEducationExtraction → race-safe idempotent upsert → audit.
 */
export async function runEducationExtraction(
  opts: RunEducationExtractionOptions,
): Promise<EducationExtractionRunResult> {
  const { studentId, actorUserId, ip } = opts;
  const auditAction = opts.auditAction ?? "ai_extract_education";

  const [student] = await db.select({ id: studentsTable.id })
    .from(studentsTable)
    .where(and(eq(studentsTable.id, studentId), isNull(studentsTable.deletedAt)));
  if (!student) return { status: "not_found" };

  // Level is resolved SERVER-side; without it we cannot build the
  // level-based prompt section, so return early with a stable warning.
  const levelKey = await resolveAppliedLevelKey(studentId);
  if (!levelKey) {
    const decision = decideEducationExtraction({ levelKey: null, documentCount: 0 });
    logAudit(actorUserId, auditAction, "student", studentId, {
      levelKey: null, documentCount: 0, upserted: 0, warnings: decision.warnings,
    }, ip);
    return { status: "ok", ...decision, upserted: 0 };
  }

  if (
    opts.skipIfFilled &&
    hasRequiredEducationCoverage(
      levelKey,
      await getExistingEducation(studentId),
    )
  ) {
    return { status: "skipped_filled", upserted: 0 };
  }

  // Education-related documents only — photo/passport are never sent.
  const docRows = await db.select({
    id: documentsTable.id,
    name: documentsTable.name,
    type: documentsTable.type,
    fileKey: documentsTable.fileKey,
    fileData: documentsTable.fileData,
    mimeType: documentsTable.mimeType,
  })
    .from(documentsTable)
    .where(and(
      eq(documentsTable.studentId, studentId),
      isNull(documentsTable.deletedAt),
      educationDocTypeCondition(),
    ))
    .orderBy(asc(documentsTable.id));

  // Reuse the existing storage/base64 fallback chain to load bytes.
  // Defensive caps: never exceed the model request budget — stop adding
  // documents past the raw-byte / count limits.
  const loaded: Array<{ label: string; mimeType: string; base64: string }> = [];
  let totalBytes = 0;
  for (const doc of docRows) {
    if (loaded.length >= MAX_EDUCATION_DOCS) {
      console.warn(`[ai-extract-education] student #${studentId}: document count cap (${MAX_EDUCATION_DOCS}) reached — remaining docs skipped`);
      break;
    }
    try {
      const bytes = await loadDocumentBytes(doc);
      if (!bytes) continue;
      const mime = (doc.mimeType || bytes.mimeType || "").toLowerCase();
      const isPdf = mime === "application/pdf";
      const isImage = (IMAGE_MEDIA_TYPES as readonly string[]).includes(mime);
      if (!isPdf && !isImage) continue; // unsupported content for vision
      if (totalBytes + bytes.buffer.length > MAX_EDUCATION_TOTAL_BYTES) {
        console.warn(`[ai-extract-education] student #${studentId}: total byte cap reached — document #${doc.id} and remaining docs skipped`);
        break;
      }
      totalBytes += bytes.buffer.length;
      loaded.push({
        label: `${doc.type}: ${doc.name}`,
        mimeType: mime,
        base64: bytes.buffer.toString("base64"),
      });
    } catch (docErr) {
      console.warn(`[ai-extract-education] failed to load document #${doc.id} (non-fatal):`, docErr);
    }
  }

  if (loaded.length === 0) {
    const decision = decideEducationExtraction({ levelKey, documentCount: 0 });
    logAudit(actorUserId, auditAction, "student", studentId, {
      levelKey, documentCount: 0, upserted: 0, warnings: decision.warnings,
    }, ip);
    return { status: "ok", ...decision, upserted: 0 };
  }

  let anthropic;
  let claudeConfig;
  try {
    const connection = await getDocumentAiConnection("claude", { fallbackToDefault: false });
    anthropic = connection.client;
    claudeConfig = { model: connection.model };
  } catch (err) {
    return {
      status: "ai_unavailable",
      error: err instanceof Error ? err.message : "AI integration not configured",
    };
  }

  // ALL education documents go in ONE messages.create call, reusing the
  // legacy prompt + the level-based education section.
  const promptText = EXTRACT_PROMPT + "\n" + buildEducationPromptSection(levelKey);
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } }
    | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };
  const contentBlocks: ContentBlock[] = [{ type: "text", text: promptText }];
  for (const doc of loaded) {
    contentBlocks.push({ type: "text", text: `\n--- Document: ${doc.label} ---` });
    if (doc.mimeType === "application/pdf") {
      contentBlocks.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: doc.base64 },
      });
    } else {
      contentBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: doc.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: doc.base64,
        },
      });
    }
  }

  let extracted: Record<string, unknown> = {};
  try {
    const message = await documentAiScheduler.run(
      { laneKey: "automatic-education", connectionKey: "claude" },
      () => anthropic.messages.create({
        model: claudeConfig.model || DEFAULT_VISION_MODEL,
        max_tokens: 8192,
        messages: [{ role: "user", content: contentBlocks as never }],
      }),
    );
    const textBlock = message.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      return { status: "ai_failed", error: "No response from AI" };
    }
    const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) extracted = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  } catch (err) {
    return {
      status: "ai_failed",
      error: err instanceof Error ? err.message : "AI extraction failed",
    };
  }

  // Map to the PUT /students/:id/education body shape (level filter, dedup,
  // GPA guarantee), drop no-data records, and apply the CRITICAL GATE FIX:
  // low confidence never drops readable records — they are saved AND flagged
  // with the stable LOW_CONFIDENCE_EDUCATION warning.
  const { records, warnings } = decideEducationExtraction({
    levelKey,
    documentCount: loaded.length,
    educationRecords: extracted.educationRecords,
    confidence: extracted.confidence,
  });

  // Idempotent, race-safe level-based upsert: ON CONFLICT against the
  // partial unique index on (student_id, level) WHERE deleted_at IS NULL.
  let upserted = 0;
  if (records.length > 0) {
    await db.transaction(async (tx) => {
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const values = {
          studentId,
          level: rec.level,
          institution: rec.institution,
          program: rec.program,
          graduationYear: rec.graduationYear,
          gpa: rec.gpa,
          gpaRaw: rec.gpaRaw,
          gpaScale: rec.gpaScale,
          languageScore: rec.languageScore,
          sortOrder: i,
        };
        const currentSet = opts.mergeMissingOnly
          ? {
              institution: sql`coalesce(nullif(btrim(${studentEducationRecordsTable.institution}), ''), ${values.institution})`,
              program: sql`coalesce(nullif(btrim(${studentEducationRecordsTable.program}), ''), ${values.program})`,
              graduationYear: sql`coalesce(${studentEducationRecordsTable.graduationYear}, ${values.graduationYear})`,
              gpa: sql`coalesce(nullif(btrim(${studentEducationRecordsTable.gpa}), ''), ${values.gpa})`,
              gpaRaw: sql`coalesce(nullif(btrim(${studentEducationRecordsTable.gpaRaw}), ''), ${values.gpaRaw})`,
              gpaScale: sql`coalesce(${studentEducationRecordsTable.gpaScale}, ${values.gpaScale})`,
              languageScore: sql`coalesce(nullif(btrim(${studentEducationRecordsTable.languageScore}), ''), ${values.languageScore})`,
              sortOrder: studentEducationRecordsTable.sortOrder,
              updatedAt: new Date(),
            }
          : {
              institution: values.institution,
              program: values.program,
              graduationYear: values.graduationYear,
              gpa: values.gpa,
              gpaRaw: values.gpaRaw,
              gpaScale: values.gpaScale,
              languageScore: values.languageScore,
              sortOrder: values.sortOrder,
              updatedAt: new Date(),
            };
        await tx.insert(studentEducationRecordsTable)
          .values(values)
          .onConflictDoUpdate({
            target: [studentEducationRecordsTable.studentId, studentEducationRecordsTable.level],
            targetWhere: isNull(studentEducationRecordsTable.deletedAt),
            set: currentSet,
          });

        // Keep the detailed portal-facing education store in sync. The worker
        // also merges both stores defensively, but this bridge makes readiness
        // badges and older API surfaces see the same newly recovered fields.
        const detailedValues = {
          studentId,
          level: rec.level,
          schoolName: rec.institution,
          fieldOfStudy: rec.program,
          endYear: rec.graduationYear,
          gpa: rec.gpa ?? rec.gpaRaw,
          gpaType: rec.gpaScale != null ? String(rec.gpaScale) : null,
          languageScore: rec.languageScore,
          // The live education_records table deliberately restricts source to
          // manual | ai_extracted | migrated.  Keep the portal preflight
          // provenance in the audit/meta layer and use the canonical DB value
          // here so a successful extraction cannot be discarded by the check
          // constraint.
          source: AI_EDUCATION_RECORD_SOURCE,
        };
        const detailedSet = opts.mergeMissingOnly
          ? {
              schoolName: sql`coalesce(nullif(btrim(${educationRecordsTable.schoolName}), ''), ${detailedValues.schoolName})`,
              fieldOfStudy: sql`coalesce(nullif(btrim(${educationRecordsTable.fieldOfStudy}), ''), ${detailedValues.fieldOfStudy})`,
              endYear: sql`coalesce(${educationRecordsTable.endYear}, ${detailedValues.endYear})`,
              gpa: sql`coalesce(nullif(btrim(${educationRecordsTable.gpa}), ''), ${detailedValues.gpa})`,
              gpaType: sql`coalesce(nullif(btrim(${educationRecordsTable.gpaType}), ''), ${detailedValues.gpaType})`,
              languageScore: sql`coalesce(nullif(btrim(${educationRecordsTable.languageScore}), ''), ${detailedValues.languageScore})`,
              updatedAt: new Date(),
            }
          : {
              schoolName: detailedValues.schoolName,
              fieldOfStudy: detailedValues.fieldOfStudy,
              endYear: detailedValues.endYear,
              gpa: detailedValues.gpa,
              gpaType: detailedValues.gpaType,
              languageScore: detailedValues.languageScore,
              source: detailedValues.source,
              updatedAt: new Date(),
            };
        await tx.insert(educationRecordsTable)
          .values(detailedValues)
          .onConflictDoUpdate({
            target: [educationRecordsTable.studentId, educationRecordsTable.level],
            set: detailedSet,
          });
        upserted++;
      }
    });
  }

  logAudit(actorUserId, auditAction, "student", studentId, {
    levelKey, documentCount: loaded.length, upserted, warnings,
  }, ip);

  return { status: "ok", records, warnings, levelKey, upserted };
}

// ---------------------------------------------------------------------------
// Automatic trigger (document upload path)
// ---------------------------------------------------------------------------

/** Avalanche guard: at most one auto-run in flight per student per process. */
const inFlight = new Set<number>();

export interface AutoEducationTriggerInput {
  studentId: number | null | undefined;
  documentType: string | null | undefined;
  actorUserId: number | null;
  ip?: string;
}

/**
 * Fire-and-forget auto extraction on document upload. NEVER throws and never
 * blocks the caller — call it WITHOUT await (or void it). Runs only when:
 *  - the document type is transcript/diploma/degree, and
 *  - the student's education records are still empty (skipIfFilled), and
 *  - no auto-run is already in flight for this student.
 */
export function maybeTriggerAutoEducationExtract(input: AutoEducationTriggerInput): void {
  const { studentId, documentType, actorUserId, ip } = input;
  if (!studentId || !isEducationTriggerDocType(documentType)) return;
  if (inFlight.has(studentId)) return;
  inFlight.add(studentId);
  setImmediate(async () => {
    try {
      const result = await runEducationExtraction({
        studentId,
        actorUserId,
        ip,
        skipIfFilled: true,
        mergeMissingOnly: true,
        auditAction: "auto_education_extract",
      });
      if (result.status === "ok") {
        console.log(`[auto-education-extract] auto_education_extract triggered student=${studentId} level=${result.levelKey ?? "unresolved"} upserted=${result.upserted}${result.warnings.length ? ` warnings=${result.warnings.join(",")}` : ""}`);
      } else if (result.status !== "skipped_filled") {
        console.warn(`[auto-education-extract] student=${studentId} not run: ${result.status}${"error" in result ? ` (${result.error})` : ""}`);
      }
    } catch (err) {
      // Non-fatal by contract — the upload already succeeded.
      console.warn(`[auto-education-extract] student=${studentId} failed (non-fatal):`, err);
    } finally {
      inFlight.delete(studentId);
    }
  });
}

// ---------------------------------------------------------------------------
// Lead-to-student conversion trigger
// ---------------------------------------------------------------------------

export interface AutoEducationTriggerForStudentInput {
  studentId: number | null | undefined;
  actorUserId: number | null;
  ip?: string;
}

/**
 * Fire-and-forget auto extraction after a lead's documents are adopted onto a
 * student (via lead convert or embed widget auto-convert). Functionally
 * equivalent to maybeTriggerAutoEducationExtract but does NOT require a
 * specific document type — it checks internally whether the student has any
 * education-trigger documents (transcript/diploma/degree) before making an
 * AI call.
 *
 * Guards:
 *  - studentId must be present
 *  - at least one education-trigger document must exist for this student
 *  - no auto-run already in flight for this student (shared inFlight guard)
 *  - student must have no data-bearing education records (skipIfFilled)
 *
 * NEVER throws and NEVER blocks the caller.  Call with void or fire-and-forget.
 * Audit action: "auto_education_extract_lead_convert"
 */
export function maybeTriggerAutoEducationExtractForStudent(
  input: AutoEducationTriggerForStudentInput,
): void {
  const { studentId, actorUserId, ip } = input;
  if (!studentId) return;
  if (inFlight.has(studentId)) return;
  inFlight.add(studentId);
  setImmediate(async () => {
    try {
      // Check whether the student has any education-trigger documents before
      // incurring an AI call.  This is a cheap read; if none are present the
      // function exits without calling Claude.
      const triggerDocs = await db
        .select({ id: documentsTable.id })
        .from(documentsTable)
        .where(and(
          eq(documentsTable.studentId, studentId),
          isNull(documentsTable.deletedAt),
          educationDocTypeCondition(),
        ))
        .limit(1);
      if (triggerDocs.length === 0) {
        // No education documents — nothing to extract.  Log at debug level only.
        console.log(`[auto-education-extract] student=${studentId} no education-trigger docs after lead convert — skipping`);
        return;
      }

      const result = await runEducationExtraction({
        studentId,
        actorUserId,
        ip,
        skipIfFilled: true,
        mergeMissingOnly: true,
        auditAction: "auto_education_extract_lead_convert",
      });
      if (result.status === "ok") {
        console.log(
          `[auto-education-extract] auto_education_extract_lead_convert student=${studentId}` +
          ` level=${result.levelKey ?? "unresolved"} upserted=${result.upserted}` +
          `${result.warnings.length ? ` warnings=${result.warnings.join(",")}` : ""}`,
        );
      } else if (result.status !== "skipped_filled") {
        console.warn(
          `[auto-education-extract] lead-convert trigger student=${studentId}` +
          ` not run: ${result.status}${"error" in result ? ` (${result.error})` : ""}`,
        );
      }
    } catch (err) {
      // Non-fatal by contract — the conversion already succeeded.
      console.warn(`[auto-education-extract] lead-convert trigger student=${studentId} failed (non-fatal):`, err);
    } finally {
      inFlight.delete(studentId);
    }
  });
}
