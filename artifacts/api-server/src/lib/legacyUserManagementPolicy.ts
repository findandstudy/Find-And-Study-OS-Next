export type LegacyUserManagementAction =
  | "read"
  | "update"
  | "delete"
  | "set_password";

export type LegacyUserManagementActor = {
  id: number;
  role: string;
  visibleBranchIds: number[] | null;
};

export type LegacyUserManagementTarget = {
  id: number;
  role: string;
  branchIds: number[];
  isDeleted: boolean;
};

export type LegacyUserManagementDecision =
  | { allowed: true; reason: "super_admin" | "self_profile" | "same_branch" }
  | {
      allowed: false;
      reason:
        | "actor_role_denied"
        | "self_sensitive_action"
        | "deleted_target"
        | "agent_relationship_route_required"
        | "target_without_branch"
        | "actor_without_branch_scope"
        | "cross_branch"
        | "peer_or_higher_privilege";
    };

const MANAGEMENT_ACTOR_RANK = new Map<string, number>([
  ["manager", 100],
  ["admin", 200],
  ["super_admin", 300],
]);
const AGENT_TARGET_ROLES = new Set(["agent", "sub_agent", "agent_staff"]);
const STUDENT_TARGET_ROLES = new Set(["student"]);
const BRANCH_STAFF_ROLES = new Set([
  "manager",
  "staff",
  "consultant",
  "editor",
  "accountant",
  "pending",
]);

/**
 * Fail-closed boundary for the legacy generic user-management routes.
 *
 * This is deliberately narrower than a general RBAC engine. Agent identities
 * must be managed through relationship-aware agent routes, student identity
 * must remain linked to a branch-scoped student record, and a non-super actor
 * can never manage a peer or a more privileged account.
 */
export function evaluateLegacyUserManagement(
  actor: LegacyUserManagementActor,
  target: LegacyUserManagementTarget,
  action: LegacyUserManagementAction,
): LegacyUserManagementDecision {
  if (target.isDeleted) return { allowed: false, reason: "deleted_target" };

  if (actor.id === target.id) {
    return action === "update"
      ? { allowed: true, reason: "self_profile" }
      : { allowed: false, reason: "self_sensitive_action" };
  }

  const actorRank = MANAGEMENT_ACTOR_RANK.get(actor.role);
  if (actorRank == null) return { allowed: false, reason: "actor_role_denied" };

  // Super Admin remains the transitional platform-support exception while
  // versioned grants, step-up receipts, and JIT privileged access are built.
  if (actor.role === "super_admin") return { allowed: true, reason: "super_admin" };

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

  if (action !== "read") {
    const targetRank = MANAGEMENT_ACTOR_RANK.get(target.role) ?? 0;
    if (targetRank >= actorRank) {
      return { allowed: false, reason: "peer_or_higher_privilege" };
    }
  }

  return { allowed: true, reason: "same_branch" };
}

/**
 * Generic /users creation and role reassignment may create branch staff only.
 * Agent and student lifecycles have separate relationship-aware routes.
 */
export function canLegacyActorAssignRole(actorRole: string, proposedRole: string): boolean {
  if (actorRole === "super_admin") return true;
  if (AGENT_TARGET_ROLES.has(proposedRole) || STUDENT_TARGET_ROLES.has(proposedRole)) return false;
  const actorRank = MANAGEMENT_ACTOR_RANK.get(actorRole);
  if (actorRank == null) return false;
  // Dynamic role permissions are mutable platform configuration. Until the
  // versioned grant control plane exists, only Super Admin may assign them.
  if (!BRANCH_STAFF_ROLES.has(proposedRole)) return false;
  const proposedRank = MANAGEMENT_ACTOR_RANK.get(proposedRole) ?? 0;
  return proposedRank < actorRank;
}

export function isLegacyAgentManagedRole(role: string): boolean {
  return AGENT_TARGET_ROLES.has(role);
}
