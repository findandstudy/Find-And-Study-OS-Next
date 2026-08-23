export type ImpersonationActor = {
  id: number;
  role: string;
  visibleBranchIds: number[] | null;
};

export type ImpersonationTarget = {
  id: number;
  role: string;
  branchIds: number[];
  isActive: boolean;
  isDeleted: boolean;
};

export type ImpersonationDecision =
  | { allowed: true; reason: "super_admin" | "same_branch" }
  | {
      allowed: false;
      reason:
        | "self"
        | "actor_role_denied"
        | "inactive_target"
        | "deleted_target"
        | "privileged_target_requires_super_admin"
        | "agent_relationship_route_required"
        | "target_without_branch"
        | "actor_without_branch_scope"
        | "cross_branch";
    };

const ADMIN_ACTOR_ROLES = new Set(["super_admin", "admin", "manager"]);
const PRIVILEGED_TARGET_ROLES = new Set(["super_admin", "admin", "manager"]);
const AGENT_TARGET_ROLES = new Set(["agent", "sub_agent", "agent_staff"]);

/**
 * Transitional, fail-closed policy for the legacy /users/:id/impersonate
 * route. This does not claim to be the target grant engine. It prevents the
 * legacy role projection from becoming a cross-branch or agent-tree bypass
 * while active-context/grant authorization is built.
 */
export function evaluateLegacyUserImpersonation(
  actor: ImpersonationActor,
  target: ImpersonationTarget,
): ImpersonationDecision {
  if (actor.id === target.id) return { allowed: false, reason: "self" };
  if (!ADMIN_ACTOR_ROLES.has(actor.role)) {
    return { allowed: false, reason: "actor_role_denied" };
  }
  if (target.isDeleted) return { allowed: false, reason: "deleted_target" };
  if (!target.isActive) return { allowed: false, reason: "inactive_target" };

  // Platform support remains possible for Super Admin during the migration,
  // but every lower legacy role is constrained below. G60R replaces this
  // exception with JIT capability + active-context + step-up receipts.
  if (actor.role === "super_admin") return { allowed: true, reason: "super_admin" };

  if (PRIVILEGED_TARGET_ROLES.has(target.role)) {
    return { allowed: false, reason: "privileged_target_requires_super_admin" };
  }
  if (AGENT_TARGET_ROLES.has(target.role)) {
    return { allowed: false, reason: "agent_relationship_route_required" };
  }
  if (target.branchIds.length === 0) {
    return { allowed: false, reason: "target_without_branch" };
  }
  if (actor.visibleBranchIds == null || actor.visibleBranchIds.length === 0) {
    return { allowed: false, reason: "actor_without_branch_scope" };
  }
  if (target.branchIds.some((branchId) => !actor.visibleBranchIds!.includes(branchId))) {
    return { allowed: false, reason: "cross_branch" };
  }
  return { allowed: true, reason: "same_branch" };
}
