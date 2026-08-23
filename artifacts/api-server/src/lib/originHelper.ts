import { db, agentsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export type OriginMeta = {
  originType: "direct" | "agent" | "sub_agent";
  originEntityType: string | null;
  originEntityId: number | null;
  originDisplayName: string | null;
};

const DIRECT_ROLES = [
  "super_admin", "admin", "manager", "staff", "consultant", "editor", "accountant",
];

export async function inferOriginFromUser(user: {
  id: number;
  role: string;
  managingAgentId?: number | null;
}): Promise<OriginMeta> {
  if (DIRECT_ROLES.includes(user.role)) {
    return {
      originType: "direct",
      originEntityType: null,
      originEntityId: null,
      originDisplayName: "Find And Study",
    };
  }

  if (user.role === "agent_staff") {
    const managingAgentId = user.managingAgentId;
    if (!managingAgentId) {
      const [staffUser] = await db
        .select({ managingAgentId: usersTable.managingAgentId })
        .from(usersTable)
        .where(eq(usersTable.id, user.id));
      if (staffUser?.managingAgentId) {
        return inferOriginFromAgentId(staffUser.managingAgentId);
      }
    } else {
      return inferOriginFromAgentId(managingAgentId);
    }
    return directOrigin();
  }

  if (user.role === "agent" || user.role === "sub_agent") {
    const [agentRec] = await db
      .select({
        id: agentsTable.id,
        parentAgentId: agentsTable.parentAgentId,
        companyName: agentsTable.companyName,
        businessName: agentsTable.businessName,
        firstName: agentsTable.firstName,
        lastName: agentsTable.lastName,
        branch: agentsTable.branch,
      })
      .from(agentsTable)
      .where(eq(agentsTable.userId, user.id));

    if (!agentRec) return directOrigin();

    return buildOriginFromAgent(agentRec);
  }

  return directOrigin();
}

export async function inferOriginFromAgentId(agentId: number): Promise<OriginMeta> {
  const [agentRec] = await db
    .select({
      id: agentsTable.id,
      parentAgentId: agentsTable.parentAgentId,
      companyName: agentsTable.companyName,
      businessName: agentsTable.businessName,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      branch: agentsTable.branch,
    })
    .from(agentsTable)
    .where(eq(agentsTable.id, agentId));

  if (!agentRec) return directOrigin();
  return buildOriginFromAgent(agentRec);
}

function buildOriginFromAgent(agent: {
  id: number;
  parentAgentId: number | null;
  companyName: string | null;
  businessName: string | null;
  firstName: string;
  lastName: string;
  branch: string | null;
}): OriginMeta {
  const isSubAgent = !!agent.parentAgentId;
  const displayName =
    agent.companyName || agent.businessName || `${agent.firstName} ${agent.lastName}`.trim();
  const name = isSubAgent && agent.branch ? `${displayName} (${agent.branch})` : displayName;

  return {
    originType: isSubAgent ? "sub_agent" : "agent",
    originEntityType: "agent",
    originEntityId: agent.id,
    originDisplayName: name,
  };
}

export function directOrigin(): OriginMeta {
  return {
    originType: "direct",
    originEntityType: null,
    originEntityId: null,
    originDisplayName: "Find And Study",
  };
}

