/**
 * Build a human-readable display name for an uploaded document.
 *
 * Used by every document-upload code path (panel, public-apply,
 * embed widget, agent app create) so the stored `documents.name`
 * (or `application_stage_documents.fileName`) always looks like
 * `"EYMEN NAMAZCI - Passport.pdf"` instead of the raw client filename.
 */

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Mirrors `artifacts/edcons/src/lib/programDocTypes.ts` PROGRAM_DOC_META so
// the label staff/students see in the panel matches the stored file name.
// Keep keys lowercase. Add new keys here when the panel adds them.
const DOC_LABELS: Record<string, string> = {
  passport: "Passport",
  photo: "Photograph",
  photograph: "Photograph",
  high_school_diploma: "High School Diploma",
  hs_diploma: "High School Diploma",
  high_school_diploma_translation: "HS Diploma (Translation)",
  class_10th_ssc_marks_sheet: "Class 10 / SSC Marks Sheet",
  class_12th_hsc_certificate: "Class 12 / HSC Certificate",
  class_12th_hsc_marks_sheet: "Class 12 / HSC Marks Sheet",
  diploma_certificate: "Diploma Certificate",
  diploma_transcript: "Diploma Transcript",
  diploma_recognition: "Diploma Recognition",
  bachelors_certificate: "Bachelor's Certificate",
  bachelors_transcript: "Bachelor's Transcript",
  bachelors_provisional_certificate: "Bachelor's Provisional Cert.",
  bachelors_transcript_all_semesters: "Bachelor's Transcript (All Sem.)",
  masters_certificate: "Master's Certificate",
  masters_transcript: "Master's Transcript",
  masters_provisional_certificate: "Master's Provisional Cert.",
  masters_transcript_all_semesters: "Master's Transcript (All Sem.)",
  cv: "CV",
  resume: "CV",
  lor: "Recommendation Letter",
  recommendation_letter: "Recommendation Letter",
  sop: "Statement of Purpose",
  statement_of_purpose: "Statement of Purpose",
  essay: "Essay",
  experience_letters: "Experience Letters",
  other_certificates_documents: "Other Certificates",
  ielts_pte_gre_gmat_toefl_duolingo: "Language/Test Score",
  language_certificate: "Language Certificate",
  language_test: "Language Test",
  portfolio: "Portfolio",
  research_proposal: "Research Proposal",
  publication_list: "Publication List",
  birth_certificate: "Birth Certificate",
  national_id: "National ID",
  bank_statement: "Bank Statement",
  sponsor_letter: "Sponsor Letter",
  military_status_document: "Military Status Document",
  yos_score_report: "YÖS Score Report",
  transcript: "Transcript",
  diploma: "Diploma",
  other: "Other Document",
  // Stage-document labels (mirror StageDocumentsPanel.STAGE_LABELS) so
  // that application_stage_documents downloads also get a friendly label.
  app_fee_paid: "Application Fee Paid",
  missing_docs: "Missing Documents",
  upload_payment: "Upload Payment",
  deposit_paid: "Deposit Paid Receipt",
  visa_approved: "Visa OK",
  student_card: "Student Card",
  visa_reject: "Visa Reject",
  offer_received: "Offer",
  acceptance_letter: "Acceptance Letter",
  final_acceptance: "Final Acceptance Letter",
};

// Older Add Student clients sent the visible label instead of the canonical
// document key. Keep the aliases explicit: ambiguous labels must not be
// guessed into the wrong document category.
const LEGACY_DOC_TYPE_ALIASES: Record<string, string> = {
  "diploma certificate": "diploma_certificate",
  "diploma transcript": "diploma_transcript",
  "bachelor's cert.": "bachelors_certificate",
  "bachelor’s cert.": "bachelors_certificate",
};

export function normalizeDocumentTypeKey(value: unknown): string {
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return "";
  return LEGACY_DOC_TYPE_ALIASES[key] ?? key;
}

/**
 * In-memory cache of admin-managed document-type labels from the
 * `catalog_options` table (category='documents'). Refreshed lazily
 * every 5 minutes; failures fall back to the static DOC_LABELS map.
 * Lets admins add new document types in the UI and have them appear
 * in download filenames without a server restart.
 */
let dbLabelCache: Record<string, string> | null = null;
let dbLabelCacheUntil = 0;
const DB_LABEL_TTL_MS = 5 * 60 * 1000;

async function loadDbLabels(): Promise<Record<string, string>> {
  const now = Date.now();
  if (dbLabelCache && now < dbLabelCacheUntil) return dbLabelCache;
  try {
    const mod = await import("@workspace/db");
    const { db } = mod as { db: { execute: (q: unknown) => Promise<{ rows: { value: string; metadata: { label?: unknown } | null }[] }> } };
    const sqlMod = await import("drizzle-orm");
    const result = await db.execute(sqlMod.sql`SELECT value, metadata FROM catalog_options WHERE category = 'documents' AND is_active = true`);
    const map: Record<string, string> = {};
    for (const row of result.rows ?? []) {
      const label = row.metadata && typeof row.metadata.label === "string" ? row.metadata.label : null;
      if (label) map[String(row.value).toLowerCase()] = label;
    }
    dbLabelCache = map;
    dbLabelCacheUntil = now + DB_LABEL_TTL_MS;
    return map;
  } catch {
    dbLabelCache = dbLabelCache || {};
    dbLabelCacheUntil = now + DB_LABEL_TTL_MS;
    return dbLabelCache;
  }
}

// Kick off a background refresh on module load so the first request
// already has the cache warm (best-effort, errors swallowed above).
void loadDbLabels();

export function invalidateDocLabelCache(): void {
  dbLabelCache = null;
  dbLabelCacheUntil = 0;
}

export function getDocLabel(docType: string | null | undefined): string {
  if (!docType) return "Document";
  const key = String(docType).toLowerCase().trim();
  // Prefer admin-managed label, fall back to hardcoded map, then humanise.
  if (dbLabelCache && dbLabelCache[key]) {
    void loadDbLabels(); // refresh in background when stale
    return dbLabelCache[key];
  }
  // Trigger background load on cache miss (non-blocking).
  void loadDbLabels();
  if (DOC_LABELS[key]) return DOC_LABELS[key];
  // Friendly fallback: turn `military_status_document` into
  // `Military Status Document`.
  return key
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ") || "Document";
}

function extFromMime(mimeType: string | null | undefined): string {
  if (!mimeType) return "";
  return EXT_BY_MIME[String(mimeType).toLowerCase()] || "";
}

/**
 * Sanitize a single name component (no path separators / control chars)
 * and trim length. Mirrors what `sanitizeFileName` does in `lib/files`
 * but operates on the composed string we build below.
 */
function sanitizeNameComponent(s: string, max = 80): string {
  return String(s ?? "")
    .replace(/[\\/<>:"|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Compose a descriptive document name like
 *   "EYMEN NAMAZCI - Passport.pdf"
 *
 * - `studentName` may be the full name or just first/last;
 *   passing an empty string yields just `"Passport.pdf"`.
 * - `mimeType` is used to append the right extension; pass null to skip.
 */
export function buildDocName(
  studentName: string,
  docType: string | null | undefined,
  mimeType?: string | null,
): string {
  const cleanName = sanitizeNameComponent(studentName, 120);
  const label = sanitizeNameComponent(getDocLabel(docType), 80);
  const stem = cleanName ? `${cleanName} - ${label}` : label;
  const ext = extFromMime(mimeType);
  const full = ext ? `${stem}.${ext}` : stem;
  return full.slice(0, 255);
}

/**
 * Convenience: build name from first/last directly.
 */
export function buildDocNameFromParts(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
  docType: string | null | undefined,
  mimeType?: string | null,
): string {
  const full = [firstName, lastName].filter(Boolean).join(" ").trim();
  return buildDocName(full, docType, mimeType);
}
