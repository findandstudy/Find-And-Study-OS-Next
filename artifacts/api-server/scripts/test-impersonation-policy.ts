import assert from "node:assert/strict";
import test from "node:test";
import { evaluateLegacyUserImpersonation } from "../src/lib/impersonationPolicy.js";

const target = {
  id: 20,
  role: "staff",
  branchIds: [10],
  isActive: true,
  isDeleted: false,
};

test("admin and manager impersonation is limited to the same branch", () => {
  assert.deepEqual(
    evaluateLegacyUserImpersonation(
      { id: 1, role: "manager", visibleBranchIds: [10] },
      target,
    ),
    { allowed: true, reason: "same_branch" },
  );
  assert.deepEqual(
    evaluateLegacyUserImpersonation(
      { id: 1, role: "admin", visibleBranchIds: [11] },
      target,
    ),
    { allowed: false, reason: "cross_branch" },
  );
});

test("legacy privileged and agent targets cannot bypass their dedicated policy", () => {
  assert.deepEqual(
    evaluateLegacyUserImpersonation(
      { id: 1, role: "manager", visibleBranchIds: [10] },
      { ...target, role: "admin" },
    ),
    { allowed: false, reason: "privileged_target_requires_super_admin" },
  );
  assert.deepEqual(
    evaluateLegacyUserImpersonation(
      { id: 1, role: "admin", visibleBranchIds: [10] },
      { ...target, role: "agent" },
    ),
    { allowed: false, reason: "agent_relationship_route_required" },
  );
});

test("branchless, inactive, deleted, and self targets fail closed", () => {
  const actor = { id: 1, role: "admin", visibleBranchIds: [10] };
  assert.equal(
    evaluateLegacyUserImpersonation(actor, { ...target, branchIds: [] }).reason,
    "target_without_branch",
  );
  assert.equal(
    evaluateLegacyUserImpersonation(actor, { ...target, isActive: false }).reason,
    "inactive_target",
  );
  assert.equal(
    evaluateLegacyUserImpersonation(actor, { ...target, isDeleted: true }).reason,
    "deleted_target",
  );
  assert.equal(
    evaluateLegacyUserImpersonation(actor, { ...target, id: actor.id }).reason,
    "self",
  );
});

test("Super Admin support context remains explicit and cannot target inactive users", () => {
  const actor = { id: 1, role: "super_admin", visibleBranchIds: null };
  assert.deepEqual(
    evaluateLegacyUserImpersonation(actor, { ...target, role: "admin", branchIds: [] }),
    { allowed: true, reason: "super_admin" },
  );
  assert.equal(
    evaluateLegacyUserImpersonation(actor, { ...target, isActive: false }).reason,
    "inactive_target",
  );
});

test("all linked target branches must be inside the actor scope", () => {
  assert.equal(
    evaluateLegacyUserImpersonation(
      { id: 1, role: "admin", visibleBranchIds: [10] },
      { ...target, branchIds: [10, 11] },
    ).reason,
    "cross_branch",
  );
});
