import test from "node:test";
import assert from "node:assert/strict";
import { authorizeStudentCreationSourceLead } from "../src/lib/studentCreationSource.js";

const base = {
  actorUserId: 40,
  actorIsAdmin: false,
  actorIsAgent: false,
  actorIsAgentStaff: false,
  agentStaffCanAccessLeads: true,
  visibleAgentIds: [] as number[],
  canViewOthers: false,
  sourceLeadAgentId: null as number | null,
  sourceLeadAssignedToId: 40 as number | null,
  sourceLeadWithinBranchScope: true,
};

test("assigned staff may create a student from an accessible null-branch lead", () => {
  assert.deepEqual(authorizeStudentCreationSourceLead(base), { allowed: true });
});

test("staff cannot use another staff member's assigned lead as a source", () => {
  assert.deepEqual(
    authorizeStudentCreationSourceLead({ ...base, sourceLeadAssignedToId: 41 }),
    { allowed: false, status: 403, error: "Access denied" },
  );
});

test("records.view_others still requires branch scope", () => {
  assert.deepEqual(
    authorizeStudentCreationSourceLead({
      ...base,
      canViewOthers: true,
      sourceLeadAssignedToId: 41,
      sourceLeadWithinBranchScope: false,
    }),
    { allowed: false, status: 404, error: "Lead not found" },
  );
});

test("agent source lead must belong to the agent visibility tree", () => {
  assert.deepEqual(
    authorizeStudentCreationSourceLead({
      ...base,
      actorIsAgent: true,
      visibleAgentIds: [10, 11],
      sourceLeadAgentId: 12,
    }),
    { allowed: false, status: 403, error: "You do not have access to this lead" },
  );
  assert.deepEqual(
    authorizeStudentCreationSourceLead({
      ...base,
      actorIsAgent: true,
      visibleAgentIds: [10, 11],
      sourceLeadAgentId: 11,
    }),
    { allowed: true },
  );
});

test("agent staff also needs lead permission for source inheritance", () => {
  assert.deepEqual(
    authorizeStudentCreationSourceLead({
      ...base,
      actorIsAgentStaff: true,
      agentStaffCanAccessLeads: false,
    }),
    {
      allowed: false,
      status: 403,
      error: "You do not have permission to access this lead",
    },
  );
});

test("admins retain unrestricted source-lead access", () => {
  assert.deepEqual(
    authorizeStudentCreationSourceLead({
      ...base,
      actorIsAdmin: true,
      sourceLeadAssignedToId: 999,
      sourceLeadWithinBranchScope: false,
    }),
    { allowed: true },
  );
});
