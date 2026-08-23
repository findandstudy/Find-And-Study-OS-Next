import { db, pool, leadsTable, studentsTable, applicationsTable, usersTable } from "@workspace/db";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { logAudit } from "./auth";
import { dispatchNotification } from "./notificationDispatcher";

const CHECK_INTERVAL = 24 * 60 * 60 * 1000;
const INITIAL_DELAY = 30 * 1000;
const LAST_COUNT_KEY = "assignment_inconsistency_last_count";

export interface AssignmentInconsistency {
  studentId: number;
  studentName: string;
  studentAssignedToId: number | null;
  leadId?: number;
  leadAssignedToId?: number | null;
  applicationId?: number;
  applicationAssignedToId?: number | null;
  type: "lead_mismatch" | "application_mismatch";
}

export async function checkAssignmentConsistency(): Promise<AssignmentInconsistency[]> {
  try {
    const students = await db
      .select({
        id: studentsTable.id,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        assignedToId: studentsTable.assignedToId,
      })
      .from(studentsTable)
      .where(isNull(studentsTable.deletedAt));

    if (students.length === 0) return [];

    const studentIds = students.map(s => s.id);
    const studentMap = new Map(students.map(s => [s.id, s]));

    const leads = await db
      .select({
        id: leadsTable.id,
        convertedStudentId: leadsTable.convertedStudentId,
        assignedToId: leadsTable.assignedToId,
      })
      .from(leadsTable)
      .where(
        and(
          isNull(leadsTable.deletedAt),
          inArray(leadsTable.convertedStudentId, studentIds)
        )
      );

    const apps = await db
      .select({
        id: applicationsTable.id,
        studentId: applicationsTable.studentId,
        assignedToId: applicationsTable.assignedToId,
      })
      .from(applicationsTable)
      .where(
        and(
          isNull(applicationsTable.deletedAt),
          inArray(applicationsTable.studentId, studentIds)
        )
      );

    const inconsistencies: AssignmentInconsistency[] = [];

    for (const lead of leads) {
      if (!lead.convertedStudentId) continue;
      const student = studentMap.get(lead.convertedStudentId);
      if (!student) continue;
      if (lead.assignedToId !== student.assignedToId) {
        inconsistencies.push({
          studentId: student.id,
          studentName: [student.firstName, student.lastName].filter(Boolean).join(" ") || `Student #${student.id}`,
          studentAssignedToId: student.assignedToId,
          leadId: lead.id,
          leadAssignedToId: lead.assignedToId,
          type: "lead_mismatch",
        });
      }
    }

    for (const app of apps) {
      const student = studentMap.get(app.studentId);
      if (!student) continue;
      if (app.assignedToId !== student.assignedToId) {
        inconsistencies.push({
          studentId: student.id,
          studentName: [student.firstName, student.lastName].filter(Boolean).join(" ") || `Student #${student.id}`,
          studentAssignedToId: student.assignedToId,
          applicationId: app.id,
          applicationAssignedToId: app.assignedToId,
          type: "application_mismatch",
        });
      }
    }

    return inconsistencies;
  } catch (err: any) {
    console.error("[assignmentConsistencyChecker] query error:", err?.message || err);
    return [];
  }
}

async function resolveUserName(id: number | null): Promise<string | null> {
  if (!id) return null;
  try {
    const [u] = await db
      .select({ firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
      .from(usersTable)
      .where(eq(usersTable.id, id));
    if (!u) return `User #${id}`;
    return [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || `User #${id}`;
  } catch {
    return `User #${id}`;
  }
}

async function getLastKnownCount(): Promise<number> {
  try {
    const { rows } = await pool.query<{ value: string }>(
      `SELECT value FROM system_kv WHERE key = $1`,
      [LAST_COUNT_KEY]
    );
    if (rows.length > 0) return parseInt(rows[0].value, 10) || 0;
  } catch {
  }
  return 0;
}

async function saveLastKnownCount(count: number): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO system_kv (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [LAST_COUNT_KEY, String(count)]
    );
  } catch (err: any) {
    console.error("[assignmentConsistencyChecker] failed to save last count:", err?.message || err);
  }
}

export async function runAssignmentConsistencyCheck(): Promise<void> {
  try {
    const inconsistencies = await checkAssignmentConsistency();
    const currentCount = inconsistencies.length;

    if (currentCount === 0) {
      console.log("[assignmentConsistencyChecker] No assignment inconsistencies found.");
      await saveLastKnownCount(0);
      return;
    }

    const lastCount = await getLastKnownCount();
    console.warn(`[assignmentConsistencyChecker] Found ${currentCount} assignment inconsistency(ies) (was ${lastCount}).`);

    for (const inc of inconsistencies) {
      if (inc.type === "lead_mismatch") {
        const studentName = await resolveUserName(inc.studentAssignedToId);
        const leadName = await resolveUserName(inc.leadAssignedToId ?? null);
        logAudit(null, "assignment.inconsistency", "student", inc.studentId, {
          type: inc.type,
          studentAssignedToId: inc.studentAssignedToId,
          studentAssignedToName: studentName,
          leadId: inc.leadId,
          leadAssignedToId: inc.leadAssignedToId,
          leadAssignedToName: leadName,
          studentName: inc.studentName,
        });
      } else {
        const studentName = await resolveUserName(inc.studentAssignedToId);
        const appName = await resolveUserName(inc.applicationAssignedToId ?? null);
        logAudit(null, "assignment.inconsistency", "student", inc.studentId, {
          type: inc.type,
          studentAssignedToId: inc.studentAssignedToId,
          studentAssignedToName: studentName,
          applicationId: inc.applicationId,
          applicationAssignedToId: inc.applicationAssignedToId,
          applicationAssignedToName: appName,
          studentName: inc.studentName,
        });
      }
    }

    await saveLastKnownCount(currentCount);

    if (currentCount <= lastCount) {
      console.log(`[assignmentConsistencyChecker] Count has not increased (${lastCount} → ${currentCount}); skipping notification.`);
      return;
    }

    const leadMismatches = inconsistencies.filter(i => i.type === "lead_mismatch").length;
    const appMismatches = inconsistencies.filter(i => i.type === "application_mismatch").length;

    const parts: string[] = [];
    if (leadMismatches > 0) parts.push(`${leadMismatches} lead–student`);
    if (appMismatches > 0) parts.push(`${appMismatches} application–student`);
    const summary = parts.join(", ");

    await dispatchNotification({
      event: "assignment.inconsistency",
      title: "Assignment Inconsistencies Detected",
      body: `${currentCount} assignment inconsistency(ies) detected: ${summary}. Check the Assignment Inconsistencies report in the Audit section.`,
      actionUrl: "/settings/audit?action=assignment.inconsistency",
      icon: "⚠️",
      data: {
        count: currentCount,
        previousCount: lastCount,
        leadMismatches,
        appMismatches,
      },
    });
  } catch (err: any) {
    console.error("[assignmentConsistencyChecker] run error:", err?.message || err);
  }
}

let initialTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

export function startAssignmentConsistencyChecker(): () => void {
  if (initialTimer || intervalTimer) return stopAssignmentConsistencyChecker;
  initialTimer = setTimeout(() => {
    initialTimer = null;
    void runAssignmentConsistencyCheck();
    intervalTimer = setInterval(runAssignmentConsistencyCheck, CHECK_INTERVAL);
  }, INITIAL_DELAY);
  return stopAssignmentConsistencyChecker;
}

export function stopAssignmentConsistencyChecker(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  initialTimer = null;
  intervalTimer = null;
}
