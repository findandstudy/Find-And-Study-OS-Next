import { STAFF_ROLES, ADMIN_ROLES, isAgentRole } from "./roles";

export type UploadPermissionLevel =
  | "none"
  | "admin_only"
  | "staff_only"
  | "staff_and_agent"
  | "everyone";

/**
 * Decide whether a given user role is allowed to upload documents for a
 * pipeline stage with the given upload-permission level.
 *
 * Permission matrix (Task #134):
 *   none             → nobody
 *   admin_only       → admin / manager / super_admin only (preserves
 *                      historical access for migrated default stages
 *                      such as offer_received / acceptance_letter /
 *                      final_acceptance — must NOT broaden to other
 *                      staff roles like consultant / editor / accountant)
 *   staff_only       → all staff roles (admin + staff/consultant/editor/...)
 *   staff_and_agent  → staff + agents (no students)
 *   everyone         → staff + agents + students
 */
export function canUploadStageDocument(
  level: string | null | undefined,
  role: string,
): boolean {
  const isAdmin = ADMIN_ROLES.includes(role as any);
  const isStaff = STAFF_ROLES.includes(role as any);
  const isAgent = isAgentRole(role);
  const isStudent = role === "student";

  switch (level) {
    case "admin_only":
      return isAdmin;
    case "staff_only":
      return isStaff;
    case "staff_and_agent":
      return isStaff || isAgent;
    case "everyone":
      return isStaff || isAgent || isStudent;
    case "none":
    case null:
    case undefined:
    default:
      return false;
  }
}
