import { Router, type IRouter, type Request, type Response } from "express";
import { cascadeStudentAssignment } from "../lib/leadAssignment";
import { z } from "zod";
import {
  db,
  usersTable,
  agentsTable,
  studentsTable,
  agencyAssignedStaffTable,
  staffWorkSchedulesTable,
  staffLanguagesTable,
  staffCountriesTable,
  staffDocumentsTable,
  staffSalaryPaymentsTable,
  staffCommissionsTable,
  settingsTable,
  userSessionsTable,
  userPresenceTable,
  STAFF_DOC_TYPES,
  STAFF_DOC_RULES,
  STAFF_SALARY_STATUSES,
  STAFF_COMMISSION_STATUSES,
  STAFF_SALARY_PERIODS,
  type StaffDocType,
} from "@workspace/db";
import { and, eq, gte, lt, lte, sql, desc, isNull, ilike, or, inArray } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { userHasPermission } from "../lib/permissions";
import { ObjectStorageService, ObjectNotFoundError } from "../lib/objectStorage";
import { recompressStoredObjectIfNeeded } from "../lib/documentBytes";
import { UploadTooLargeError } from "../lib/uploads/processUpload";
import { Readable } from "stream";

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

// Sadece super_admin + admin (manager dahil değil — kullanıcı talebi net).
const STAFF_CARD_ADMINS = ["super_admin", "admin"];
const requireStaffCardAdmin = requireRole(...STAFF_CARD_ADMINS);

// ─────────────────────────────────────────────────────────────────────────────
// Liste — staff/manager rolündeki kullanıcılar
// ─────────────────────────────────────────────────────────────────────────────
router.get("/staff-cards", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const { search, role } = req.query as Record<string, string>;
  const conditions = [
    isNull(usersTable.deletedAt),
    inArray(usersTable.role, ["super_admin", "admin", "manager", "staff", "consultant", "editor", "accountant"]),
  ];
  if (role) conditions.push(eq(usersTable.role, role));
  if (search) {
    conditions.push(
      or(
        ilike(usersTable.firstName, `%${search}%`),
        ilike(usersTable.lastName, `%${search}%`),
        ilike(usersTable.email, `%${search}%`)
      )!
    );
  }
  const data = await db
    .select({
      id: usersTable.id,
      email: usersTable.email,
      firstName: usersTable.firstName,
      lastName: usersTable.lastName,
      role: usersTable.role,
      avatarUrl: usersTable.avatarUrl,
      isActive: usersTable.isActive,
      locationCountry: usersTable.locationCountry,
      locationCity: usersTable.locationCity,
      timezone: usersTable.timezone,
      createdAt: usersTable.createdAt,
    })
    .from(usersTable)
    .where(and(...conditions))
    .orderBy(usersTable.firstName, usersTable.lastName)
    .limit(500);
  res.json({ data });
});

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate kart
// ─────────────────────────────────────────────────────────────────────────────
router.get("/staff-cards/me/revenue-month", requireAuth, async (req, res): Promise<void> => {
  const userId = req.user!.id;
  const [settingsRow] = await db.select({ directStudentEnrollmentBonusRate: settingsTable.directStudentEnrollmentBonusRate }).from(settingsTable);
  const rate = Number(settingsRow?.directStudentEnrollmentBonusRate ?? 0) || 0;

  const directStudents = await db.select({ id: studentsTable.id, status: studentsTable.status }).from(studentsTable).where(
    and(eq(studentsTable.assignedToId, userId), eq(studentsTable.originType, "direct"), isNull(studentsTable.agentId), isNull(studentsTable.deletedAt))
  );
  const directIds = directStudents.map(s => s.id);
  let paidComms: { studentId: number | null }[] = [];
  if (directIds.length > 0) {
    paidComms = await db.select({ studentId: staffCommissionsTable.studentId }).from(staffCommissionsTable).where(
      and(eq(staffCommissionsTable.userId, userId), eq(staffCommissionsTable.status, "paid"), inArray(staffCommissionsTable.studentId, directIds))
    );
  }
  const paidStudentIds = new Set(paidComms.map(c => c.studentId).filter((x): x is number => x != null));
  const unpaidEnrolled = directStudents.filter(s => s.status === "enrolled" && !paidStudentIds.has(s.id));
  const potentialBonus = unpaidEnrolled.length * rate;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const pendingSalaries = await db.select({ amount: staffSalaryPaymentsTable.amount, currency: staffSalaryPaymentsTable.currency })
    .from(staffSalaryPaymentsTable)
    .where(and(eq(staffSalaryPaymentsTable.userId, userId), eq(staffSalaryPaymentsTable.status, "pending"), gte(staffSalaryPaymentsTable.payDate, monthStart), lt(staffSalaryPaymentsTable.payDate, monthEnd)));
  const pendingSalaryByCurrency: Record<string, number> = {};
  for (const p of pendingSalaries) {
    const cur = String(p.currency || "USD").toUpperCase();
    pendingSalaryByCurrency[cur] = (pendingSalaryByCurrency[cur] || 0) + (Number(p.amount) || 0);
  }
  res.json({ potentialBonus, bonusRate: rate, pendingSalaryByCurrency, unpaidEnrolledDirectStudents: unpaidEnrolled.length });
});

router.get("/staff-cards/:userId", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  if (Number.isNaN(userId)) { res.status(400).json({ error: "Invalid user id" }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const { passwordHash: _ph, replitId: _ri, passwordResetToken: _prt, emailVerificationToken: _evt, ...safeUser } = user;

  const schedules = await db.select().from(staffWorkSchedulesTable)
    .where(eq(staffWorkSchedulesTable.userId, userId))
    .orderBy(staffWorkSchedulesTable.weekday);

  const languages = await db.select().from(staffLanguagesTable)
    .where(eq(staffLanguagesTable.userId, userId));

  const countries = await db.select().from(staffCountriesTable)
    .where(eq(staffCountriesTable.userId, userId));

  const documents = await db.select({
    id: staffDocumentsTable.id,
    docType: staffDocumentsTable.docType,
    filename: staffDocumentsTable.filename,
    sizeBytes: staffDocumentsTable.sizeBytes,
    mimeType: staffDocumentsTable.mimeType,
    uploadedAt: staffDocumentsTable.uploadedAt,
    uploadedBy: staffDocumentsTable.uploadedBy,
  })
    .from(staffDocumentsTable)
    .where(and(eq(staffDocumentsTable.userId, userId), isNull(staffDocumentsTable.deletedAt)))
    .orderBy(desc(staffDocumentsTable.uploadedAt));

  const assignedAgents = await db.select({
    id: agentsTable.id,
    firstName: agentsTable.firstName,
    lastName: agentsTable.lastName,
    companyName: agentsTable.companyName,
    businessName: agentsTable.businessName,
    email: agentsTable.email,
    isPrimary: agencyAssignedStaffTable.isPrimary,
    assignedAt: agencyAssignedStaffTable.createdAt,
  })
    .from(agencyAssignedStaffTable)
    .innerJoin(agentsTable, eq(agencyAssignedStaffTable.agentId, agentsTable.id))
    .where(and(eq(agencyAssignedStaffTable.userId, userId), isNull(agentsTable.deletedAt)))
    .orderBy(agentsTable.companyName);

  const assignedStudents = await db.select({
    id: studentsTable.id,
    firstName: studentsTable.firstName,
    lastName: studentsTable.lastName,
    email: studentsTable.email,
    status: studentsTable.status,
    season: studentsTable.season,
  })
    .from(studentsTable)
    .where(and(eq(studentsTable.assignedToId, userId), isNull(studentsTable.deletedAt)))
    .orderBy(studentsTable.firstName);

  const salaryPayments = await db.select().from(staffSalaryPaymentsTable)
    .where(eq(staffSalaryPaymentsTable.userId, userId))
    .orderBy(desc(staffSalaryPaymentsTable.payDate));

  const commissions = await db.select().from(staffCommissionsTable)
    .where(eq(staffCommissionsTable.userId, userId))
    .orderBy(desc(staffCommissionsTable.payDate));

  const salaryTotals = salaryPayments.reduce((acc, p) => {
    const amt = Number(p.amount) || 0;
    if (p.status === "paid") acc.paid += amt;
    else if (p.status === "pending") acc.pending += amt;
    return acc;
  }, { paid: 0, pending: 0 });

  const commissionTotals = commissions.reduce((acc, c) => {
    const amt = Number(c.amount) || 0;
    if (c.status === "paid") acc.paid += amt;
    else if (c.status === "pending" || c.status === "approved") acc.pending += amt;
    return acc;
  }, { paid: 0, pending: 0 });

  const [presence] = await db.select().from(userPresenceTable).where(eq(userPresenceTable.userId, userId));

  res.json({
    user: safeUser,
    schedules,
    languages,
    countries,
    documents,
    assignedAgents,
    assignedStudents,
    salaryPayments,
    commissions,
    salaryTotals,
    commissionTotals,
    presence: presence || { status: "offline", lastActiveAt: null },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Profil — lokasyon/timezone/baz alanlar
// ─────────────────────────────────────────────────────────────────────────────
const profileBodySchema = z.object({
  firstName: z.string().trim().min(1).optional(),
  lastName: z.string().trim().min(1).optional(),
  phone: z.string().trim().nullable().optional(),
  startDate: z.string().nullable().optional(),
  homeAddress: z.string().nullable().optional(),
  emergencyContactName: z.string().nullable().optional(),
  emergencyContactPhone: z.string().nullable().optional(),
  locationCountry: z.string().nullable().optional(),
  locationCity: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
});

router.put("/staff-cards/:userId/profile", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const parsed = profileBodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const updates = parsed.data;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields" }); return; }
  const [u] = await db.update(usersTable).set(updates).where(eq(usersTable.id, userId)).returning();
  if (!u) { res.status(404).json({ error: "User not found" }); return; }
  logAudit(req.user!.id, "staff_card.profile.update", "user", userId, updates, req.ip);
  res.json({ success: true });
});


// ─────────────────────────────────────────────────────────────────────────────
// Çalışma saatleri (haftalık takvim)
// ─────────────────────────────────────────────────────────────────────────────
const scheduleEntrySchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startMinutes: z.number().int().min(0).max(24 * 60),
  endMinutes: z.number().int().min(0).max(24 * 60),
}).refine(s => s.endMinutes > s.startMinutes, { message: "endMinutes must be greater than startMinutes" });

router.put("/staff-cards/:userId/schedule", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  if (Number.isNaN(userId)) { res.status(400).json({ error: "Invalid user id" }); return; }
  const parsed = z.object({ entries: z.array(scheduleEntrySchema) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid body" }); return; }
  // Overlap validation per weekday
  const byDay: Record<number, Array<{ s: number; e: number }>> = {};
  for (const e of parsed.data.entries) {
    if (!byDay[e.weekday]) byDay[e.weekday] = [];
    byDay[e.weekday].push({ s: e.startMinutes, e: e.endMinutes });
  }
  for (const wd of Object.keys(byDay)) {
    const ranges = byDay[Number(wd)].sort((a, b) => a.s - b.s);
    for (let i = 1; i < ranges.length; i++) {
      if (ranges[i].s < ranges[i - 1].e) {
        res.status(400).json({ error: `Aynı gün içinde çakışan zaman aralığı (gün ${wd})` });
        return;
      }
    }
  }
  await db.transaction(async (tx) => {
    await tx.delete(staffWorkSchedulesTable).where(eq(staffWorkSchedulesTable.userId, userId));
    if (parsed.data.entries.length > 0) {
      await tx.insert(staffWorkSchedulesTable).values(
        parsed.data.entries.map(e => ({ userId, weekday: e.weekday, startMinutes: e.startMinutes, endMinutes: e.endMinutes }))
      );
    }
  });
  logAudit(req.user!.id, "staff_card.schedule.update", "user", userId, { count: parsed.data.entries.length }, req.ip);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Diller
// ─────────────────────────────────────────────────────────────────────────────
router.put("/staff-cards/:userId/languages", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const parsed = z.object({
    languages: z.array(z.object({
      language: z.string().trim().min(1).max(60),
      proficiency: z.string().trim().max(40).nullable().optional(),
    })),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  await db.transaction(async (tx) => {
    await tx.delete(staffLanguagesTable).where(eq(staffLanguagesTable.userId, userId));
    if (parsed.data.languages.length > 0) {
      await tx.insert(staffLanguagesTable).values(
        parsed.data.languages.map(l => ({ userId, language: l.language, proficiency: l.proficiency || null }))
      );
    }
  });
  logAudit(req.user!.id, "staff_card.languages.update", "user", userId, { count: parsed.data.languages.length }, req.ip);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// İlgilendiği ülkeler (Faz 1 — otomatik sohbet atama motorunun veri temeli)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/staff-cards/:userId/countries", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  if (Number.isNaN(userId)) { res.status(400).json({ error: "Invalid user id" }); return; }
  const rows = await db.select({ country: staffCountriesTable.country }).from(staffCountriesTable)
    .where(eq(staffCountriesTable.userId, userId));
  res.json({ data: rows.map(r => r.country) });
});

router.put("/staff-cards/:userId/countries", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  if (Number.isNaN(userId)) { res.status(400).json({ error: "Invalid user id" }); return; }
  const parsed = z.object({
    countries: z.array(z.string().trim().min(1).max(100)),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const deduped = Array.from(new Set(parsed.data.countries));
  await db.transaction(async (tx) => {
    await tx.delete(staffCountriesTable).where(eq(staffCountriesTable.userId, userId));
    if (deduped.length > 0) {
      await tx.insert(staffCountriesTable).values(
        deduped.map(country => ({ userId, country }))
      );
    }
  });
  logAudit(req.user!.id, "staff_card.countries.update", "user", userId, { count: deduped.length }, req.ip);
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// Belgeler — upload/list/delete/download
// Upload akışı: client önce /storage/uploads/request-url ile presigned URL
// alır, dosyayı oraya PUT eder, sonra bu endpoint'e objectPath + meta
// gönderir. Burada server tarafı format/size validation yapar ve db'ye yazar.
// ─────────────────────────────────────────────────────────────────────────────
const documentRegisterSchema = z.object({
  docType: z.enum(STAFF_DOC_TYPES as unknown as [StaffDocType, ...StaffDocType[]]),
  filename: z.string().trim().min(1).max(255),
  objectPath: z.string().trim().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().trim().min(1).max(100),
});

router.post("/staff-cards/:userId/documents", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const parsed = documentRegisterSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const { docType, filename, objectPath, sizeBytes, mimeType } = parsed.data;
  const rule = STAFF_DOC_RULES[docType];
  if (!rule.mimeTypes.includes(mimeType)) {
    res.status(400).json({ error: `Bu belge tipi için izin verilen formatlar: ${rule.mimeTypes.join(", ")}` });
    return;
  }
  if (sizeBytes > rule.maxBytes) {
    res.status(413).json({ error: `Dosya boyutu ${Math.round(rule.maxBytes / 1024 / 1024)}MB sınırını aşıyor.` });
    return;
  }
  // Enforce staff-documents/{userId}/<id> prefix so private staff docs are
  // stored under their dedicated namespace (per spec).
  const expectedPrefix = `/objects/staff-documents/${userId}/`;
  if (!objectPath.startsWith(expectedPrefix)) {
    res.status(400).json({ error: `Object path must use prefix ${expectedPrefix}` });
    return;
  }
  let finalSizeBytes = sizeBytes;
  let finalMimeType = mimeType;
  try {
    const recompressed = await recompressStoredObjectIfNeeded(objectPath, mimeType);
    if (recompressed?.recompressed) {
      finalSizeBytes = recompressed.sizeBytes;
      finalMimeType = recompressed.mimeType;
    }
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      res.status(413).json({ error: err.message });
      return;
    }
    console.error("[STAFF-CARDS] recompressStoredObjectIfNeeded failed, keeping original:", err);
  }

  const [doc] = await db.insert(staffDocumentsTable).values({
    userId, docType, filename, objectPath, sizeBytes: finalSizeBytes, mimeType: finalMimeType,
    uploadedBy: req.user!.id,
  }).returning();
  logAudit(req.user!.id, "staff_card.document.upload", "user", userId, { docType, filename, sizeBytes }, req.ip);
  const { objectPath: _op, ...safe } = doc;
  res.status(201).json(safe);
});

router.delete("/staff-cards/:userId/documents/:docId", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const docId = parseInt(String(req.params.docId), 10);
  const [doc] = await db.select().from(staffDocumentsTable)
    .where(and(eq(staffDocumentsTable.id, docId), eq(staffDocumentsTable.userId, userId), isNull(staffDocumentsTable.deletedAt)));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
  await db.update(staffDocumentsTable).set({ deletedAt: sql`now()` }).where(eq(staffDocumentsTable.id, docId));
  logAudit(req.user!.id, "staff_card.document.delete", "user", userId, { docId, docType: doc.docType }, req.ip);
  res.sendStatus(204);
});

router.get("/staff-cards/:userId/documents/:docId/download", requireAuth, requireStaffCardAdmin, async (req: Request, res: Response): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const docId = parseInt(String(req.params.docId), 10);
  const [doc] = await db.select().from(staffDocumentsTable)
    .where(and(eq(staffDocumentsTable.id, docId), eq(staffDocumentsTable.userId, userId), isNull(staffDocumentsTable.deletedAt)));
  if (!doc) { res.status(404).json({ error: "Document not found" }); return; }
  try {
    const file = await objectStorage.getObjectEntityFile(doc.objectPath);
    res.setHeader("Content-Disposition", `attachment; filename="${doc.filename.replace(/"/g, "")}"`);
    logAudit(req.user!.id, "staff_card.document.download", "user", userId, { docId, docType: doc.docType }, req.ip);
    await objectStorage.streamObjectToResponse(req, res, file, {
      contentType: doc.mimeType || undefined,
      cacheControl: "private, no-store",
    });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) { res.status(404).json({ error: "File no longer exists in storage" }); return; }
    console.error("[staff-cards] download error:", err);
    res.status(500).json({ error: "Download failed" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Atanmış acenteler — agency_assigned_staff M:N
// ─────────────────────────────────────────────────────────────────────────────
router.post("/staff-cards/:userId/assigned-agents", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const parsed = z.object({ agentId: z.number().int().positive(), isPrimary: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const { agentId, isPrimary } = parsed.data;
  await db.insert(agencyAssignedStaffTable).values({ userId, agentId, isPrimary: !!isPrimary }).onConflictDoNothing();
  logAudit(req.user!.id, "staff_card.assigned_agent.add", "user", userId, { agentId, isPrimary: !!isPrimary }, req.ip);
  res.json({ success: true });
});

router.delete("/staff-cards/:userId/assigned-agents/:agentId", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const agentId = parseInt(String(req.params.agentId), 10);
  await db.delete(agencyAssignedStaffTable)
    .where(and(eq(agencyAssignedStaffTable.userId, userId), eq(agencyAssignedStaffTable.agentId, agentId)));
  logAudit(req.user!.id, "staff_card.assigned_agent.remove", "user", userId, { agentId }, req.ip);
  res.sendStatus(204);
});

// ─────────────────────────────────────────────────────────────────────────────
// Atanmış öğrenciler — students.assigned_to_id
// ─────────────────────────────────────────────────────────────────────────────
router.post("/staff-cards/:userId/assigned-students", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const parsed = z.object({ studentId: z.number().int().positive() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const { studentId } = parsed.data;
  const canCascadeAdd = await userHasPermission({ id: req.user!.id, role: req.user!.role }, "records.cascade_assignment");
  const updated = await db.transaction(async (tx) => {
    const [student] = await tx.update(studentsTable).set({ assignedToId: userId })
      .where(eq(studentsTable.id, studentId)).returning();
    if (!student) return null;
    if (canCascadeAdd) {
      await cascadeStudentAssignment({
        studentId,
        newAssignedToId: userId,
        actorUserId: req.user!.id,
        ipAddress: req.ip,
        executor: tx,
        throwOnError: true,
      });
    }
    return student;
  });
  if (!updated) { res.status(404).json({ error: "Student not found" }); return; }
  logAudit(req.user!.id, "staff_card.assigned_student.add", "user", userId, { studentId }, req.ip);
  res.json({ success: true });
});

router.delete("/staff-cards/:userId/assigned-students/:studentId", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const studentId = parseInt(String(req.params.studentId), 10);
  const canCascadeRemove = await userHasPermission({ id: req.user!.id, role: req.user!.role }, "records.cascade_assignment");
  const changed = await db.transaction(async (tx) => {
    const [student] = await tx.update(studentsTable).set({ assignedToId: null })
      .where(and(eq(studentsTable.id, studentId), eq(studentsTable.assignedToId, userId)))
      .returning({ id: studentsTable.id });
    if (!student) return false;
    if (canCascadeRemove) {
      await cascadeStudentAssignment({
        studentId,
        newAssignedToId: null,
        actorUserId: req.user!.id,
        ipAddress: req.ip,
        executor: tx,
        throwOnError: true,
      });
    }
    return true;
  });
  if (changed) logAudit(req.user!.id, "staff_card.assigned_student.remove", "user", userId, { studentId }, req.ip);
  res.sendStatus(204);
});

// ─────────────────────────────────────────────────────────────────────────────
// Maaş ödemeleri
// ─────────────────────────────────────────────────────────────────────────────
const salaryBodySchema = z.object({
  amount: z.coerce.number().nonnegative(),
  currency: z.string().trim().length(3).default("USD"),
  period: z.enum(STAFF_SALARY_PERIODS as unknown as [string, ...string[]]).default("monthly"),
  payDate: z.string().nullable().optional(),
  status: z.enum(STAFF_SALARY_STATUSES as unknown as [string, ...string[]]).default("pending"),
  notes: z.string().nullable().optional(),
});

router.post("/staff-cards/:userId/salary-payments", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const parsed = salaryBodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid body" }); return; }
  const d = parsed.data;
  const [row] = await db.insert(staffSalaryPaymentsTable).values({
    userId,
    amount: String(d.amount),
    currency: d.currency,
    period: d.period,
    payDate: d.payDate ? new Date(d.payDate) : null,
    status: d.status,
    notes: d.notes || null,
    createdBy: req.user!.id,
  }).returning();
  logAudit(req.user!.id, "staff_card.salary.create", "user", userId, { id: row.id, amount: d.amount, currency: d.currency }, req.ip);
  res.status(201).json(row);
});

router.post("/staff-cards/:userId/salary-payments/bulk", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  if (Number.isNaN(userId)) { res.status(400).json({ error: "Invalid user id" }); return; }
  const bulkSchema = z.object({
    count: z.coerce.number().int().min(1).max(36),
    startDate: z.string().optional(),
    amount: z.coerce.number().positive(),
    currency: z.string().trim().min(2).max(5).default("USD"),
    period: z.string().default("monthly"),
    notes: z.string().nullable().optional(),
  });
  const parsed = bulkSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid body" }); return; }
  const { count, startDate, amount, currency, period, notes } = parsed.data;
  const base = startDate ? new Date(startDate) : new Date();
  base.setDate(1);
  base.setHours(0, 0, 0, 0);
  const rows = Array.from({ length: count }, (_, i) => {
    const d = new Date(base.getFullYear(), base.getMonth() + i, 1);
    return { userId, amount: String(amount), currency: currency.toUpperCase(), period, payDate: d, status: "pending" as const, notes: notes || null, createdBy: req.user!.id };
  });
  const created = await db.insert(staffSalaryPaymentsTable).values(rows).returning();
  logAudit(req.user!.id, "staff_card.salary.bulk_create", "user", userId, { count, amount, currency }, req.ip);
  res.status(201).json({ created: created.length, rows: created });
});

router.patch("/staff-cards/:userId/salary-payments/:id", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const id = parseInt(String(req.params.id), 10);
  const parsed = salaryBodySchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const d = parsed.data;
  const updates: Record<string, unknown> = {};
  if (d.amount !== undefined) updates.amount = String(d.amount);
  if (d.currency !== undefined) updates.currency = d.currency;
  if (d.period !== undefined) updates.period = d.period;
  if (d.payDate !== undefined) updates.payDate = d.payDate ? new Date(d.payDate) : null;
  if (d.status !== undefined) updates.status = d.status;
  if (d.notes !== undefined) updates.notes = d.notes;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields" }); return; }
  const [row] = await db.update(staffSalaryPaymentsTable).set(updates)
    .where(and(eq(staffSalaryPaymentsTable.id, id), eq(staffSalaryPaymentsTable.userId, userId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  logAudit(req.user!.id, "staff_card.salary.update", "user", userId, { id, ...updates }, req.ip);
  res.json(row);
});

router.delete("/staff-cards/:userId/salary-payments/:id", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const id = parseInt(String(req.params.id), 10);
  await db.delete(staffSalaryPaymentsTable)
    .where(and(eq(staffSalaryPaymentsTable.id, id), eq(staffSalaryPaymentsTable.userId, userId)));
  logAudit(req.user!.id, "staff_card.salary.delete", "user", userId, { id }, req.ip);
  res.sendStatus(204);
});

// ─────────────────────────────────────────────────────────────────────────────
// Komisyonlar
// ─────────────────────────────────────────────────────────────────────────────
const commissionBodySchema = z.object({
  amount: z.coerce.number().nonnegative(),
  currency: z.string().trim().length(3).default("USD"),
  studentId: z.number().int().positive().nullable().optional(),
  agentId: z.number().int().positive().nullable().optional(),
  applicationId: z.number().int().positive().nullable().optional(),
  status: z.enum(STAFF_COMMISSION_STATUSES as unknown as [string, ...string[]]).default("pending"),
  payDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
});

router.post("/staff-cards/:userId/commissions", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const parsed = commissionBodySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message || "Invalid body" }); return; }
  const d = parsed.data;
  const [row] = await db.insert(staffCommissionsTable).values({
    userId,
    amount: String(d.amount),
    currency: d.currency,
    studentId: d.studentId ?? null,
    agentId: d.agentId ?? null,
    applicationId: d.applicationId ?? null,
    status: d.status,
    payDate: d.payDate ? new Date(d.payDate) : null,
    notes: d.notes || null,
    createdBy: req.user!.id,
  }).returning();
  logAudit(req.user!.id, "staff_card.commission.create", "user", userId, { id: row.id, amount: d.amount }, req.ip);
  res.status(201).json(row);
});

router.patch("/staff-cards/:userId/commissions/:id", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const id = parseInt(String(req.params.id), 10);
  const parsed = commissionBodySchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid body" }); return; }
  const d = parsed.data;
  const updates: Record<string, unknown> = {};
  if (d.amount !== undefined) updates.amount = String(d.amount);
  if (d.currency !== undefined) updates.currency = d.currency;
  if (d.studentId !== undefined) updates.studentId = d.studentId;
  if (d.agentId !== undefined) updates.agentId = d.agentId;
  if (d.applicationId !== undefined) updates.applicationId = d.applicationId;
  if (d.status !== undefined) updates.status = d.status;
  if (d.payDate !== undefined) updates.payDate = d.payDate ? new Date(d.payDate) : null;
  if (d.notes !== undefined) updates.notes = d.notes;
  if (Object.keys(updates).length === 0) { res.status(400).json({ error: "No fields" }); return; }
  const [row] = await db.update(staffCommissionsTable).set(updates)
    .where(and(eq(staffCommissionsTable.id, id), eq(staffCommissionsTable.userId, userId)))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  logAudit(req.user!.id, "staff_card.commission.update", "user", userId, { id, ...updates }, req.ip);
  res.json(row);
});

router.delete("/staff-cards/:userId/commissions/:id", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  const id = parseInt(String(req.params.id), 10);
  await db.delete(staffCommissionsTable)
    .where(and(eq(staffCommissionsTable.id, id), eq(staffCommissionsTable.userId, userId)));
  logAudit(req.user!.id, "staff_card.commission.delete", "user", userId, { id }, req.ip);
  res.sendStatus(204);
});

// ─────────────────────────────────────────────────────────────────────────────
// Activity raporu — planlanan vs gerçek aktif saat (staff timezone aware)
// Range: daily (last 7 days), weekly (last 4 weeks), monthly (last 12 months grouped by month)
// ─────────────────────────────────────────────────────────────────────────────
function tzOffsetMinutes(date: Date, tz: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = dtf.formatToParts(date);
    const m: Record<string, string> = {};
    for (const p of parts) m[p.type] = p.value;
    const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch { return 0; }
}
function tzDayKey(date: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch { return date.toISOString().slice(0, 10); }
}
function tzDayStartMs(dayKey: string, tz: string): number {
  const [y, mo, d] = dayKey.split("-").map(Number);
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const off = tzOffsetMinutes(new Date(guess), tz);
  return guess - off * 60000;
}
function tzWeekday(date: Date, tz: string): number {
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? 0;
  } catch { return date.getDay(); }
}

router.get("/staff-cards/:userId/activity", requireAuth, requireStaffCardAdmin, async (req, res): Promise<void> => {
  const userId = parseInt(String(req.params.userId), 10);
  if (Number.isNaN(userId)) { res.status(400).json({ error: "Invalid user id" }); return; }
  const range = ((req.query.range as string) || "weekly").toLowerCase();

  // Resolve staff timezone (fallback UTC)
  const [u] = await db.select({ timezone: usersTable.timezone }).from(usersTable).where(eq(usersTable.id, userId));
  const tz = u?.timezone || "UTC";

  let days = 7;
  if (range === "yearly") days = 365;
  else if (range === "monthly") days = 30;
  else if (range === "weekly") days = 7;
  else if (range === "daily") days = 1;

  const now = new Date();
  const todayKey = tzDayKey(now, tz);
  const todayStart = tzDayStartMs(todayKey, tz);
  const fromMs = todayStart - (days - 1) * 24 * 60 * 60 * 1000;
  const dateFrom = new Date(fromMs);

  const schedules = await db.select().from(staffWorkSchedulesTable)
    .where(eq(staffWorkSchedulesTable.userId, userId));
  const scheduleByWeekday: Record<number, Array<{ startMinutes: number; endMinutes: number }>> = {};
  for (const s of schedules) {
    if (!scheduleByWeekday[s.weekday]) scheduleByWeekday[s.weekday] = [];
    scheduleByWeekday[s.weekday].push({ startMinutes: s.startMinutes, endMinutes: s.endMinutes });
  }

  const sessions = await db.select().from(userSessionsTable)
    .where(and(eq(userSessionsTable.userId, userId), gte(userSessionsTable.startedAt, dateFrom)));

  // Per-day breakdown in staff timezone
  const byDay: Record<string, { plannedMinutes: number; actualMinutes: number; outsideMinutes: number; weekday: number }> = {};
  for (let i = 0; i < days; i++) {
    const dayMs = fromMs + i * 24 * 60 * 60 * 1000;
    if (dayMs > now.getTime()) break;
    const key = tzDayKey(new Date(dayMs), tz);
    const wd = tzWeekday(new Date(dayMs + 12 * 60 * 60 * 1000), tz);
    const planned = Math.min(1440, (scheduleByWeekday[wd] || []).reduce((sum, w) => sum + (w.endMinutes - w.startMinutes), 0));
    byDay[key] = { plannedMinutes: planned, actualMinutes: 0, outsideMinutes: 0, weekday: wd };
  }

  // Session window intersection in staff timezone: split each session by tz-day,
  // intersect with that weekday's schedule windows (window minutes are local).
  for (const s of sessions) {
    const startMs = new Date(s.startedAt).getTime();
    const endMs = s.endedAt ? new Date(s.endedAt).getTime()
      : (s.lastSeenAt ? new Date(s.lastSeenAt).getTime() : startMs + (s.totalDurationSeconds || 0) * 1000);
    if (endMs <= startMs) continue;
    const totalMin = (endMs - startMs) / 60000;
    const activeMin = (s.activeDurationSeconds || 0) / 60;
    const activeRatio = totalMin > 0 ? Math.min(1, activeMin / totalMin) : 0;

    let cursorKey = tzDayKey(new Date(startMs), tz);
    const lastKey = tzDayKey(new Date(endMs), tz);
    let safety = 400;
    while (safety-- > 0) {
      const dayStart = tzDayStartMs(cursorKey, tz);
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;
      const segStart = Math.max(startMs, dayStart);
      const segEnd = Math.min(endMs, dayEnd);
      const segMin = (segEnd - segStart) / 60000;
      if (segMin > 0 && byDay[cursorKey]) {
        const wd = byDay[cursorKey].weekday;
        const windows = scheduleByWeekday[wd] || [];
        let inWindowMin = 0;
        for (const w of windows) {
          const wStart = dayStart + w.startMinutes * 60000;
          const wEnd = dayStart + w.endMinutes * 60000;
          const iStart = Math.max(segStart, wStart);
          const iEnd = Math.min(segEnd, wEnd);
          if (iEnd > iStart) inWindowMin += (iEnd - iStart) / 60000;
        }
        const outsideMin = Math.max(0, segMin - inWindowMin);
        byDay[cursorKey].actualMinutes += Math.round(inWindowMin * activeRatio);
        byDay[cursorKey].outsideMinutes += Math.round(outsideMin * activeRatio);
      }
      if (cursorKey === lastKey) break;
      cursorKey = tzDayKey(new Date(dayEnd + 60 * 60 * 1000), tz);
    }
  }

  // Build breakdown — for monthly bucket per month (YYYY-MM); else per day.
  let breakdown: Array<{ day: string; plannedMinutes: number; actualMinutes: number; outsideMinutes: number; missingMinutes: number; overtimeMinutes: number }>;
  if (range === "yearly") {
    const byMonth: Record<string, { plannedMinutes: number; actualMinutes: number; outsideMinutes: number }> = {};
    for (const [day, v] of Object.entries(byDay)) {
      const mk = day.slice(0, 7);
      if (!byMonth[mk]) byMonth[mk] = { plannedMinutes: 0, actualMinutes: 0, outsideMinutes: 0 };
      byMonth[mk].plannedMinutes += v.plannedMinutes;
      byMonth[mk].actualMinutes += v.actualMinutes;
      byMonth[mk].outsideMinutes += v.outsideMinutes;
    }
    breakdown = Object.entries(byMonth).sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({
      day,
      plannedMinutes: v.plannedMinutes,
      actualMinutes: v.actualMinutes,
      outsideMinutes: v.outsideMinutes,
      missingMinutes: Math.max(0, v.plannedMinutes - v.actualMinutes),
      overtimeMinutes: Math.max(0, v.actualMinutes - v.plannedMinutes),
    }));
  } else {
    breakdown = Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b)).map(([day, v]) => ({
      day,
      plannedMinutes: v.plannedMinutes,
      actualMinutes: v.actualMinutes,
      outsideMinutes: v.outsideMinutes,
      missingMinutes: Math.max(0, v.plannedMinutes - v.actualMinutes),
      overtimeMinutes: Math.max(0, v.actualMinutes - v.plannedMinutes),
    }));
  }

  const totals = breakdown.reduce((acc, d) => {
    acc.plannedMinutes += d.plannedMinutes;
    acc.actualMinutes += d.actualMinutes;
    acc.outsideMinutes += d.outsideMinutes;
    acc.missingMinutes += d.missingMinutes;
    acc.overtimeMinutes += d.overtimeMinutes;
    return acc;
  }, { plannedMinutes: 0, actualMinutes: 0, outsideMinutes: 0, missingMinutes: 0, overtimeMinutes: 0 });

  const [presence] = await db.select().from(userPresenceTable).where(eq(userPresenceTable.userId, userId));

  res.json({
    range,
    from: dateFrom.toISOString(),
    breakdown,
    totals,
    lastActiveAt: presence?.lastActiveAt || null,
  });
});

export default router;
