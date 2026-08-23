/**
 * educationExtraction — FAZ 3 (AI Çıkarımı).
 *
 * Pure helpers that turn an AI document-extraction result into the
 * level-based `education: [...]` array consumed by the FAZ 2
 * PUT /students/:id/education endpoint.
 *
 * - Which levels get filled is decided by the applied study level
 *   (students.interestedLevel, falling back to the program's level key)
 *   via requiredEducationLevels() from @workspace/db:
 *     Group A → high_school, Group B → bachelor, Group C → bachelor+master.
 * - GPA guarantee: every record's gpa is normalized to a 0-100 percent
 *   (decimals kept), with the original kept in gpaRaw and gpaScale=100.
 * - No `any`: input is parsed with Zod (zod/v4).
 */
import { z } from "zod/v4";
import {
  requiredEducationLevels,
  academicFieldsForLevel,
  type EducationLevel,
} from "@workspace/db";
import { normalizeGpaEvidenceTo100 } from "./gpaNormalize";

export const EDUCATION_LEVEL_VALUES = ["high_school", "bachelor", "master"] as const;

/** Canonical value accepted by education_records_source_check for AI output. */
export const AI_EDUCATION_RECORD_SOURCE = "ai_extracted" as const;

/** Loose shape the AI is asked to return per education record. */
export const aiEducationRecordSchema = z.object({
  level: z.enum(EDUCATION_LEVEL_VALUES),
  institution: z.string().nullish(),
  program: z.string().nullish(),
  graduationYear: z.union([z.number(), z.string()]).nullish(),
  gpa: z.union([z.number(), z.string()]).nullish(),
  languageScore: z.string().nullish(),
});
export type AiEducationRecord = z.infer<typeof aiEducationRecordSchema>;

export const aiEducationArraySchema = z.array(aiEducationRecordSchema);

/** Output shape — compatible with PutStudentEducationBody records[]. */
export interface EducationRecordOutput {
  level: EducationLevel;
  institution: string | null;
  program: string | null;
  graduationYear: number | null;
  gpa: string | null;
  gpaRaw: string | null;
  gpaScale: number | null;
  languageScore: string | null;
}

/**
 * Build the prompt section instructing the AI which education records to
 * extract for the applied study level.
 */
export function buildEducationPromptSection(levelKey: string): string {
  const levels = requiredEducationLevels(levelKey);
  const recordSpecs = levels.map((lvl) => {
    const fields = academicFieldsForLevel(lvl);
    const fieldDesc = fields
      .map((f) => {
        switch (f) {
          case "institution":
            return lvl === "high_school"
              ? '"institution": high school name'
              : '"institution": university name';
          case "program":
            return '"program": department/major/program name';
          case "graduationYear":
            return '"graduationYear": 4-digit graduation year (number)';
          case "gpa":
            return '"gpa": the grade exactly as printed on the transcript/diploma, in its native scale (e.g. "3.42/4", "87.5", "15/20")';
          case "languageScore":
            return '"languageScore": language test score as free text (e.g. "IELTS 7.0", "TOEFL 95")';
        }
      })
      .join("; ");
    return `  - { "level": "${lvl}", ${fieldDesc} }`;
  });
  return [
    "",
    "EDUCATION RECORDS (level-based):",
    `The student is applying for study level "${levelKey}". Fill ONLY these education records from the provided documents:`,
    ...recordSpecs,
    'Return them as an "educationRecords" array in the JSON. Use null for anything you cannot confidently read — never guess.',
    "Take the grade (gpa) from the transcript or diploma; take the language score from a language certificate if present.",
  ].join("\n");
}

/**
 * Normalize a single AI record into the PUT body shape with the GPA
 * guarantee applied.
 */
function normalizeRecord(rec: AiEducationRecord): EducationRecordOutput {
  const gyNum = rec.graduationYear != null && rec.graduationYear !== ""
    ? parseInt(String(rec.graduationYear), 10)
    : NaN;

  let gpa: string | null = null;
  let gpaRaw: string | null = null;
  let gpaScale: number | null = null;
  if (rec.gpa != null && String(rec.gpa).trim() !== "") {
    const raw = String(rec.gpa).trim();
    const pct = normalizeGpaEvidenceTo100(raw);
    if (!isNaN(pct)) {
      // Portal compatibility (SIT/Zoho rejects decimal GPA): always an
      // INTEGER percentage 0–100. Original kept in gpaRaw.
      gpa = String(Math.min(100, Math.max(0, Math.round(pct))));
      gpaRaw = raw;
      gpaScale = 100;
    } else {
      // Unnormalizable grade: keep the raw text so nothing is lost.
      gpa = raw;
      gpaRaw = raw;
      gpaScale = null;
    }
  }

  const clean = (v: string | null | undefined): string | null =>
    v != null && String(v).trim() !== "" ? String(v).trim().slice(0, 300) : null;

  return {
    level: rec.level,
    institution: clean(rec.institution),
    program: rec.level === "high_school" ? null : clean(rec.program),
    graduationYear: Number.isFinite(gyNum) ? gyNum : null,
    gpa,
    gpaRaw,
    gpaScale,
    languageScore: clean(rec.languageScore),
  };
}

/** true when at least one extractable field carries data. */
export function educationRecordHasData(rec: EducationRecordOutput): boolean {
  return (
    rec.institution != null ||
    rec.program != null ||
    rec.gpa != null ||
    rec.graduationYear != null ||
    rec.languageScore != null
  );
}

/**
 * A record under the wrong historic level is not sufficient. For example,
 * after Associate → Master changes, a populated high_school row must not stop
 * extraction of the now-required bachelor evidence.
 */
export function hasRequiredEducationCoverage(
  levelKey: string,
  records: EducationRecordOutput[],
): boolean {
  const hasText = (value: unknown): boolean =>
    value !== undefined &&
    value !== null &&
    String(value).trim() !== "";
  const required = requiredEducationLevels(levelKey);
  return required.every((level) =>
    records.some(
      (record) =>
        record.level === level &&
        hasText(record.institution) &&
        record.graduationYear != null &&
        (hasText(record.gpa) || hasText(record.gpaRaw)),
    ),
  );
}

/**
 * Document types loaded as AI input for education extraction. Must cover
 * every type that can trigger the automatic run (transcript/diploma/degree)
 * plus "other" (mixed uploads often land there).
 *
 * NOTE: This exact-match list is kept for legacy references that still need
 * an array constant.  The actual SQL filter used by runEducationExtraction
 * and related functions is the broader fuzzy condition generated by
 * educationDocTypeCondition() in educationAutoExtract.ts, which matches
 * real-world document labels such as "high school diploma translation",
 * "class 12th marks sheet", "bachelor's transcript", etc.
 */
export const EDUCATION_SOURCE_DOC_TYPES = ["transcript", "diploma", "degree", "other"] as const;

/**
 * Fuzzy keyword fragments used to decide whether a document type label
 * is education-related.  Each entry is matched as a CASE-INSENSITIVE
 * SUBSTRING of the type string.  Kept here (pure TS, no DB) so both
 * the in-process regex guard and the SQL filter stay in sync from one
 * source of truth.
 *
 * Deliberately excludes passport, photo, photograph, visa, bank, reference —
 * none of those substrings appear in the list below.
 */
export const EDUCATION_FUZZY_KEYWORDS: readonly string[] = [
  "transcript",
  "diploma",
  "degree",
  "marks",       // marksheet, marks sheet, class 12th marks, mark card
  "certificate", // school certificate, leaving certificate, academic certificate
  "cert",        // abbreviated form: leaving cert, a-level cert (superset of "certificate")
  "result",      // exam result, result sheet
  "grade",       // grade card, grade sheet
  "academic",    // academic record, academic transcript
  "secondary",   // secondary school certificate
  "leaving",     // school leaving certificate
  "baccalaur",   // baccalaureate
  "matriculat",  // matriculation
  "hsc",         // Higher Secondary Certificate (South Asia: class_12th_hsc_marks_sheet)
  "ssc",         // Secondary School Certificate (South Asia)
  "equivalency", // credential equivalency, education equivalency documents
] as const;

/** Document types that carry education data and may auto-trigger extraction.
 *
 * Uses substring / partial matching so real-world document labels such as
 * "high school diploma translation", "class 12th marks sheet", or
 * "bachelor's transcript" are correctly recognised without requiring an
 * exact match against the short fixed list.
 */
export function isEducationTriggerDocType(documentType: string | null | undefined): boolean {
  const s = String(documentType || "").toLowerCase();
  return EDUCATION_FUZZY_KEYWORDS.some((kw) => s.includes(kw));
}

export interface AutoEducationTriggerDecisionInput {
  documentType: string | null | undefined;
  /** Existing (non-deleted) student_education_records rows for the student. */
  existingRecords: EducationRecordOutput[];
}

/**
 * Pure decision core of the automatic document-upload trigger:
 * run auto extraction ONLY for transcript/diploma/degree documents AND only
 * while the student's education is still empty (idempotent — a student with
 * any data-bearing record is never re-extracted or overwritten).
 */
export function decideAutoEducationTrigger(input: AutoEducationTriggerDecisionInput): boolean {
  if (!isEducationTriggerDocType(input.documentType)) return false;
  return !input.existingRecords.some(educationRecordHasData);
}

export interface LegacyEducationAutoUpsertInput {
  confidence?: unknown;
  record: EducationRecordOutput;
}

export interface LegacyEducationAutoUpsertDecision {
  save: boolean;
  lowConfidence: boolean;
}

/**
 * Shared gate for the legacy /ai/extract-document FIX-15D auto-upsert path.
 *
 * Same CRITICAL rule as decideEducationExtraction: low confidence never
 * blanket-skips — a record carrying ANY readable field (institution /
 * program / gpa / graduationYear / languageScore) is still saved
 * (partial-save) and flagged LOW_CONFIDENCE_EDUCATION by the caller.
 * Normal/high confidence behavior is unchanged (always save).
 */
export function decideLegacyEducationAutoUpsert(
  input: LegacyEducationAutoUpsertInput,
): LegacyEducationAutoUpsertDecision {
  if (input.confidence !== "low") {
    return { save: true, lowConfidence: false };
  }
  return { save: educationRecordHasData(input.record), lowConfidence: true };
}

export interface ExtractEducationDecisionInput {
  levelKey: string | null;
  documentCount: number;
  educationRecords?: unknown;
  confidence?: unknown;
}

export interface ExtractEducationDecision {
  records: EducationRecordOutput[];
  warnings: string[];
  levelKey: string | null;
}

/**
 * Pure decision core of POST /ai/students/:id/extract-education.
 *
 * - No resolvable level → LEVEL_UNRESOLVED, nothing to save.
 * - No education documents → NO_EDUCATION_DOCUMENTS, nothing to save.
 * - Otherwise map the AI educationRecords via mapExtractionToEducation and
 *   drop records with no readable data.
 * - CRITICAL GATE: confidence === "low" never drops readable records — they
 *   are kept for saving and flagged with LOW_CONFIDENCE_EDUCATION instead.
 */
export function decideEducationExtraction(
  input: ExtractEducationDecisionInput,
): ExtractEducationDecision {
  if (!input.levelKey) {
    return { records: [], warnings: ["LEVEL_UNRESOLVED"], levelKey: null };
  }
  if (input.documentCount <= 0) {
    return { records: [], warnings: ["NO_EDUCATION_DOCUMENTS"], levelKey: input.levelKey };
  }
  const mapped = mapExtractionToEducation(input.educationRecords, input.levelKey);
  const records = mapped.filter(educationRecordHasData);
  const warnings: string[] = [];
  if (input.confidence === "low" && records.length > 0) {
    warnings.push("LOW_CONFIDENCE_EDUCATION");
  }
  return { records, warnings, levelKey: input.levelKey };
}

/**
 * Map a raw AI extraction to the final `education` array for the applied
 * level: keep only the levels required by the level key, dedup levels
 * (first wins), normalize GPA, order as requiredEducationLevels() orders.
 */
export function mapExtractionToEducation(
  rawRecords: unknown,
  levelKey: string,
): EducationRecordOutput[] {
  const parsed = aiEducationArraySchema.safeParse(rawRecords);
  if (!parsed.success) return [];
  const allowed = requiredEducationLevels(levelKey);
  const byLevel = new Map<EducationLevel, AiEducationRecord>();
  for (const rec of parsed.data) {
    if (allowed.includes(rec.level) && !byLevel.has(rec.level)) {
      byLevel.set(rec.level, rec);
    }
  }
  const out: EducationRecordOutput[] = [];
  for (const lvl of allowed) {
    const rec = byLevel.get(lvl);
    if (rec) out.push(normalizeRecord(rec));
  }
  return out;
}
