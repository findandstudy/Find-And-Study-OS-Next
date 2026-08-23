/**
 * Backwards-compatible thin re-export of the shared `@workspace/roles`
 * package. Existing route imports (`import { STAFF_ROLES } from
 * "../lib/roles"`) keep working; new code should import from
 * `@workspace/roles` directly.
 */
export {
  ADMIN_ROLES,
  MANAGER_ROLES,
  STAFF_ROLES,
  FINANCE_ROLES,
  CONTENT_ROLES,
  AGENT_ROLES,
  STUDENT_ROLES,
  DIRECT_BRANCH_ROLES,
  isAgentRole,
  isStaffRole,
  isAdminRole,
  isManagerRole,
  isFinanceRole,
  isContentRole,
  isStudentRole,
  requiresDirectBranch,
} from "@workspace/roles";
