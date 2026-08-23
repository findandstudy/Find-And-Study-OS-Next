import type { Request } from "express";
import { db, studentsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { STAFF_ROLES, ADMIN_ROLES, isAgentRole } from "./roles";
import { getAgentVisibleIds } from "./agentVisibility";
import { getAgencyMemberAgentIds } from "./agencyStaff";
import { isInBranchScope } from "./branchScope";
import { getEffectivePermissionSet } from "./permissions";

export type StudentAccessResult =
  | { ok: true; student: typeof studentsTable.$inferSelect }
  | { ok: false; status: 403 | 404; error: string };

/**
 * Centralized authorization check for per-student endpoints.
 * Mirrors the visibility logic of GET /students/:id so endpoints like
 * /students/:id/photo cannot leak data via id-enumeration (IDOR).
 */
export async function assertCanAccessStudent(
  req: Request,
  studentId: number,
): Promise<StudentAccessResult> {
  const user = req.user;
  if (!user) return { ok: false, status: 403, error: "Access denied" };

  if (!Number.isFinite(studentId) || studentId <= 0) {
    return { ok: false, status: 404, error: "Student not found" };
  }

  const [student] = await db
    .select()
    .from(studentsTable)
    .where(and(eq(studentsTable.id, studentId), isNull(studentsTable.deletedAt)));
  if (!student) return { ok: false, status: 404, error: "Student not found" };

  const isStaff = (STAFF_ROLES as readonly string[]).includes(user.role);
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(user.role);
  const isOwnProfile = student.userId === user.id;
  const isAgent = isAgentRole(user.role);

  if (isAgent) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    if (!student.agentId || !visibleIds.includes(student.agentId)) {
      return { ok: false, status: 403, error: "Access denied" };
    }
    return { ok: true, student };
  }

  if (isStaff && !isAdmin) {
    const perms = await getEffectivePermissionSet(user);
    // view_others grants full record visibility within the same branch scope (Task #494)
    if (perms.has("records.view_others")) {
      const inScope = await isInBranchScope(user.id, user.role, student.branchId, user);
      if (!inScope) return { ok: false, status: 404, error: "Student not found" };
      return { ok: true, student };
    }
    if (student.assignedToId !== null && student.assignedToId !== user.id) {
      let allowed = false;
      if (student.agentId) {
        const agencyAgentIds = await getAgencyMemberAgentIds(user.id);
        if (agencyAgentIds.includes(student.agentId)) {
          // isInBranchScope handles null branch (globally visible) + super_admin + visible set
          if (await isInBranchScope(user.id, user.role, student.branchId, user)) {
            allowed = true;
          }
        }
      }
      if (!allowed) return { ok: false, status: 403, error: "Access denied" };
    }
    return { ok: true, student };
  }

  if (!isStaff && !isOwnProfile) {
    return { ok: false, status: 403, error: "Access denied" };
  }

  return { ok: true, student };
}
