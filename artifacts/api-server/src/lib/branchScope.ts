import { db, usersTable, agentsTable, agentBranchesTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";

const SUPER_ROLES = new Set(["super_admin"]);

type BranchContext = {
  branchId?: number | null;
  managingAgentId?: number | null;
};

function hasRequestBranchContext(context: BranchContext | undefined): context is BranchContext {
  return !!context && Object.prototype.hasOwnProperty.call(context, "branchId");
}

/**
 * Returns the list of branch IDs the user is allowed to see.
 * - super_admin → null (means: no scoping, see everything)
 * - any other role with a branch_id → [branchId]
 * - agents/sub_agents/agent_staff → all branches assigned to their agency
 *   via the agent_branches join table (plus their direct branchId if any)
 * - users with no branch assigned → [] (sees nothing branch-scoped)
 */
export async function getVisibleBranchIds(
  userId: number,
  role: string,
  context?: BranchContext,
): Promise<number[] | null> {
  if (SUPER_ROLES.has(role)) return null;

  const user = hasRequestBranchContext(context)
    ? { branchId: context.branchId ?? null, managingAgentId: context.managingAgentId ?? null }
    : (await db
        .select({ branchId: usersTable.branchId, managingAgentId: usersTable.managingAgentId })
        .from(usersTable)
        .where(eq(usersTable.id, userId)))[0];

  const ids = new Set<number>();
  if (user?.branchId) ids.add(user.branchId);

  if (role === "agent" || role === "sub_agent") {
    const [agent] = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.userId, userId));
    if (agent) {
      // Self + child agents (sub-agents under this agent) so an agent sees its full sub-tree.
      const children = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.parentAgentId, agent.id));
      const agentIds = [agent.id, ...children.map(c => c.id)];
      const rows = await db
        .select({ branchId: agentBranchesTable.branchId })
        .from(agentBranchesTable)
        .where(inArray(agentBranchesTable.agentId, agentIds));
      rows.forEach(r => ids.add(r.branchId));
    }
  } else if (role === "agent_staff" && user?.managingAgentId) {
    const rows = await db.select({ branchId: agentBranchesTable.branchId }).from(agentBranchesTable).where(eq(agentBranchesTable.agentId, user.managingAgentId));
    rows.forEach(r => ids.add(r.branchId));
  }

  return Array.from(ids);
}

/**
 * Resolve a branch_id to inherit on a newly created record.
 * - super_admin may pass any branchId explicitly (or null = unassigned).
 * - Branch-scoped users: explicitBranchId is honored only if it is within
 *   their visible scope; otherwise inherit their first visible branch.
 *   If they have no visible branches, returns null (caller should 403).
 */
export async function resolveCreateBranchId(
  userId: number,
  role: string,
  explicitBranchId?: number | null,
  context?: BranchContext,
): Promise<number | null> {
  if (SUPER_ROLES.has(role)) {
    return explicitBranchId ?? null;
  }
  const visible = await getVisibleBranchIds(userId, role, context);
  if (!visible || visible.length === 0) return null;
  if (explicitBranchId != null && visible.includes(explicitBranchId)) {
    return explicitBranchId;
  }
  return visible[0];
}

/**
 * Verify that the given agent is in the caller's visible branch scope.
 * Returns true for super_admin (no scope), or when at least one of the
 * agent's branches intersects with the caller's visible branches.
 */
/**
 * Returns true when a record (identified by its branchId) is within the user's
 * visible branch scope. Records with a null branchId are globally visible.
 * Use after granting "records.view_others" access to prevent cross-branch IDOR.
 */
export async function isInBranchScope(
  userId: number,
  userRole: string,
  recordBranchId: number | null,
  context?: BranchContext,
): Promise<boolean> {
  if (recordBranchId == null) return true; // null-branch records are globally visible
  const visibleBranchIds = await getVisibleBranchIds(userId, userRole, context);
  if (visibleBranchIds === null) return true; // super_admin sees everything
  if (visibleBranchIds.length === 0) return false; // user has no branch assignments
  return visibleBranchIds.includes(recordBranchId);
}

export async function isAgentInScope(
  callerUserId: number,
  callerRole: string,
  agentId: number,
  context?: BranchContext,
): Promise<boolean> {
  const visible = await getVisibleBranchIds(callerUserId, callerRole, context);
  if (visible === null) return true; // super_admin
  if (visible.length === 0) return false;
  const links = await db
    .select({ branchId: agentBranchesTable.branchId })
    .from(agentBranchesTable)
    .where(eq(agentBranchesTable.agentId, agentId));
  if (links.length === 0) return false;
  const allowed = new Set(visible);
  return links.some(l => allowed.has(l.branchId));
}
