import { test } from "node:test";
import assert from "node:assert/strict";
import { isAgentSourcedAndBlockedForStaff } from "../src/lib/rbac/agentSourceScope";

// Sprint A — KURAL 1: Non-admin staff (staff, consultant, editor, accountant)
// must not see or mutate records where agentId IS NOT NULL.
// Sprint A — KURAL 2: agent role sees only its own records (sub-agents excluded).
// These tests cover the pure helper logic (no DB needed).

// ---------------------------------------------------------------------------
// isAgentSourcedAndBlockedForStaff
// ---------------------------------------------------------------------------

test("isAgentSourcedAndBlockedForStaff: admin roles are never blocked", () => {
  for (const role of ["super_admin", "admin", "manager"]) {
    assert.equal(
      isAgentSourcedAndBlockedForStaff({ role }, 42),
      false,
      `${role} should not be blocked (agentId=42)`,
    );
    assert.equal(
      isAgentSourcedAndBlockedForStaff({ role }, null),
      false,
      `${role} should not be blocked (agentId=null)`,
    );
  }
});

test("isAgentSourcedAndBlockedForStaff: agent roles are never blocked (managed by own visibility logic)", () => {
  for (const role of ["agent", "sub_agent", "agent_staff"]) {
    assert.equal(
      isAgentSourcedAndBlockedForStaff({ role }, 7),
      false,
      `${role} should not be blocked`,
    );
    assert.equal(
      isAgentSourcedAndBlockedForStaff({ role }, null),
      false,
      `${role} should not be blocked (null agentId)`,
    );
  }
});

test("isAgentSourcedAndBlockedForStaff: non-admin staff blocked when agentId is set", () => {
  for (const role of ["staff", "consultant", "editor", "accountant"]) {
    assert.equal(
      isAgentSourcedAndBlockedForStaff({ role }, 1),
      true,
      `${role} must be blocked when agentId=1`,
    );
    assert.equal(
      isAgentSourcedAndBlockedForStaff({ role }, 99),
      true,
      `${role} must be blocked when agentId=99`,
    );
  }
});

test("isAgentSourcedAndBlockedForStaff: non-admin staff NOT blocked when agentId is null/undefined", () => {
  for (const role of ["staff", "consultant", "editor", "accountant"]) {
    assert.equal(
      isAgentSourcedAndBlockedForStaff({ role }, null),
      false,
      `${role} should see direct records (agentId=null)`,
    );
    assert.equal(
      isAgentSourcedAndBlockedForStaff({ role }, undefined),
      false,
      `${role} should see direct records (agentId=undefined)`,
    );
  }
});

test("isAgentSourcedAndBlockedForStaff: student role is NOT blocked (own visibility handled elsewhere)", () => {
  // student accesses own applications via studentId scope; KURAL 1 does not apply.
  assert.equal(
    isAgentSourcedAndBlockedForStaff({ role: "student" }, 5),
    false,
    "student must not be blocked even when agentId is set",
  );
  assert.equal(
    isAgentSourcedAndBlockedForStaff({ role: "student" }, null),
    false,
    "student must not be blocked when agentId is null",
  );
});

test("isAgentSourcedAndBlockedForStaff: agentId=0 blocks staff — 0 != null is true", () => {
  // 0 is not a valid agent PK (serial starts at 1), but the guard uses `!= null`
  // which evaluates `0 != null` as true → non-admin staff are blocked.
  // This is the safe/conservative outcome for an impossible-in-practice value.
  for (const role of ["staff", "consultant"]) {
    assert.equal(
      isAgentSourcedAndBlockedForStaff({ role }, 0),
      true,
      `${role}: agentId=0 != null is true → staff blocked (conservative)`,
    );
  }
});
