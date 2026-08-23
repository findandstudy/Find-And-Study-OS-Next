type ApplicationCommissionTotalsInput = {
  universityCommissionTotal: unknown;
  agentCommissionTotal: unknown;
  subAgentCommissionTotal: unknown;
  isAgentUser: boolean;
  isSubAgentUser: boolean;
};

function toFiniteAmount(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? "0"));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Mirrors the row-level commission visibility rules used by the applications
 * endpoint, but operates on the complete filtered result set.
 */
export function resolveApplicationCommissionTotal({
  universityCommissionTotal,
  agentCommissionTotal,
  subAgentCommissionTotal,
  isAgentUser,
  isSubAgentUser,
}: ApplicationCommissionTotalsInput): number {
  const universityTotal = toFiniteAmount(universityCommissionTotal);
  const agentTotal = toFiniteAmount(agentCommissionTotal);
  const subAgentTotal = toFiniteAmount(subAgentCommissionTotal);

  if (isAgentUser) {
    return isSubAgentUser ? subAgentTotal : agentTotal - subAgentTotal;
  }

  return universityTotal - agentTotal;
}
