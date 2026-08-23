/**
 * profile.ts — builds a SubmitProfile + SubmitFiles from the DB record
 * for a given portal submission (or directly from an application).
 *
 * Documents are downloaded from their fileUrl / fileKey, or decoded from
 * base64 fileData, into a per-submission temp dir so the adapter can
 * reference them as local file paths.
 *
 * Two entry points share the same profile-mapping + document-download core:
 *   - buildStudentProfile(submissionId)      — used by the production worker
 *     (resolves application + student from a portal_submissions row).
 *   - buildProfileFromApplication(appId)      — used by the local dry-test CLI
 *     (resolves student directly from an application, no submission row).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  db,
  portalSubmissionsTable,
  applicationsTable,
  studentsTable,
  documentsTable,
  educationRecordsTable,
  studentEducationRecordsTable,
} from "@workspace/db";
import { eq, and, isNull, isNotNull, or, desc } from "drizzle-orm";
import { buildProfile, mapDocType, REQUIRED_DOCS, extractStudentDocumentRefs, selectPriorSchoolName, buildSignedStudentPhotoPath, buildSignedDocumentPath, docFetchUrl, validateIdentityFields, formatIdentityErrors, portalPreflightManifest, sitPassportIdentityProofFromDocument } from "@workspace/portal-adapters";
import type { SubmitProfile, SubmitFiles, StudentDocumentRef } from "@workspace/portal-adapters";
import {
  resolveAltinbasPassportDates,
  resolvePortalResidenceDefaults,
  selectFirstDocumentPerMappedSlot,
  shouldDeduplicateDocumentSlots,
} from "./altinbasLegacyPolicy.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface StudentProfileResult {
  profile: SubmitProfile;
  files: SubmitFiles;
  /** Caller is responsible for removing this directory after use. */
  tempDir: string;
  /** SubmitFiles keys that were successfully downloaded (for logging / resultJson). */
  filledSlots: string[];
  /** REQUIRED_DOCS slots with no downloaded file (for logging / resultJson). */
  missingSlots: string[];
  /**
   * Per-slot download errors for slots that had a document record but failed
   * to produce a local file. Empty when all slots resolved cleanly.
   */
  downloadErrors: Record<string, string>;
  /**
   * True when the student has at least one content-bearing document row
   * (fileUrl/fileKey/fileData) in the CRM, regardless of whether any local
   * file was actually resolved. Distinguishes "document-bearing student with
   * a broken download pipeline" (must block submit for browser adapters)
   * from "student genuinely has zero CRM documents" (existing behaviour,
   * must NOT be blocked).
   */
  hasContentBearingDocs: boolean;
}

export interface ApplicationPreflightSnapshot {
  applicationId: number | null;
  studentId: number;
  profile: SubmitProfile;
  documentTypes: string[];
}

type StudentRow = typeof studentsTable.$inferSelect;
type ApplicationRow = typeof applicationsTable.$inferSelect;

// ---------------------------------------------------------------------------
// Shared core: profile mapping
// ---------------------------------------------------------------------------

/**
 * Maps a CRM student + application record into a CRM-agnostic SubmitProfile.
 * Single source of truth shared by both entry points below.
 */
export function buildSubmitProfileFromRecords(
  student: StudentRow,
  app: Pick<ApplicationRow, "level" | "programName" | "programId" | "universityName">,
  options: {
    allowMissingProgramId?: boolean;
    allowIncompleteProfile?: boolean;
  } = {},
): SubmitProfile {
  return buildProfile({
    email:          student.email          ?? "",
    passportNumber: student.passportNumber ?? "",
    firstName:      student.firstName       ?? "",
    lastName:       student.lastName        ?? "",
    dateOfBirth:    student.dateOfBirth     ?? "",
    gender:         student.gender          ?? "",
    fatherName:     student.fatherName?.trim() || "-",
    motherName:     student.motherName?.trim() || "-",
    nationality:    student.nationality     ?? "",
    address:        student.address         ?? "",
    addressStreet:  student.address?.trim() || undefined,
    addressCity:    student.addressCity?.trim() || undefined,
    addressZip:     student.postalCode?.trim() || undefined,
    cityOfBirth:    student.cityOfBirth?.trim() || undefined,
    visaSupport:
      student.needsVisaSupport == null
        ? undefined
        : student.needsVisaSupport ? "Yes" : "No",
    phone:          student.phoneE164 ?? student.phone ?? "",
    level:          app.level               ?? "",
    programName:    app.programName         ?? "",
    programId:      app.programId           != null ? String(app.programId) : "",
    universityName: app.universityName      ?? undefined,
    schoolName:     selectPriorSchoolName(app.level, {
      highSchool:         student.highSchool,
      universityBachelor: student.universityBachelor,
      universityMaster:   student.universityMaster,
    }),
    gpa:            student.gpa             ?? undefined,
    graduationYear: student.graduationYear  ?? undefined,
    languageScore:      student.languageScore != null ? Number(student.languageScore) : undefined,
    passportIssueDate:  student.passportIssueDate ?? undefined,
    passportExpiryDate: student.passportExpiry    ?? undefined,
  }, options);
}

export interface DraftApplicationPreflightInput {
  studentId: number;
  programId: number | null;
  level: string | null;
  programName: string | null;
  universityName: string | null;
}

async function buildPreflightSnapshotFromRecords(
  applicationId: number | null,
  student: StudentRow,
  app: Pick<ApplicationRow, "level" | "programName" | "programId" | "universityName">,
  adapterKey: string,
): Promise<ApplicationPreflightSnapshot> {
  const [detailed, current, documents] = await Promise.all([
    db.select().from(educationRecordsTable)
      .where(eq(educationRecordsTable.studentId, student.id)),
    db.select().from(studentEducationRecordsTable)
      .where(and(
        eq(studentEducationRecordsTable.studentId, student.id),
        isNull(studentEducationRecordsTable.deletedAt),
      )),
    db.select({ type: documentsTable.type })
      .from(documentsTable)
      .where(and(
        eq(documentsTable.studentId, student.id),
        isNull(documentsTable.deletedAt),
        or(
          isNotNull(documentsTable.fileUrl),
          isNotNull(documentsTable.fileKey),
          isNotNull(documentsTable.fileData),
        ),
      )),
  ]);

  const merged = mergePortalEducationRecords(detailed, current);
  const profile = buildSubmitProfileFromRecords(student, app, {
    // Portal rows must be matched against the portal's live catalogue by
    // university/program/level labels. CRM catalogue ids are mutable and can
    // disappear after a yearly programme refresh; they are optional evidence,
    // never the only identity proof.
    allowMissingProgramId: true,
    allowIncompleteProfile: true,
  });
  applyEducationFallbacks(profile, merged);
  const residence = resolvePortalResidenceDefaults({
    universityKey: adapterKey,
    addressCity: student.addressCity,
    postalCode: student.postalCode,
    address: student.address,
    nationality: student.nationality,
  });
  profile.addressCity ||= residence.addressCity;
  profile.addressZip ||= residence.postalCode;
  if (merged.length > 0) profile.educationRecords = merged as any;
  if (student.photoUrl?.trim()) profile.photoUrl = student.photoUrl.trim();

  return {
    applicationId,
    studentId: student.id,
    profile,
    documentTypes: documents.map((row) => row.type),
  };
}

type LegacyEducationRow = typeof educationRecordsTable.$inferSelect;
type StudentEducationRow = typeof studentEducationRecordsTable.$inferSelect;

/**
 * The application currently has two education stores:
 * - education_records: detailed/legacy portal shape
 * - student_education_records: current staff form + automatic AI extraction
 *
 * Merge them level-by-level without overwriting a detailed value. This keeps
 * the worker compatible with historical rows while making newly AI-extracted
 * education immediately visible to every adapter.
 */
export function mergePortalEducationRecords(
  detailed: LegacyEducationRow[],
  current: StudentEducationRow[],
): LegacyEducationRow[] {
  const byLevel = new Map<string, LegacyEducationRow>();
  for (const row of detailed) byLevel.set(row.level, { ...row });

  for (const row of current) {
    const existing = byLevel.get(row.level);
    const supplemental = {
      id: existing?.id ?? -row.id,
      studentId: row.studentId,
      level: row.level,
      schoolName: row.institution,
      country: null,
      fieldOfStudy: row.program,
      startMonth: null,
      startYear: null,
      endMonth: null,
      endYear: row.graduationYear,
      city: null,
      languageScore: row.languageScore,
      gpa: row.gpa ?? row.gpaRaw,
      gpaType: row.gpaScale != null ? String(row.gpaScale) : null,
      source: "student_education_records",
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    } satisfies LegacyEducationRow;

    if (!existing) {
      byLevel.set(row.level, supplemental);
      continue;
    }
    const fill = <T>(primary: T | null, fallback: T | null): T | null =>
      primary == null ||
      (typeof primary === "string" && primary.trim() === "")
        ? fallback
        : primary;
    byLevel.set(row.level, {
      ...existing,
      schoolName: fill(existing.schoolName, supplemental.schoolName),
      fieldOfStudy: fill(existing.fieldOfStudy, supplemental.fieldOfStudy),
      endYear: fill(existing.endYear, supplemental.endYear),
      languageScore: fill(existing.languageScore, supplemental.languageScore),
      gpa: fill(existing.gpa, supplemental.gpa),
      gpaType: fill(existing.gpaType, supplemental.gpaType),
    });
  }
  return [...byLevel.values()];
}

function applyEducationFallbacks(
  profile: SubmitProfile,
  records: LegacyEducationRow[],
): void {
  const level = String(profile.level ?? "").toLowerCase();
  const wanted =
    /phd|doctor|doktora/.test(level)
      ? ["master", "bachelor", "high_school"]
      : /master|graduate|yüksek|yuksek/.test(level)
        ? ["bachelor", "high_school"]
        : ["high_school"];
  const record =
    wanted.map((key) => records.find((row) => row.level === key)).find(Boolean) ??
    records[0];
  if (!record) return;

  if (!profile.schoolName?.trim() && record.schoolName?.trim()) {
    profile.schoolName = record.schoolName.trim();
  }
  if (
    profile.graduationYear == null &&
    record.endYear != null &&
    Number.isFinite(Number(record.endYear))
  ) {
    profile.graduationYear = Number(record.endYear);
  }
  if (profile.gpa == null && record.gpa != null) {
    const numeric = Number(String(record.gpa).replace(",", "."));
    if (Number.isFinite(numeric)) profile.gpa = numeric;
  }
  if (profile.languageScore == null && record.languageScore != null) {
    const numeric = Number(String(record.languageScore).replace(",", "."));
    if (Number.isFinite(numeric)) profile.languageScore = numeric;
  }
}

/**
 * Cheap DB-only profile snapshot for the API enqueue gate. It deliberately
 * does not download document bytes or open a browser.
 */
export async function buildApplicationPreflightSnapshot(
  applicationId: number,
  options: { adapterKey?: string } = {},
): Promise<ApplicationPreflightSnapshot> {
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(and(
      eq(applicationsTable.id, applicationId),
      isNull(applicationsTable.deletedAt),
    ));
  if (!app) throw new Error(`Application ${applicationId} not found`);

  const [student] = await db
    .select()
    .from(studentsTable)
    .where(and(
      eq(studentsTable.id, app.studentId),
      isNull(studentsTable.deletedAt),
    ));
  if (!student) throw new Error(`Student ${app.studentId} not found`);

  return buildPreflightSnapshotFromRecords(
    applicationId,
    student,
    app,
    options.adapterKey ?? "",
  );
}

/**
 * Portal readiness before an application row exists. Creation endpoints use
 * this to enrich/validate the student first, so an incomplete application
 * never enters Inquiry and then fails silently in the automation queue.
 */
export async function buildDraftApplicationPreflightSnapshot(
  input: DraftApplicationPreflightInput,
  options: { adapterKey?: string } = {},
): Promise<ApplicationPreflightSnapshot> {
  const [student] = await db
    .select()
    .from(studentsTable)
    .where(and(
      eq(studentsTable.id, input.studentId),
      isNull(studentsTable.deletedAt),
    ));
  if (!student) throw new Error(`Student ${input.studentId} not found`);

  return buildPreflightSnapshotFromRecords(
    null,
    student,
    {
      programId: input.programId,
      level: input.level,
      programName: input.programName,
      universityName: input.universityName,
    },
    options.adapterKey ?? "",
  );
}

// ---------------------------------------------------------------------------
// Shared core: document download
// ---------------------------------------------------------------------------

interface DownloadedDocs {
  files: SubmitFiles;
  tempDir: string;
  filledSlots: string[];
  missingSlots: string[];
  downloadErrors: Record<string, string>;
  /** Photo URL for URL-fetching create webhooks (e.g. SIT). */
  photoUrl?: string;
  /** Document URLs for URL-fetching create webhooks (e.g. SIT). */
  documentRefs: StudentDocumentRef[];
  /** See StudentProfileResult.hasContentBearingDocs. */
  hasContentBearingDocs: boolean;
  /** High-confidence identity extracted independently from the passport. */
  passportIdentityProof?: SubmitProfile["passportIdentityProof"];
}

/**
 * Non-JPEG raster image formats we convert to JPEG. JPEG is intentionally
 * absent (already accepted), as are vector/document formats (svg, pdf) and any
 * format sharp reports that we don't want to rasterize.
 */
const CONVERTIBLE_RASTER_FORMATS = new Set([
  "png",
  "webp",
  "gif",
  "tiff",
  "avif",
  "heif", // HEIC reports as "heif" — converted only if this sharp build supports it
]);

/**
 * Some portals (e.g. Topkapı) accept only JPG/JPEG for the photo and reject
 * PNG / WEBP / HEIC with "Dosya türü geçersiz". Convert any non-JPEG raster
 * IMAGE to JPEG before upload (PDFs and already-JPEG files are left untouched).
 *
 * Detection is CONTENT-based via sharp.metadata() — the extension and DB
 * mimeType are NOT trusted, so a PNG mislabeled as .jpg / image/jpeg is still
 * converted. Only formats in CONVERTIBLE_RASTER_FORMATS are converted, so real
 * JPEGs, PDFs, SVGs and anything sharp can't read are left exactly as-is.
 *
 * The photo slot is the exception: Topkapı also rejects raw CRM JPEGs on the
 * "Fotoğraf" field but accepts the same image once re-encoded through sharp, so
 * the photo is ALWAYS re-encoded (regardless of input format) into a clean
 * baseline sRGB JPEG with metadata stripped.
 *
 * Returns the (possibly new .jpg) path; never throws — on failure the original
 * path is returned so the upload still proceeds.
 */
async function ensureJpegImage(
  filePath: string,
  docKey: string,
  logLabel: string,
): Promise<string> {
  let format: string | undefined;
  try {
    format = (await sharp(filePath).metadata()).format;
  } catch {
    // Not a sharp-decodable image (e.g. PDF or unsupported codec) — leave as is.
    return filePath;
  }
  if (!format) return filePath;

  // Photo slot: ALWAYS re-encode through sharp, even when already JPEG. The
  // portal rejects raw CRM JPEGs but accepts sharp-re-encoded baseline JPEGs.
  if (docKey === "photo") {
    const jpgPath = filePath.replace(/\.[^.]+$/, "") + ".jpg";
    const kb = (n: number) => Math.round(n / 1024);
    let oldSize = 0;
    try {
      oldSize = (await fs.stat(filePath)).size;
    } catch {
      /* keep 0 */
    }
    try {
      const out = await sharp(filePath)
        .rotate() // bake in EXIF orientation
        .flatten({ background: "#ffffff" }) // drop alpha → white
        .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 90, progressive: false, mozjpeg: false }) // baseline, no metadata
        .toBuffer();
      await fs.writeFile(jpgPath, out);
      console.log(
        `[portal-profile] ${logLabel} normalized photo ${kb(oldSize)}→${kb(out.length)} KB`,
      );
      return jpgPath;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[portal-profile] ${logLabel} photo normalize failed — format=${format}: ${msg}`,
      );
      return filePath;
    }
  }

  if (!CONVERTIBLE_RASTER_FORMATS.has(format)) return filePath;

  const jpgPath = filePath.replace(/\.[^.]+$/, "") + ".jpg";
  try {
    await sharp(filePath).jpeg({ quality: 90 }).toFile(jpgPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[portal-profile] ${logLabel} jpeg conversion failed — slot=${docKey} format=${format}: ${msg}`,
    );
    return filePath;
  }
  console.log(`[portal-profile] ${logLabel} converted ${docKey} ${format}→jpg`);
  return jpgPath;
}

/**
 * Document slots that the portal accepts ONLY as PDF (passport, transcript,
 * diploma). The photo slot is intentionally absent — it must stay an image
 * (JPEG), handled by ensureJpegImage above.
 */
const PDF_DOC_SLOTS = new Set<string>(["passport", "transcript", "diploma", "english", "motivation", "recommendation"]);

/**
 * Some portals (e.g. Topkapı) accept passport / transcript / diploma ONLY as
 * PDF and reject JPG / PNG with "Dosya türü geçersiz". Wrap any raster IMAGE
 * for these slots into a single-page PDF before upload.
 *
 * Detection is CONTENT-based: files that already start with the %PDF- magic
 * bytes are left untouched; otherwise sharp decodes the image (JPEG/PNG embed
 * directly, anything else — webp/heic/tiff/gif/avif — is rasterized to JPEG
 * first). Files sharp can't read and that aren't PDFs are left exactly as-is so
 * the upload still proceeds. Never throws — on failure the original path is
 * returned.
 */
async function ensurePdfDocument(
  filePath: string,
  docKey: string,
  logLabel: string,
): Promise<string> {
  // Already a PDF? leave untouched (detect by magic bytes, not extension/mime).
  try {
    const fh = await fs.open(filePath, "r");
    try {
      const head = Buffer.alloc(5);
      await fh.read(head, 0, 5, 0);
      if (head.toString("latin1") === "%PDF-") return filePath;
    } finally {
      await fh.close();
    }
  } catch {
    return filePath;
  }

  // Not a PDF — must be a sharp-decodable image to wrap, else leave as-is.
  let format: string | undefined;
  try {
    format = (await sharp(filePath).metadata()).format;
  } catch {
    return filePath;
  }
  if (!format) return filePath;

  try {
    let embedBytes: Buffer;
    let isPng: boolean;
    if (format === "png") {
      embedBytes = await fs.readFile(filePath);
      isPng = true;
    } else if (format === "jpeg") {
      embedBytes = await fs.readFile(filePath);
      isPng = false;
    } else {
      // webp / heic / tiff / gif / avif → rasterize to JPEG first
      embedBytes = await sharp(filePath).jpeg({ quality: 90 }).toBuffer();
      isPng = false;
    }

    const pdf = await PDFDocument.create();
    const img = isPng
      ? await pdf.embedPng(embedBytes)
      : await pdf.embedJpg(embedBytes);
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });

    const pdfPath = filePath.replace(/\.[^.]+$/, "") + ".pdf";
    await fs.writeFile(pdfPath, await pdf.save());
    console.log(`[portal-profile] ${logLabel} converted ${docKey} ${format}→pdf`);
    return pdfPath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[portal-profile] ${logLabel} pdf conversion failed — slot=${docKey} format=${format}: ${msg}`,
    );
    return filePath;
  }
}

/**
 * Upper size bound for an uploaded image. The Topkapı portal rejects files over
 * its limit with a misleading "Dosya türü geçersiz" (invalid file type) error,
 * so oversized images are downscaled before upload. PDFs are handled separately
 * (always normalized through Ghostscript regardless of size — see below).
 */
const MAX_UPLOAD_BYTES = 1.8 * 1024 * 1024;

/** True when the file starts with the %PDF- magic bytes (content, not ext). */
async function isPdfFile(filePath: string): Promise<boolean> {
  try {
    const fh = await fs.open(filePath, "r");
    try {
      const head = Buffer.alloc(5);
      await fh.read(head, 0, 5, 0);
      return head.toString("latin1") === "%PDF-";
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

/**
 * Normalizes a document for upload to the portal.
 *
 * The Topkapı portal rejects raw CRM PDFs with a misleading "Dosya türü
 * geçersiz" (invalid file type) error, but accepts the same content once it has
 * been rewritten by Ghostscript. So EVERY PDF is normalized through Ghostscript
 * regardless of size (no size threshold, no size comparison — the goal is a
 * portal-compatible rewrite, not compression). If `gs` errors or produces an
 * empty file, the original is used so the upload still proceeds.
 *
 * Images (the photo slot stays a JPEG) are instead downscaled to ≤1600px wide
 * JPEG q72 only when they exceed MAX_UPLOAD_BYTES, returning the original unless
 * the result is strictly smaller.
 *
 * Detection is CONTENT-based (magic bytes) — a real PDF saved with a `.bin`
 * extension (base64 path) is still routed to Ghostscript, not sharp. Never
 * throws: on any failure the original path is returned.
 */
async function normalizeForUpload(
  filePath: string,
  docKey: string,
  logLabel: string,
): Promise<string> {
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return filePath;
  }

  const kb = (n: number) => Math.round(n / 1024);

  // --- PDF → Ghostscript (ALWAYS normalize, any size) ----------------------
  if (await isPdfFile(filePath)) {
    const out = filePath.replace(/\.[^.]+$/, "") + ".min.pdf";
    try {
      await execFileP("gs", [
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        "-dPDFSETTINGS=/ebook",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        `-sOutputFile=${out}`,
        filePath,
      ]);
      const outSize = (await fs.stat(out)).size;
      if (outSize > 0) {
        console.log(`[portal-profile] ${logLabel} normalized pdf ${docKey} ${kb(size)}→${kb(outSize)} KB`);
        return out;
      }
    } catch (err) {
      console.warn(`[portal-profile] ${logLabel} gs normalize failed — slot=${docKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return filePath;
  }

  // --- Image → sharp (only when oversized) ---------------------------------
  if (size <= MAX_UPLOAD_BYTES) return filePath;
  const out = filePath.replace(/\.[^.]+$/, "") + ".min.jpg";
  try {
    await sharp(filePath)
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 72 })
      .toFile(out);
    const outSize = (await fs.stat(out)).size;
    if (outSize > 0 && outSize < size) {
      console.log(`[portal-profile] ${logLabel} compressed image ${docKey} ${kb(size)}→${kb(outSize)} KB`);
      return out;
    }
  } catch (err) {
    console.warn(`[portal-profile] ${logLabel} image compress failed — slot=${docKey}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return filePath;
}

/**
 * Per-slot upload-format normalization. photo → JPEG; passport / transcript /
 * diploma → PDF (image→pdf via pdf-lib). Both helpers are content-based and
 * never throw. After conversion, every PDF (native or image→pdf output) is
 * rewritten through Ghostscript; oversized photos are downscaled.
 */
async function ensureUploadFormat(
  filePath: string,
  docKey: string,
  logLabel: string,
): Promise<string> {
  const converted = PDF_DOC_SLOTS.has(docKey)
    ? await ensurePdfDocument(filePath, docKey, logLabel)
    : await ensureJpegImage(filePath, docKey, logLabel);
  return normalizeForUpload(converted, docKey, logLabel);
}

/**
 * Downloads a student's documents into a fresh temp directory.
 *
 * Document resolution order per slot:
 *   1. Non-deleted records with content (fileUrl / fileKey / fileData), sorted
 *      so content-bearing rows win over empty stubs when multiple non-deleted
 *      records exist for the same slot (first-wins after sort).
 *   2. Empty stub records (fileUrl = fileKey = fileData = NULL) are skipped.
 *   3. For each candidate: try URL download (fileUrl then fileKey), then fall
 *      back to base64 fileData written to a temp file.
 *
 * Download failures are non-fatal: they are recorded in `downloadErrors` and
 * the slot is listed in `missingSlots`.
 *
 * @param tempPrefix  mkdtemp prefix (e.g. "portal-sub-12" / "portal-app-2054").
 * @param logLabel    label used in log lines (e.g. "#12" / "app#2054").
 */
async function downloadStudentDocuments(
  studentId: number,
  tempPrefix: string,
  logLabel: string,
  options: { deduplicateMappedSlots?: boolean } = {},
): Promise<DownloadedDocs> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `${tempPrefix}-`));

  const docs = await db
    .select({
      id:        documentsTable.id,
      type:      documentsTable.type,
      fileUrl:   documentsTable.fileUrl,
      fileKey:   documentsTable.fileKey,
      fileData:  documentsTable.fileData,
      name:      documentsTable.name,
      sizeBytes: documentsTable.sizeBytes,
      mimeType:  documentsTable.mimeType,
      extractedData: documentsTable.extractedData,
      confidenceScore: documentsTable.confidenceScore,
    })
    .from(documentsTable)
    .where(
      and(
        eq(documentsTable.studentId, studentId),
        isNull(documentsTable.deletedAt),
      ),
    )
    .orderBy(desc(documentsTable.createdAt));

  // Sort: content-bearing records first so they win the first-wins slot race
  // when an empty stub also exists for the same type.
  const hasContent = (d: typeof docs[0]) =>
    !!(d.fileUrl || d.fileKey || d.fileData);
  const sortedDocs = [...docs].sort((a, b) => {
    const ac = hasContent(a) ? 0 : 1;
    const bc = hasContent(b) ? 0 : 1;
    return ac - bc;
  });
  const passportDocument = sortedDocs.find((doc) =>
    hasContent(doc) &&
    mapDocType(`${doc.type ?? ""} ${doc.name ?? ""}`) === "passport"
  );
  const passportIdentityProof = passportDocument
    ? sitPassportIdentityProofFromDocument({
        extractedData: passportDocument.extractedData,
        confidenceScore: passportDocument.confidenceScore,
        documentId: passportDocument.id,
      }) ?? undefined
    : undefined;

  const files: SubmitFiles = {};
  const downloadErrors: Record<string, string> = {};
  const docKeyStatus: Record<string, "ok" | "no-content" | "docKey-null" | "err"> = {};
  const hasContentBearingDocs = docs.some(hasContent);
  const docsToProcess = options.deduplicateMappedSlots
    ? selectFirstDocumentPerMappedSlot(
        sortedDocs,
        (doc) => doc.type ? mapDocType(doc.type) : null,
      )
    : sortedDocs;

  // Run native photo/PDF normalization sequentially. Concurrent sharp plus
  // multiple Ghostscript children can terminate the worker with SIGBUS on the
  // production host, leaving the submission lease stuck without a JS error.
  // Sequential processing also makes the first-wins slot rule deterministic.
  docsLoop: for (const doc of docsToProcess) {
      if (!doc.type) continue;

      const docKey = mapDocType(doc.type);
      if (!docKey) continue;

      if (files[docKey]) continue; // first-wins — already resolved by a content-bearing record

      // Skip empty stubs entirely (no content in any storage field) —
      // genuinely no document was ever attached to this row.
      if (!doc.fileUrl && !doc.fileKey && !doc.fileData) {
        docKeyStatus[docKey] = docKeyStatus[docKey] ?? "no-content";
        continue;
      }

      try {
        // --- path A: URL download (same resolution SIT already uses) ---------
        // Never trust a raw fileUrl/fileKey path directly — unknown
        // /objects/... paths are served the SPA shell (200 text/html), not the
        // file. docFetchUrl() resolves either the doc's own public URL or the
        // signed /api/documents/:id/file path.
        //
        // KÖK NEDEN düzeltmesi: eskiden path A'daki İLK indirme hatası doğrudan
        // catch'e düşüyor ve base64 fileData yedeği HİÇ denenmiyordu — süresi
        // geçmiş/kırık bir public fileUrl (403/404/HTML) tek başına slotu
        // kaybettiriyor, SIT de "sıfır belgeli create engellendi" ile submit'i
        // blokluyordu. Artık: public URL başarısız olursa imzalı
        // /api/documents/:id/file yolu, o da olmazsa base64 denenir; her deneme
        // hangi doc/URL/HTTP status ile düştüğünü ayrı ayrı loglar.
        const primaryUrl = docFetchUrl(doc);
        const candidates: string[] = [];
        if (primaryUrl) candidates.push(primaryUrl);
        // Public fileUrl seçildiyse imzalı yolu da yedek aday olarak ekle.
        if (primaryUrl && /^https?:\/\//i.test(primaryUrl) && doc.id != null) {
          const signed = buildSignedDocumentPath(doc.id);
          if (signed && signed !== primaryUrl) candidates.push(signed);
        }
        if (!primaryUrl) {
          docKeyStatus[docKey] = docKeyStatus[docKey] ?? "docKey-null";
          console.warn(
            `[portal-profile] ${logLabel} doc #${doc.id} slot=${docKey} type=${doc.type}: ` +
            `indirilebilir URL üretilemedi (public fileUrl yok ve imzalı URL üretilemedi — ` +
            `ASSET_URL_SIGNING_SECRET/SESSION_SECRET yapılandırmasını kontrol edin); base64 yedeğe geçiliyor`,
          );
        }

        const attemptErrors: string[] = [];
        for (const url of candidates) {
          try {
            const ext = safeDocExt(doc.mimeType, doc.name);
            const dest = path.join(tempDir, `${docKey}.${ext}`);
            await downloadFile(url, dest);
            files[docKey] = await ensureUploadFormat(dest, docKey, logLabel);
            docKeyStatus[docKey] = "ok";
            continue docsLoop;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            attemptErrors.push(msg);
            console.warn(
              `[portal-profile] ${logLabel} doc #${doc.id} slot=${docKey} type=${doc.type} ` +
              `URL indirme başarısız — ${msg}` +
              (doc.fileData || candidates.indexOf(url) < candidates.length - 1
                ? " (sonraki yedek denenecek)"
                : ""),
            );
          }
        }

        // --- path B: base64 fileData fallback --------------------------------
        if (doc.fileData) {
          const buf = Buffer.from(doc.fileData, "base64");
          const dest = path.join(tempDir, `${docKey}.bin`);
          await fs.writeFile(dest, buf);
          files[docKey] = await ensureUploadFormat(dest, docKey, logLabel);
          docKeyStatus[docKey] = "ok";
          continue;
        }

        // Tüm adaylar tükendi ve base64 yok → hatayı slot bazında kaydet.
        if (attemptErrors.length > 0) {
          downloadErrors[docKey] = `doc #${doc.id} type=${doc.type} fileKey=${doc.fileKey ?? "-"}: ${attemptErrors.join(" | ")}`;
          docKeyStatus[docKey] = "err";
          console.warn(
            `[portal-profile] ${logLabel} doc download failed (tüm yollar tükendi)` +
            ` — slot=${docKey} doc #${doc.id} type=${doc.type} fileKey=${doc.fileKey ?? "-"}: ${attemptErrors.join(" | ")}`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        downloadErrors[docKey] = `doc #${doc.id} type=${doc.type} fileKey=${doc.fileKey ?? "-"}: ${msg}`;
        docKeyStatus[docKey] = "err";
        console.warn(
          `[portal-profile] ${logLabel} doc download failed` +
          ` — slot=${docKey} doc #${doc.id} type=${doc.type} fileKey=${doc.fileKey ?? "-"}: ${msg}`,
        );
      }
  }

  const filledSlots  = REQUIRED_DOCS.filter((slot) => !!files[slot]);
  const missingSlots = REQUIRED_DOCS.filter((slot) => !files[slot]);

  const missingDetail =
    missingSlots.length > 0
      ? missingSlots.map((s) => {
          if (downloadErrors[s]) return `${s}(err: ${downloadErrors[s]})`;
          const status = docKeyStatus[s];
          if (status === "no-content") return `${s}(no-content)`;
          if (status === "docKey-null") return `${s}(docKey-null)`;
          return `${s}(no-record)`;
        }).join(", ")
      : "";

  console.log(
    `[portal-profile] ${logLabel} doc slots — filled: [${filledSlots.join(", ")}]` +
    (missingSlots.length > 0 ? ` | missing: [${missingDetail}]` : " | all 4 filled"),
  );

  // URL refs for URL-fetching create webhooks (e.g. SIT). Independent of the
  // local-file download above — derived directly from the CRM document rows.
  const { photoUrl: docPhotoUrl, hasPhotoDoc, documents: documentRefs } = extractStudentDocumentRefs(docs);
  let photoUrl = docPhotoUrl;
  if (!photoUrl && hasPhotoDoc) {
    // Photo exists but only as base64/DB content (no public object URL). Fall
    // back to a signed, auth-free photo-endpoint URL the webhook can fetch.
    const signed = buildSignedStudentPhotoPath(studentId);
    if (signed) photoUrl = signed;
  }
  console.log(
    `[portal-profile] ${logLabel} doc urls — photo: ${photoUrl ? "yes" : "no"}` +
    ` | documents: ${documentRefs.length}` +
    (documentRefs.length ? ` [${documentRefs.map((d) => d.type).join(", ")}]` : ""),
  );

  return { files, tempDir, filledSlots, missingSlots, downloadErrors, photoUrl, documentRefs, hasContentBearingDocs, passportIdentityProof };
}

// ---------------------------------------------------------------------------
// buildStudentProfile — submission-keyed (production worker)
// ---------------------------------------------------------------------------

/**
 * Fetches the application + student data for a given portal_submission row,
 * downloads the student's documents to a temporary directory, and returns
 * a SubmitProfile + SubmitFiles ready for the adapter.
 *
 * Throws when the submission, application, or student cannot be found.
 */
export async function buildStudentProfile(
  submissionId: number,
): Promise<StudentProfileResult> {
  // ----- 1. Load submission ------------------------------------------------
  const [sub] = await db
    .select()
    .from(portalSubmissionsTable)
    .where(eq(portalSubmissionsTable.id, submissionId));

  if (!sub) throw new Error(`Submission ${submissionId} not found`);

  // ----- 2. Load application -----------------------------------------------
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.id, sub.applicationId),
        isNull(applicationsTable.deletedAt),
      ),
    );

  if (!app) throw new Error(`Application ${sub.applicationId} not found`);

  // ----- 3. Load student ---------------------------------------------------
  if (!sub.studentId) throw new Error(`Submission ${submissionId} has no studentId`);

  const [student] = await db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.id, sub.studentId));

  if (!student) throw new Error(`Student ${sub.studentId} not found`);

  // ----- 3b. Load education records ----------------------------------------
  const educationRecords = await db
    .select()
    .from(educationRecordsTable)
    .where(eq(educationRecordsTable.studentId, sub.studentId));
  const currentEducationRecords = await db
    .select()
    .from(studentEducationRecordsTable)
    .where(and(
      eq(studentEducationRecordsTable.studentId, sub.studentId),
      isNull(studentEducationRecordsTable.deletedAt),
    ));
  const mergedEducationRecords = mergePortalEducationRecords(
    educationRecords,
    currentEducationRecords,
  );

  // ----- 4. Build profile + download documents -----------------------------
  const profile = buildSubmitProfileFromRecords(student, app, {
    // Every portal adapter matches the live programme by labels. A CRM
    // catalogue id is a useful override key when present, but yearly catalogue
    // replacement must not make an otherwise valid historical application
    // impossible to run.
    allowMissingProgramId: true,
    // Only adapters covered by the common manifest receive an incomplete
    // shape. The runner evaluates that manifest before credentials/login.
    allowIncompleteProfile:
      portalPreflightManifest(sub.adapterKey ?? "") !== null,
  });
  applyEducationFallbacks(profile, mergedEducationRecords);
  const residence = resolvePortalResidenceDefaults({
    universityKey: sub.universityKey,
    addressCity: student.addressCity,
    postalCode: student.postalCode,
    address: student.address,
    nationality: student.nationality,
  });
  if (!profile.addressCity) {
    profile.addressCity = residence.addressCity;
    console.warn(
      `[portal-profile] #${submissionId} residence fallback` +
      ` (field=addressCity, value=${residence.addressCity === "city" ? "default" : "derived"})`,
    );
  }
  profile.addressZip ||= residence.postalCode;
  const isAltinbas = /altinbas/i.test(sub.universityKey);
  const deduplicateDocumentSlots =
    shouldDeduplicateDocumentSlots(sub.universityKey);
  if (isAltinbas) {
    const passportDates = resolveAltinbasPassportDates({
      dateOfBirth: student.dateOfBirth,
      passportIssueDate: student.passportIssueDate,
      passportExpiryDate: student.passportExpiry,
    });
    profile.passportIssueDate = passportDates.issueDate;
    profile.passportExpiryDate = passportDates.expiryDate;
    if (passportDates.fallbackFields.length > 0) {
      console.warn(
        `[portal-profile] #${submissionId} Altınbaş legacy passport-date fallback` +
        ` (fields=${passportDates.fallbackFields.join(",")})`,
      );
    }
  }

  // ----- 4a. SON SAVUNMA HATTI: kimlik alanı doğrulaması (real mode) --------
  // Pasaport numarası, ad/soyad ve tarihler portal formuna yazılmadan HEMEN
  // önce doğrulanır. Geçersiz veri buraya kadar sızdıysa (Gate 5 / worker
  // guard atlanmış olsa bile) tarayıcı hiç açılmadan başvuru durdurulur —
  // gerçek bir üniversite portalına asla hatalı kimlik verisi gönderilmez.
  // Dry-run'lar (mode !== "real") ve buildProfileFromApplication (dry CLI)
  // kasıtlı olarak engellenmez.
  if (sub.mode === "real") {
    const identityErrors = validateIdentityFields({
      passportNumber:     student.passportNumber,
      firstName:          student.firstName,
      lastName:           student.lastName,
      dateOfBirth:        student.dateOfBirth,
      passportIssueDate:  profile.passportIssueDate,
      passportExpiryDate: profile.passportExpiryDate,
    });
    if (identityErrors.length > 0) {
      throw new Error(
        `[VERİ DOĞRULAMA] Kimlik alanları geçersiz — gerçek portal başvurusu durduruldu: ` +
        formatIdentityErrors(identityErrors),
      );
    }
  }

  // Attach education records so adapters (Altınbaş, Topkapı, etc.) can read
  // per-level city and languageScore without falling back to legacy top-level
  // student fields. Typed as any[] to avoid a circular type dependency — the
  // shape mirrors EducationRecord from @workspace/db.
  if (mergedEducationRecords.length > 0) {
    profile.educationRecords = mergedEducationRecords as any;
  }

  // Expose E164 phone on the profile as untyped extra fields so adapters that
  // cast to `any` (e.g. SIT CONTACTFIX2) can read it without relying on the
  // `profile.phone` fallback alone. `phone_e164` mirrors the DB column name.
  (profile as any).phoneE164   = student.phoneE164 ?? null;
  (profile as any).phone_e164  = student.phoneE164 ?? null;

  // Aggregator (SIT/United) routing: the submission carries the member
  // (catalog) university it must select inside the aggregator portal. Override
  // the profile so the adapter's school-selection (matchAllowedUniversity /
  // selById("selectuniversity", profile.universityName)) targets the member,
  // not the aggregator or a drifted free-text name.
  const meta = sub.meta as { targetUniversityName?: string } | null;
  if (meta?.targetUniversityName) {
    profile.universityName = meta.targetUniversityName;
  }

  const dl = await downloadStudentDocuments(
    sub.studentId,
    `portal-sub-${submissionId}`,
    `#${submissionId}`,
    { deduplicateMappedSlots: deduplicateDocumentSlots },
  );

  // Carry document/photo URLs on the profile for URL-fetching create webhooks.
  if (dl.photoUrl) profile.photoUrl = dl.photoUrl;
  if (dl.documentRefs.length) profile.studentDocuments = dl.documentRefs;
  profile.passportIdentityProof = dl.passportIdentityProof;

  // Expose the CRM application id so adapters can query prior portal_submissions
  // (e.g. Altınbaş pre-flight dangling-record check). Optional — not set in the
  // dry-test CLI path (buildProfileFromApplication).
  profile.applicationDbId = sub.applicationId;
  profile.portalSubmissionExternalRef =
    sub.externalRef?.trim() || undefined;

  return { profile, ...dl };
}

// ---------------------------------------------------------------------------
// buildProfileFromApplication — application-keyed (local dry-test CLI)
// ---------------------------------------------------------------------------

/**
 * Builds a SubmitProfile + SubmitFiles directly from an application id, with
 * no portal_submissions row required. Resolves the student via the
 * application's studentId. Reuses the exact same profile-mapping and
 * document-download logic as buildStudentProfile (single source of truth) so
 * the local dry-test CLI exercises the identical profile the worker would.
 *
 * Throws when the application or student cannot be found.
 */
export async function buildProfileFromApplication(
  applicationId: number,
): Promise<StudentProfileResult> {
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.id, applicationId),
        isNull(applicationsTable.deletedAt),
      ),
    );

  if (!app) throw new Error(`Application ${applicationId} not found`);

  const [student] = await db
    .select()
    .from(studentsTable)
    .where(eq(studentsTable.id, app.studentId));

  if (!student) throw new Error(`Student ${app.studentId} not found`);

  const educationRecords = await db
    .select()
    .from(educationRecordsTable)
    .where(eq(educationRecordsTable.studentId, app.studentId));
  const currentEducationRecords = await db
    .select()
    .from(studentEducationRecordsTable)
    .where(and(
      eq(studentEducationRecordsTable.studentId, app.studentId),
      isNull(studentEducationRecordsTable.deletedAt),
    ));
  const mergedEducationRecords = mergePortalEducationRecords(
    educationRecords,
    currentEducationRecords,
  );

  const profile = buildSubmitProfileFromRecords(student, app);
  applyEducationFallbacks(profile, mergedEducationRecords);
  if (mergedEducationRecords.length > 0) {
    profile.educationRecords = mergedEducationRecords as any;
  }
  (profile as any).phoneE164  = student.phoneE164 ?? null;
  (profile as any).phone_e164 = student.phoneE164 ?? null;
  const dl = await downloadStudentDocuments(
    app.studentId,
    `portal-app-${applicationId}`,
    `app#${applicationId}`,
  );

  // Carry document/photo URLs on the profile for URL-fetching create webhooks.
  if (dl.photoUrl) profile.photoUrl = dl.photoUrl;
  if (dl.documentRefs.length) profile.studentDocuments = dl.documentRefs;
  profile.passportIdentityProof = dl.passportIdentityProof;

  return { profile, ...dl };
}

// ---------------------------------------------------------------------------
// Internal: destination filename extension resolution
// ---------------------------------------------------------------------------

// Never derive the destination extension from the download URL — the fetch
// URL may be the signed `/api/documents/:id/file` endpoint (no dot, has
// slashes), which would produce a malformed dest path like
// `photo./api/documents/6358/file` and fail the write with ENOENT even
// though the download itself succeeded. Always resolve from the document's
// own declared mimeType/name instead.
const MIME_EXT_MAP: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heic",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
};

function safeDocExt(mimeType?: string | null, name?: string | null): string {
  const fromMime = mimeType ? MIME_EXT_MAP[mimeType.toLowerCase().trim()] : undefined;
  if (fromMime) return fromMime;

  if (name) {
    const raw = path.extname(name).replace(/^\./, "").toLowerCase();
    if (/^[a-z0-9]{1,5}$/.test(raw)) return raw;
  }

  return "bin";
}

// ---------------------------------------------------------------------------
// Internal: download helper
// ---------------------------------------------------------------------------

// Strip the query string before embedding a URL in any error/log message —
// document fetch URLs may carry a signed ?exp=&sig= pair that must NEVER be
// logged or persisted (downloadErrors end up in result_json).
function redactedUrl(u: string): string {
  const q = u.indexOf("?");
  return q === -1 ? u : u.slice(0, q) + "?<redacted>";
}

async function downloadFile(url: string, dest: string): Promise<void> {
  // Relative /api/documents/... or /objects/... URLs must be absolutized —
  // fetch() cannot parse relative URLs. The api-server serves both on its own
  // origin.
  const base = (process.env.OBJECT_BASE_URL || `http://127.0.0.1:${process.env.PORT || "5057"}`).replace(/\/$/, "");
  const absUrl = /^https?:\/\//i.test(url) ? url : base + (url.startsWith("/") ? url : "/" + url);
  // Retry transient failures (network errors, 5xx, 404 races) with a short
  // backoff before giving up — a single hiccup must not cost the upload slot.
  const MAX_ATTEMPTS = 3;
  // Node fetch has no default timeout. A stale public object URL must not hold
  // a portal lane lease forever; bound each attempt so the signed endpoint or
  // base64 fallback can be reached and the queue can write back a real result.
  const FETCH_TIMEOUT_MS = 15_000;
  let res: Awaited<ReturnType<typeof fetch>> | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(absUrl, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.ok) break;
      lastErr = new Error(`HTTP ${res.status} downloading ${redactedUrl(absUrl)}`);
    } catch (err) {
      res = null;
      lastErr = err;
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * 700));
    }
  }
  if (!res || !res.ok) {
    throw lastErr instanceof Error
      ? new Error(`${lastErr.message} (after ${MAX_ATTEMPTS} attempts)`)
      : new Error(`download failed after ${MAX_ATTEMPTS} attempts: ${String(lastErr)} — ${redactedUrl(absUrl)}`);
  }

  // A 200 alone is not proof of success: unknown /objects/... paths (and any
  // other unmatched route) fall through to the SPA's index.html, which is
  // also served as 200. Reject anything that looks like the app shell rather
  // than real file content — by content-type first, then by body-sniffing a
  // few tell-tale HTML/SPA markers as a fallback for mislabeled responses.
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    throw new Error(`refusing HTML response (content-type: ${contentType || "unknown"}) from ${redactedUrl(absUrl)} — likely SPA fallback, not the file`);
  }

  const buf = Buffer.from(await res.arrayBuffer());

  if (looksLikeHtmlShell(buf)) {
    throw new Error(`refusing HTML/SPA-shell body from ${redactedUrl(absUrl)} — not real file content`);
  }

  await fs.writeFile(dest, buf);
}

/**
 * Body-sniff fallback for when a misconfigured route serves the SPA shell
 * with a non-HTML content-type. Only inspects a small leading slice — real
 * binary/document files (PDF, JPEG, PNG, DOCX/zip, etc.) never start with
 * these markers.
 */
function looksLikeHtmlShell(buf: Buffer): boolean {
  const head = buf.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return (
    head.startsWith("<!doctype html") ||
    head.startsWith("<html") ||
    (head.includes("<head") && head.includes("<script") && head.includes("id=\"root\""))
  );
}
