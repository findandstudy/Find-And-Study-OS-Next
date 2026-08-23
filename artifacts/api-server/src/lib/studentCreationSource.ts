export interface StudentCreationSourceLeadAccessInput {
  actorUserId: number;
  actorIsAdmin: boolean;
  actorIsAgent: boolean;
  actorIsAgentStaff: boolean;
  agentStaffCanAccessLeads: boolean;
  visibleAgentIds: number[];
  canViewOthers: boolean;
  sourceLeadAgentId: number | null;
  sourceLeadAssignedToId: number | null;
  sourceLeadWithinBranchScope: boolean;
}

export type StudentCreationSourceLeadAccessResult =
  | { allowed: true }
  | { allowed: false; status: 403 | 404; error: string };

/**
 * Mirrors the lead-detail authorization rules for the optional sourceLeadId
 * accepted by POST /students. Keeping this decision pure makes it possible to
 * prove that source-lead inheritance cannot become a branch/ownership bypass.
 */
export function authorizeStudentCreationSourceLead(
  input: StudentCreationSourceLeadAccessInput,
): StudentCreationSourceLeadAccessResult {
  if (input.actorIsAgent) {
    if (
      input.sourceLeadAgentId == null ||
      !input.visibleAgentIds.includes(input.sourceLeadAgentId)
    ) {
      return { allowed: false, status: 403, error: "You do not have access to this lead" };
    }
    return { allowed: true };
  }

  if (input.actorIsAdmin) return { allowed: true };

  if (input.actorIsAgentStaff && !input.agentStaffCanAccessLeads) {
    return {
      allowed: false,
      status: 403,
      error: "You do not have permission to access this lead",
    };
  }

  if (input.sourceLeadAgentId != null && !input.canViewOthers) {
    return { allowed: false, status: 404, error: "Lead not found" };
  }
  if (input.canViewOthers && !input.sourceLeadWithinBranchScope) {
    return { allowed: false, status: 404, error: "Lead not found" };
  }
  if (
    !input.canViewOthers &&
    input.sourceLeadAssignedToId != null &&
    input.sourceLeadAssignedToId !== input.actorUserId
  ) {
    return { allowed: false, status: 403, error: "Access denied" };
  }

  return { allowed: true };
}
