import { Router, type IRouter, type Request } from "express";
import express from "express";
import { db, applicationStageDocumentsTable, applicationsTable, studentsTable, usersTable, pipelineStagesTable, universitiesTable, programsTable, documentsTable, auditLogsTable } from "@workspace/db";
import { handleMissingDocFulfillment } from "../lib/missingDocsFulfillment";
import { checkMandatoryDocsForApplication, reEvaluateMandatoryDocs } from "../lib/mandatoryDocs.js";
import { eq, and, sql, desc, isNull } from "drizzle-orm";
import { requireAuth, requireAgentStaffPermission, logAudit } from "../lib/auth";
import { STAFF_ROLES, ADMIN_ROLES, isAgentRole, isStaffRole } from "../lib/roles";
import { canUploadStageDocument } from "../lib/stagePermissions";
import { getAgentVisibleIds } from "../lib/agentVisibility";
import { validateUploadedFile, validateUploadedFileBuffer, sanitizeFileName } from "../lib/fileUploadValidation";
import { processUpload, UploadTooLargeError } from "../lib/uploads/processUpload";
import { buildDocNameFromParts } from "../lib/docNaming";
import { assertCanAccessStudent } from "../lib/studentAccess";

const router: IRouter = Router();

// Stage-document uploads carry base64-encoded files in the JSON body. The
// global parser caps requests at 1MB which fails even small PDFs; allow up
// to ~25MB (~18MB raw file) for the upload route specifically. The global
// parser is skipped for this path via app.ts LARGE_BODY_PATH_REGEXES.
const stageDocsJsonParser = express.json({ limit: "25mb" });
router.post("/applications/:id/stage-documents", stageDocsJsonParser, (_req, _res, next) => next());

interface StageBehavior {
  uploadPermissionLevel: string;
  tracksOfferExpiry: boolean;
  requiresValidUntil: boolean;
}

async function getStageBehavior(stageKey: string): Promise<StageBehavior | null> {
  const [row] = await db.select({
    uploadPermissionLevel: pipelineStagesTable.uploadPermissionLevel,
    tracksOfferExpiry: pipelineStagesTable.tracksOfferExpiry,
    requiresValidUntil: pipelineStagesTable.requiresValidUntil,
  }).from(pipelineStagesTable)
    .where(and(
      eq(pipelineStagesTable.entityType, "application"),
      eq(pipelineStagesTable.key, stageKey),
    ));
  if (!row) return null;
  return {
    uploadPermissionLevel: row.uploadPermissionLevel || "none",
    tracksOfferExpiry: !!row.tracksOfferExpiry,
    requiresValidUntil: !!row.requiresValidUntil,
  };
}

async function verifyApplicationAccess(req: Request, applicationId: number): Promise<boolean> {
  const user = req.user!;
  const [app] = await db.select().from(applicationsTable).where(and(eq(applicationsTable.id, applicationId), isNull(applicationsTable.deletedAt)));
  if (!app) return false;

  if (STAFF_ROLES.includes(user.role as any)) {
    // Admin-level staff see all applications unconditionally.
    if (ADMIN_ROLES.includes(user.role as any)) return true;
    // Non-admin staff: must be able to access the application's student via the
    // same assignment/branch/agency rules used by GET /students/:id and
    // GET /applications/:id. Unconditional true was a bypass for any staff role.
    const access = await assertCanAccessStudent(req, app.studentId);
    return access.ok;
  }

  if (user.role === "student") {
    const [studentRec] = await db.select().from(studentsTable).where(eq(studentsTable.userId, user.id));
    return !!studentRec && studentRec.id === app.studentId;
  }

  if (isAgentRole(user.role)) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    return !!app.agentId && visibleIds.includes(app.agentId);
  }

  return false;
}

router.get("/applications/:id/stage-documents", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const applicationId = parseInt(String(req.params.id), 10);
  const user = req.user!;

  const hasAccess = await verifyApplicationAccess(req, applicationId);
  if (!hasAccess) { res.status(403).json({ error: "Access denied" }); return; }

  const { stage, page = "1", limit = "100" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;
  const conditions = [eq(applicationStageDocumentsTable.applicationId, applicationId)];
  if (stage) conditions.push(eq(applicationStageDocumentsTable.stage, stage));

  const docs = await db
    .select({
      id: applicationStageDocumentsTable.id,
      applicationId: applicationStageDocumentsTable.applicationId,
      stage: applicationStageDocumentsTable.stage,
      fileName: applicationStageDocumentsTable.fileName,
      fileUrl: applicationStageDocumentsTable.fileUrl,
      mimeType: applicationStageDocumentsTable.mimeType,
      sizeBytes: applicationStageDocumentsTable.sizeBytes,
      uploadedBy: applicationStageDocumentsTable.uploadedBy,
      uploadedByRole: applicationStageDocumentsTable.uploadedByRole,
      uploadedByName: applicationStageDocumentsTable.uploadedByName,
      isMissingDocNote: applicationStageDocumentsTable.isMissingDocNote,
      validUntil: applicationStageDocumentsTable.validUntil,
      expiryNotifiedThresholds: applicationStageDocumentsTable.expiryNotifiedThresholds,
      hasFileData: sql<boolean>`${applicationStageDocumentsTable.fileData} IS NOT NULL`.as("has_file_data"),
      createdAt: applicationStageDocumentsTable.createdAt,
    })
    .from(applicationStageDocumentsTable)
    .where(and(...conditions))
    .orderBy(desc(applicationStageDocumentsTable.createdAt))
    .limit(limitNum)
    .offset(offset);

  res.json(docs);
});

router.post("/applications/:id/stage-documents", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const applicationId = parseInt(String(req.params.id), 10);
  const user = req.user!;

  const hasAccess = await verifyApplicationAccess(req, applicationId);
  if (!hasAccess) { res.status(403).json({ error: "Access denied" }); return; }

  const { stage, fileName, fileUrl, validUntil, documentNameOverride, respondingToNoteId } = req.body;
  let { fileData, mimeType, sizeBytes } = req.body;

  if (!stage || !fileName) {
    res.status(400).json({ error: "stage and fileName are required" });
    return;
  }
  const parsedRespondingToNoteId = respondingToNoteId == null ? undefined : Number(respondingToNoteId);
  if (parsedRespondingToNoteId !== undefined && (!Number.isInteger(parsedRespondingToNoteId) || parsedRespondingToNoteId <= 0)) {
    res.status(400).json({ error: "respondingToNoteId must be a positive integer" });
    return;
  }

  // Task #167 — when admin configured a Document Name on a stage-action
  // upload button, that name takes priority over the descriptive default.
  // Keep original extension from the uploaded file.
  let overrideBase: string | null = null;
  if (typeof documentNameOverride === "string" && documentNameOverride.trim()) {
    const trimmed = documentNameOverride.trim().slice(0, 64);
    const dot = String(fileName).lastIndexOf(".");
    const ext = dot > 0 ? String(fileName).slice(dot) : "";
    overrideBase = `${trimmed}${ext}`;
  }

  const behavior = await getStageBehavior(stage);
  if (!behavior || behavior.uploadPermissionLevel === "none") {
    res.status(400).json({ error: "Document upload not allowed for this stage" });
    return;
  }

  let validUntilDate: Date | null = null;
  if (validUntil) {
    const parsed = new Date(validUntil);
    if (isNaN(parsed.getTime())) {
      res.status(400).json({ error: "validUntil must be a valid date" });
      return;
    }
    validUntilDate = parsed;
  }
  if (behavior.requiresValidUntil && !validUntilDate) {
    res.status(400).json({ error: "validUntil is required for this stage" });
    return;
  }

  let descriptiveName: string | null = null;
  try {
    const [appStudent] = await db
      .select({ firstName: studentsTable.firstName, lastName: studentsTable.lastName })
      .from(applicationsTable)
      .innerJoin(studentsTable, eq(studentsTable.id, applicationsTable.studentId))
      .where(eq(applicationsTable.id, applicationId));
    if (appStudent) {
      descriptiveName = buildDocNameFromParts(
        appStudent.firstName,
        appStudent.lastName,
        stage,
        mimeType,
      );
    }
  } catch (e) {
    console.error("[STAGE-DOC] failed to resolve student name for descriptive doc name:", e);
  }
  // Priority: admin-configured Document Name > descriptive student name > raw upload name.
  const safeName = overrideBase
    ? sanitizeFileName(overrideBase)
    : (descriptiveName ?? sanitizeFileName(fileName));

  if (fileData) {
    if (!mimeType) {
      res.status(400).json({ error: "mimeType is required for file uploads" });
      return;
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(fileData, "base64");
    } catch {
      res.status(400).json({ error: "Invalid base64 file data" });
      return;
    }
    const validationError = await validateUploadedFileBuffer(safeName, mimeType, buffer);
    if (validationError) {
      const httpStatus = validationError.type === "size_exceeded" ? 413 : 400;
      res.status(httpStatus).json({ error: validationError.message });
      return;
    }

    // System-wide document size policy chokepoint: shrink anything over the
    // portal-ready target before it's persisted as base64 fileData.
    try {
      const processed = await processUpload(buffer, safeName, mimeType);
      if (processed.meta.compressed) {
        fileData = processed.buffer.toString("base64");
        mimeType = processed.mime;
        sizeBytes = processed.buffer.length;
      }
    } catch (err) {
      if (err instanceof UploadTooLargeError) {
        res.status(413).json({ error: err.message });
        return;
      }
      console.error("[STAGE-DOC] processUpload failed, keeping original:", err);
    }
  }

  if (fileUrl) {
    try {
      const url = new URL(fileUrl);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        res.status(400).json({ error: "fileUrl must use http or https protocol" });
        return;
      }
    } catch {
      res.status(400).json({ error: "fileUrl must be a valid URL" });
      return;
    }
  }

  if (!fileData && !fileUrl) {
    res.status(400).json({ error: "Either fileData or fileUrl is required" });
    return;
  }

  const allowed = canUploadStageDocument(behavior.uploadPermissionLevel, user.role);
  if (!allowed) {
    res.status(403).json({ error: "You do not have permission to upload documents for this stage" });
    return;
  }

  const uploaderName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email;

  const [doc] = await db.insert(applicationStageDocumentsTable).values({
    applicationId,
    stage,
    fileName: safeName,
    fileData: fileData || null,
    fileUrl: fileUrl || null,
    mimeType: mimeType || null,
    sizeBytes: sizeBytes ? Number(sizeBytes) : null,
    uploadedBy: user.id,
    uploadedByRole: user.role,
    uploadedByName: uploaderName,
    isMissingDocNote: false,
    validUntil: behavior.tracksOfferExpiry ? validUntilDate : null,
  }).returning();

  await logAudit(user.id, "upload_stage_document", "application", applicationId, { stage, fileName, docId: doc.id }, req.ip);

  // Task #187 — stage uploads may fulfil an open missing-doc request.
  // Use the override name (admin-configured Document Name) when present,
  // otherwise the stage key as the document-type signal.
  const fulfilmentSignal = (typeof documentNameOverride === "string" && documentNameOverride.trim())
    ? documentNameOverride.trim()
    : stage;
  await handleMissingDocFulfillment(
    applicationId,
    fulfilmentSignal,
    user.id,
    doc.id,
    parsedRespondingToNoteId,
  );

  // Mirror ALL stage uploads to the student's shared document pool so they
  // appear in the application detail (Program Document Requirements), the
  // student Belgeler tab, and are counted by the mandatory-gate / automation.
  // The catalog type comes from documentNameOverride when the admin configured
  // it for this stage action, otherwise we fall back to the stage key.
  // Idempotent: if a mirror already exists for this stage-doc ID, skip insert.
  try {
    const [appRow] = await db
      .select({ studentId: applicationsTable.studentId })
      .from(applicationsTable)
      .where(eq(applicationsTable.id, applicationId));
    if (appRow?.studentId) {
      const docType = (typeof documentNameOverride === "string" && documentNameOverride.trim())
        ? documentNameOverride.trim()
        : stage;
      const [existingMirror] = await db
        .select({ id: documentsTable.id })
        .from(documentsTable)
        .where(and(
          eq(documentsTable.sourceStageDocumentId, doc.id),
          isNull(documentsTable.deletedAt)
        ));
      if (!existingMirror) {
        await db.insert(documentsTable).values({
          studentId: appRow.studentId,
          applicationId,
          name: safeName,
          type: docType,
          status: "approved",
          fileData: fileData || null,
          fileUrl: fileUrl || null,
          mimeType: mimeType || null,
          sizeBytes: sizeBytes ? Number(sizeBytes) : null,
          sourceStageDocumentId: doc.id,
        });
      }
    }
  } catch (e) {
    // Non-fatal: the stage document record was already saved; log and continue.
    console.error("[STAGE-DOC] failed to mirror stage upload to student pool:", e);
  }

  // Re-evaluate mandatory doc gate AFTER the mirror insert above so the
  // just-uploaded document is already visible in documentsTable when the
  // check runs. If all mandatory docs are now present, advance to "inquiry".
  void reEvaluateMandatoryDocs(applicationId);

  res.status(201).json(doc);
});

router.patch("/applications/:id/stage-documents/:docId", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const applicationId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  const user = req.user!;

  const isAdmin = ADMIN_ROLES.includes(user.role as any);
  if (!isAdmin) {
    res.status(403).json({ error: "Only administrators can edit document metadata" });
    return;
  }

  const [doc] = await db.select().from(applicationStageDocumentsTable)
    .where(and(eq(applicationStageDocumentsTable.id, docId), eq(applicationStageDocumentsTable.applicationId, applicationId)));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  const updates: Record<string, unknown> = {};
  if (req.body.validUntil !== undefined) {
    if (req.body.validUntil === null || req.body.validUntil === "") {
      updates.validUntil = null;
    } else {
      const parsed = new Date(req.body.validUntil);
      if (isNaN(parsed.getTime())) {
        res.status(400).json({ error: "validUntil must be a valid date" });
        return;
      }
      updates.validUntil = parsed;
    }
    updates.expiryNotifiedThresholds = null;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  const [updated] = await db.update(applicationStageDocumentsTable)
    .set(updates)
    .where(eq(applicationStageDocumentsTable.id, docId))
    .returning();

  await logAudit(user.id, "update_stage_document", "application", applicationId, { docId, ...updates }, req.ip);
  res.json(updated);
});

router.delete("/applications/:id/stage-documents/:docId", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const applicationId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  const user = req.user!;

  const isAdmin = ADMIN_ROLES.includes(user.role as any);
  const [doc] = await db.select().from(applicationStageDocumentsTable)
    .where(and(eq(applicationStageDocumentsTable.id, docId), eq(applicationStageDocumentsTable.applicationId, applicationId)));

  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  if (!isAdmin && doc.uploadedBy !== user.id) {
    res.status(403).json({ error: "You can only delete your own uploads" });
    return;
  }

  await db.delete(applicationStageDocumentsTable)
    .where(eq(applicationStageDocumentsTable.id, docId));

  // Faz J — sync-delete the documents mirror that was created when this
  // stage doc was uploaded so the application detail and student Belgeler
  // tab no longer show the deleted document.
  try {
    await db.update(documentsTable)
      .set({ deletedAt: new Date() })
      .where(and(
        eq(documentsTable.sourceStageDocumentId, docId),
        isNull(documentsTable.deletedAt)
      ));
  } catch (e) {
    console.error("[STAGE-DOC] failed to remove document mirror on stage-doc delete:", e);
  }

  await logAudit(user.id, "delete_stage_document", "application", applicationId, { docId, stage: doc.stage }, req.ip);
  res.sendStatus(204);
});

router.get("/applications/:id/missing-doc-notes", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const applicationId = parseInt(String(req.params.id), 10);
  const user = req.user!;

  const hasAccess = await verifyApplicationAccess(req, applicationId);
  if (!hasAccess) { res.status(403).json({ error: "Access denied" }); return; }

  const { page = "1", limit = "200", stage } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(500, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  // Task #187 — notes are now created on whichever stage the
  // missing_docs action originates from (no longer hardcoded to
  // "missing_docs"). Default = all stages; optional ?stage= filter.
  const wheres = [
    eq(applicationStageDocumentsTable.applicationId, applicationId),
    eq(applicationStageDocumentsTable.isMissingDocNote, true),
  ];
  if (stage && typeof stage === "string") {
    wheres.push(eq(applicationStageDocumentsTable.stage, stage));
  }

  const notes = await db
    .select()
    .from(applicationStageDocumentsTable)
    .where(and(...wheres))
    .orderBy(desc(applicationStageDocumentsTable.createdAt))
    .limit(limitNum)
    .offset(offset);

  // Task #187 contract — expose explicit field names alongside the raw
  // schema row (BC kept so existing clients keep working):
  //   documentType  = catalog key (null when isCustom)
  //   customTitle   = free-text title (null when !isCustom)
  //   requestedAt   = createdAt
  //   requestedBy   = uploadedByName
  const shaped = notes.map((n: any) => ({
    ...n,
    documentType: n.isCustom ? null : n.fileName,
    customTitle: n.isCustom ? n.fileName : null,
    requestedAt: n.createdAt,
    requestedBy: n.uploadedByName,
  }));

  // Automatic readiness checks can park an application in missing_docs without
  // a staff actor. In that path we cannot create application_stage_documents
  // request rows because uploaded_by is a required user FK. Keep this endpoint
  // read-only and supplement persisted staff requests with the current canonical
  // mandatory-doc result and the latest portal preflight evidence.
  const [application] = await db
    .select({ stage: applicationsTable.stage })
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId))
    .limit(1);

  const shouldDerive = application?.stage === "missing_docs" && (!stage || stage === "missing_docs");
  if (!shouldDerive) {
    res.json(shaped);
    return;
  }

  const requestedKeys = new Set(
    shaped
      .filter((note: any) => !note.fulfilledAt)
      .map((note: any) => String(note.fileName || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const derivedKeys = new Set<string>();

  const mandatoryCheck = await checkMandatoryDocsForApplication(applicationId);
  for (const type of mandatoryCheck?.missing || []) derivedKeys.add(String(type).trim().toLowerCase());

  const [latestPreflight] = await db
    .select({ changes: auditLogsTable.changes, createdAt: auditLogsTable.createdAt })
    .from(auditLogsTable)
    .where(and(
      eq(auditLogsTable.action, "portal_application_preflight"),
      eq(auditLogsTable.resource, "application"),
      eq(auditLogsTable.resourceId, applicationId),
    ))
    .orderBy(desc(auditLogsTable.createdAt), desc(auditLogsTable.id))
    .limit(1);

  let preflight: Record<string, unknown> = {};
  if (latestPreflight?.changes) {
    try {
      preflight = JSON.parse(latestPreflight.changes) as Record<string, unknown>;
    } catch {
      preflight = {};
    }
  }
  const failedPreflight = preflight.ready === false;
  const preflightMissing = failedPreflight && Array.isArray(preflight.missingDocuments) ? preflight.missingDocuments : [];
  for (const type of preflightMissing) {
    const key = String(type || "").trim().toLowerCase();
    if (key) derivedKeys.add(key);
  }

  const incompatibleFields = failedPreflight && Array.isArray(preflight.incompatibleFields) ? preflight.incompatibleFields : [];
  for (const issue of incompatibleFields) {
    const field = String((issue as { field?: unknown })?.field || "").trim().toLowerCase();
    if (field.startsWith("passport")) derivedKeys.add("passport");
  }

  const derived = [...derivedKeys]
    .filter((key) => key && !requestedKeys.has(key))
    .map((key, index) => ({
      id: -(index + 1),
      applicationId,
      stage: "missing_docs",
      fileName: key,
      isMissingDocNote: true,
      isCustom: false,
      fulfilledAt: null,
      respondedAt: null,
      note: null,
      createdAt: latestPreflight?.createdAt || null,
      uploadedByName: null,
      documentType: key,
      customTitle: null,
      requestedAt: latestPreflight?.createdAt || null,
      requestedBy: null,
      isDerived: true,
    }));

  res.json([...shaped, ...derived]);
});

router.post("/applications/:id/missing-doc-notes", requireAuth, (req, res, next) => {
  // Task #187 — block students from creating missing-doc requests on
  // their own application. The pre-existing handler only protected via
  // verifyApplicationAccess, which returns true for the student owner.
  if (req.user && req.user.role === "student") { res.status(403).json({ error: "Forbidden" }); return; }
  next();
}, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const applicationId = parseInt(String(req.params.id), 10);
  const user = req.user!;

  // Task #167 — row-level authz before any read/write.
  const hasAccess = await verifyApplicationAccess(req, applicationId);
  if (!hasAccess) { res.status(403).json({ error: "Access denied" }); return; }

  // Task #187 — new payload shape `items: [{documentType?, customTitle?, note?}]`
  // with backwards-compat for the legacy `notes: string[]`. At least one of
  // documentType / customTitle must be present per item.
  type IncomingItem = { documentType?: unknown; customTitle?: unknown; note?: unknown };
  const { notes, items, stage: stageParam } = req.body as { notes?: unknown; items?: unknown; stage?: string };

  // Validate catalog `documentType` values against the live admin-managed
  // catalog (catalog_options category=documents). Unknown keys would
  // never auto-fulfill, so we reject them up front instead of silently
  // creating a row that can only be closed manually.
  const { loadDocCatalogKeySet } = await import("../lib/docCatalog");
  let catalogKeys: Set<string> = new Set();
  try { catalogKeys = await loadDocCatalogKeySet(); } catch { /* serve open if catalog unavailable */ }

  let normalizedItems: { fileName: string; isCustom: boolean; note: string | null }[] = [];
  if (Array.isArray(items)) {
    const rejected: string[] = [];
    for (const raw of items as IncomingItem[]) {
      if (!raw || typeof raw !== "object") continue;
      const docType = typeof raw.documentType === "string" ? raw.documentType.trim() : "";
      const custom = typeof raw.customTitle === "string" ? raw.customTitle.trim() : "";
      const note = typeof raw.note === "string" ? raw.note.trim() : "";
      if (docType) {
        if (catalogKeys.size > 0 && !catalogKeys.has(docType)) {
          rejected.push(docType);
          continue;
        }
        normalizedItems.push({ fileName: docType.slice(0, 128), isCustom: false, note: note ? note.slice(0, 500) : null });
      } else if (custom) {
        normalizedItems.push({ fileName: custom.slice(0, 128), isCustom: true, note: note ? note.slice(0, 500) : null });
      }
    }
    if (rejected.length > 0) {
      res.status(400).json({ error: `Geçersiz katalog belgesi: ${rejected.join(", ")}` });
      return;
    }
  } else if (Array.isArray(notes)) {
    // Legacy free-text payload — every line is a custom request.
    normalizedItems = (notes as unknown[])
      .filter((n): n is string => typeof n === "string" && !!n.trim())
      .map(n => ({ fileName: n.trim().slice(0, 128), isCustom: true, note: null }));
  } else {
    res.status(400).json({ error: "items or notes array is required" });
    return;
  }

  // Determine the action's source stage from the request, falling back to
  // the application's current stage. Notes are tied to that stage so custom
  // pipeline workflows (not just a hardcoded "missing_docs" key) work.
  let stageKey = typeof stageParam === "string" && stageParam.trim() ? stageParam.trim() : "";
  if (!stageKey) {
    const [appRow] = await db.select({ stage: applicationsTable.stage })
      .from(applicationsTable)
      .where(and(eq(applicationsTable.id, applicationId), isNull(applicationsTable.deletedAt)));
    if (!appRow) { res.status(404).json({ error: "Application not found" }); return; }
    stageKey = appRow.stage;
  }

  // Authorize against THAT stage's uploadPermissionLevel (not a hardcoded key).
  // Also pull `actions` so we can snapshot the missing_docs action's
  // targetStageKey (the "waiting" stage staff moved the app to) onto
  // every created row — fulfillment uses it to gate auto-advance.
  const isAdmin = ADMIN_ROLES.includes(user.role as any);
  const [stageRow] = await db.select({
    uploadPermissionLevel: pipelineStagesTable.uploadPermissionLevel,
    actions: pipelineStagesTable.actions,
  })
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.entityType, "application"), eq(pipelineStagesTable.key, stageKey)));
  const permLevel = stageRow?.uploadPermissionLevel || "admin_only";
  const missingDocsAction = Array.isArray(stageRow?.actions)
    ? (stageRow!.actions as any[]).find(a => a && a.type === "missing_docs")
    : null;
  const actionTargetStageKey: string | null = missingDocsAction && typeof missingDocsAction.targetStageKey === "string" && missingDocsAction.targetStageKey
    ? missingDocsAction.targetStageKey
    : null;
  const isStaff = isStaffRole(user.role);
  const isAgent = isAgentRole(user.role);
  let allowed = false;
  if (permLevel === "everyone") allowed = true;
  else if (permLevel === "staff_and_agent") allowed = isStaff || isAgent;
  else if (permLevel === "staff_only") allowed = isStaff;
  else if (permLevel === "admin_only") allowed = isAdmin;
  if (!allowed) {
    res.status(403).json({ error: "Bu aşamada eksik belge notu eklemeye yetkiniz yok" });
    return;
  }

  await db.delete(applicationStageDocumentsTable).where(and(
    eq(applicationStageDocumentsTable.applicationId, applicationId),
    eq(applicationStageDocumentsTable.stage, stageKey),
    eq(applicationStageDocumentsTable.isMissingDocNote, true),
  ));

  const uploaderName = `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email;

  const insertValues = normalizedItems.map((it) => ({
    applicationId,
    stage: stageKey,
    fileName: it.fileName,
    uploadedBy: user.id,
    uploadedByRole: user.role,
    uploadedByName: uploaderName,
    isMissingDocNote: true,
    isCustom: it.isCustom,
    note: it.note,
    actionTargetStageKey,
  }));

  if (insertValues.length > 0) {
    await db.insert(applicationStageDocumentsTable).values(insertValues);
  }

  const result = await db.select().from(applicationStageDocumentsTable).where(and(
    eq(applicationStageDocumentsTable.applicationId, applicationId),
    eq(applicationStageDocumentsTable.stage, stageKey),
    eq(applicationStageDocumentsTable.isMissingDocNote, true),
  )).orderBy(desc(applicationStageDocumentsTable.createdAt));

  await logAudit(user.id, "update_missing_doc_notes", "application", applicationId, { count: result.length, stage: stageKey }, req.ip);
  res.json(result);
});

// Task #187 — manual close (admin / staff) for a single missing-doc request
// row, used to mark custom requests fulfilled. Catalog rows are normally
// closed automatically by the upload hook but can also be closed manually.
// Explicit role gate: only staff/admin/agent_staff (with `documents` perm)
// may mutate — never students, even on their own application.
const STAFF_AGENT_ROLES = new Set([...STAFF_ROLES, ...ADMIN_ROLES, "agent", "agent_staff"]);
function requireStaffOrAdmin(req: any, res: any, next: any) {
  if (!req.user) { res.status(401).json({ error: "Authentication required" }); return; }
  if (!STAFF_AGENT_ROLES.has(req.user.role)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}
router.patch("/applications/:id/missing-doc-notes/:noteId", requireAuth, requireStaffOrAdmin, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const applicationId = parseInt(String(req.params.id), 10);
  const noteId = parseInt(String(req.params.noteId), 10);
  const user = req.user!;

  const hasAccess = await verifyApplicationAccess(req, applicationId);
  if (!hasAccess) { res.status(403).json({ error: "Access denied" }); return; }

  const [row] = await db.select().from(applicationStageDocumentsTable).where(and(
    eq(applicationStageDocumentsTable.id, noteId),
    eq(applicationStageDocumentsTable.applicationId, applicationId),
    eq(applicationStageDocumentsTable.isMissingDocNote, true),
  ));
  if (!row) { res.status(404).json({ error: "Request not found" }); return; }

  const fulfilled = !!req.body?.fulfilled;
  const [updated] = await db.update(applicationStageDocumentsTable)
    .set({ fulfilledAt: fulfilled ? new Date() : null })
    .where(eq(applicationStageDocumentsTable.id, noteId))
    .returning();

  await logAudit(user.id, "update_missing_doc_note_fulfilled", "application", applicationId, { noteId, fulfilled }, req.ip);
  res.json(updated);
});

// Task #187 — delete a single missing-doc request row (admin / staff).
router.delete("/applications/:id/missing-doc-notes/:noteId", requireAuth, requireStaffOrAdmin, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const applicationId = parseInt(String(req.params.id), 10);
  const noteId = parseInt(String(req.params.noteId), 10);
  const user = req.user!;

  const hasAccess = await verifyApplicationAccess(req, applicationId);
  if (!hasAccess) { res.status(403).json({ error: "Access denied" }); return; }

  const [row] = await db.select().from(applicationStageDocumentsTable).where(and(
    eq(applicationStageDocumentsTable.id, noteId),
    eq(applicationStageDocumentsTable.applicationId, applicationId),
    eq(applicationStageDocumentsTable.isMissingDocNote, true),
  ));
  if (!row) { res.status(404).json({ error: "Request not found" }); return; }

  await db.delete(applicationStageDocumentsTable).where(eq(applicationStageDocumentsTable.id, noteId));
  await logAudit(user.id, "delete_missing_doc_note", "application", applicationId, { noteId }, req.ip);
  res.sendStatus(204);
});

// Task #167 — aggregate every stage-document across all of a student's
// applications, with university/program/stage context. Powers the
// "Başvuru Belgeleri" section on the student detail page.
router.get("/students/:id/application-documents", requireAuth, requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const studentId = parseInt(String(req.params.id), 10);
  const access = await assertCanAccessStudent(req, studentId);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }

  const rows = await db
    .select({
      id: applicationStageDocumentsTable.id,
      applicationId: applicationStageDocumentsTable.applicationId,
      stage: applicationStageDocumentsTable.stage,
      fileName: applicationStageDocumentsTable.fileName,
      mimeType: applicationStageDocumentsTable.mimeType,
      sizeBytes: applicationStageDocumentsTable.sizeBytes,
      uploadedBy: applicationStageDocumentsTable.uploadedBy,
      uploadedByRole: applicationStageDocumentsTable.uploadedByRole,
      uploadedByName: applicationStageDocumentsTable.uploadedByName,
      validUntil: applicationStageDocumentsTable.validUntil,
      hasFileData: sql<boolean>`${applicationStageDocumentsTable.fileData} IS NOT NULL`.as("has_file_data"),
      fileUrl: applicationStageDocumentsTable.fileUrl,
      isMissingDocNote: applicationStageDocumentsTable.isMissingDocNote,
      createdAt: applicationStageDocumentsTable.createdAt,
      universityName: universitiesTable.name,
      programName: programsTable.name,
      stageLabel: pipelineStagesTable.label,
    })
    .from(applicationStageDocumentsTable)
    .innerJoin(applicationsTable, eq(applicationsTable.id, applicationStageDocumentsTable.applicationId))
    .leftJoin(universitiesTable, eq(universitiesTable.id, applicationsTable.universityId))
    .leftJoin(programsTable, eq(programsTable.id, applicationsTable.programId))
    .leftJoin(pipelineStagesTable, and(
      eq(pipelineStagesTable.entityType, "application"),
      eq(pipelineStagesTable.key, applicationStageDocumentsTable.stage),
    ))
    .where(and(
      eq(applicationsTable.studentId, studentId),
      isNull(applicationsTable.deletedAt),
      eq(applicationStageDocumentsTable.isMissingDocNote, false),
    ))
    .orderBy(desc(applicationStageDocumentsTable.createdAt));

  res.json(rows);
});

router.get("/applications/:id/stage-documents/:docId/download", requireAuth, requireAgentStaffPermission("documents"), async (req, res): Promise<void> => {
  const applicationId = parseInt(String(req.params.id), 10);
  const docId = parseInt(String(req.params.docId), 10);
  const user = req.user!;

  const hasAccess = await verifyApplicationAccess(req, applicationId);
  if (!hasAccess) { res.status(403).json({ error: "Access denied" }); return; }

  const [doc] = await db.select().from(applicationStageDocumentsTable)
    .where(and(eq(applicationStageDocumentsTable.id, docId), eq(applicationStageDocumentsTable.applicationId, applicationId)));

  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }

  // Rebuild descriptive name on the fly so old uploads also get
  // "FIRSTNAME LASTNAME - StageLabel.ext" at download time.
  let downloadName = doc.fileName;
  try {
    const [appStudent] = await db
      .select({ firstName: studentsTable.firstName, lastName: studentsTable.lastName })
      .from(applicationsTable)
      .innerJoin(studentsTable, eq(studentsTable.id, applicationsTable.studentId))
      .where(eq(applicationsTable.id, applicationId));
    if (appStudent) {
      downloadName = buildDocNameFromParts(
        appStudent.firstName,
        appStudent.lastName,
        doc.stage,
        doc.mimeType,
      );
    }
  } catch (e) {
    console.error("[STAGE-DOC] failed to rebuild descriptive name on download:", e);
  }

  if (doc.fileData) {
    const buffer = Buffer.from(doc.fileData, "base64");
    res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(downloadName)}"`);
    res.setHeader("Content-Length", buffer.length);
    res.send(buffer);
  } else if (doc.fileUrl) {
    res.redirect(doc.fileUrl);
  } else {
    res.status(404).json({ error: "No file data available" });
  }
});

export default router;
