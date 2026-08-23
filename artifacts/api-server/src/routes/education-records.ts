import { Router } from "express";
import { eq, and } from "drizzle-orm";
import { db, educationRecordsTable, studentsTable } from "@workspace/db";
import { requireAuth, requireRole } from "../lib/auth";
import { STAFF_ROLES, ADMIN_ROLES, AGENT_ROLES } from "../lib/roles";
import { buildAgentSourceScope, isAgentSourcedAndBlockedForStaff } from "../lib/rbac/agentSourceScope";

const VALID_LEVELS = new Set(["high_school", "bachelor", "master"]);

const router = Router();

async function assertCanAccessStudent(
  req: any,
  studentId: number,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const user = req.user as { id: number; role: string };
  const [student] = await db
    .select({ id: studentsTable.id, agentId: studentsTable.agentId })
    .from(studentsTable)
    .where(eq(studentsTable.id, studentId));
  if (!student) return { ok: false, status: 404, error: "Student not found" };
  if (isAgentSourcedAndBlockedForStaff(user, student.agentId)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const scope = await buildAgentSourceScope(user, studentsTable.agentId);
  if (scope.empty) return { ok: false, status: 403, error: "Forbidden" };
  return { ok: true };
}

// GET /students/:id/education-records
router.get(
  "/students/:id/education-records",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES, ...AGENT_ROLES),
  async (req, res): Promise<void> => {
    const studentId = parseInt(String(req.params.id), 10);
    if (!Number.isFinite(studentId)) {
      res.status(400).json({ error: "Invalid student id" });
      return;
    }
    const access = await assertCanAccessStudent(req, studentId);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const records = await db
      .select()
      .from(educationRecordsTable)
      .where(eq(educationRecordsTable.studentId, studentId))
      .orderBy(educationRecordsTable.level);
    res.json(records);
  },
);

// PUT /students/:id/education-records/:level — upsert one level
router.put(
  "/students/:id/education-records/:level",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const studentId = parseInt(String(req.params.id), 10);
    const level = String(req.params.level);
    if (!Number.isFinite(studentId)) {
      res.status(400).json({ error: "Invalid student id" });
      return;
    }
    if (!VALID_LEVELS.has(level)) {
      res.status(400).json({ error: `Invalid level — must be one of: ${[...VALID_LEVELS].join(", ")}` });
      return;
    }
    const access = await assertCanAccessStudent(req, studentId);
    if (!access.ok) {
      res.status(access.status).json({ error: access.error });
      return;
    }
    const {
      schoolName, country, city, fieldOfStudy,
      startMonth, startYear, endMonth, endYear,
      gpa, gpaType, languageScore,
    } = req.body as Record<string, unknown>;

    const [existing] = await db
      .select({ id: educationRecordsTable.id })
      .from(educationRecordsTable)
      .where(
        and(
          eq(educationRecordsTable.studentId, studentId),
          eq(educationRecordsTable.level, level),
        ),
      );

    const payload = {
      studentId,
      level,
      schoolName:    typeof schoolName    === "string" ? schoolName    : null,
      country:       typeof country       === "string" ? country       : null,
      city:          typeof city          === "string" ? city          : null,
      fieldOfStudy:  typeof fieldOfStudy  === "string" ? fieldOfStudy  : null,
      startMonth:    typeof startMonth    === "string" ? startMonth    : null,
      startYear:     typeof startYear     === "number" ? startYear     : null,
      endMonth:      typeof endMonth      === "string" ? endMonth      : null,
      endYear:       typeof endYear       === "number" ? endYear       : null,
      gpa:           typeof gpa           === "string" ? gpa           : null,
      gpaType:       typeof gpaType       === "string" ? gpaType       : null,
      languageScore: typeof languageScore === "string" ? languageScore : null,
      source:        "manual" as const,
      updatedAt:     new Date(),
    };

    if (existing) {
      await db
        .update(educationRecordsTable)
        .set(payload)
        .where(eq(educationRecordsTable.id, existing.id));
      const [updated] = await db
        .select()
        .from(educationRecordsTable)
        .where(eq(educationRecordsTable.id, existing.id));
      res.json(updated);
    } else {
      const [inserted] = await db
        .insert(educationRecordsTable)
        .values(payload)
        .returning();
      res.status(201).json(inserted);
    }
  },
);

export default router;
