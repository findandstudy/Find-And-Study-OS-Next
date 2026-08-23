import { db, agentsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const AGENT_VISIBILITY_TTL = 30_000;
const agentVisibilityCache = new Map<string, { ids: number[]; fetchedAt: number }>();

export async function getAgentVisibleIds(userId: number, userRole: string): Promise<number[]> {
  const cacheKey = `${userId}:${userRole}`;
  const cached = agentVisibilityCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < AGENT_VISIBILITY_TTL) {
    return cached.ids;
  }

  let ids: number[];

  if (userRole === "agent_staff") {
    const [staffUser] = await db.select({ managingAgentId: usersTable.managingAgentId }).from(usersTable).where(eq(usersTable.id, userId));
    if (!staffUser?.managingAgentId) {
      ids = [];
    } else {
      const [managingAgent] = await db.select().from(agentsTable).where(eq(agentsTable.id, staffUser.managingAgentId));
      if (!managingAgent) {
        ids = [];
      } else if (!managingAgent.parentAgentId) {
        const subAgents = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.parentAgentId, managingAgent.id));
        ids = [managingAgent.id, ...subAgents.map(s => s.id)];
      } else {
        ids = [managingAgent.id];
      }
    }
  } else {
    const [agentRec] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
    if (!agentRec) {
      ids = [];
    } else if (userRole === "agent" && !agentRec.parentAgentId) {
      // A parent agent (no parentAgentId) sees its OWN records plus those of its
      // OWN sub-agents (agents whose parentAgentId === this agent). Records of
      // other agencies (and their sub-agents) are NEVER included — the sub-agent
      // query is scoped strictly to parentAgentId = agentRec.id, so this stays
      // IDOR-safe.
      const subAgents = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.parentAgentId, agentRec.id));
      ids = [agentRec.id, ...subAgents.map(s => s.id)];
    } else {
      ids = [agentRec.id];
    }
  }

  agentVisibilityCache.set(cacheKey, { ids, fetchedAt: Date.now() });
  return ids;
}

export function invalidateAgentVisibilityCache(userId: number, userRole: string): void {
  agentVisibilityCache.delete(`${userId}:${userRole}`);
}

export async function getAgentRecord(userId: number, userRole?: string) {
  if (userRole === "agent_staff") {
    const [staffUser] = await db.select({ managingAgentId: usersTable.managingAgentId }).from(usersTable).where(eq(usersTable.id, userId));
    if (!staffUser?.managingAgentId) return null;
    const [agentRec] = await db.select().from(agentsTable).where(eq(agentsTable.id, staffUser.managingAgentId));
    return agentRec || null;
  }
  const [agentRec] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  return agentRec || null;
}

export async function getManagingAgentId(userId: number, userRole: string): Promise<number | null> {
  if (userRole === "agent_staff") {
    const [staffUser] = await db.select({ managingAgentId: usersTable.managingAgentId }).from(usersTable).where(eq(usersTable.id, userId));
    return staffUser?.managingAgentId || null;
  }
  const [agentRec] = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.userId, userId));
  return agentRec?.id || null;
}
