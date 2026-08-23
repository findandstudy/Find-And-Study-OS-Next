import { db, agentsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export interface AgentCommissionInfo {
  agentId: number | null;
  agentCommissionRate: string | null;
  agentCommissionAmount: string | null;
  subAgentId: number | null;
  subAgentCommissionRate: string | null;
  subAgentCommissionAmount: string | null;
}

export async function resolveAgentCommission(
  agentId: number | null | undefined,
  universityCommissionAmount: number
): Promise<AgentCommissionInfo> {
  const empty: AgentCommissionInfo = {
    agentId: agentId ?? null,
    agentCommissionRate: null,
    agentCommissionAmount: null,
    subAgentId: null,
    subAgentCommissionRate: null,
    subAgentCommissionAmount: null,
  };

  if (!agentId || universityCommissionAmount <= 0) return empty;

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
  if (!agent) return empty;

  // Resolve parent agent if any. Two defensive guards apply:
  //   1. Self-reference guard: if parentAgentId === agent.id, treat as standalone.
  //      The schema does not enforce parent_agent_id ≠ id at the DB level, and
  //      a self-referencing row would otherwise loop in any future recursive
  //      walker. Current code is single-hop so this is purely defensive.
  //   2. Orphan parent guard: parent_agent_id has no FK reference and is not
  //      cleared when the parent agent is deleted. If the referenced parent
  //      no longer exists, treat the current agent as standalone (use its own
  //      commissionRate) instead of zeroing out commission entirely — the
  //      latter is a financial regression for legitimate agents whose parent
  //      was removed.
  let parentAgent: typeof agent | null = null;
  if (agent.parentAgentId && agent.parentAgentId !== agent.id) {
    const [p] = await db.select().from(agentsTable).where(eq(agentsTable.id, agent.parentAgentId));
    if (p) parentAgent = p;
    // If !p (orphan), parentAgent stays null and we fall through to standalone.
  }

  if (parentAgent) {
    const parentRate = parentAgent.commissionRate ?? 0;
    const parentAmount = parentRate > 0 ? (universityCommissionAmount * parentRate) / 100 : 0;

    const subRate = agent.commissionRate ?? 0;
    const subAmount = subRate > 0 && parentAmount > 0 ? (parentAmount * subRate) / 100 : 0;

    return {
      agentId: parentAgent.id,
      agentCommissionRate: parentRate > 0 ? String(parentRate) : null,
      agentCommissionAmount: parentAmount > 0 ? String(Math.round(parentAmount * 100) / 100) : null,
      subAgentId: agent.id,
      subAgentCommissionRate: subRate > 0 ? String(subRate) : null,
      subAgentCommissionAmount: subAmount > 0 ? String(Math.round(subAmount * 100) / 100) : null,
    };
  }

  const rate = agent.commissionRate ?? 0;
  const amount = rate > 0 ? (universityCommissionAmount * rate) / 100 : 0;

  return {
    agentId: agent.id,
    agentCommissionRate: rate > 0 ? String(rate) : null,
    agentCommissionAmount: amount > 0 ? String(Math.round(amount * 100) / 100) : null,
    subAgentId: null,
    subAgentCommissionRate: null,
    subAgentCommissionAmount: null,
  };
}
