import assert from "node:assert/strict";
import test from "node:test";
import {
  canLegacyActorAssignRole,
  evaluateLegacyUserManagement,
} from "../src/lib/legacyUserManagementPolicy";

const actor = (role: string, id = 1, visibleBranchIds: number[] | null = [10]) => ({
  id,
  role,
  visibleBranchIds,
});
const target = (role: string, id = 2, branchIds: number[] = [10]) => ({
  id,
  role,
  branchIds,
  isDeleted: false,
});

test("same-branch directory reads are allowed but cross-branch reads fail closed", () => {
  assert.deepEqual(
    evaluateLegacyUserManagement(actor("manager"), target("staff"), "read"),
    { allowed: true, reason: "same_branch" },
  );
  assert.deepEqual(
    evaluateLegacyUserManagement(actor("manager"), target("staff", 2, [11]), "read"),
    { allowed: false, reason: "cross_branch" },
  );
  assert.deepEqual(
    evaluateLegacyUserManagement(actor("manager", 1, []), target("staff"), "read"),
    { allowed: false, reason: "actor_without_branch_scope" },
  );
});

test("all linked student branches must be inside the actor scope", () => {
  assert.equal(
    evaluateLegacyUserManagement(actor("admin", 1, [10, 11]), target("student", 2, [10, 11]), "update").allowed,
    true,
  );
  assert.deepEqual(
    evaluateLegacyUserManagement(actor("admin", 1, [10]), target("student", 2, [10, 11]), "update"),
    { allowed: false, reason: "cross_branch" },
  );
});

test("agent identities require relationship-aware routes for non-super actors", () => {
  assert.deepEqual(
    evaluateLegacyUserManagement(actor("admin"), target("agent"), "read"),
    { allowed: false, reason: "agent_relationship_route_required" },
  );
  assert.deepEqual(
    evaluateLegacyUserManagement(actor("super_admin", 1, null), target("agent"), "read"),
    { allowed: true, reason: "super_admin" },
  );
});

test("peer or higher privileged accounts cannot be mutated or reset", () => {
  assert.deepEqual(
    evaluateLegacyUserManagement(actor("manager"), target("manager"), "update"),
    { allowed: false, reason: "peer_or_higher_privilege" },
  );
  assert.deepEqual(
    evaluateLegacyUserManagement(actor("manager"), target("admin"), "set_password"),
    { allowed: false, reason: "peer_or_higher_privilege" },
  );
  assert.equal(
    evaluateLegacyUserManagement(actor("admin"), target("manager"), "delete").allowed,
    true,
  );
});

test("self-service allows profile update only", () => {
  assert.deepEqual(
    evaluateLegacyUserManagement(actor("admin"), target("admin", 1), "update"),
    { allowed: true, reason: "self_profile" },
  );
  assert.deepEqual(
    evaluateLegacyUserManagement(actor("admin"), target("admin", 1), "set_password"),
    { allowed: false, reason: "self_sensitive_action" },
  );
});

test("role assignment cannot create peers, super admins, agents, or students", () => {
  assert.equal(canLegacyActorAssignRole("manager", "staff"), true);
  assert.equal(canLegacyActorAssignRole("manager", "manager"), false);
  assert.equal(canLegacyActorAssignRole("admin", "manager"), true);
  assert.equal(canLegacyActorAssignRole("admin", "admin"), false);
  assert.equal(canLegacyActorAssignRole("admin", "super_admin"), false);
  assert.equal(canLegacyActorAssignRole("admin", "agent"), false);
  assert.equal(canLegacyActorAssignRole("admin", "student"), false);
  assert.equal(canLegacyActorAssignRole("admin", "custom_power_role"), false);
  assert.equal(canLegacyActorAssignRole("super_admin", "super_admin"), true);
  assert.equal(canLegacyActorAssignRole("super_admin", "custom_power_role"), true);
});
