import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, studentsTable, documentsTable, usersTable, agentsTable, applicationsTable, applicationStageDocumentsTable, notesTable, followUpsTable, leadsTable, invoicesTable, commissionsTable, serviceFeesTable, settingsTable, softDelete, studentEducationRecordsTable, educationRecordsTable, lifecycleCascadeStateTable } from "@workspace/db";
import { eq, ilike, or, sql, and, lt, lte, gte, desc, asc, inArray, isNotNull, ne } from "drizzle-orm";
import { requireAuth, requireRole, requireAgentStaffPermission, logAudit } from "../lib/auth";
import { STAFF_ROLES, ADMIN_ROLES, AGENT_ROLES, isAgentRole } from "../lib/roles";
import { getAgentVisibleIds, getAgentRecord } from "../lib/agentVisibility";
import { getAssignmentVisibility, getEffectivePermissionSet, canAccessAssignedRecord, userHasPermission } from "../lib/permissions";
import { cascadeStudentAssignment } from "../lib/leadAssignment";
import { resolveAgentCommission } from "../lib/agentCommission";
import { getAgencyMemberAgentIds } from "../lib/agencyStaff";
import { getVisibleBranchIds, isInBranchScope, resolveCreateBranchId } from "../lib/branchScope";
import { assertCanAccessStudent } from "../lib/studentAccess";
import { streamDocumentToResponse } from "../lib/documentBytes";
import { isNull } from "drizzle-orm";
import { normalizeAndValidateNames, normalizePhoneField, EXTENDED_NAME_FIELDS, toLatinUpper } from "../lib/textNormalize";
import { dispatchNotification } from "../lib/notificationDispatcher";
import { inferOriginFromUser, inferOriginFromAgentId, type OriginMeta } from "../lib/originHelper";
import { toE164 } from "../lib/inbox/phone";
import { rejectInvalidPhone } from "../lib/phoneValidation";
import { parsePaginationParams, buildPageMeta } from "@workspace/pagination";
import { buildStableSignedStudentPhotoThumbnailPath, verifyStudentPhotoSignature } from "@workspace/portal-adapters";
import bcrypt from "bcryptjs";
import { deleteSessionsForUser } from "../lib/replitAuth";
import { getCurrentSeason } from "../lib/season";
import { enqueueOnStageChange, resolvePortalRouting } from "../lib/portalAutoTrigger.js";
import { computeReadiness } from "../lib/portalReadiness";
import {
  cleanStudentEducationRecords,
  toLegacyEducationRecord,
} from "../lib/studentEducationInput";
import { resolveResidenceAddress } from "../lib/studentAddressDefaults";
import {
  buildStudentEducationRecordsFromLegacy,
  hydrateStudentEducationRecords,
} from "../lib/studentEducationHydration";
import {
  maybeTriggerAutoEducationExtractForStudent,
  resolveAppliedLevelKey,
} from "../lib/educationAutoExtract";
import { authorizeStudentCreationSourceLead } from "../lib/studentCreationSource";
import { validatePassportNumber } from "@workspace/portal-adapters/identity-validation";
import { validateStudentCreateFields } from "../lib/studentCreateValidation";
import { recordRequestSpan } from "../lib/requestTelemetry";
import { buildFacetFilterInput, loadFacetValue } from "../lib/facetCache";
import { getStudentPhotoThumbnail } from "../lib/studentPhotoThumbnail";
import { studentHasServablePhotoSql } from "../lib/studentPhoto";

const router: IRouter = Router();

const STUDENT_PATCH_FIELDS = [
  "firstName", "lastName", "email", "phone", "nationality",
  "dateOfBirth", "passportNumber", "passportIssueDate", "passportExpiry",
  "motherName", "fatherName", "address", "cityOfBirth", "addressCity", "postalCode", "needsVisaSupport", "gender",
  "status", "agentId", "assignedToId", "userId", "notes",
  "highSchool", "graduationYear", "gpa", "languageScore",
  "universityBachelor", "universityMaster",
  "photoUrl", "nextFollowup", "interestedLevel",
  "transferStudent", "hasTcId", "hasBlueCard",
];

function addDateRangeCondition(conditions: any[], column: any, range?: string): void {
  if (!range || range === "all") return;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (range === "today") conditions.push(and(gte(column, today), lt(column, tomorrow))!);
  else if (range === "yesterday") {
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    conditions.push(and(gte(column, yesterday), lt(column, today))!);
  } else if (range === "last7") {
    const start = new Date(today);
    start.setDate(start.getDate() - 7);
    conditions.push(gte(column, start));
  } else if (range === "thisMonth") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    conditions.push(and(gte(column, start), lt(column, end))!);
  } else if (range === "thisYear") {
    const start = new Date(now.getFullYear(), 0, 1);
    const end = new Date(now.getFullYear() + 1, 0, 1);
    conditions.push(and(gte(column, start), lt(column, end))!);
  }
}

router.get("/students/me", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const [student] = await db.select().from(studentsTable).where(and(eq(studentsTable.userId, userId), isNull(studentsTable.deletedAt)));
  if (!student) { res.status(404).json({ error: "Student profile not found" }); return; }
  res.json(student);
});

// Task #187 — list every open missing-doc request across all of the
// signed-in student's applications, with stage/university/program context
// for the student portal "Bekleyen Talepler" section.
router.get("/students/me/missing-docs", requireAuth, async (req, res): Promise<void> => {
  const user = req.user!;
  if (user.role !== "student") {
    res.status(403).json({ error: "Only students can call this endpoint" });
    return;
  }
  const { db, applicationStageDocumentsTable, applicationsTable, studentsTable: stdT, universitiesTable, programsTable, pipelineStagesTable } = await import("@workspace/db");
  const { eq, and, isNull, desc, sql } = await import("drizzle-orm");

  const [studentRec] = await db.select({ id: stdT.id }).from(stdT).where(eq(stdT.userId, user.id));
  if (!studentRec) { res.json([]); return; }

  const rows = await db
    .select({
      id: applicationStageDocumentsTable.id,
      applicationId: applicationStageDocumentsTable.applicationId,
      stage: applicationStageDocumentsTable.stage,
      stageLabel: pipelineStagesTable.label,
      fileName: applicationStageDocumentsTable.fileName,
      isCustom: applicationStageDocumentsTable.isCustom,
      note: applicationStageDocumentsTable.note,
      fulfilledAt: applicationStageDocumentsTable.fulfilledAt,
      respondedAt: applicationStageDocumentsTable.respondedAt,
      createdAt: applicationStageDocumentsTable.createdAt,
      uploadedByName: applicationStageDocumentsTable.uploadedByName,
      universityName: universitiesTable.name,
      programName: programsTable.name,
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
      eq(applicationsTable.studentId, studentRec.id),
      isNull(applicationsTable.deletedAt),
      eq(applicationStageDocumentsTable.isMissingDocNote, true),
      isNull(applicationStageDocumentsTable.fulfilledAt),
    ))
    .orderBy(desc(applicationStageDocumentsTable.createdAt));

  // Task #187 contract — explicit names (documentType / customTitle /
  // requestedAt / requestedBy) alongside raw fields for BC.
  const shaped = rows.map((r: any) => ({
    ...r,
    documentType: r.isCustom ? null : r.fileName,
    customTitle: r.isCustom ? r.fileName : null,
    requestedAt: r.createdAt,
    requestedBy: r.uploadedByName,
  }));
  res.json(shaped);
});

router.get("/students/my-advisor", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const [student] = await db.select().from(studentsTable).where(and(eq(studentsTable.userId, userId), isNull(studentsTable.deletedAt)));
  if (!student) { res.status(404).json({ error: "Student profile not found" }); return; }
  if (!student.assignedToId) { res.json(null); return; }
  const [advisor] = await db
    .select({
      id: usersTable.id,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      email: usersTable.email,
      phone: usersTable.phone,
      role: usersTable.role,
      avatarUrl: usersTable.avatarUrl,
    })
    .from(usersTable)
    .where(eq(usersTable.id, student.assignedToId));
  if (!advisor) { res.json(null); return; }
  res.json(advisor);
});

router.put("/students/me", requireAuth, async (req, res): Promise<void> => {
  if (req.user!.role !== "student") { res.status(403).json({ error: "Students only" }); return; }
  const userId = req.user!.id;
  const SELF_FIELDS = [
    "firstName", "lastName", "phone", "nationality",
    "dateOfBirth", "passportNumber", "passportIssueDate", "passportExpiry",
    "motherName", "fatherName", "address", "cityOfBirth", "addressCity", "postalCode", "needsVisaSupport", "gender",
    "highSchool", "universityBachelor", "universityMaster",
    "graduationYear", "gpa", "languageScore",
  ];
  const data: Record<string, unknown> = {};
  for (const k of SELF_FIELDS) {
    if (req.body[k] !== undefined) data[k] = req.body[k];
  }
  const { error: meNameErr, normalized: normData } = normalizeAndValidateNames(data, EXTENDED_NAME_FIELDS);
  if (meNameErr) { res.status(400).json({ error: meNameErr }); return; }
  if (Object.prototype.hasOwnProperty.call(normData, "phone")) {
    const rawPhone = (normData as any).phone;
    if (rejectInvalidPhone(res, rawPhone)) return;
    (normData as any).phone = rawPhone ? normalizePhoneField(rawPhone) : rawPhone;
    (normData as any).phoneE164 = toE164((normData as any).phone);
  }
  Object.assign(data, normData);

  const [existing] = await db.select().from(studentsTable).where(eq(studentsTable.userId, userId));
  if (existing) {
    const residence = resolveResidenceAddress({
      address: data.address ?? existing.address,
      addressCity: data.addressCity ?? existing.addressCity,
      postalCode: data.postalCode ?? existing.postalCode,
      nationality: data.nationality ?? existing.nationality,
    });
    data.addressCity = residence.addressCity;
    data.postalCode = residence.postalCode;
    const [updated] = await db.update(studentsTable).set(data).where(eq(studentsTable.id, existing.id)).returning();
    res.json(updated);
  } else {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    const residence = resolveResidenceAddress(data);
    const [created] = await db.insert(studentsTable).values({
      userId,
      firstName: (data.firstName as string) || user.firstName || "",
      lastName: (data.lastName as string) || user.lastName || "",
      email: user.email || "",
      ...data,
      addressCity: residence.addressCity,
      postalCode: residence.postalCode,
    }).returning();
    res.json(created);
  }
});

// Photo access guard: allow either a normal authenticated session OR a valid
// HMAC-signed, short-lived query signature (`?exp=&sig=`). The signed variant
// lets external create webhooks (e.g. SIT n8n) fetch a student's photo without a
// session cookie — most photos are base64 in the DB with no public object URL.
function photoAccessGuard(req: Request, res: Response, next: NextFunction): void {
  const studentId = parseInt(String(req.params.id), 10);
  const exp = Number(req.query.exp);
  const sig = typeof req.query.sig === "string" ? req.query.sig : "";
  if (sig && verifyStudentPhotoSignature(studentId, exp, sig)) {
    (req as Request & { __photoSignedAccess?: boolean }).__photoSignedAccess = true;
    next();
    return;
  }
  requireAuth(req, res, next);
}

router.get("/students/:id/photo", photoAccessGuard, async (req, res): Promise<void> => {
  const studentId = parseInt(String(req.params.id), 10);
  if (!(req as Request & { __photoSignedAccess?: boolean }).__photoSignedAccess) {
    const access = await assertCanAccessStudent(req, studentId);
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  }
  const [photoDoc] = await db.select({
      fileKey: documentsTable.fileKey,
      fileData: documentsTable.fileData,
      fileUrl: documentsTable.fileUrl,
      mimeType: documentsTable.mimeType,
    })
    .from(documentsTable)
    .where(and(eq(documentsTable.studentId, studentId), or(eq(documentsTable.type, "photo"), eq(documentsTable.type, "photograph")), isNull(documentsTable.deletedAt)))
    .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id))
    .limit(1);
  if (!photoDoc || (!photoDoc.fileKey && !photoDoc.fileData && !photoDoc.fileUrl)) {
    res.status(404).json({ error: "No photo" }); return;
  }
  // fileUrl-only documents (no object-storage key): redirect the browser so it
  // fetches the file directly.  Only allow http/https to prevent SSRF via
  // data: or file: URIs.
  if (!photoDoc.fileKey && !photoDoc.fileData) {
    const url = photoDoc.fileUrl!;
    if (!/^https?:\/\//i.test(url)) {
      res.status(422).json({ error: "Invalid photo URL" }); return;
    }
    res.redirect(302, url);
    return;
  }
  // Use private caching so a shared proxy cannot serve one user's photo to
  // another user who happens to request the same URL.
  res.set("Cache-Control", "private, max-age=300");
  try {
    const sent = await streamDocumentToResponse(photoDoc, res);
    if (!sent && !res.headersSent) res.status(404).json({ error: "No photo" });
  } catch (err) {
    console.error(`[STUDENTS] photo stream for #${studentId} failed:`, err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to load photo" });
  }
});

router.get("/students/:id/photo/thumbnail", photoAccessGuard, async (req, res): Promise<void> => {
  const studentId = parseInt(String(req.params.id), 10);
  if (!(req as Request & { __photoSignedAccess?: boolean }).__photoSignedAccess) {
    const access = await assertCanAccessStudent(req, studentId);
    if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  }
  const [photoDoc] = await db.select({
      id: documentsTable.id,
      fileKey: documentsTable.fileKey,
      fileData: documentsTable.fileData,
      fileUrl: documentsTable.fileUrl,
      mimeType: documentsTable.mimeType,
      createdAt: documentsTable.createdAt,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(documentsTable)
    .innerJoin(studentsTable, eq(documentsTable.studentId, studentsTable.id))
    .where(and(
      eq(documentsTable.studentId, studentId),
      or(eq(documentsTable.type, "photo"), eq(documentsTable.type, "photograph")),
      isNull(documentsTable.deletedAt),
    ))
    .orderBy(desc(documentsTable.createdAt), desc(documentsTable.id))
    .limit(1);
  if (!photoDoc || (!photoDoc.fileKey && !photoDoc.fileData && !photoDoc.fileUrl)) {
    res.status(404).json({ error: "No photo" }); return;
  }

  const etag = `\"student-photo-thumb-${photoDoc.id}\"`;
  if (req.headers["if-none-match"] === etag) {
    res.status(304).end();
    return;
  }
  try {
    const thumbnail = await getStudentPhotoThumbnail(
      `${photoDoc.id}:${photoDoc.createdAt?.getTime() || 0}`,
      photoDoc,
      `${photoDoc.firstName} ${photoDoc.lastName}`,
    );
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Content-Length", String(thumbnail.buffer.length));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.setHeader("ETag", etag);
    res.setHeader("X-Thumbnail-Cache", thumbnail.cacheStatus);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(thumbnail.buffer);
  } catch (err) {
    console.error(`[STUDENTS] photo thumbnail for #${studentId} failed:`, err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to create photo thumbnail" });
  }
});

router.get("/students", requireAuth, requireRole(...STAFF_ROLES, "student", ...AGENT_ROLES), requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const user = req.user!;
  const query = req.query as Record<string, string>;
  const includeFacets = query.includeFacets !== "0";
  const {
    agentId, status, search, season, originType: originFilter,
    appSource, assignment, nationality, name, email, passport,
    dateRange, followupRange, sortKey = "date", sortDir = "desc",
  } = query;
  const pageParams = parsePaginationParams(req, { defaultLimit: 20, maxLimit: 5000 });
  const pageNum = pageParams.page;
  const limitNum = pageParams.limit;
  const offset = pageParams.offset;

  const conditions = [isNull(studentsTable.deletedAt)];
  const scopeResolveStartedAt = process.hrtime.bigint();
  let agentVisibleIds: number[] | null = null;
  let permissionKeys: string[] | null = null;
  let assignmentVisibility: string | null = null;
  let agencyAgentIds: number[] = [];
  let visibleBranchIds: number[] | null = null;

  if (season) conditions.push(eq(studentsTable.season, season));
  if (isAgentRole(user.role)) {
    agentVisibleIds = await getAgentVisibleIds(user.id, user.role);
    if (agentVisibleIds.length === 0) {
      res.json({ data: [], meta: { total: 0, page: pageNum, limit: limitNum, totalPages: 0 } });
      return;
    }
    conditions.push(inArray(studentsTable.agentId, agentVisibleIds));
  } else if (user.role === "student") {
    conditions.push(eq(studentsTable.userId, user.id));
  } else if (!(ADMIN_ROLES as readonly string[]).includes(user.role)) {
    // Non-admin staff: visibility driven by records.* keys. Always see own
    // records; view_unassigned adds the unassigned pool; view_others adds
    // teammates' records. Plus (Task #128) students of an agency where the
    // user is listed as assigned staff are always visible.
    const perms = await getEffectivePermissionSet(user);
    permissionKeys = [...perms].sort();
    assignmentVisibility = getAssignmentVisibility(perms);
    if (assignmentVisibility !== "all") {
      agencyAgentIds = await getAgencyMemberAgentIds(user.id);
      const orParts: any[] = assignmentVisibility === "assigned"
        ? [isNotNull(studentsTable.assignedToId)]
        : [eq(studentsTable.assignedToId, user.id)];
      if (assignmentVisibility === "own_or_unassigned") {
        orParts.push(isNull(studentsTable.assignedToId));
      }
      if (agencyAgentIds.length > 0) {
        orParts.push(inArray(studentsTable.agentId, agencyAgentIds));
      }
      conditions.push(or(...orParts)!);
    }
  }
  // Branch scoping (super_admin: null = all). Applies to staff AND agents.
  // Null-branch students (created via public apply popup, embed widgets) are
  // visible to any branch-scoped user so they can be claimed and assigned.
  if (user.role !== "student") {
    visibleBranchIds = await getVisibleBranchIds(user.id, user.role, user);
    if (visibleBranchIds !== null) {
      if (visibleBranchIds.length === 0) {
        conditions.push(isNull(studentsTable.branchId));
      } else {
        conditions.push(or(inArray(studentsTable.branchId, visibleBranchIds), isNull(studentsTable.branchId))!);
      }
    }
  }
  recordRequestSpan("scopeResolve", Number(process.hrtime.bigint() - scopeResolveStartedAt) / 1_000_000);
  const facetScope = {
    userId: user.id,
    role: user.role,
    permissions: permissionKeys,
    assignmentVisibility,
    visibleBranchIds: visibleBranchIds ? [...visibleBranchIds].sort((a, b) => a - b) : visibleBranchIds,
    agentVisibleIds: agentVisibleIds ? [...agentVisibleIds].sort((a, b) => a - b) : null,
    agencyAgentIds: [...agencyAgentIds].sort((a, b) => a - b),
  };
  if (search) {
    const rawTerm = search.trim();
    const translitTerm = toLatinUpper(rawTerm);
    const terms = Array.from(new Set([rawTerm, translitTerm].filter(Boolean)));
    const tokens = translitTerm.split(/\s+/).filter(Boolean);
    const orParts: any[] = [];
    for (const t of terms) {
      orParts.push(
        ilike(studentsTable.firstName, `%${t}%`),
        ilike(studentsTable.lastName, `%${t}%`),
        ilike(studentsTable.email, `%${t}%`),
        ilike(studentsTable.phone, `%${t}%`),
        ilike(studentsTable.passportNumber, `%${t}%`),
        sql`(coalesce(${studentsTable.firstName},'') || ' ' || coalesce(${studentsTable.lastName},'')) ILIKE ${'%' + t + '%'}`,
        sql`(coalesce(${studentsTable.lastName},'') || ' ' || coalesce(${studentsTable.firstName},'')) ILIKE ${'%' + t + '%'}`,
      );
    }
    if (tokens.length > 1) {
      // Çok-kelimeli aramada her token'ı KELİME SINIRINDA eşleştir.
      // Aksi halde "murat vural" araması "MURATL VURAL"ı da getirir.
      const esc = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
      orParts.push(and(
        ...tokens.map((tok: string) => {
          const pat = `\\m${esc(tok)}\\M`;
          return or(
            sql`${studentsTable.firstName} ~* ${pat}`,
            sql`${studentsTable.lastName} ~* ${pat}`,
          )!;
        })
      )!);
    }
    conditions.push(or(...orParts)!);
  }

  if (status && status !== "all") conditions.push(eq(studentsTable.status, status));
  if (agentId && agentId !== "all" && user.role !== "student") {
    if (agentId === "none") conditions.push(isNull(studentsTable.agentId));
    else {
      const parsed = parseInt(agentId, 10);
      if (Number.isFinite(parsed)) conditions.push(eq(studentsTable.agentId, parsed));
    }
  }
  if (originFilter && originFilter !== "all" && ["direct", "agent", "sub_agent"].includes(originFilter)) {
    conditions.push(eq(studentsTable.originType, originFilter));
  }
  if (appSource === "agent") conditions.push(isNotNull(studentsTable.agentId));
  else if (appSource === "staff") conditions.push(isNull(studentsTable.agentId));
  if (assignment === "mine") conditions.push(eq(studentsTable.assignedToId, user.id));
  else if (assignment === "unassigned") conditions.push(isNull(studentsTable.assignedToId));
  else if (assignment === "mine_unassigned") {
    conditions.push(or(eq(studentsTable.assignedToId, user.id), isNull(studentsTable.assignedToId))!);
  } else if (assignment && assignment !== "all") {
    const parsed = parseInt(assignment, 10);
    if (Number.isFinite(parsed)) conditions.push(eq(studentsTable.assignedToId, parsed));
  }
  if (nationality && nationality !== "all") conditions.push(eq(studentsTable.nationality, nationality));
  if (name) {
    const term = `%${name.trim()}%`;
    conditions.push(or(
      ilike(studentsTable.firstName, term),
      ilike(studentsTable.lastName, term),
      sql`(coalesce(${studentsTable.firstName},'') || ' ' || coalesce(${studentsTable.lastName},'')) ILIKE ${term}`,
    )!);
  }
  if (email) conditions.push(ilike(studentsTable.email, `%${email.trim()}%`));
  if (passport) conditions.push(ilike(studentsTable.passportNumber, `%${passport.trim()}%`));
  addDateRangeCondition(conditions, studentsTable.createdAt, dateRange);
  if (followupRange && followupRange !== "all") {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const nextWeek = new Date(today);
    nextWeek.setDate(nextWeek.getDate() + 7);
    if (followupRange === "none") conditions.push(isNull(studentsTable.nextFollowup));
    else if (followupRange === "today") conditions.push(and(gte(studentsTable.nextFollowup, today), lt(studentsTable.nextFollowup, tomorrow))!);
    else if (followupRange === "upcoming7") conditions.push(and(gte(studentsTable.nextFollowup, today), lte(studentsTable.nextFollowup, nextWeek))!);
    else if (followupRange === "overdue") conditions.push(lt(studentsTable.nextFollowup, today));
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

  const sortColumns: Record<string, any> = {
    name: sql`lower(coalesce(${studentsTable.firstName}, '') || ' ' || coalesce(${studentsTable.lastName}, ''))`,
    email: studentsTable.email,
    nationality: studentsTable.nationality,
    status: studentsTable.status,
    passport: studentsTable.passportNumber,
    date: studentsTable.createdAt,
  };
  const orderColumn = sortColumns[sortKey] || studentsTable.createdAt;
  const order = sortDir === "asc" ? asc(orderColumn) : desc(orderColumn);

  const facetRowsPromise = includeFacets
    ? loadFacetValue({
        namespace: "students-list",
        scope: facetScope,
        filters: buildFacetFilterInput(query),
        load: async () => {
          const [statusRows, nationalityRows, agentRows] = await Promise.all([
            db.select({ status: studentsTable.status, count: sql<number>`count(*)` })
              .from(studentsTable).where(whereClause).groupBy(studentsTable.status),
            db.selectDistinct({ value: studentsTable.nationality })
              .from(studentsTable).where(and(whereClause, isNotNull(studentsTable.nationality))).orderBy(studentsTable.nationality),
            db.selectDistinct({ id: agentsTable.id, name: agentsTable.companyName })
              .from(studentsTable).innerJoin(agentsTable, eq(studentsTable.agentId, agentsTable.id))
              .where(whereClause).orderBy(agentsTable.companyName),
          ]);
          return { statusRows, nationalityRows, agentRows };
        },
      })
    : Promise.resolve({
        statusRows: [] as Array<{ status: string; count: number }>,
        nationalityRows: [] as Array<{ value: string | null }>,
        agentRows: [] as Array<{ id: number | null; name: string | null }>,
      });

  const [countRows, rows, facetRows] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(studentsTable).where(whereClause),
    db
    .select({
      student: studentsTable,
      agentName: agentsTable.companyName,
      studentHasPhoto: studentHasServablePhotoSql(),
    })
    .from(studentsTable)
    .leftJoin(agentsTable, eq(studentsTable.agentId, agentsTable.id))
    .where(whereClause)
    .limit(limitNum)
    .offset(offset)
    .orderBy(order, desc(studentsTable.id)),
    facetRowsPromise,
  ]);
  const { statusRows, nationalityRows, agentRows } = facetRows;
  const count = countRows[0]?.count ?? 0;

  const data = rows.map(r => ({
    ...r.student,
    agentName: r.agentName || null,
    hasPhoto: !!r.studentHasPhoto,
    photoUrl: r.studentHasPhoto ? buildStableSignedStudentPhotoThumbnailPath(r.student.id) : null,
  }));

  res.json({
    data,
    meta: {
      total: Number(count),
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(Number(count) / limitNum),
      ...(includeFacets ? {
        statusCounts: Object.fromEntries(statusRows.map((row) => [row.status, Number(row.count)])),
        facets: {
          nationalities: nationalityRows.map((row) => row.value).filter(Boolean),
          agents: agentRows.filter((row) => row.id != null && row.name).map((row) => ({ id: row.id, name: row.name })),
        },
      } : {}),
    },
  });
});

router.post("/students", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const {
    firstName, lastName, status = "active",
    email, phone, nationality,
    dateOfBirth, gender, passportNumber, passportIssueDate, passportExpiry,
    motherName, fatherName, address, cityOfBirth, addressCity, postalCode, needsVisaSupport,
    agentId, userId, notes,
    highSchool, graduationYear, gpa, languageScore, season,
    interestedLevel,
    educationRecords: rawEducationRecords,
    sourceLeadId: rawSourceLeadId,
  } = req.body;
  const user = req.user!;
  const normalizedPassportNumber = passportNumber == null
    ? ""
    : String(passportNumber).trim();

  if (!firstName || !lastName) {
    res.status(400).json({ error: "firstName and lastName are required" });
    return;
  }
  const createValidationIssues = validateStudentCreateFields(req.body);
  if (createValidationIssues.length > 0) {
    res.status(422).json({
      error: createValidationIssues[0].message,
      code: "STUDENT_CREATE_VALIDATION_FAILED",
      fields: createValidationIssues,
    });
    return;
  }
  if (
    normalizedPassportNumber &&
    validatePassportNumber(normalizedPassportNumber)
  ) {
    res.status(422).json({
      error: "Passport number is not valid. Enter only the number printed on the passport; quotation marks are not allowed.",
      code: "PASSPORT_NUMBER_INVALID",
    });
    return;
  }
  if (
    needsVisaSupport !== undefined &&
    needsVisaSupport !== null &&
    typeof needsVisaSupport !== "boolean"
  ) {
    res.status(400).json({ error: "needsVisaSupport must be boolean or null" });
    return;
  }
  const { error: nameErr, normalized: normBody } = normalizeAndValidateNames(
    { firstName, lastName, motherName, fatherName, highSchool, address,
      universityBachelor: req.body.universityBachelor, universityMaster: req.body.universityMaster },
    EXTENDED_NAME_FIELDS,
  );
  if (nameErr) { res.status(400).json({ error: nameErr }); return; }

  const educationInput = rawEducationRecords === undefined
    ? { ok: true as const, records: [] }
    : cleanStudentEducationRecords(rawEducationRecords);
  if (!educationInput.ok) {
    res.status(400).json({ error: educationInput.error });
    return;
  }
  const resolvedEducationRecords = buildStudentEducationRecordsFromLegacy(
    interestedLevel || "Bachelor",
    {
      highSchool: normBody.highSchool,
      universityBachelor: normBody.universityBachelor,
      universityMaster: normBody.universityMaster,
      graduationYear,
      gpa,
      languageScore,
    },
    educationInput.records,
  );
  const residence = resolveResidenceAddress({
    address: normBody.address,
    addressCity,
    postalCode,
    nationality,
  });

  let sourceLead: {
    id: number;
    branchId: number | null;
    assignedToId: number | null;
    agentId: number | null;
    season: string;
    convertedStudentId: number | null;
    originType: string;
    originEntityType: string | null;
    originEntityId: number | null;
    originDisplayName: string | null;
  } | null = null;
  if (rawSourceLeadId !== undefined && rawSourceLeadId !== null) {
    const sourceLeadId = Number(rawSourceLeadId);
    if (!Number.isInteger(sourceLeadId) || sourceLeadId < 1) {
      res.status(400).json({ error: "sourceLeadId must be a positive integer" });
      return;
    }

    [sourceLead] = await db
      .select({
        id: leadsTable.id,
        branchId: leadsTable.branchId,
        assignedToId: leadsTable.assignedToId,
        agentId: leadsTable.agentId,
        season: leadsTable.season,
        convertedStudentId: leadsTable.convertedStudentId,
        originType: leadsTable.originType,
        originEntityType: leadsTable.originEntityType,
        originEntityId: leadsTable.originEntityId,
        originDisplayName: leadsTable.originDisplayName,
      })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, sourceLeadId), isNull(leadsTable.deletedAt)));

    if (!sourceLead) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    if (sourceLead.convertedStudentId != null) {
      res.status(409).json({
        error: "This lead has already been converted to a student",
        studentId: sourceLead.convertedStudentId,
      });
      return;
    }

    const actorIsAgent = isAgentRole(user.role);
    const actorIsAdmin = (ADMIN_ROLES as readonly string[]).includes(user.role);
    const visibleAgentIds = actorIsAgent
      ? await getAgentVisibleIds(user.id, user.role)
      : [];
    const permissionSet = !actorIsAgent && !actorIsAdmin
      ? await getEffectivePermissionSet(user)
      : new Set<string>();
    const [agentStaffUser] = user.role === "agent_staff"
      ? await db
          .select({ agentStaffPermissions: usersTable.agentStaffPermissions })
          .from(usersTable)
          .where(eq(usersTable.id, user.id))
      : [null];
    const access = authorizeStudentCreationSourceLead({
      actorUserId: user.id,
      actorIsAdmin,
      actorIsAgent,
      actorIsAgentStaff: user.role === "agent_staff",
      agentStaffCanAccessLeads:
        user.role !== "agent_staff" ||
        ((agentStaffUser?.agentStaffPermissions as string[] | null) ?? []).includes("leads"),
      visibleAgentIds,
      canViewOthers: permissionSet.has("records.view_others"),
      sourceLeadAgentId: sourceLead.agentId,
      sourceLeadAssignedToId: sourceLead.assignedToId,
      sourceLeadWithinBranchScope: await isInBranchScope(
        user.id,
        user.role,
        sourceLead.branchId,
        user,
      ),
    });
    if (!access.allowed) {
      res.status(access.status).json({ error: access.error });
      return;
    }
  }

  if (normalizedPassportNumber) {
    const [dupPassport] = await db.select({ id: studentsTable.id }).from(studentsTable)
      .where(and(eq(studentsTable.passportNumber, normalizedPassportNumber), isNull(studentsTable.deletedAt)));
    if (dupPassport) {
      res.status(409).json({ error: "A student with this passport number already exists" });
      return;
    }
  }

  let resolvedAgentId = sourceLead?.agentId ?? agentId ?? null;
  if (isAgentRole(req.user!.role)) {
    const agentRec = await getAgentRecord(req.user!.id, req.user!.role);
    if (!agentRec) {
      res.status(403).json({ error: "No agent record found" });
      return;
    }
    resolvedAgentId = agentRec.id;
  }

  if (email) {
    const normalizedEmail = email.toLowerCase().trim();
    const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail));
    if (existingUser && existingUser.role !== "student") {
      res.status(409).json({ error: "This email is already in use by a staff/admin account. Same email cannot be used across different roles." });
      return;
    }
    const [existingStudent] = await db.select().from(studentsTable).where(and(eq(studentsTable.email, normalizedEmail), isNull(studentsTable.deletedAt)));
    if (existingStudent) {
      res.status(409).json({ error: "A student with this email already exists" });
      return;
    }
  }

  if (rejectInvalidPhone(res, phone)) return;
  const origin = sourceLead
    ? {
        originType: sourceLead.originType || "direct",
        originEntityType: sourceLead.originEntityType,
        originEntityId: sourceLead.originEntityId,
        originDisplayName: sourceLead.originDisplayName || "Find And Study",
        originLocked: true,
        originLeadId: sourceLead.id,
      }
    : resolvedAgentId
      ? await inferOriginFromAgentId(resolvedAgentId)
      : await inferOriginFromUser(user);
  const inheritedBranchId = sourceLead
    ? sourceLead.branchId
    : await resolveCreateBranchId(user.id, user.role, req.body.branchId ?? null, user);
  if (inheritedBranchId == null && !sourceLead && user.role !== "super_admin" && user.role !== "student" && !isAgentRole(user.role)) {
    res.status(403).json({ error: "No accessible branch — cannot create student" });
    return;
  }
  const resolvedSeason = season || sourceLead?.season || (await getCurrentSeason());
  const student = await db.transaction(async (tx) => {
    const [insertedStudent] = await tx.insert(studentsTable).values({
      branchId: inheritedBranchId,
      firstName: normBody.firstName as string, lastName: normBody.lastName as string, status,
      email: email ? email.toLowerCase().trim() : null,
      phone: phone ? normalizePhoneField(phone) : null,
      phoneE164: toE164(phone ? normalizePhoneField(phone) : null),
      nationality: nationality || null,
      dateOfBirth: dateOfBirth || null,
      gender: gender || null,
      passportNumber: normalizedPassportNumber || null,
      passportIssueDate: passportIssueDate || null,
      passportExpiry: passportExpiry || null,
      motherName: normBody.motherName ? (normBody.motherName as string) : null,
      fatherName: normBody.fatherName ? (normBody.fatherName as string) : null,
      address: normBody.address ? (normBody.address as string) : null,
      cityOfBirth: typeof cityOfBirth === "string" && cityOfBirth.trim() ? cityOfBirth.trim() : null,
      addressCity: residence.addressCity,
      postalCode: residence.postalCode,
      needsVisaSupport: typeof needsVisaSupport === "boolean" ? needsVisaSupport : null,
      agentId: resolvedAgentId,
      assignedToId: sourceLead?.assignedToId ?? null,
      userId: userId || null,
      notes: notes || null,
      highSchool: normBody.highSchool ? (normBody.highSchool as string) : null,
      universityBachelor: normBody.universityBachelor ? (normBody.universityBachelor as string) : null,
      universityMaster: normBody.universityMaster ? (normBody.universityMaster as string) : null,
      graduationYear: graduationYear ? parseInt(String(graduationYear), 10) : null,
      gpa: gpa || null,
      languageScore: languageScore || null,
      interestedLevel: interestedLevel || null,
      season: resolvedSeason,
      ...origin,
    }).returning();

    if (resolvedEducationRecords.length > 0) {
      await tx.insert(studentEducationRecordsTable).values(
        resolvedEducationRecords.map(({ country: _country, ...record }) => ({
          ...record,
          studentId: insertedStudent.id,
        })),
      );
      await tx.insert(educationRecordsTable).values(
        resolvedEducationRecords.map((record) =>
          toLegacyEducationRecord(insertedStudent.id, record),
        ),
      );
    }
    return insertedStudent;
  });

  await logAudit(req.user!.id, "create_student", "student", student.id, { firstName, lastName }, req.ip);

  dispatchNotification({
    actorUserId: req.user!.id,
    event: "student.created",
    title: "New Student Registered",
    body: `${student.firstName} ${student.lastName} has been registered as a new student.`,
    actionUrl: `/staff/students/${student.id}`,
    icon: "GraduationCap",
    templateVars: { firstName: student.firstName, lastName: student.lastName, email: student.email || "", nationality: student.nationality || "" },
  }).catch(() => {});

  res.status(201).json(student);
});

router.post("/students/bulk", requireAuth, requireRole(...STAFF_ROLES, "agent" as any), async (req, res): Promise<void> => {
  const { students } = req.body as { students: any[] };
  if (!Array.isArray(students) || students.length === 0) {
    res.status(400).json({ error: "students array is required" });
    return;
  }

  const bulkUser = req.user!;
  const bulkOrigin = await inferOriginFromUser({ role: bulkUser.role, id: bulkUser.id, managingAgentId: (bulkUser as any).managingAgentId });
  const inserted: any[] = [];
  const errors: any[] = [];

  for (let i = 0; i < students.length; i++) {
    const s = students[i];
    if (!s.firstName || !s.lastName) {
      errors.push({ index: i, error: "firstName and lastName are required", row: s });
      continue;
    }
    const { error: bNameErr, normalized: ns } = normalizeAndValidateNames(s, EXTENDED_NAME_FIELDS);
    if (bNameErr) {
      errors.push({ index: i, error: bNameErr, row: s });
      continue;
    }
    const normBulkPhone = s.phone ? normalizePhoneField(s.phone) : null;
    const residence = resolveResidenceAddress({
      address: (ns.address as string) || s.address,
      addressCity: s.addressCity,
      postalCode: s.postalCode,
      nationality: s.nationality,
    });
    try {
      const [student] = await db.insert(studentsTable).values({
        firstName: ns.firstName as string,
        lastName: ns.lastName as string,
        status: s.status || "active",
        email: s.email || null,
        phone: normBulkPhone,
        phoneE164: toE164(normBulkPhone),
        nationality: s.nationality || null,
        dateOfBirth: s.dateOfBirth || null,
        gender: s.gender || null,
        passportNumber: s.passportNumber || null,
        passportIssueDate: s.passportIssueDate || null,
        passportExpiry: s.passportExpiry || null,
        motherName: ns.motherName ? (ns.motherName as string) : null,
        fatherName: ns.fatherName ? (ns.fatherName as string) : null,
        address: (ns.address as string) || s.address || null,
        addressCity: residence.addressCity,
        postalCode: residence.postalCode,
        notes: s.notes || null,
        highSchool: (ns.highSchool as string) || s.highSchool || null,
        graduationYear: s.graduationYear ? parseInt(String(s.graduationYear), 10) : null,
        gpa: s.gpa || null,
        languageScore: s.languageScore || null,
        ...bulkOrigin,
      }).returning();
      inserted.push(student);
    } catch (err: any) {
      errors.push({ index: i, error: err.message, row: s });
    }
  }

  await logAudit(req.user!.id, "bulk_create_students", "student", undefined, { count: inserted.length }, req.ip);
  res.status(201).json({ inserted, errors, total: students.length, success: inserted.length });
});

router.get("/students/:id", requireAuth, requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const access = await assertCanAccessStudent(req, id);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  const residence = resolveResidenceAddress(access.student);
  res.json({ ...access.student, ...residence });
});

// --- Education records (FAZ 2) -------------------------------------------
const EDUCATION_LEVELS = ["high_school", "bachelor", "master"] as const;

router.get("/students/:id/education", requireAuth, requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const access = await assertCanAccessStudent(req, id);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  const records = await db.select().from(studentEducationRecordsTable)
    .where(and(eq(studentEducationRecordsTable.studentId, id), isNull(studentEducationRecordsTable.deletedAt)))
    .orderBy(asc(studentEducationRecordsTable.sortOrder), asc(studentEducationRecordsTable.id));
  const levelKey =
    (await resolveAppliedLevelKey(id)) ||
    access.student.interestedLevel ||
    "Bachelor";
  const hydrated = hydrateStudentEducationRecords(
    levelKey,
    access.student,
    records,
  );
  res.json({ records: hydrated });
});

// --- Portal Uyumluluk Katmanı Faz 3 — soft readiness gate (read-only) -----
router.get("/students/:id/portal-readiness", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const access = await assertCanAccessStudent(req, id);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  const portal = String(req.query.portal || "sit").trim().toLowerCase() || "sit";

  // Readiness badges are application-scoped. A student must not inherit the
  // historical default SIT badge merely because SIT is the default query
  // parameter. Resolve each current application through the exact same dynamic
  // membership/standalone routing used by Portal Automation, so changing an
  // active portal university or multi-portal membership is reflected here
  // without a code change or hardcoded university list.
  const applicationTargets = await db
    .select({
      id: applicationsTable.id,
      universityId: applicationsTable.universityId,
      universityName: applicationsTable.universityName,
    })
    .from(applicationsTable)
    .where(and(
      eq(applicationsTable.studentId, id),
      isNull(applicationsTable.deletedAt),
    ));
  const routedTargets = await Promise.all(
    applicationTargets.map(async (application) => ({
      applicationId: application.id,
      routing: await resolvePortalRouting({
        universityId: application.universityId,
        universityName: application.universityName,
      }),
    })),
  );
  const applicableApplicationIds = routedTargets
    .filter(({ routing }) => {
      const portalUniversity = routing?.portalUni;
      if (!portalUniversity) return false;
      return [
        portalUniversity.universityKey,
        portalUniversity.adapterKey,
        portalUniversity.routesVia,
      ]
        .filter(Boolean)
        .some((key) => String(key).trim().toLowerCase() === portal);
    })
    .map(({ applicationId }) => applicationId);

  if (applicableApplicationIds.length === 0) {
    res.json({
      applicable: false,
      supported: true,
      ready: true,
      portal,
      level: null,
      missing: [],
      incompatible: [],
      skipped: [],
      applicationIds: [],
    });
    return;
  }

  const [eduRecords, docs] = await Promise.all([
    db.select().from(educationRecordsTable).where(eq(educationRecordsTable.studentId, id)),
    db.select({ type: documentsTable.type }).from(documentsTable)
      .where(and(eq(documentsTable.studentId, id), isNull(documentsTable.deletedAt))),
  ]);
  const readiness = computeReadiness(access.student, eduRecords, portal, docs.map((d) => d.type));
  res.json({
    ...readiness,
    applicable: true,
    applicationIds: applicableApplicationIds,
  });
});

router.put("/students/:id/education", requireAuth, requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const access = await assertCanAccessStudent(req, id);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }

  const rawRecords = (req.body as any)?.records;
  if (!Array.isArray(rawRecords)) {
    res.status(400).json({ error: "records must be an array" });
    return;
  }
  const s = (v: any, max: number) => (v === undefined || v === null || v === "") ? null : String(v).slice(0, max);
  const seenLevels = new Set<string>();
  const cleaned: Array<{
    level: string; institution: string | null; program: string | null;
    graduationYear: number | null; gpa: string | null; gpaRaw: string | null;
    gpaScale: number | null; languageScore: string | null; sortOrder: number;
  }> = [];
  for (let i = 0; i < rawRecords.length; i++) {
    const r = rawRecords[i] || {};
    const level = String(r.level || "");
    if (!(EDUCATION_LEVELS as readonly string[]).includes(level)) {
      res.status(400).json({ error: `records[${i}].level must be one of: ${EDUCATION_LEVELS.join(", ")}` });
      return;
    }
    if (seenLevels.has(level)) {
      res.status(400).json({ error: `Duplicate level "${level}" — only one record per level is allowed` });
      return;
    }
    seenLevels.add(level);
    const gy = r.graduationYear != null && r.graduationYear !== "" ? parseInt(String(r.graduationYear), 10) : null;
    const gs = r.gpaScale != null && r.gpaScale !== "" ? parseInt(String(r.gpaScale), 10) : null;
    cleaned.push({
      level,
      institution: s(r.institution, 300),
      program: level === "high_school" ? null : s(r.program, 300),
      graduationYear: Number.isFinite(gy as number) ? gy : null,
      gpa: s(r.gpa, 20),
      gpaRaw: s(r.gpaRaw, 50),
      gpaScale: Number.isFinite(gs as number) ? gs : null,
      languageScore: s(r.languageScore, 50),
      sortOrder: i,
    });
  }

  // Replace-set semantics in one transaction: soft-delete current set, insert new.
  const inserted = await db.transaction(async (tx) => {
    await tx.update(studentEducationRecordsTable)
      .set({ deletedAt: new Date() })
      .where(and(eq(studentEducationRecordsTable.studentId, id), isNull(studentEducationRecordsTable.deletedAt)));
    if (cleaned.length === 0) return [];
    return tx.insert(studentEducationRecordsTable)
      .values(cleaned.map((r) => ({ ...r, studentId: id })))
      .returning();
  });

  await logAudit(req.user!.id, "student.education_updated", "student", id, { levels: cleaned.map((r) => r.level) }, req.ip);
  res.json({ records: inserted });
});

router.patch("/students/:id", requireAuth, requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const role = req.user!.role;
  const isStaff = (STAFF_ROLES as readonly string[]).includes(role);
  const isAgent = isAgentRole(role);
  const isStudent = role === "student";
  if (!isStaff && !isAgent && !isStudent) { res.status(403).json({ error: "Forbidden" }); return; }

  const [existing] = await db.select().from(studentsTable).where(and(eq(studentsTable.id, id), isNull(studentsTable.deletedAt)));
  if (!existing) { res.status(404).json({ error: "Student not found" }); return; }

  if (isStudent) {
    if (existing.userId !== req.user!.id) {
      res.status(403).json({ error: "You can only edit your own record" }); return;
    }
  } else if (isAgent) {
    const visibleAgentIds = await getAgentVisibleIds(req.user!.id, role);
    if (visibleAgentIds.length === 0) { res.status(403).json({ error: "Agent profile not found" }); return; }
    if (!existing.agentId || !visibleAgentIds.includes(existing.agentId)) {
      res.status(403).json({ error: "You can only edit your own students" }); return;
    }
  }

  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(role);
  const perms = isAgent || isStudent || isAdmin
    ? new Set<string>()
    : await getEffectivePermissionSet(req.user!);

  if (!isStudent && !isAgent && !isAdmin) {
    if (!canAccessAssignedRecord(perms, existing.assignedToId, req.user!.id)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  }

  const STUDENT_SELF_FIELDS = [
    "firstName", "lastName", "phone", "nationality",
    "dateOfBirth", "passportNumber", "passportIssueDate", "passportExpiry",
    "motherName", "fatherName", "address", "cityOfBirth", "addressCity", "postalCode", "needsVisaSupport", "gender",
    "highSchool", "universityBachelor", "universityMaster",
    "graduationYear", "gpa", "languageScore", "photoUrl",
  ];
  let allowedFields = isStudent
    ? STUDENT_SELF_FIELDS
    : isAgent
    ? STUDENT_PATCH_FIELDS.filter(f => f !== "agentId" && f !== "userId" && f !== "assignedToId" && f !== "status")
    : STUDENT_PATCH_FIELDS;
  // Agent student-status change is governed by the
  // applications.change_student_app_stage permission (Task #564 — replaces the
  // old agentCanChangeStudentAppStage Settings toggle). Agents resolve their
  // effective permission set here since `perms` is empty for the agent branch.
  if (isAgent && req.body.status !== undefined) {
    const agentPerms = await getEffectivePermissionSet(req.user!);
    if (agentPerms.has("applications.change_student_app_stage")) {
      allowedFields = [...allowedFields, "status"];
    }
  }
  if (!isAdmin && !isAgent && !isStudent && !perms.has("students.change_stage")) {
    allowedFields = allowedFields.filter(f => f !== "status");
  }
  if (!isAdmin && !isAgent && !isStudent && req.body.assignedToId !== undefined) {
    // Task #494: strict rule — non-admin may only change assignment when they ARE the current assignee.
    // Exception (Task #507): self-claim of an unassigned record is allowed.
    // Exception: users with records.change_assigned permission may reassign any record.
    const isSelfClaim = existing.assignedToId === null && req.body.assignedToId === req.user!.id;
    const canChangeAssigned = perms.has("records.change_assigned");
    if (!isSelfClaim && !canChangeAssigned && existing.assignedToId !== req.user!.id) {
      res.status(403).json({ error: "Only the current assignee or an admin can change assignment" });
      return;
    }
  }
  const updates: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  if (isAdmin && req.body.originType !== undefined) {
    const validOrigin = ["direct", "agent", "sub_agent"];
    if (validOrigin.includes(req.body.originType)) {
      updates["originType"] = req.body.originType;
      updates["originEntityType"] = req.body.originEntityType ?? null;
      updates["originEntityId"] = req.body.originEntityId ?? null;
      updates["originDisplayName"] = req.body.originDisplayName ?? null;
      updates["originLocked"] = true;
    }
  }
  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }
  if (
    updates.needsVisaSupport !== undefined &&
    updates.needsVisaSupport !== null &&
    typeof updates.needsVisaSupport !== "boolean"
  ) {
    res.status(400).json({ error: "needsVisaSupport must be boolean or null" });
    return;
  }
  for (const key of ["cityOfBirth", "addressCity", "postalCode"] as const) {
    if (typeof updates[key] === "string") {
      updates[key] = (updates[key] as string).trim() || null;
    }
  }
  if (
    ["address", "addressCity", "postalCode", "nationality"].some((key) =>
      Object.prototype.hasOwnProperty.call(updates, key),
    )
  ) {
    const residence = resolveResidenceAddress({
      address: updates.address ?? existing.address,
      addressCity: updates.addressCity ?? existing.addressCity,
      postalCode: updates.postalCode ?? existing.postalCode,
      nationality: updates.nationality ?? existing.nationality,
    });
    updates.addressCity = residence.addressCity;
    updates.postalCode = residence.postalCode;
  }
  if (updates.email && typeof updates.email === "string") {
    const normalizedEmail = (updates.email as string).toLowerCase().trim();
    updates.email = normalizedEmail;
    const [dupEmail] = await db.select({ id: studentsTable.id }).from(studentsTable)
      .where(and(eq(studentsTable.email, normalizedEmail), isNull(studentsTable.deletedAt)));
    if (dupEmail && dupEmail.id !== id) {
      res.status(409).json({ error: "A student with this email already exists" });
      return;
    }
  }
  if (Object.prototype.hasOwnProperty.call(updates, "passportNumber")) {
    const normPassport = updates.passportNumber == null
      ? ""
      : String(updates.passportNumber).trim();
    if (normPassport && validatePassportNumber(normPassport)) {
      res.status(422).json({
        error: "Passport number is not valid. Enter only the number printed on the passport; quotation marks are not allowed.",
        code: "PASSPORT_NUMBER_INVALID",
      });
      return;
    }
    updates.passportNumber = normPassport || null;
    if (normPassport) {
      const [dupPassport] = await db.select({ id: studentsTable.id }).from(studentsTable)
        .where(and(eq(studentsTable.passportNumber, normPassport), isNull(studentsTable.deletedAt)));
      if (dupPassport && dupPassport.id !== id) {
        res.status(409).json({ error: "A student with this passport number already exists" });
        return;
      }
    }
  }
  const { error: nameErr, normalized: normUpdates } = normalizeAndValidateNames(
    updates, EXTENDED_NAME_FIELDS
  );
  if (nameErr) { res.status(400).json({ error: nameErr }); return; }
  if (Object.prototype.hasOwnProperty.call(normUpdates, "phone")) {
    const rawPhone = (normUpdates as any).phone;
    if (rejectInvalidPhone(res, rawPhone)) return;
    (normUpdates as any).phone = rawPhone ? normalizePhoneField(rawPhone) : rawPhone;
    (normUpdates as any).phoneE164 = toE164((normUpdates as any).phone);
  }
  const studentAssignmentChanged =
    Object.prototype.hasOwnProperty.call(normUpdates, "assignedToId") &&
    existing.assignedToId !== normUpdates.assignedToId;
  const canCascadeAssignment = studentAssignmentChanged
    ? await userHasPermission({ id: req.user!.id, role }, "records.cascade_assignment")
    : false;
  const studentStatusChanged = Object.prototype.hasOwnProperty.call(normUpdates, "status") && existing.status !== normUpdates.status;
  const student = studentAssignmentChanged || studentStatusChanged
    ? await db.transaction(async (tx) => {
        const [updatedStudent] = await tx.update(studentsTable).set(normUpdates).where(eq(studentsTable.id, id)).returning();
        if (!updatedStudent) return null;
        if (studentStatusChanged) {
          await tx.delete(lifecycleCascadeStateTable).where(and(
            eq(lifecycleCascadeStateTable.entityType, "student"),
            eq(lifecycleCascadeStateTable.entityId, id),
          ));
        }
        if (studentAssignmentChanged && (canCascadeAssignment || updatedStudent.assignedToId !== null)) {
          await cascadeStudentAssignment({
            studentId: id,
            newAssignedToId: updatedStudent.assignedToId,
            actorUserId: req.user!.id,
            ipAddress: req.ip,
            nullFillOnly: !canCascadeAssignment,
            throwOnError: true,
            executor: tx,
          });
        }
        return updatedStudent;
      })
    : (await db.update(studentsTable).set(normUpdates).where(eq(studentsTable.id, id)).returning())[0];
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }
  const studentDiff: Record<string, any> = {};
  for (const k of Object.keys(normUpdates)) {
    if (k === "phoneE164") continue;
    const oldVal = (existing as any)[k];
    const newVal = (normUpdates as any)[k];
    const oldNorm = oldVal instanceof Date ? oldVal.toISOString() : oldVal;
    const newNorm = newVal instanceof Date ? newVal.toISOString() : newVal;
    if (oldNorm !== newNorm) {
      studentDiff[k] = { from: oldVal ?? null, to: newVal ?? null };
    }
  }
  await logAudit(req.user!.id, "update_student", "student", id, Object.keys(studentDiff).length ? studentDiff : updates, req.ip);

  if (
    Object.prototype.hasOwnProperty.call(normUpdates, "interestedLevel") &&
    student.interestedLevel !== existing.interestedLevel
  ) {
    maybeTriggerAutoEducationExtractForStudent({
      studentId: id,
      actorUserId: req.user!.id,
      ip: req.ip,
    });
  }

  // T4: Cross-sync contact info back to source lead(s) (best-effort)
  const studentSyncFields: Record<string, unknown> = {};
  for (const f of ["firstName", "lastName", "email", "phone", "phoneE164", "nationality"]) {
    if (Object.prototype.hasOwnProperty.call(normUpdates, f)) {
      studentSyncFields[f] = (normUpdates as any)[f];
    }
  }
  if (Object.keys(studentSyncFields).length > 0) {
    try {
      await db.update(leadsTable).set(studentSyncFields).where(eq(leadsTable.convertedStudentId, id));
    } catch (err) {
      console.warn("[student->lead sync] failed:", err);
    }
  }

  // Cascade assignment up to the source lead(s) and across the student's
  // applications so the same person shows one owner across Leads, Students and
  // Applications. With `records.cascade_assignment` permission: OVERWRITES all.
  // Without it: null-fill only — fills unassigned sibling records automatically.
  if (updates.status && updates.status !== existing.status) {
    // Event-driven portal enqueue: student stage changed — check all their
    // applications immediately instead of waiting for the batch scan.
    void enqueueOnStageChange({
      studentId:   id,
      newStage:    String(updates.status),
      actorUserId: req.user!.id,
    });

    const recipientIds: number[] = [];
    if (student.assignedToId) recipientIds.push(student.assignedToId);
    if (student.userId) recipientIds.push(student.userId);
    try {
      await dispatchNotification({
        actorUserId: req.user!.id,
        event: "student.status_changed",
        title: "Student Status Changed",
        body: `Student ${student.firstName} ${student.lastName} status changed from "${existing.status}" to "${updates.status}".`,
        actionUrl: `/staff/students/${student.id}`,
        icon: "UserCheck",
        recipientUserIds: recipientIds.length > 0 ? recipientIds : undefined,
        templateVars: { firstName: student.firstName, lastName: student.lastName, oldStatus: existing.status || "", newStatus: String(updates.status) },
      });
    } catch (err) {
      console.error("[STUDENTS] status_changed dispatch error:", err);
    }
  }

  if (updates.assignedToId && updates.assignedToId !== existing.assignedToId) {
    dispatchNotification({
    actorUserId: req.user!.id,
      event: "student.assigned",
      title: "Student Assigned to You",
      body: `Student ${student.firstName} ${student.lastName} has been assigned to you.`,
      actionUrl: `/staff/students/${student.id}`,
      icon: "UserCheck",
      recipientUserIds: [updates.assignedToId as number],
      templateVars: { firstName: student.firstName, lastName: student.lastName },
    }).catch(() => {});
  }

  if (updates.agentId !== undefined && updates.agentId !== existing.agentId) {
    if (updates.agentId) {
      dispatchNotification({
    actorUserId: req.user!.id,
        event: "student.agent_linked",
        title: "Student Linked to Agent",
        body: `Student ${student.firstName} ${student.lastName} has been linked to an agent.`,
        actionUrl: `/staff/students/${student.id}`,
        icon: "Building2",
        recipientUserIds: student.assignedToId ? [student.assignedToId] : undefined,
        templateVars: { firstName: student.firstName, lastName: student.lastName },
      }).catch(() => {});
    } else {
      dispatchNotification({
    actorUserId: req.user!.id,
        event: "student.agent_unlinked",
        title: "Student Unlinked from Agent",
        body: `Student ${student.firstName} ${student.lastName} has been unlinked from their agent.`,
        actionUrl: `/staff/students/${student.id}`,
        icon: "Unlink",
        recipientUserIds: student.assignedToId ? [student.assignedToId] : undefined,
        templateVars: { firstName: student.firstName, lastName: student.lastName },
      }).catch(() => {});
    }
  }

  res.json(student);
});

// Transfer a student (and its full ownership chain) from the acting parent agent
// to one of the agent's OWN sub-agents. The parent keeps its commission share —
// resolveAgentCommission recomputes each commission row so commission.agentId
// stays the PARENT (parentAmount) and subAgentId/subAmount go to the sub-agent.
// Only a parent agent ("agent" role, no parentAgentId) may call this.
router.post("/students/:id/transfer-to-sub-agent", requireAuth, requireRole("agent"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const subAgentId = parseInt(String(req.body?.subAgentId), 10);
  if (isNaN(subAgentId)) { res.status(400).json({ error: "subAgentId is required" }); return; }

  const actingAgent = await getAgentRecord(req.user!.id, req.user!.role);
  if (!actingAgent) { res.status(403).json({ error: "Agent profile not found" }); return; }
  // A sub-agent cannot itself transfer students (no second tier exists).
  if (actingAgent.parentAgentId) { res.status(403).json({ error: "Sub-agents cannot transfer students" }); return; }

  const [existing] = await db.select().from(studentsTable).where(and(eq(studentsTable.id, id), isNull(studentsTable.deletedAt)));
  if (!existing) { res.status(404).json({ error: "Student not found" }); return; }

  // IDOR: the student must currently be inside the acting agent's own tree
  // (the agent itself or one of its own sub-agents).
  const visibleIds = await getAgentVisibleIds(req.user!.id, req.user!.role);
  if (!existing.agentId || !visibleIds.includes(existing.agentId)) {
    res.status(403).json({ error: "You can only transfer your own students" }); return;
  }

  // IDOR: the destination must be one of THIS agent's own sub-agents.
  const [target] = await db.select().from(agentsTable)
    .where(and(eq(agentsTable.id, subAgentId), eq(agentsTable.parentAgentId, actingAgent.id), isNull(agentsTable.deletedAt)));
  if (!target) { res.status(404).json({ error: "Sub-agent not found" }); return; }

  if (existing.agentId === subAgentId) { res.status(400).json({ error: "Student already belongs to this sub-agent" }); return; }

  // Full origin metadata for the destination sub-agent (type + entity + display
  // name). Applied to both student and applications so origin-based filtering
  // and display stay consistent with the new owner. Reads agent rows only.
  const subOrigin = await inferOriginFromAgentId(subAgentId);

  await db.transaction(async (tx) => {
    // 1. Student ownership → sub-agent (full origin reflects the sub-agent tier).
    await tx.update(studentsTable).set({
      agentId: subAgentId,
      originType: subOrigin.originType,
      originEntityType: subOrigin.originEntityType,
      originEntityId: subOrigin.originEntityId,
      originDisplayName: subOrigin.originDisplayName,
    }).where(eq(studentsTable.id, id));

    // 2. Existing applications + their service-fee rows move to the sub-agent.
    const apps = await tx.select({ id: applicationsTable.id }).from(applicationsTable)
      .where(and(eq(applicationsTable.studentId, id), isNull(applicationsTable.deletedAt)));
    const appIds = apps.map(a => a.id);
    if (appIds.length > 0) {
      // agentId AND full origin metadata must move together so origin-based
      // filtering / reporting stays consistent with the new owner (sub-agent).
      await tx.update(applicationsTable).set({
        agentId: subAgentId,
        originType: subOrigin.originType,
        originEntityType: subOrigin.originEntityType,
        originEntityId: subOrigin.originEntityId,
        originDisplayName: subOrigin.originDisplayName,
      }).where(inArray(applicationsTable.id, appIds));
      await tx.update(serviceFeesTable).set({ agentId: subAgentId }).where(inArray(serviceFeesTable.applicationId, appIds));

      // 3. Recompute each commission row through the chain. The university
      //    commission amount is agent-independent and stays as-is; only the
      //    agent/sub-agent split changes. resolveAgentCommission returns the
      //    PARENT as agentId for a sub-agent, so the parent keeps its share.
      const comms = await tx.select().from(commissionsTable).where(inArray(commissionsTable.applicationId, appIds));
      for (const comm of comms) {
        const uniAmt = parseFloat(String(comm.universityCommissionAmount ?? "0")) || 0;
        const recomputed = await resolveAgentCommission(subAgentId, uniAmt);
        // For zero-amount rows resolveAgentCommission returns the passed id with
        // null amounts; force the parent/sub link so ownership stays consistent.
        await tx.update(commissionsTable).set({
          agentId: uniAmt > 0 ? recomputed.agentId : actingAgent.id,
          agentCommissionRate: recomputed.agentCommissionRate,
          agentCommissionAmount: recomputed.agentCommissionAmount,
          subAgentId: uniAmt > 0 ? recomputed.subAgentId : subAgentId,
          subAgentCommissionRate: recomputed.subAgentCommissionRate,
          subAgentCommissionAmount: recomputed.subAgentCommissionAmount,
        }).where(eq(commissionsTable.id, comm.id));
      }
    }

    // 4. Source lead(s) that converted into this student also follow ownership.
    await tx.update(leadsTable).set({ agentId: subAgentId }).where(eq(leadsTable.convertedStudentId, id));
  });

  await logAudit(req.user!.id, "transfer_student_to_sub_agent", "student", id, { fromAgentId: existing.agentId, toAgentId: subAgentId }, req.ip);

  const [updated] = await db.select().from(studentsTable).where(eq(studentsTable.id, id));
  res.json(updated);
});

router.post("/students/bulk-action", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const user = req.user!;
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(user.role);
  const { ids, action, assignedToId, status } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) { res.status(400).json({ error: "ids required" }); return; }
  if (!["delete", "assign", "move"].includes(action)) { res.status(400).json({ error: "Invalid action" }); return; }
  // Task #494: non-admin may only bulk-assign their own records; delete/move remain admin-only
  if (!isAdmin && action !== "assign") {
    res.status(403).json({ error: "Only admins can bulk delete or move students" }); return;
  }
  const numericIds = ids.map(Number).filter((n: number) => !isNaN(n));
  let updated = 0;
  if (action === "delete") {
    const studentsToDelete = await db.select({ id: studentsTable.id, userId: studentsTable.userId }).from(studentsTable).where(and(inArray(studentsTable.id, numericIds), isNull(studentsTable.deletedAt)));
    const deleteIds = studentsToDelete.map(s => s.id);
    if (deleteIds.length > 0) {
      const userIds = studentsToDelete.filter(s => s.userId).map(s => s.userId!);
      await softDeleteStudents(deleteIds, userIds, user.id);
      updated = deleteIds.length;
    }
    for (const id of deleteIds) await logAudit(user.id, "delete_student", "student", id, { soft: true }, req.ip);
  } else if (action === "assign" && assignedToId !== undefined) {
    const newAssignedToId = assignedToId ? Number(assignedToId) : null;
    // Non-admin: filter to only records they are the current assignee of
    let idsToUpdate = numericIds;
    let skipped = 0;
    if (!isAdmin) {
      const ownedRows = await db.select({ id: studentsTable.id })
        .from(studentsTable)
        .where(and(inArray(studentsTable.id, numericIds), eq(studentsTable.assignedToId, user.id), isNull(studentsTable.deletedAt)));
      idsToUpdate = ownedRows.map(r => r.id);
      skipped = numericIds.length - idsToUpdate.length;
      if (idsToUpdate.length === 0) {
        res.json({ success: true, updated: 0, skipped }); return;
      }
    }
    const affected = await db.select({ id: studentsTable.id }).from(studentsTable)
      .where(and(inArray(studentsTable.id, idsToUpdate), isNull(studentsTable.deletedAt)));
    const canCascade = await userHasPermission({ id: user.id, role: user.role }, "records.cascade_assignment");
    updated = await db.transaction(async (tx) => {
      const result = await tx.update(studentsTable).set({ assignedToId: newAssignedToId })
        .where(and(inArray(studentsTable.id, idsToUpdate), isNull(studentsTable.deletedAt)));
      for (const studentRow of affected) {
        if (canCascade || newAssignedToId !== null) {
          await cascadeStudentAssignment({
            studentId: studentRow.id,
            newAssignedToId,
            actorUserId: user.id,
            ipAddress: req.ip,
            nullFillOnly: !canCascade,
            throwOnError: true,
            executor: tx,
          });
        }
      }
      return result.rowCount ?? idsToUpdate.length;
    });
    await logAudit(user.id, "bulk_assign_students", "student", undefined, { ids: idsToUpdate, assignedToId }, req.ip);
    res.json({ success: true, updated, skipped }); return;
  } else if (action === "move" && status) {
    updated = await db.transaction(async (tx) => {
      const result = await tx.update(studentsTable).set({ status })
        .where(and(inArray(studentsTable.id, numericIds), isNull(studentsTable.deletedAt)));
      await tx.delete(lifecycleCascadeStateTable).where(and(
        eq(lifecycleCascadeStateTable.entityType, "student"),
        inArray(lifecycleCascadeStateTable.entityId, numericIds),
      ));
      return result.rowCount ?? numericIds.length;
    });
    await logAudit(user.id, "bulk_move_students", "student", undefined, { ids: numericIds, status }, req.ip);
  } else {
    res.status(400).json({ error: "Missing required fields for action" }); return;
  }
  res.json({ success: true, updated });
});

router.delete("/students/:id", requireAuth, requireRole(...STAFF_ROLES), requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const access = await assertCanAccessStudent(req, id);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  const student = access.student;

  await softDeleteStudents([id], [student.userId].filter(Boolean) as number[], req.user!.id);

  await logAudit(req.user!.id, "delete_student", "student", id, { soft: true }, req.ip);
  res.status(204).end();
});

// Cascade soft-delete: student row, its applications, and its documents (all
// have deletedAt). Linked auth user is deactivated rather than soft-deleted —
// keeps login records and historical author refs valid. Notes / invoices /
// follow_ups don't have deletedAt; they're hidden via the parent.deletedAt
// filter on listing endpoints.
async function softDeleteStudents(studentIds: number[], userIds: number[], actorUserId: number): Promise<void> {
  if (studentIds.length === 0) return;
  await db.transaction(async (tx) => {
    const apps = await tx.select({ id: applicationsTable.id })
      .from(applicationsTable)
      .where(and(inArray(applicationsTable.studentId, studentIds), isNull(applicationsTable.deletedAt)));
    const appIds = apps.map(a => a.id);
    if (appIds.length > 0) {
      await softDelete(applicationsTable, appIds, { actorUserId, tx });
      await tx.update(documentsTable)
        .set({ deletedAt: sql`now()` })
        .where(and(inArray(documentsTable.applicationId, appIds), isNull(documentsTable.deletedAt)));
    }
    await tx.update(documentsTable)
      .set({ deletedAt: sql`now()` })
      .where(and(inArray(documentsTable.studentId, studentIds), isNull(documentsTable.deletedAt)));
    // Archive the complete converted journey. Leaving live leads pointing at a
    // deleted student produced unresolvable inbox/detail state and made a later
    // restore incomplete. Multiple leads per student are all preserved and
    // archived together; no row is hard-deleted.
    const linkedLeads = await tx.select({ id: leadsTable.id }).from(leadsTable)
      .where(and(inArray(leadsTable.convertedStudentId, studentIds), isNull(leadsTable.deletedAt)));
    if (linkedLeads.length > 0) {
      await softDelete(leadsTable, linkedLeads.map((row) => row.id), { actorUserId, tx });
    }
    await softDelete(studentsTable, studentIds, { actorUserId, tx });
    if (userIds.length > 0) {
      await tx.update(usersTable).set({ isActive: false }).where(inArray(usersTable.id, userIds));
    }
  });
}

// Restore only rows archived by the same student-archive transaction. Because
// PostgreSQL now() is transaction-stable, their deleted_at values are exactly
// equal; applications/documents deleted earlier for another reason stay
// archived and are never accidentally resurrected.
router.post("/students/:id/restore", requireAuth, requireRole("super_admin", "admin"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [student] = await db.select().from(studentsTable).where(and(eq(studentsTable.id, id), isNotNull(studentsTable.deletedAt)));
  if (!student?.deletedAt) { res.status(404).json({ error: "Archived student not found" }); return; }

  const restored = await db.transaction(async (tx) => {
    const deletedAt = student.deletedAt!;
    const apps = await tx.select({ id: applicationsTable.id }).from(applicationsTable)
      .where(and(eq(applicationsTable.studentId, id), eq(applicationsTable.deletedAt, deletedAt)));
    const appIds = apps.map((row) => row.id);
    const leads = await tx.select({ id: leadsTable.id }).from(leadsTable)
      .where(and(eq(leadsTable.convertedStudentId, id), eq(leadsTable.deletedAt, deletedAt)));

    if (appIds.length > 0) {
      await tx.update(applicationsTable).set({ deletedAt: null, deletedBy: null }).where(inArray(applicationsTable.id, appIds));
      await tx.update(documentsTable).set({ deletedAt: null }).where(and(
        inArray(documentsTable.applicationId, appIds),
        eq(documentsTable.deletedAt, deletedAt),
      ));
    }
    await tx.update(documentsTable).set({ deletedAt: null }).where(and(
      eq(documentsTable.studentId, id),
      eq(documentsTable.deletedAt, deletedAt),
    ));
    if (leads.length > 0) {
      await tx.update(leadsTable).set({ deletedAt: null, deletedBy: null }).where(inArray(leadsTable.id, leads.map((row) => row.id)));
    }
    await tx.update(studentsTable).set({ deletedAt: null, deletedBy: null }).where(eq(studentsTable.id, id));
    if (student.userId) await tx.update(usersTable).set({ isActive: true }).where(eq(usersTable.id, student.userId));
    return { applications: appIds.length, leads: leads.length };
  });

  await logAudit(req.user!.id, "restore_student_journey", "student", id, restored, req.ip);
  res.json({ success: true, studentId: id, restored });
});

// Hard-delete (purge) — super_admin only. Permanently removes student and all
// associated rows; loses audit/finance history. Use for GDPR-style purges.
router.post("/students/:id/purge", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const [student] = await db.select().from(studentsTable).where(eq(studentsTable.id, id));
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }
  await db.transaction(async (tx) => {
    const apps = await tx.select({ id: applicationsTable.id }).from(applicationsTable).where(eq(applicationsTable.studentId, id));
    const appIds = apps.map(a => a.id);
    if (appIds.length > 0) {
      await tx.delete(notesTable).where(and(inArray(notesTable.resourceId, appIds), eq(notesTable.resourceType, "application")));
      await tx.delete(applicationStageDocumentsTable).where(inArray(applicationStageDocumentsTable.applicationId, appIds));
    }
    await tx.delete(notesTable).where(and(eq(notesTable.resourceId, id), eq(notesTable.resourceType, "student")));
    await tx.delete(documentsTable).where(eq(documentsTable.studentId, id));
    await tx.delete(invoicesTable).where(eq(invoicesTable.studentId, id));
    await tx.delete(followUpsTable).where(eq(followUpsTable.studentId, id));
    await tx.delete(studentsTable).where(eq(studentsTable.id, id));
  });
  await logAudit(req.user!.id, "purge_student", "student", id, { hard: true }, req.ip);
  res.json({ success: true });
});

router.patch("/students/:id/origin", requireAuth, requireRole("super_admin", "admin"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { originType, originEntityType, originEntityId, originDisplayName } = req.body;
  if (!originType || !["direct", "agent", "sub_agent"].includes(originType)) {
    res.status(400).json({ error: "originType must be direct, agent, or sub_agent" });
    return;
  }
  const [existing] = await db.select().from(studentsTable).where(and(eq(studentsTable.id, id), isNull(studentsTable.deletedAt)));
  if (!existing) { res.status(404).json({ error: "Student not found" }); return; }

  const oldOrigin = { originType: existing.originType, originEntityType: existing.originEntityType, originEntityId: existing.originEntityId, originDisplayName: existing.originDisplayName };

  const [updated] = await db.update(studentsTable).set({
    originType,
    originEntityType: originEntityType || null,
    originEntityId: originEntityId || null,
    originDisplayName: originDisplayName || null,
    originLocked: true,
  }).where(eq(studentsTable.id, id)).returning();

  await logAudit(req.user!.id, "override_origin", "student", id, { old: oldOrigin, new: { originType, originEntityType, originEntityId, originDisplayName } }, req.ip);
  res.json(updated);
});

router.post("/students/:id/set-password", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { password } = req.body;
  if (!password || password.length < 6) {
    res.status(400).json({ error: "Password must be at least 6 characters" });
    return;
  }
  const [student] = await db.select().from(studentsTable).where(and(eq(studentsTable.id, id), isNull(studentsTable.deletedAt)));
  if (!student) { res.status(404).json({ error: "Student not found" }); return; }

  const hash = await bcrypt.hash(password, 10);

  if (student.userId) {
    await db.update(usersTable).set({ passwordHash: hash, passwordResetToken: null, passwordResetExpires: null }).where(eq(usersTable.id, student.userId));
    await deleteSessionsForUser(student.userId);
    await logAudit(req.user!.id, "set_password", "student", id, { userId: student.userId }, req.ip);
    res.json({ success: true, userId: student.userId });
  } else {
    if (!student.email) {
      res.status(400).json({ error: "Student has no email address. Please add an email first." });
      return;
    }
    const [existingUser] = await db.select().from(usersTable).where(eq(usersTable.email, student.email));
    if (existingUser) {
      if (existingUser.role !== "student") {
        res.status(409).json({ error: "This email is already in use by a non-student account. Cannot link." });
        return;
      }
      await db.update(usersTable).set({ passwordHash: hash, passwordResetToken: null, passwordResetExpires: null }).where(eq(usersTable.id, existingUser.id));
      await deleteSessionsForUser(existingUser.id);
      await db.update(studentsTable).set({ userId: existingUser.id }).where(eq(studentsTable.id, id));
      await logAudit(req.user!.id, "set_password", "student", id, { userId: existingUser.id, linkedExisting: true }, req.ip);
      res.json({ success: true, userId: existingUser.id });
    } else {
      const [newUser] = await db.insert(usersTable).values({
        email: student.email,
        passwordHash: hash,
        firstName: student.firstName || "",
        lastName: student.lastName || "",
        role: "student",
        isActive: true,
        phone: student.phone || null,
        phoneE164: (student as any).phoneE164 || toE164(student.phone || "") || null,
      }).returning();
      await db.update(studentsTable).set({ userId: newUser.id }).where(eq(studentsTable.id, id));
      await logAudit(req.user!.id, "set_password", "student", id, { userId: newUser.id, createdUser: true }, req.ip);
      res.json({ success: true, userId: newUser.id, userCreated: true });
    }
  }
});

router.get("/students/:id/notes", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES, "student"), requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { page = "1", limit = "50", internal } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const userRole = req.user!.role;
  const isStaff = ["super_admin", "admin", "manager", "staff"].includes(userRole);

  if (userRole === "student") {
    const [student] = await db.select({ id: studentsTable.id }).from(studentsTable)
      .where(and(eq(studentsTable.id, id), eq(studentsTable.userId, req.user!.id), isNull(studentsTable.deletedAt)));
    if (!student) { res.status(403).json({ error: "Access denied" }); return; }
  }

  const conditions = [eq(notesTable.resourceId, id), eq(notesTable.resourceType, "student")];

  if (!isStaff || internal !== "true") {
    conditions.push(eq(notesTable.isInternal, false));
  } else {
    conditions.push(eq(notesTable.isInternal, true));
  }

  const notes = await db
    .select({
      id: notesTable.id,
      content: notesTable.content,
      authorId: notesTable.authorId,
      authorName: sql<string | null>`concat(${usersTable.firstName}, ' ', ${usersTable.lastName})`,
      isInternal: notesTable.isInternal,
      createdAt: notesTable.createdAt,
    })
    .from(notesTable)
    .leftJoin(usersTable, eq(notesTable.authorId, usersTable.id))
    .where(and(...conditions))
    .orderBy(notesTable.createdAt)
    .limit(limitNum)
    .offset(offset);
  res.json(notes);
});

router.post("/students/:id/notes", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { content, isInternal } = req.body;
  if (!content?.trim()) { res.status(400).json({ error: "content is required" }); return; }

  const isStaff = ["super_admin", "admin", "manager", "staff"].includes(req.user!.role);

  const [note] = await db.insert(notesTable).values({
    content: String(content).slice(0, 5000),
    authorId: req.user!.id,
    resourceType: "student",
    resourceId: id,
    isInternal: isStaff && isInternal === true,
  }).returning();

  const [student] = await db.select({
    assignedToId: studentsTable.assignedToId,
    agentId: studentsTable.agentId,
    firstName: studentsTable.firstName,
    lastName: studentsTable.lastName,
  }).from(studentsTable).where(eq(studentsTable.id, id));

  if (student) {
    const recipientIds: number[] = [];
    if (student.assignedToId && student.assignedToId !== req.user!.id) {
      recipientIds.push(student.assignedToId);
    }
    if (student.agentId) {
      const [agent] = await db.select({ userId: agentsTable.userId }).from(agentsTable)
        .where(eq(agentsTable.id, student.agentId));
      if (agent?.userId && agent.userId !== req.user!.id && !recipientIds.includes(agent.userId)) {
        recipientIds.push(agent.userId);
      }
    }
    if (recipientIds.length > 0) {
      dispatchNotification({
    actorUserId: req.user!.id,
        event: "note.created",
        title: "New Note Added",
        body: `A note was added to student ${student.firstName} ${student.lastName}`,
        actionUrl: `/staff/students/${id}`,
        recipientUserIds: recipientIds,
        data: { resourceType: "student", resourceId: id },
      });
    }
  }

  res.status(201).json({ ...note, authorName: `${req.user!.firstName || ""} ${req.user!.lastName || ""}`.trim() });
});

router.delete("/students/:id/notes/:noteId", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const noteId = parseInt(String(req.params.noteId), 10);
  if (isNaN(id) || isNaN(noteId)) { res.status(400).json({ error: "Invalid id" }); return; }

  const [note] = await db.select({
    id: notesTable.id,
    content: notesTable.content,
    authorId: notesTable.authorId,
    isInternal: notesTable.isInternal,
  }).from(notesTable).where(and(
    eq(notesTable.id, noteId),
    eq(notesTable.resourceId, id),
    eq(notesTable.resourceType, "student"),
  ));
  if (!note) { res.status(404).json({ error: "Note not found" }); return; }

  await db.delete(notesTable).where(eq(notesTable.id, noteId));

  await logAudit(req.user!.id, "delete_note", "student", id, {
    noteId,
    isInternal: note.isInternal,
    authorId: note.authorId,
    contentPreview: (note.content || "").slice(0, 200),
  }, req.ip);

  res.status(204).end();
});

router.get("/students/:id/follow-ups", requireAuth, requireRole(...STAFF_ROLES), requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const access = await assertCanAccessStudent(req, id);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  const { page = "1", limit = "50" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(200, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const data = await db
    .select({
      id: followUpsTable.id,
      studentId: followUpsTable.studentId,
      title: followUpsTable.title,
      scheduledAt: followUpsTable.scheduledAt,
      completed: followUpsTable.completed,
      completedAt: followUpsTable.completedAt,
      notes: followUpsTable.notes,
      createdById: followUpsTable.createdById,
      createdByName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', cu.first_name, cu.last_name), '') FROM users cu WHERE cu.id = ${followUpsTable.createdById})`,
      updatedById: followUpsTable.updatedById,
      updatedByName: sql<string | null>`(SELECT NULLIF(CONCAT_WS(' ', uu.first_name, uu.last_name), '') FROM users uu WHERE uu.id = ${followUpsTable.updatedById})`,
      createdAt: followUpsTable.createdAt,
      updatedAt: followUpsTable.updatedAt,
    })
    .from(followUpsTable)
    .where(eq(followUpsTable.studentId, id))
    .orderBy(asc(followUpsTable.scheduledAt))
    .limit(limitNum)
    .offset(offset);
  res.json(data);
});

router.post("/students/:id/follow-ups", requireAuth, requireRole(...STAFF_ROLES), requireAgentStaffPermission("students"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const access = await assertCanAccessStudent(req, id);
  if (!access.ok) { res.status(access.status).json({ error: access.error }); return; }
  const { title, scheduledAt, notes } = req.body;
  if (!title?.trim() || !scheduledAt) {
    res.status(400).json({ error: "title and scheduledAt are required" });
    return;
  }
  const scheduledDate = new Date(scheduledAt);
  if (isNaN(scheduledDate.getTime())) {
    res.status(400).json({ error: "Invalid date" });
    return;
  }
  if (scheduledDate < new Date()) {
    res.status(400).json({ error: "Cannot schedule follow-ups in the past" });
    return;
  }
  const [followUp] = await db.insert(followUpsTable).values({
    studentId: id,
    resourceType: "student",
    title: String(title).slice(0, 500),
    scheduledAt: scheduledDate,
    notes: notes ? String(notes).slice(0, 2000) : null,
    createdById: req.user!.id,
    assignedToId: req.user!.id,
  }).returning();
  await logAudit(req.user!.id, "create_follow_up", "student", id, {
    followUpId: followUp.id,
    title: followUp.title,
    scheduledAt: followUp.scheduledAt instanceof Date ? followUp.scheduledAt.toISOString() : followUp.scheduledAt,
    notes: followUp.notes ? String(followUp.notes).slice(0, 200) : null,
  }, req.ip);
  res.status(201).json(followUp);
});

export default router;
