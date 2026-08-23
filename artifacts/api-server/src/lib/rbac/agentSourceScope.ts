import { isNull, inArray } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { ADMIN_ROLES, STAFF_ROLES, isAgentRole } from "@workspace/roles";
import { getAgentVisibleIds } from "../agentVisibility";

export interface AgentSourceScopeResult {
  condition: ReturnType<typeof isNull> | ReturnType<typeof inArray> | null;
  empty: boolean;
}

/**
 * Returns a Drizzle WHERE condition that scopes a list query to records the
 * given user may see, based on the agent-source visibility rules:
 *
 *  - super_admin / admin / manager  → no filter (null)
 *  - non-admin staff (staff, consultant, editor, accountant)
 *                                   → agentIdCol IS NULL  (KURAL 1)
 *  - agent / sub_agent / agent_staff → agentIdCol IN visibleIds  (KURAL 2 via getAgentVisibleIds)
 *
 * If `empty` is true the caller must return an empty result set immediately.
 */
export async function buildAgentSourceScope(
  user: { id: number; role: string },
  agentIdCol: Column,
): Promise<AgentSourceScopeResult> {
  if ((ADMIN_ROLES as string[]).includes(user.role)) {
    return { condition: null, empty: false };
  }

  if (isAgentRole(user.role)) {
    const visibleIds = await getAgentVisibleIds(user.id, user.role);
    if (visibleIds.length === 0) return { condition: null, empty: true };
    return { condition: inArray(agentIdCol, visibleIds), empty: false };
  }

  return { condition: isNull(agentIdCol), empty: false };
}

/**
 * Returns true when a non-admin staff user should be blocked from accessing
 * a specific agent-sourced record.  Use in single-record (detail / mutation)
 * endpoint scope guards.
 *
 * Only targets non-admin STAFF_ROLES (staff, consultant, editor, accountant).
 * Returns false for admin roles, agent roles, students, and any other role
 * — those are handled by their own visibility logic elsewhere.
 */
export function isAgentSourcedAndBlockedForStaff(
  user: { role: string },
  recordAgentId: number | null | undefined,
): boolean {
  if ((ADMIN_ROLES as string[]).includes(user.role)) return false;
  if (isAgentRole(user.role)) return false;
  // Only apply to non-admin staff roles; students / other roles are not in scope.
  if (!(STAFF_ROLES as string[]).includes(user.role)) return false;
  return recordAgentId != null;
}
