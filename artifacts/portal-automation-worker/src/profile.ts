/**
 * profile.ts — builds a SubmitProfile + SubmitFiles from the DB record
 * for a given portal submission.
 *
 * Documents are downloaded from their fileUrl / fileKey, or decoded from
 * base64 fileData, into a per-submission temp dir so the adapter can
 * reference them as local file paths.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { db, portalSubmissionsTable, applicationsTable, studentsTable, documentsTable, educationRecordsTable } from "@workspace/db";
import { eq, and, isNull, desc } from "drizzle-orm";
import { buildProfile, mapDocType, REQUIRED_DOCS, extractStudentDocumentRefs, selectPriorSchoolName, buildSignedStudentPhotoPath, buildSignedDocumentPath, docFetchUrl, sitPassportIdentityProofFromDocument } from "@workspace/portal-adapters";
import type { SubmitProfile, SubmitFiles } from "@workspace/portal-adapters";
import { resolvePortalResidenceDefaults } from "@workspace/portal-runner";

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
   * a broken download pipeline" (must block submit) from "student genuinely
   * has zero CRM documents" (existing behaviour, must NOT be blocked).
   */
  hasContentBearingDocs: boolean;
}

// ---------------------------------------------------------------------------
// buildStudentProfile
// ---------------------------------------------------------------------------

/**
 * Fetches the application + student data for a given portal_submission row,
 * downloads the student's documents to a temporary directory, and returns
 * a SubmitProfile + SubmitFiles ready for the adapter.
 *
 * Document resolution order per slot:
 *   1. Non-deleted records with content (fileUrl / fileKey / fileData), sorted
 *      so content-bearing rows win over empty stubs when multiple non-deleted
 *      records exist for the same slot (first-wins after sort).
 *   2. Empty stub records (fileUrl = fileKey = fileData = NULL) are skipped.
 *   3. For each candidate: try URL download (fileUrl then fileKey), then fall
 *      back to base64 fileData written to a temp file.
 *
 * Throws when the submission, application, or student cannot be found.
 * Download failures are non-fatal: they are recorded in `downloadErrors` and
 * the slot is listed in `missingSlots`.
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

  // ----- 3b. Load education_records (FIX-15D) --------------------------------
  const eduRows = await db
    .select()
    .from(educationRecordsTable)
    .where(eq(educationRecordsTable.studentId, sub.studentId));

  // ----- 4. Build SubmitProfile --------------------------------------------
  // Guard parent names: buildProfile requires non-empty values and throws if
  // they are blank, crashing the whole submission. Log + fall back to "-" so
  // the portal still receives a valid form (most portals accept "-" for N/A).
  const fatherNameVal = student.fatherName?.trim() || "-";
  const motherNameVal = student.motherName?.trim() || "-";
  if (!student.fatherName?.trim())
    console.warn(`[portal-profile] #${submissionId} fatherName missing or empty — using "-" fallback`);
  if (!student.motherName?.trim())
    console.warn(`[portal-profile] #${submissionId} motherName missing or empty — using "-" fallback`);

  // Guard address: buildProfile requires a non-empty value and throws if
  // blank, crashing the whole submission. Prefer the student's own address;
  // if absent, fall back to nationality (best available location proxy —
  // students table has no separate city field); as a last resort use "-" so
  // the portal still receives a valid form value.
  const addressVal =
    student.address?.trim() ||
    (student.nationality?.trim() ? student.nationality.trim() : "") ||
    "-";
  if (!student.address?.trim())
    console.warn(
      `[portal-profile] #${submissionId} address missing or empty — using ` +
      `${addressVal === "-" ? "placeholder" : "nationality"} fallback`,
    );

  const profile: SubmitProfile = buildProfile(
    {
      email:          student.email         ?? "",
      passportNumber: student.passportNumber ?? "",
      firstName:      student.firstName      ?? "",
      lastName:       student.lastName       ?? "",
      dateOfBirth:    student.dateOfBirth ?? "",
      gender:         student.gender      ?? "",
      fatherName:     fatherNameVal,
      motherName:     motherNameVal,
      nationality:    student.nationality ?? "",
      address:        addressVal,
      addressStreet:  student.address?.trim() || undefined,
      addressCity:    student.addressCity?.trim() || undefined,
      addressZip:     student.postalCode?.trim() || undefined,
      cityOfBirth:    student.cityOfBirth?.trim() || undefined,
      visaSupport:
        student.needsVisaSupport == null
          ? undefined
          : student.needsVisaSupport ? "Yes" : "No",
      phone:          student.phoneE164 ?? student.phone ?? "",
      level:          app.level              ?? "",
      programName:    app.programName        ?? "",
      programId:      app.programId          != null ? String(app.programId) : "",
      universityName: app.universityName       ?? undefined,
      schoolName:     selectPriorSchoolName(app.level, {
        highSchool:         student.highSchool,
        universityBachelor: student.universityBachelor,
        universityMaster:   student.universityMaster,
      }),
      gpa:            student.gpa             ?? undefined,
      graduationYear: student.graduationYear  != null ? Number(student.graduationYear) : undefined,
      languageScore:  student.languageScore   != null ? Number(student.languageScore)  : undefined,
      passportIssueDate:  student.passportIssueDate ?? undefined,
      passportExpiryDate: student.passportExpiry    ?? undefined,
      // Additive — Altınbaş Faz-B: pass education/address data for new derive helpers
      highSchool:         student.highSchool         ?? undefined,
      universityBachelor: student.universityBachelor ?? undefined,
      universityMaster:   student.universityMaster   ?? undefined,
      // intakeTerm: application intake period first, season as fallback open-term
      intakeTerm: app.intake ?? app.season ?? undefined,
    },
    {
      // United resolves the live programme by exact university/programme
      // labels. Catalog refreshes may legitimately retire the historical
      // mutable program id, so only United may build without it.
      allowMissingProgramId:
        sub.adapterKey === "united" ||
        sub.universityKey === "united_education",
    },
  );
  // Preserve the previously verified United application id across retries.
  // It is candidate evidence only: the adapter still requires an exact
  // university + programme readback before accepting the existing profile.
  profile.portalSubmissionExternalRef =
    sub.externalRef?.trim() || undefined;
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

  // FIX-15D: attach education_records after buildProfile (buildProfile ignores unknown fields).
  profile.educationRecords = eduRows.map((r) => ({
    level:         r.level,
    schoolName:    r.schoolName    ?? null,
    country:       r.country       ?? null,
    city:          r.city          ?? null,
    fieldOfStudy:  r.fieldOfStudy  ?? null,
    startMonth:    r.startMonth    ?? null,
    startYear:     r.startYear     ?? null,
    endMonth:      r.endMonth      ?? null,
    endYear:       r.endYear       ?? null,
    gpa:           r.gpa           ?? null,
    gpaType:       r.gpaType       ?? null,
    languageScore: r.languageScore ?? null,
  }));
  // Historical applications stored prior-education values directly on the
  // student row, before education_records existed. Keep those values in an
  // additive compatibility payload so Altınbaş can complete a partial record
  // without changing Topkapı or writing fabricated values back to the CRM.
  profile.legacyEducation = {
    highSchool:      student.highSchool?.trim()         || undefined,
    bachelorSchool: student.universityBachelor?.trim() || undefined,
    masterSchool:   student.universityMaster?.trim()   || undefined,
    rawGpa:          student.gpa?.trim()                || undefined,
  };

  // ----- 5. Download documents to temp dir ---------------------------------
  const tempDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `portal-sub-${submissionId}-`),
  );

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
        eq(documentsTable.studentId, sub.studentId!),
        isNull(documentsTable.deletedAt),
      ),
    )
    .orderBy(desc(documentsTable.createdAt));

  // Carry document/photo URLs on the profile for URL-fetching create webhooks
  // (e.g. SIT). Derived directly from the CRM document rows; independent of the
  // local-file download below.
  const { photoUrl: docPhotoUrl, hasPhotoDoc, documents: docRefs } = extractStudentDocumentRefs(docs);
  if (docPhotoUrl) {
    profile.photoUrl = docPhotoUrl;
  } else if (hasPhotoDoc) {
    // Photo exists but only as base64/DB content (no public object URL). Fall
    // back to a signed, auth-free photo-endpoint URL the webhook can fetch.
    const signed = buildSignedStudentPhotoPath(sub.studentId!);
    if (signed) profile.photoUrl = signed;
  }
  if (docRefs.length) profile.studentDocuments = docRefs;
  console.log(
    `[portal-profile] #${submissionId} doc urls — photo: ${profile.photoUrl ? "yes" : "no"}` +
    ` | documents: ${docRefs.length}` +
    (docRefs.length ? ` [${docRefs.map((d) => d.type).join(", ")}]` : ""),
  );

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
  if (passportDocument) {
    profile.passportIdentityProof =
      sitPassportIdentityProofFromDocument({
        extractedData: passportDocument.extractedData,
        confidenceScore: passportDocument.confidenceScore,
        documentId: passportDocument.id,
      }) ?? undefined;
  }

  const hasContentBearingDocs = docs.some(hasContent);

  const files: SubmitFiles = {};
  const downloadErrors: Record<string, string> = {};
  const docKeyStatus: Record<string, "ok" | "no-content" | "docKey-null" | "err"> = {};

  await Promise.all(
    sortedDocs.map(async (doc) => {
      if (!doc.type) return;

      const docKey = mapDocType(doc.type);
      if (!docKey) return;

      if (files[docKey]) return; // first-wins — already resolved by a content-bearing record

      // Skip empty stubs entirely (no content in any storage field) — genuinely
      // no document was ever attached to this row.
      if (!doc.fileUrl && !doc.fileKey && !doc.fileData) {
        docKeyStatus[docKey] = docKeyStatus[docKey] ?? "no-content";
        return;
      }

      try {
        // --- path A: signed URL download (same resolution SIT uses) ----------
        // Never trust a raw fileUrl/fileKey path directly — the api-server
        // serves the SPA shell for unknown /objects/... paths (200 text/html),
        // so all local-file resolution must go through docFetchUrl(), which
        // produces either the doc's own public URL or the signed
        // /api/documents/:id/file path — same primitive SIT's proven working
        // photo/document webhooks already use.
        // KÖK NEDEN düzeltmesi: public fileUrl (403/404/HTML) tek denemede
        // düşünce imzalı /api/documents/:id/file yolu hiç denenmiyordu. Artık
        // public URL sonrası imzalı yol da denenir; her başarısız deneme
        // hangi doc/URL/HTTP status ile düştüğünü ayrı loglar.
        const primaryUrl = docFetchUrl(doc);
        const candidates: string[] = [];
        if (primaryUrl) candidates.push(primaryUrl);
        if (primaryUrl && /^https?:\/\//i.test(primaryUrl) && doc.id != null) {
          const signed = buildSignedDocumentPath(doc.id);
          if (signed && signed !== primaryUrl) candidates.push(signed);
        }
        if (!primaryUrl) {
          docKeyStatus[docKey] = docKeyStatus[docKey] ?? "docKey-null";
          console.warn(
            `[portal-profile] #${submissionId} doc #${doc.id} slot=${docKey} type=${doc.type}: ` +
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
            files[docKey] = dest;
            docKeyStatus[docKey] = "ok";
            return;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            attemptErrors.push(msg);
            console.warn(
              `[portal-profile] #${submissionId} doc #${doc.id} slot=${docKey} type=${doc.type} ` +
              `URL indirme başarısız — ${msg}` +
              (doc.fileData || candidates.indexOf(url) < candidates.length - 1
                ? " (sonraki yedek denenecek)"
                : ""),
            );
          }
        }
        if (attemptErrors.length > 0) {
          downloadErrors[docKey] = `doc #${doc.id} type=${doc.type} fileKey=${doc.fileKey ?? "-"}: ${attemptErrors.join(" | ")}`;
          // Fall through to base64 fallback
        }

        // --- path B: base64 fileData fallback --------------------------------
        if (doc.fileData) {
          const ext = safeDocExt(doc.mimeType, doc.name);
          const dest = path.join(tempDir, `${docKey}.${ext}`);
          const buf = Buffer.from(doc.fileData, "base64");
          await fs.writeFile(dest, buf);
          files[docKey] = dest;
          docKeyStatus[docKey] = "ok";
          return;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        downloadErrors[docKey] = `doc #${doc.id} type=${doc.type} fileKey=${doc.fileKey ?? "-"}: ${msg}`;
        docKeyStatus[docKey] = "err";
        console.warn(
          `[portal-profile] #${submissionId} doc download failed` +
          ` — slot=${docKey} doc #${doc.id} type=${doc.type} fileKey=${doc.fileKey ?? "-"}: ${msg}`,
        );
      }
    }),
  );

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
    `[portal-profile] #${submissionId} doc slots — filled: [${filledSlots.join(", ")}]` +
    (missingSlots.length > 0 ? ` | missing: [${missingDetail}]` : " | all 4 filled"),
  );

  return { profile, files, tempDir, filledSlots, missingSlots, downloadErrors, hasContentBearingDocs };
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
  // Relative /objects/... URLs must be absolutized — Node fetch() cannot parse relative URLs.
  // The api-server serves /objects/ on its own origin (proven: curl 127.0.0.1:PORT/objects/... = 200).
  const base = (process.env.OBJECT_BASE_URL || `http://127.0.0.1:${process.env.PORT || "5057"}`).replace(/\/$/, "");
  const absUrl = /^https?:\/\//i.test(url) ? url : base + (url.startsWith("/") ? url : "/" + url);
  // Retry transient failures (network errors, 5xx, 404 races) with a short
  // backoff before giving up — a single hiccup must not cost the upload slot.
  const MAX_ATTEMPTS = 3;
  // A broken/public object URL used to leave a worker lease in `running`
  // forever because Node fetch has no default timeout. Keep each candidate
  // bounded so the signed endpoint or base64 fallback can still be tried and
  // the queue can write back a useful failure instead of requiring a manual
  // cancel/reset.
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
