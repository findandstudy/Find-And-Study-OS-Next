/**
 * @workspace/roles — single source of truth for role constants.
 *
 * Used by both backend (api-server) and frontend (edcons) so that role
 * sets stay in sync. Changing a role group here is a single edit instead
 * of hunting down 12+ duplicates across the codebase.
 *
 * Arrays are exported as plain `string[]` so existing call sites that
 * spread/forward them into APIs typed as `string[]` continue to compile
 * unchanged. Use the named `*Role` union types for narrower checks.
 */

export const ADMIN_ROLES: string[] = ["super_admin", "admin", "manager"];
export const MANAGER_ROLES: string[] = ["super_admin", "admin", "manager"];
export const STAFF_ROLES: string[] = [
  "super_admin", "admin", "manager",
  "staff", "consultant", "editor", "accountant",
];
export const FINANCE_ROLES: string[] = ["super_admin", "admin", "accountant"];
export const CONTENT_ROLES: string[] = ["super_admin", "admin", "manager", "editor"];
export const AGENT_ROLES: string[] = ["agent", "sub_agent", "agent_staff"];
export const STUDENT_ROLES: string[] = ["student"];
export const DIRECT_BRANCH_ROLES: string[] = [
  "admin", "manager", "staff", "consultant", "editor", "accountant",
];

export type AdminRole = "super_admin" | "admin" | "manager";
export type ManagerRole = "super_admin" | "admin" | "manager";
export type StaffRole =
  | "super_admin" | "admin" | "manager"
  | "staff" | "consultant" | "editor" | "accountant";
export type FinanceRole = "super_admin" | "admin" | "accountant";
export type ContentRole = "super_admin" | "admin" | "manager" | "editor";
export type AgentRole = "agent" | "sub_agent" | "agent_staff";
export type StudentRole = "student";

export function isAgentRole(role: string): role is AgentRole {
  return AGENT_ROLES.includes(role);
}
export function isStaffRole(role: string): role is StaffRole {
  return STAFF_ROLES.includes(role);
}
export function isAdminRole(role: string): role is AdminRole {
  return ADMIN_ROLES.includes(role);
}
export function isManagerRole(role: string): role is ManagerRole {
  return MANAGER_ROLES.includes(role);
}
export function isFinanceRole(role: string): role is FinanceRole {
  return FINANCE_ROLES.includes(role);
}
export function isContentRole(role: string): role is ContentRole {
  return CONTENT_ROLES.includes(role);
}
export function isStudentRole(role: string): role is StudentRole {
  return STUDENT_ROLES.includes(role);
}

/** Roles whose record access is derived directly from users.branch_id. */
export function requiresDirectBranch(role: string): boolean {
  return DIRECT_BRANCH_ROLES.includes(role);
}
