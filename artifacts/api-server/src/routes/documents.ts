import { Router, type IRouter } from "express";
import { db, documentsTable, studentsTable, applicationsTable } from "@workspace/db";
import { eq, and, inArray, desc, isNull, isNotNull, or } from "drizzle-orm";
import { requireAuth, requireRole, requireAgentStaffPermission, logAudit } from "../lib/auth";
import { STAFF_ROLES, AGENT_ROLES, ADMIN_ROLES, isAgentRole } from "../lib/roles";
import { assertCanAccessStudent } from "../lib/studentAccess";
import { getAgentVisibleIds } from "../lib/agentVisibility";
import { dispatchNotification } from "../lib/notificationDispatcher";
import { validateStudentDocumentFile, validateStudentDocumentBuffer, sanitizeFileName, isPdf } from "../lib/fileUploadValidation";
import { buildDocNameFromParts, normalizeDocumentTypeKey } from "../lib/docNaming";
import { loadDocumentBytes, streamDocumentToResponse, recompressStoredObjectIfNeeded } from "../lib/documentBytes";
import { UploadTooLargeError } from "../lib/uploads/processUpload";
import { verifyDocumentSignature } from "@workspace/portal-adapters";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { handleMissingDocFulfillment } from "../lib/missingDocsFulfillment";
import { reEvaluateMandatoryDocs, reEvaluateMandatoryDocsForStudent } from "../lib/mandatoryDocs";
import { recomputeStudentPhoto } from "../lib/studentPhoto";
import { maybeTriggerAutoEducationExtract } from "../lib/educationAutoExtract";
import { callerOwnsObject } from "../lib/objectAuthz";
import archiver from "archiver";
import { PDFDocument } from "pdf-lib";

const documentsObjectStorage = new ObjectStorageService();

async function fetchFileKeyBytes(fileKey: string): Promise<Buffer> {
  const file = await documentsObjectStorage.getObjectEntityFile(fileKey);
  const [buf] = await file.download();
  return buf;
}

const router: IRouter = Router();

const DOC_PATCH_FIELDS = ["name", "type", "status", "studentId", "applicationId", "notes"];

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    // Strip IPv6 brackets: new URL('http://[::1]/').hostname === '[::1]'
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    // Block SSRF targets: loopback, link-local, private ranges
    if (
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "0.0.0.0" ||
      host === "::1" ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^fc[0-9a-f]{2}:/i.test(host) ||
      /^fd[0-9a-f]{2}:/i.test(host)
    ) return false;
    return true;
  } catch {
    return false;
  }
}

router.get("/documents", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const { studentId, applicationId, type, status } = req.query as Record<string, string>;

  const conditions = [isNull(documentsTable.deletedAt)];
  if (studentId) conditions.push(eq(documentsTable.studentId, parseInt(studentId, 10)));
  if (applicationId) conditions.push(eq(documentsTable.applicationId, parseInt(applicationId, 10)));
  if (type) conditions.push(eq(documentsTable.type, type));
  if (status) conditions.push(eq(documentsTable.status, status));

  const user = req.user!;
  const isStaff = STAFF_ROLES.includes(user.role as any);

  if (!isStaff) {
    if (user.role === "student") {
      const [studentRec] = await db.select().from(studentsTable).where(eq(studentsTable.userId, user.id));
      if (!studentRec) { res.json([]); return; }
      conditions.push(eq(documentsTable.studentId, studentRec.id));
    } else if (isAgentRole(user.role)) {
      if (studentId) {
        const visibleIds = await getAgentVisibleIds(user.id, user.role);
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, parseInt(studentId, 10)));
        if (!student || !student.agentId || !visibleIds.includes(student.agentId)) {
          res.json([]);
          return;
        }
      } else {
        const visibleIds = await getAgentVisibleIds(user.id, user.role);
        const agentStudents = await db.select({ id: studentsTable.id }).from(studentsTable).where(
          inArray(studentsTable.agentId, visibleIds.length > 0 ? visibleIds : [0])
        );
        const studentIds = agentStudents.map(s => s.id);
        if (studentIds.length === 0) { res.json([]); return; }
        conditions.push(inArray(documentsTable.studentId, studentIds));
      }
    } else {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } else {
    // Admin-level staff see all documents unconditionally.
    // Non-admin staff are scoped to students they can access (same rules as
    // GET /students/:id via assertCanAccessStudent).
    const isAdmin = ADMIN_ROLES.includes(user.role as any);
    if (!isAdmin) {
      if (studentId) {
        // Per-student access gate — closes the IDOR for ?studentId=<victim>.
        const access = await assertCanAccessStudent(req, parseInt(studentId, 10));
        if (!access.ok) { res.json([]); return; }
      } else {
        // No student filter: scope to directly-assigned students so the caller
        // cannot browse the entire document corpus.
        const myStudents = await db.select({ id: studentsTable.id }).from(studentsTable)
          .where(and(eq(studentsTable.assignedToId, user.id), isNull(studentsTable.deletedAt)));
        const myStudentIds = myStudents.map(s => s.id);
        if (myStudentIds.length === 0) { res.json([]); return; }
        conditions.push(inArray(documentsTable.studentId, myStudentIds));
      }
    }
  }

  // Cap result size so unfiltered calls can't drag the whole documents table
  // through the shared pool. ?limit= is honored up to MAX; the default (500)
  // is far above any single student's realistic document count.
  const DEFAULT_DOC_LIMIT = 500;
  const MAX_DOC_LIMIT = 2000;
  const rawLimit = parseInt(String(req.query.limit ?? ""), 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, MAX_DOC_LIMIT)
    : DEFAULT_DOC_LIMIT;

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const docs = await db.select().from(documentsTable).where(whereClause)
    .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id))
    .limit(limit);
  res.json(docs);
});

router.post("/documents", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const user = req.user!;
  const isStaff = STAFF_ROLES.includes(user.role as any);
  const { name, type: requestedType, status = "pending", studentId, applicationId, fileUrl, fileKey, notes, originalFileName, respondingToNoteId } = req.body;
  const type = normalizeDocumentTypeKey(requestedType);
  let { mimeType, sizeBytes } = req.body;
  if (req.body.fileData) {
    res.status(400).json({ error: "fileData uploads are no longer accepted. Upload via /storage/uploads/request-url and pass fileKey." });
    return;
  }

  if (!isStaff) {
    if (user.role === "student") {
      const [studentRec] = await db.select().from(studentsTable).where(eq(studentsTable.userId, user.id));
      if (!studentRec || (studentId && studentRec.id !== studentId)) {
        res.status(403).json({ error: "Students can only upload documents for themselves" });
        return;
      }
      // Task #187 — IDOR guard. The fulfillment hook runs against the
      // request's applicationId even when stored doc.applicationId is
      // null for students. A malicious student could guess another
      // student's app id and trigger missing-doc fulfillment / stage
      // changes on it. Verify the app belongs to this student.
      if (applicationId && studentRec) {
        const [ownApp] = await db.select({ id: applicationsTable.id })
          .from(applicationsTable)
          .where(and(eq(applicationsTable.id, Number(applicationId)), eq(applicationsTable.studentId, studentRec.id), isNull(applicationsTable.deletedAt)));
        if (!ownApp) {
          res.status(403).json({ error: "You can only upload to your own applications" });
          return;
        }
      }
    } else if (isAgentRole(user.role)) {
      if (studentId) {
        const visibleIds = await getAgentVisibleIds(user.id, user.role);
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
        if (!student || !student.agentId || !visibleIds.includes(student.agentId)) {
          res.status(403).json({ error: "You can only upload documents for your own students" });
          return;
        }
      }
      // Task #187 — IDOR guard for agents: applicationId must belong to
      // a student they can see.
      if (applicationId) {
        const visibleIds = await getAgentVisibleIds(user.id, user.role);
        const [appRow] = await db.select({ studentId: applicationsTable.studentId })
          .from(applicationsTable)
          .where(and(eq(applicationsTable.id, Number(applicationId)), isNull(applicationsTable.deletedAt)));
        if (!appRow) { res.status(404).json({ error: "Application not found" }); return; }
        const [appStudent] = await db.select({ agentId: studentsTable.agentId })
          .from(studentsTable).where(eq(studentsTable.id, appRow.studentId));
        if (!appStudent?.agentId || !visibleIds.includes(appStudent.agentId)) {
          res.status(403).json({ error: "Application is outside your scope" });
          return;
        }
      }
    } else {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  if (!name || !type) {
    res.status(400).json({ error: "name and type are required" });
    return;
  }
  if (fileUrl && !isValidHttpUrl(fileUrl)) {
    res.status(400).json({ error: "fileUrl must be a valid http/https URL" });
    return;
  }

  let descriptiveName: string | null = null;
  let resolvedStudentId: number | null = studentId ?? null;
  if (!resolvedStudentId && applicationId) {
    try {
      const [appRec] = await db
        .select({ studentId: applicationsTable.studentId })
        .from(applicationsTable)
        .where(eq(applicationsTable.id, applicationId));
      if (appRec?.studentId) resolvedStudentId = appRec.studentId;
    } catch (e) {
      console.error("[DOCUMENTS] failed to resolve studentId from applicationId:", e);
    }
  }
  if (resolvedStudentId) {
    try {
      const [studentRec] = await db
        .select({ firstName: studentsTable.firstName, lastName: studentsTable.lastName })
        .from(studentsTable)
        .where(eq(studentsTable.id, resolvedStudentId));
      if (studentRec) {
        descriptiveName = buildDocNameFromParts(
          studentRec.firstName,
          studentRec.lastName,
          type,
          mimeType,
        );
      }
    } catch (e) {
      console.error("[DOCUMENTS] failed to resolve student name for descriptive doc name:", e);
    }
  }
  const safeName = descriptiveName
    ? descriptiveName
    : (name ? sanitizeFileName(name) : name);

  if (fileKey) {
    if (!mimeType) {
      res.status(400).json({ error: "mimeType is required for file uploads" });
      return;
    }
    const validationFileName = originalFileName
      ? sanitizeFileName(originalFileName)
      : (() => {
          const syntheticExt = isPdf(mimeType) ? ".pdf" : mimeType === "image/png" ? ".png" : ".jpg";
          return `document${syntheticExt}`;
        })();
    const declaredSize = sizeBytes ? Number(sizeBytes) : 0;
    const validationError = validateStudentDocumentFile(type, validationFileName, mimeType, declaredSize);
    if (validationError) {
      const httpStatus = validationError.type === "size_exceeded" ? 413 : 400;
      res.status(httpStatus).json({ error: validationError.message });
      return;
    }
    let head: Buffer;
    try {
      head = await fetchFileKeyBytes(fileKey);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(400).json({ error: "Uploaded file could not be located in object storage." });
        return;
      }
      console.error("[DOCUMENTS] head-byte fetch failed:", err);
      res.status(502).json({ error: "Failed to verify uploaded file." });
      return;
    }
    const bufferError = await validateStudentDocumentBuffer(type, validationFileName, mimeType, head);
    if (bufferError) {
      try {
        const file = await documentsObjectStorage.getObjectEntityFile(fileKey);
        await file.delete({ ignoreNotFound: true });
      } catch (delErr) {
        console.error("[DOCUMENTS] failed to clean up rejected upload:", delErr);
      }
      const httpStatus = bufferError.type === "size_exceeded" ? 413 : 400;
      res.status(httpStatus).json({ error: bufferError.message });
      return;
    }

    // System-wide document size policy: shrink anything over the
    // portal-ready target in place before it's ever registered, so every
    // stored document is already small enough for portal upload widgets.
    // No-op when the file is already <= target (e.g. local driver already
    // compressed it at PUT time).
    try {
      const recompressed = await recompressStoredObjectIfNeeded(fileKey, mimeType);
      if (recompressed?.recompressed) {
        mimeType = recompressed.mimeType;
        sizeBytes = recompressed.sizeBytes;
      }
    } catch (err) {
      if (err instanceof UploadTooLargeError) {
        res.status(413).json({ error: err.message });
        return;
      }
      console.error("[DOCUMENTS] recompressStoredObjectIfNeeded failed, keeping original:", err);
    }
  }

  // Ownership guard: non-staff callers (students and agents) may only attach
  // storage objects they uploaded themselves. This closes the IDOR where an
  // attacker supplies a victim's object key to exfiltrate private files via
  // the document download endpoint. Staff are trusted and bypass this check.
  if (fileKey && !isStaff) {
    const owned = await callerOwnsObject(user.id, fileKey);
    if (!owned) {
      console.warn(`[DOCUMENTS] fileKey ownership violation: userId=${user.id} role=${user.role} key=${fileKey}`);
      res.status(403).json({ error: "You can only attach files that you have uploaded" });
      return;
    }
  }

  const effectiveStatus = isStaff ? status : "pending";

  // Application-scoped uploads are only honoured for staff; everyone else
  // uploads at the student profile level (applicationId null).
  const targetApplicationId = isStaff && applicationId ? Number(applicationId) : null;

  // Replace the prior version of this document type within the SAME scope only.
  // A profile-level upload (no application) replaces earlier profile-level docs;
  // an application-scoped upload replaces only the prior doc for that same
  // application. This keeps the student's own documents and each application's
  // documents independent — uploading a passport for one application no longer
  // wipes the student's profile passport or another application's copy.
  //
  // GUARD: only retire the old record when the NEW upload has verified content
  // (fileKey or fileUrl). Without this guard a request that omits both fields
  // (e.g. a metadata-only POST or an abandoned GCS upload) would soft-delete
  // the existing content-bearing record and leave an empty stub in its place —
  // the exact pattern that produced the 2026-06-02 data corruption.
  if (resolvedStudentId && type && (fileKey || fileUrl)) {
    const scopeCondition = targetApplicationId
      ? eq(documentsTable.applicationId, targetApplicationId)
      : isNull(documentsTable.applicationId);
    const oldDocs = await db.select({ id: documentsTable.id }).from(documentsTable).where(
      and(
        eq(documentsTable.studentId, resolvedStudentId),
        eq(documentsTable.type, type),
        scopeCondition,
        isNull(documentsTable.deletedAt)
      )
    );
    if (oldDocs.length > 0) {
      await db.update(documentsTable)
        .set({ deletedAt: new Date() })
        .where(inArray(documentsTable.id, oldDocs.map(d => d.id)));
    }
  }

  const [doc] = await db.insert(documentsTable).values({
    name: safeName, type, status: effectiveStatus,
    studentId: resolvedStudentId,
    applicationId: targetApplicationId,
    fileUrl: fileUrl || null,
    fileKey: fileKey || null,
    mimeType: mimeType || null,
    sizeBytes: sizeBytes ? Number(sizeBytes) : null,
    notes: notes || null,
  }).returning();
  await logAudit(user.id, "create_document", "document", doc.id, { name, type }, req.ip);

  // When a document is uploaded for a specific application and the student does
  // not yet have this document type among their own (profile-level) documents,
  // also record a profile-level copy so it appears in the student's documents.
  // The copy reuses the same stored file (fileKey), so no bytes are duplicated.
  // If the student already has a profile-level document of this type, leave it
  // untouched — the new upload stays only in the application's documents.
  if (targetApplicationId && doc.studentId && type) {
    const existingProfile = await db.select({ id: documentsTable.id }).from(documentsTable).where(
      and(
        eq(documentsTable.studentId, doc.studentId),
        eq(documentsTable.type, type),
        isNull(documentsTable.applicationId),
        isNull(documentsTable.deletedAt)
      )
    );
    if (existingProfile.length === 0) {
      await db.insert(documentsTable).values({
        name: safeName, type, status: effectiveStatus,
        studentId: doc.studentId,
        applicationId: null,
        fileUrl: fileUrl || null,
        fileKey: fileKey || null,
        mimeType: mimeType || null,
        sizeBytes: sizeBytes ? Number(sizeBytes) : null,
        notes: notes || null,
      });
    }
  }

  // AUTO-TRIGGER: transcript/diploma/degree upload for a student whose
  // education records are still empty fires the FAZ 1 extraction core in
  // the background. Fire-and-forget by contract — the upload response never
  // waits on it and never fails because of it (idempotent: skipIfFilled +
  // per-student in-flight guard live inside the trigger).
  maybeTriggerAutoEducationExtract({
    studentId: doc.studentId,
    documentType: type,
    actorUserId: user.id,
    ip: req.ip,
  });

  if (doc.studentId && (type === "photo" || type === "photograph")) {
    // Recompute from the docs themselves so fileData-only photos (which carry
    // neither fileKey nor fileUrl) still flip has_photo on. Single source of truth.
    await recomputeStudentPhoto(doc.studentId);
  }

  if (doc.studentId) {
    const [studentRec] = await db.select({ assignedToId: studentsTable.assignedToId }).from(studentsTable).where(eq(studentsTable.id, doc.studentId));
    const recipientIds: number[] = [];
    if (studentRec?.assignedToId) recipientIds.push(studentRec.assignedToId);
    try {
      await dispatchNotification({
        actorUserId: req.user!.id,
        event: "student.document_uploaded",
        title: "Document Uploaded",
        body: `A new document "${doc.name}" (${doc.type}) has been uploaded.`,
        actionUrl: `/staff/students`,
        icon: "Upload",
        recipientUserIds: recipientIds.length > 0 ? recipientIds : undefined,
        templateVars: { documentName: doc.name, documentType: doc.type },
      });
    } catch {}

    // A profile-level upload is shared evidence for every application owned by
    // this student. Re-check only applications parked in `missing_docs`; an
    // application-scoped upload remains isolated to its explicit application.
    try {
      if (targetApplicationId) {
        await reEvaluateMandatoryDocs(targetApplicationId);
      } else {
        await reEvaluateMandatoryDocsForStudent(doc.studentId);
      }
    } catch (e) {
      console.error("[DOCUMENTS] mandatory-document re-evaluation failed:", e);
    }
  }

  // Task #187 — auto-match against open missing-doc requests, scoped to
  // the SINGLE application this upload is bound to. Cross-application
  // fulfillment is not allowed: one upload must not silently close
  // requests (or auto-advance stages) on the student's other apps.
  // Uploads without an explicit applicationId (e.g. profile-level docs)
  // skip the hook entirely; the student/staff must select an application.
  const targetAppId = applicationId ? Number(applicationId) : (doc.applicationId || null);
  if (targetAppId && type) {
    try {
      void handleMissingDocFulfillment(targetAppId, type, user.id, doc.id, typeof respondingToNoteId === "number" ? respondingToNoteId : null);
    } catch (e) {
      console.error("[DOCUMENTS] missing-doc fulfillment trigger failed:", e);
    }
  }

  res.status(201).json(doc);
});

router.get("/documents/:id/download", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [doc] = await db.select().from(documentsTable).where(and(eq(documentsTable.id, id), isNull(documentsTable.deletedAt)));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const user = req.user!;
  const isStaff = STAFF_ROLES.includes(user.role as any);
  if (!isStaff) {
    if (user.role === "student") {
      const [studentRec] = await db.select().from(studentsTable).where(eq(studentsTable.userId, user.id));
      if (!studentRec || studentRec.id !== doc.studentId) {
        res.status(403).json({ error: "Access denied" }); return;
      }
    } else if (isAgentRole(user.role)) {
      if (!doc.studentId) { res.status(403).json({ error: "Access denied" }); return; }
      const visibleIds = await getAgentVisibleIds(user.id, user.role);
      const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, doc.studentId));
      if (!student || !student.agentId || !visibleIds.includes(student.agentId)) {
        res.status(403).json({ error: "Access denied" }); return;
      }
    } else {
      res.status(403).json({ error: "Access denied" }); return;
    }
  } else {
    // Non-admin staff: row-level check against the document's student.
    const isAdmin = ADMIN_ROLES.includes(user.role as any);
    if (!isAdmin && doc.studentId) {
      const access = await assertCanAccessStudent(req, doc.studentId);
      if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
    }
  }

  const wantsAttachment = req.query.disposition !== "inline";
  const downloadName = (req.query.filename as string | undefined) || doc.name;
  res.setHeader("Cache-Control", "private, max-age=300");
  if (wantsAttachment) {
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(downloadName)}"`);
  } else {
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(downloadName)}"`);
  }
  try {
    const sent = await streamDocumentToResponse(doc, res);
    if (!sent) {
      if (doc.fileUrl) { res.redirect(doc.fileUrl); return; }
      res.status(404).json({ error: "No file content available" });
    }
  } catch (err) {
    console.error(`[DOCUMENTS] download #${id} failed:`, err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to download document" });
  }
});

// GET /documents/:id/file — signed, AUTH-FREE document fetch for external create
// webhooks (e.g. SIT n8n). Most CRM documents live as base64 in `file_data` with
// no public object-storage key, so an external system with no session cookie
// cannot fetch them. A short-lived HMAC signature (?exp=&sig=), issued by the
// portal profile builders via buildSignedDocumentPath, authorises the fetch.
// Invalid/expired/missing signatures → 403. Never logs the signature.
router.get("/documents/:id/file", async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }
  const exp = Number(req.query.exp);
  const sig = typeof req.query.sig === "string" ? req.query.sig : "";
  if (!verifyDocumentSignature(id, exp, sig)) {
    res.status(403).json({ error: "Forbidden" }); return;
  }
  const [doc] = await db
    .select({
      fileKey: documentsTable.fileKey,
      fileData: documentsTable.fileData,
      fileUrl: documentsTable.fileUrl,
      mimeType: documentsTable.mimeType,
      name: documentsTable.name,
    })
    .from(documentsTable)
    .where(and(eq(documentsTable.id, id), isNull(documentsTable.deletedAt)));
  if (!doc) {
    // Row missing or soft-deleted — distinct from "row exists but storage
    // object is gone" so 404s are diagnosable from logs (e.g. doc 5045).
    console.warn(`[DOCUMENTS] signed file #${id} 404 — document row missing or deleted`);
    res.status(404).json({ error: `Document #${id} not found (row missing or deleted)` }); return;
  }
  if (!doc.fileKey && !doc.fileData && !doc.fileUrl) {
    console.warn(`[DOCUMENTS] signed file #${id} 404 — row exists but has no content (empty stub)`);
    res.status(404).json({ error: `Document #${id} has no file content (empty stub)` }); return;
  }
  // fileUrl-only rows (no object key / base64): redirect, but only to http(s)
  // to prevent SSRF via data:/file: URIs.
  if (!doc.fileKey && !doc.fileData) {
    const url = doc.fileUrl!;
    if (!isValidHttpUrl(url)) { res.status(422).json({ error: "Invalid document URL" }); return; }
    res.redirect(302, url);
    return;
  }
  res.setHeader("Cache-Control", "private, max-age=300");
  try {
    const sent = await streamDocumentToResponse(doc, res);
    if (!sent && !res.headersSent) {
      // Row exists but the storage object behind fileKey is gone and there is
      // no base64 fallback — include the fileKey so the 404 is actionable.
      console.warn(
        `[DOCUMENTS] signed file #${id} 404 — storage object missing (fileKey=${doc.fileKey ?? "-"}, hasFileData=${!!doc.fileData})`,
      );
      res.status(404).json({
        error: `Document #${id} file missing in storage (fileKey=${doc.fileKey ?? "-"})`,
      });
    }
  } catch (err) {
    console.error(`[DOCUMENTS] signed file #${id} failed:`, err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to load document" });
  }
});

// Build a fully-qualified URL for an /api path, honouring the reverse proxy's
// X-Forwarded-* headers (production serves the api-server behind the edge proxy)
// and falling back to a relative path when no host can be determined.
function buildPublicApiUrl(req: import("express").Request, path: string): string {
  const fwdProto = req.headers["x-forwarded-proto"];
  const fwdHost = req.headers["x-forwarded-host"];
  const proto =
    (Array.isArray(fwdProto) ? fwdProto[0] : fwdProto)?.split(",")[0]?.trim() ||
    req.protocol;
  const host =
    (Array.isArray(fwdHost) ? fwdHost[0] : fwdHost)?.split(",")[0]?.trim() ||
    req.get("host") ||
    "";
  return host ? `${proto}://${host}${path}` : path;
}

// GET /students/:id/documents — student-scoped document listing. Reachable with
// an API token (documents:read scope) as well as cookie sessions. Access is
// gated by assertCanAccessStudent, which for an agent (API-token owner) enforces
// that the student belongs to the token's agency — closing the IDOR. Only
// content-bearing documents are returned so every downloadUrl is downloadable.
router.get("/students/:id/documents", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const studentId = parseInt(String(req.params.id), 10);
  if (isNaN(studentId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const access = await assertCanAccessStudent(req, studentId);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }

  const docs = await db
    .select({
      id: documentsTable.id,
      type: documentsTable.type,
      fileName: documentsTable.name,
      mimeType: documentsTable.mimeType,
      sizeBytes: documentsTable.sizeBytes,
      sourceAttachmentId: documentsTable.sourceAttachmentId,
    })
    .from(documentsTable)
    .where(and(
      eq(documentsTable.studentId, studentId),
      isNull(documentsTable.deletedAt),
      or(
        isNotNull(documentsTable.fileKey),
        isNotNull(documentsTable.fileUrl),
        isNotNull(documentsTable.fileData),
      ),
    ))
    .orderBy(desc(documentsTable.createdAt));

  res.json(docs.map((d) => ({
    id: d.id,
    type: d.type,
    fileName: d.fileName,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    sourceAttachmentId: d.sourceAttachmentId ?? null,
    downloadUrl: buildPublicApiUrl(req, `/api/students/${studentId}/documents/${d.id}/download`),
  })));
});

// GET /students/:id/documents/:docId/download — stream a single document's
// binary content. Same agency IDOR gate as the listing; the document is also
// re-bound to :id so a doc from another student cannot be fetched via this path.
router.get("/students/:id/documents/:docId/download", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const studentId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  if (isNaN(studentId) || isNaN(docId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const access = await assertCanAccessStudent(req, studentId);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }

  const [doc] = await db
    .select()
    .from(documentsTable)
    .where(and(
      eq(documentsTable.id, docId),
      eq(documentsTable.studentId, studentId),
      isNull(documentsTable.deletedAt),
    ));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const wantsAttachment = req.query.disposition !== "inline";
  const downloadName = (req.query.filename as string | undefined) || doc.name;
  res.setHeader("Cache-Control", "private, max-age=300");
  res.setHeader(
    "Content-Disposition",
    `${wantsAttachment ? "attachment" : "inline"}; filename="${encodeURIComponent(downloadName)}"`,
  );
  try {
    const sent = await streamDocumentToResponse(doc, res);
    if (!sent) {
      if (doc.fileUrl) { res.redirect(doc.fileUrl); return; }
      res.status(404).json({ error: "No file content available" });
    }
  } catch (err) {
    console.error(`[DOCUMENTS] student-doc download #${docId} failed:`, err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to download document" });
  }
});

router.get("/documents/:id", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [doc] = await db.select().from(documentsTable).where(and(eq(documentsTable.id, id), isNull(documentsTable.deletedAt)));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const user = req.user!;
  const isStaff = STAFF_ROLES.includes(user.role as any);
  if (!isStaff) {
    if (user.role === "student") {
      const [studentRec] = await db.select().from(studentsTable).where(eq(studentsTable.userId, user.id));
      if (!studentRec || studentRec.id !== doc.studentId) {
        res.status(403).json({ error: "Access denied" }); return;
      }
    } else if (isAgentRole(user.role)) {
      if (doc.studentId) {
        const visibleIds = await getAgentVisibleIds(user.id, user.role);
        const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, doc.studentId));
        if (!student || !student.agentId || !visibleIds.includes(student.agentId)) {
          res.status(403).json({ error: "Access denied" }); return;
        }
      } else {
        res.status(403).json({ error: "Access denied" }); return;
      }
    } else {
      res.status(403).json({ error: "Access denied" }); return;
    }
  } else {
    // Non-admin staff: row-level check against the document's student.
    const isAdmin = ADMIN_ROLES.includes(user.role as any);
    if (!isAdmin && doc.studentId) {
      const access = await assertCanAccessStudent(req, doc.studentId);
      if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
    }
  }

  res.json(doc);
});

router.get("/documents/:id/versions", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id) || id <= 0) { res.status(400).json({ error: "Invalid id" }); return; }

  const [current] = await db.select().from(documentsTable).where(
    and(eq(documentsTable.id, id), isNull(documentsTable.deletedAt)),
  );
  if (!current) { res.status(404).json({ error: "Document not found" }); return; }
  if (!current.studentId) { res.status(400).json({ error: "Document has no versionable owner" }); return; }

  const access = await assertCanAccessStudent(req, current.studentId);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }

  const scope = current.applicationId
    ? eq(documentsTable.applicationId, current.applicationId)
    : isNull(documentsTable.applicationId);
  const versions = await db.select({
    id: documentsTable.id,
    name: documentsTable.name,
    type: documentsTable.type,
    status: documentsTable.status,
    mimeType: documentsTable.mimeType,
    sizeBytes: documentsTable.sizeBytes,
    createdAt: documentsTable.createdAt,
    updatedAt: documentsTable.updatedAt,
    deletedAt: documentsTable.deletedAt,
  }).from(documentsTable).where(and(
    eq(documentsTable.studentId, current.studentId),
    eq(documentsTable.type, current.type),
    scope,
  )).orderBy(desc(documentsTable.createdAt), desc(documentsTable.id));

  const total = versions.length;
  res.json({
    documentId: current.id,
    versions: versions.map((version, index) => ({
      ...version,
      version: total - index,
      isCurrent: version.id === current.id && version.deletedAt === null,
    })),
  });
});

router.patch("/documents/:id", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }

  if (req.body.fileUrl !== undefined) {
    if (!isValidHttpUrl(req.body.fileUrl)) {
      res.status(400).json({ error: "fileUrl must be a valid http/https URL" });
      return;
    }
  }

  const updates: Record<string, unknown> = {};
  for (const key of DOC_PATCH_FIELDS) {
    if (req.body[key] !== undefined) {
      updates[key] = key === "type"
        ? normalizeDocumentTypeKey(req.body[key])
        : req.body[key];
    }
  }
  if (req.body.fileUrl !== undefined) updates.fileUrl = req.body.fileUrl;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }
  const [existingDoc] = await db.select().from(documentsTable).where(and(eq(documentsTable.id, id), isNull(documentsTable.deletedAt)));
  if (!existingDoc) { res.status(404).json({ error: "Document not found" }); return; }
  // Non-admin staff: row-level check before applying any mutation.
  const isAdmin = ADMIN_ROLES.includes(req.user!.role as any);
  if (!isAdmin && existingDoc.studentId) {
    const access = await assertCanAccessStudent(req, existingDoc.studentId);
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  }
  const [doc] = await db.update(documentsTable).set(updates).where(and(eq(documentsTable.id, id), isNull(documentsTable.deletedAt))).returning();
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
  await logAudit(req.user!.id, "update_document", "document", id, updates, req.ip);

  if (updates.status && existingDoc && updates.status !== existingDoc.status) {
    const recipientIds: number[] = [];
    if (doc.studentId) {
      const [student] = await db.select({ userId: studentsTable.userId, assignedToId: studentsTable.assignedToId }).from(studentsTable).where(eq(studentsTable.id, doc.studentId));
      if (student?.userId) recipientIds.push(student.userId);
      if (student?.assignedToId) recipientIds.push(student.assignedToId);
    }
    try {
      await dispatchNotification({
        actorUserId: req.user!.id,
        event: "document.status_changed",
        title: "Document Status Updated",
        body: `Document "${doc.name}" status changed to "${updates.status}".`,
        actionUrl: doc.studentId ? `/staff/students/${doc.studentId}` : `/staff/documents`,
        icon: "FileCheck",
        recipientUserIds: recipientIds.length > 0 ? recipientIds : undefined,
        templateVars: { documentName: doc.name, documentType: doc.type || "", newStatus: String(updates.status) },
      });
    } catch {}
  }

  res.json(doc);
});

router.post("/documents/bulk-delete", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    res.status(400).json({ error: "ids array is required" });
    return;
  }
  const numericIds = ids.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
  if (numericIds.length === 0) {
    res.status(400).json({ error: "No valid ids provided" });
    return;
  }
  const docs = await db.select().from(documentsTable).where(and(inArray(documentsTable.id, numericIds), isNull(documentsTable.deletedAt)));
  if (docs.length === 0) {
    res.status(404).json({ error: "No documents found" });
    return;
  }
  // Non-admin staff: verify each targeted document's student is accessible.
  const isAdmin = ADMIN_ROLES.includes(req.user!.role as any);
  if (!isAdmin) {
    for (const doc of docs) {
      if (!doc.studentId) { res.status(403).json({ error: "Access denied" }); return; }
      const access = await assertCanAccessStudent(req, doc.studentId);
      if (!access.ok) { res.status(403).json({ error: "Access denied: one or more documents are outside your scope" }); return; }
    }
  }
  const activeIds = docs.map(d => d.id);
  await db.update(documentsTable).set({ deletedAt: new Date() }).where(inArray(documentsTable.id, activeIds));
  await logAudit(req.user!.id, "bulk_delete_documents", "document", null as any, { count: docs.length, ids: numericIds }, req.ip);

  // Resync students.has_photo for any students whose photo doc(s) were just
  // soft-deleted in this batch.
  const photoStudentIds = Array.from(new Set(
    docs.filter(d => d.studentId && (d.type === "photo" || d.type === "photograph")).map(d => d.studentId!) as number[]
  ));
  if (photoStudentIds.length > 0) {
    for (const sid of photoStudentIds) {
      await recomputeStudentPhoto(sid);
    }
  }
  res.json({ deleted: docs.length });
});

router.delete("/documents/:id", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [doc] = await db.select().from(documentsTable).where(and(eq(documentsTable.id, id), isNull(documentsTable.deletedAt)));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const user = req.user!;
  if (isAgentRole(user.role)) {
    if (!doc.studentId) { res.status(403).json({ error: "Access denied" }); return; }
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, doc.studentId));
    if (!student || !student.agentId || !visibleIds.includes(student.agentId)) {
      res.status(403).json({ error: "Access denied" }); return;
    }
  } else {
    // Non-admin staff: row-level check before deletion.
    const isAdmin = ADMIN_ROLES.includes(user.role as any);
    if (!isAdmin && doc.studentId) {
      const access = await assertCanAccessStudent(req, doc.studentId);
      if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
    }
  }

  await db.update(documentsTable).set({ deletedAt: new Date() }).where(eq(documentsTable.id, id));
  await logAudit(req.user!.id, "delete_document", "document", id, { name: doc.name }, req.ip);

  // Keep students.has_photo in sync when the deleted doc was the student's
  // photo: only flip to false when no other active photo doc remains.
  // Both 'photo' and 'photograph' type variants count as a student photo.
  if (doc.studentId && (doc.type === "photo" || doc.type === "photograph")) {
    await recomputeStudentPhoto(doc.studentId);
  }
  res.sendStatus(204);
});

router.get("/documents/download-zip/:studentId", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const studentId = parseInt(String(req.params.studentId), 10);
  if (isNaN(studentId)) { res.status(400).json({ error: "Invalid studentId" }); return; }

  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, studentId));
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }

  if (isAgentRole(req.user!.role)) {
    const visibleIds = await getAgentVisibleIds(req.user!.id, req.user!.role);
    if (!student.agentId || !visibleIds.includes(student.agentId)) {
      res.status(403).json({ error: "Access denied" }); return;
    }
  } else {
    // Non-admin staff: row-level check for this specific student.
    const isAdmin = ADMIN_ROLES.includes(req.user!.role as any);
    if (!isAdmin) {
      const access = await assertCanAccessStudent(req, studentId);
      if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
    }
  }

  // When profileOnly is requested, exclude application-scoped documents so the
  // ZIP matches the student's profile-documents list shown in the UI.
  const profileOnly = req.query.profileOnly === "true" || req.query.profileOnly === "1";

  // When applicationId is provided, scope the ZIP to a single application's
  // documents so the "download all" button on each application group only
  // bundles that application's files.
  const applicationIdRaw = req.query.applicationId;
  let applicationId: number | null = null;
  if (applicationIdRaw !== undefined) {
    applicationId = parseInt(String(applicationIdRaw), 10);
    if (isNaN(applicationId)) { res.status(400).json({ error: "Invalid applicationId" }); return; }
  }

  const docs = await db.select().from(documentsTable).where(
    and(
      eq(documentsTable.studentId, studentId),
      isNull(documentsTable.deletedAt),
      ...(profileOnly ? [isNull(documentsTable.applicationId)] : []),
      ...(applicationId !== null ? [eq(documentsTable.applicationId, applicationId)] : []),
    )
  );

  if (docs.length === 0) {
    res.status(404).json({ error: "No documents found for this student" });
    return;
  }

  const studentName = `${student.firstName}_${student.lastName}`.replace(/\s+/g, "_");
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${studentName}_documents.zip"`);

  const archive = archiver("zip", { zlib: { level: 5 } });
  archive.pipe(res);

  // Rebuild descriptive names on the fly so old documents (uploaded before
  // the descriptive-naming feature) also download as
  // "FIRSTNAME LASTNAME - DocLabel.ext". Dedupe collisions with " (id)".
  const seenNames = new Set<string>();
  for (const doc of docs) {
    const loaded = await loadDocumentBytes(doc).catch((e) => {
      console.error(`[DOCUMENTS] zip: failed to load doc #${doc.id}:`, e);
      return null;
    });
    if (loaded) {
      let name = buildDocNameFromParts(student.firstName, student.lastName, doc.type, doc.mimeType);
      if (seenNames.has(name)) {
        const dotIdx = name.lastIndexOf(".");
        name = dotIdx > 0
          ? `${name.slice(0, dotIdx)} (${doc.id})${name.slice(dotIdx)}`
          : `${name} (${doc.id})`;
      }
      seenNames.add(name);
      archive.append(loaded.buffer, { name });
    }
  }

  await archive.finalize();
});

router.post("/documents/merge-pdf", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const { documentIds } = req.body;

  if (!Array.isArray(documentIds) || documentIds.length < 2) {
    res.status(400).json({ error: "At least 2 document IDs are required" });
    return;
  }

  const numericIds = documentIds.map((id: any) => parseInt(id, 10)).filter((id: number) => !isNaN(id));
  const docs = await db.select().from(documentsTable).where(
    and(inArray(documentsTable.id, numericIds), isNull(documentsTable.deletedAt))
  );

  const pdfDocs = docs.filter(d => (d.fileData || d.fileKey) && d.mimeType === "application/pdf");
  if (pdfDocs.length < 2) {
    res.status(400).json({ error: "At least 2 PDF documents are required for merge" });
    return;
  }

  const user = req.user!;
  if (isAgentRole(user.role)) {
    // Vuln 1 fix: check EVERY document's ownership, not just a supplied studentId.
    // The old check (optional studentId + single student lookup) was an IDOR:
    // an attacker could omit studentId or supply a decoy and include arbitrary
    // victim document IDs in the merge request.
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    for (const doc of pdfDocs) {
      if (!doc.studentId) { res.status(403).json({ error: "Access denied" }); return; }
      const [student] = await db.select({ agentId: studentsTable.agentId }).from(studentsTable).where(eq(studentsTable.id, doc.studentId));
      if (!student || !student.agentId || !visibleIds.includes(student.agentId)) {
        res.status(403).json({ error: "Access denied" }); return;
      }
    }
  } else {
    // Non-admin staff: check each document's student.
    const isAdmin = ADMIN_ROLES.includes(user.role as any);
    if (!isAdmin) {
      for (const doc of pdfDocs) {
        if (!doc.studentId) { res.status(403).json({ error: "Access denied" }); return; }
        const access = await assertCanAccessStudent(req, doc.studentId);
        if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
      }
    }
  }

  try {
    const mergedPdf = await PDFDocument.create();

    for (const doc of pdfDocs) {
      const loaded = await loadDocumentBytes(doc);
      if (!loaded) continue;
      const sourcePdf = await PDFDocument.load(loaded.buffer);
      const pages = await mergedPdf.copyPages(sourcePdf, sourcePdf.getPageIndices());
      for (const page of pages) {
        mergedPdf.addPage(page);
      }
    }

    const mergedBytes = await mergedPdf.save();
    const base64 = Buffer.from(mergedBytes).toString("base64");

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="merged_documents.pdf"`);
    res.send(Buffer.from(mergedBytes));
  } catch (err) {
    console.error("[DOCUMENTS] PDF merge error:", err);
    res.status(500).json({ error: "Failed to merge PDFs" });
  }
});

router.post("/documents/:id/extract", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [doc] = await db.select().from(documentsTable).where(and(eq(documentsTable.id, id), isNull(documentsTable.deletedAt)));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const user = req.user!;
  if (isAgentRole(user.role)) {
    if (!doc.studentId) { res.status(403).json({ error: "Access denied" }); return; }
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    const [student] = await db.select({ agentId: studentsTable.agentId }).from(studentsTable).where(eq(studentsTable.id, doc.studentId));
    if (!student || !student.agentId || !visibleIds.includes(student.agentId)) {
      res.status(403).json({ error: "Access denied" }); return;
    }
  } else {
    const isAdmin = ADMIN_ROLES.includes(user.role as any);
    if (!isAdmin && doc.studentId) {
      const access = await assertCanAccessStudent(req, doc.studentId);
      if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
    }
  }

  if (!doc.fileUrl) {
    res.status(422).json({ error: "Document has no file attached. Upload a file before extracting." });
    return;
  }

  res.status(501).json({
    error: "AI document extraction is not yet configured. Please contact your administrator to enable this feature.",
    documentId: id,
  });
});

export default router;
