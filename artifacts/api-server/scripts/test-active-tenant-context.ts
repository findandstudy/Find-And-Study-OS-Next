import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ACTIVE_CONTEXT_TTL_MS,
  evaluateActiveTenantCapability,
  signActiveTenantContext,
  verifyActiveTenantContext,
  type ActiveTenantContextClaims,
  type ResolvedActiveContextState,
  type VerifiedActiveTenantContext,
} from "../src/lib/activeTenantContext.js";

const NOW = 2_000_000_000_000;
const SECRET = "active-context-test-secret-with-at-least-thirty-two-bytes";
const ID = {
  tenantA: "018f0000-0000-7000-8000-000000000001",
  tenantB: "018f0000-0000-7000-8000-000000000002",
  organizationA: "018f0000-0000-7000-8000-000000000003",
  principal: "018f0000-0000-7000-8000-000000000004",
  membership: "018f0000-0000-7000-8000-000000000005",
  assignment: "018f0000-0000-7000-8000-000000000006",
  package: "018f0000-0000-7000-8000-000000000007",
  policy: "018f0000-0000-7000-8000-000000000008",
  context: "018f0000-0000-7000-8000-000000000009",
};

function claims(
  overrides: Partial<ActiveTenantContextClaims> = {},
): ActiveTenantContextClaims {
  return {
    tokenVersion: 1,
    contextId: ID.context,
    tenantId: ID.tenantA,
    organizationId: ID.organizationA,
    legacyBranchId: 10,
    principalId: ID.principal,
    membershipId: ID.membership,
    assignmentIds: [ID.assignment],
    policyVersionId: ID.policy,
    policyVersion: 3,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function verifiedContext(
  overrides: Partial<ActiveTenantContextClaims> = {},
): VerifiedActiveTenantContext {
  const result = verifyActiveTenantContext(
    signActiveTenantContext(claims(overrides), SECRET),
    SECRET,
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  return result.context;
}

function state(
  overrides: {
    tenant?: Partial<ResolvedActiveContextState["tenant"]>;
    principal?: Partial<ResolvedActiveContextState["principal"]>;
    membership?: Partial<ResolvedActiveContextState["membership"]>;
    policy?: Partial<ResolvedActiveContextState["policy"]>;
    assignment?: Partial<ResolvedActiveContextState["assignments"][number]>;
  } = {},
): ResolvedActiveContextState {
  const assignment: ResolvedActiveContextState["assignments"][number] = {
    id: ID.assignment,
    tenantId: ID.tenantA,
    membershipId: ID.membership,
    status: "ACTIVE",
    validFrom: NOW - 10_000,
    validUntil: NOW + 60_000,
    scopeType: "LEGACY_BRANCH",
    organizationId: ID.organizationA,
    legacyBranchId: 10,
    constraintDocument: {},
    rolePackageVersionId: ID.package,
    rolePackageStatus: "ACTIVE",
    rolePackagePrincipalType: "HUMAN",
    rolePackageEffectiveAt: NOW - 10_000,
    rolePackageDeprecatedAt: null,
    capabilities: [
      {
        key: "students.view",
        effect: "ALLOW",
        status: "ACTIVE",
        stepUpRequired: false,
        approvalRequired: false,
      },
    ],
    ...overrides.assignment,
  };
  return {
    tenant: {
      id: ID.tenantA,
      status: "ACTIVE",
      policyVersion: 3,
      ...overrides.tenant,
    },
    principal: {
      id: ID.principal,
      principalType: "HUMAN",
      status: "ACTIVE",
      riskState: "NORMAL",
      ...overrides.principal,
    },
    membership: {
      id: ID.membership,
      tenantId: ID.tenantA,
      organizationId: ID.organizationA,
      legacyBranchId: 10,
      principalId: ID.principal,
      status: "ACTIVE",
      validFrom: NOW - 10_000,
      validUntil: NOW + 60_000,
      ...overrides.membership,
    },
    policy: {
      id: ID.policy,
      tenantId: ID.tenantA,
      version: 3,
      state: "ACTIVE",
      effectiveAt: NOW - 10_000,
      revokedAt: null,
      ...overrides.policy,
    },
    assignments: [assignment],
  };
}

function decide(
  context = verifiedContext(),
  resolved = state(),
  resource: { tenantId: string; organizationId: string; legacyBranchId: number } = {
    tenantId: ID.tenantA,
    organizationId: ID.organizationA,
    legacyBranchId: 10,
  },
) {
  return evaluateActiveTenantCapability({
    context,
    state: resolved,
    capabilityKey: "students.view",
    resource: { type: "student", id: "same-visible-id", ...resource },
    now: NOW,
  });
}

test("a signed, current, server-resolved context allows its exact capability and scope", () => {
  const decision = decide();
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "allowed");
  assert.deepEqual(decision.receipt.assignmentIds, [ID.assignment]);
  assert.deepEqual(decision.receipt.rolePackageVersionIds, [ID.package]);
  assert.equal(decision.receipt.policyVersionId, ID.policy);
});

test("malformed capability metadata fails closed instead of becoming an implicit allow", () => {
  for (const malformed of [
    {
      key: "students.view",
      effect: "UNKNOWN",
      status: "ACTIVE",
      stepUpRequired: false,
      approvalRequired: false,
    },
    {
      key: "students.view",
      effect: "ALLOW",
      status: "ACTIVE",
      approvalRequired: false,
    },
    {
      key: "students.view",
      effect: "ALLOW",
      status: "ACTIVE",
      stepUpRequired: false,
    },
  ]) {
    const resolved = state();
    resolved.assignments[0].capabilities = [malformed] as never;
    const decision = decide(verifiedContext(), resolved);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "resolved_state_invalid");
  }
});

test("malformed resolved scope and time fields fail closed without coercion", () => {
  const wildcard = state();
  wildcard.assignments[0].scopeType = "WILDCARD" as never;
  assert.equal(
    decide(verifiedContext(), wildcard).reason,
    "resolved_state_invalid",
  );

  const membershipTime = state();
  membershipTime.membership.validFrom = String(NOW - 10_000) as never;
  assert.equal(
    decide(verifiedContext(), membershipTime).reason,
    "resolved_state_invalid",
  );

  const assignmentTime = state();
  assignmentTime.assignments[0].validUntil = String(NOW + 60_000) as never;
  assert.equal(
    decide(verifiedContext(), assignmentTime).reason,
    "resolved_state_invalid",
  );

  const policyTime = state();
  policyTime.policy.effectiveAt = String(NOW - 10_000) as never;
  assert.equal(
    decide(verifiedContext(), policyTime).reason,
    "resolved_state_invalid",
  );
});

test("unsigned, tampered, weak-secret, future, and expired contexts fail closed", () => {
  assert.throws(
    () =>
      signActiveTenantContext(
        { ...claims(), injectedTenant: ID.tenantB } as never,
        SECRET,
      ),
    /claims are invalid/,
  );
  const token = signActiveTenantContext(claims(), SECRET);
  const [payload, signature] = token.split(".");
  assert.equal(verifyActiveTenantContext(payload, SECRET, NOW).ok, false);
  assert.deepEqual(
    verifyActiveTenantContext(`${payload}.${signature.slice(0, -1)}A`, SECRET, NOW),
    { ok: false, reason: "invalid_signature" },
  );
  assert.deepEqual(
    verifyActiveTenantContext(token, "short", NOW),
    { ok: false, reason: "signing_secret_unavailable" },
  );
  const future = signActiveTenantContext(
    claims({ issuedAt: NOW + 31_000, expiresAt: NOW + 60_000 }),
    SECRET,
  );
  assert.deepEqual(verifyActiveTenantContext(future, SECRET, NOW), {
    ok: false,
    reason: "not_yet_valid",
  });
  const expired = signActiveTenantContext(
    claims({ issuedAt: NOW - ACTIVE_CONTEXT_TTL_MS, expiresAt: NOW }),
    SECRET,
  );
  assert.deepEqual(verifyActiveTenantContext(expired, SECRET, NOW), {
    ok: false,
    reason: "expired",
  });
});

test("another tenant with the same visible resource id is hidden", () => {
  const decision = decide(verifiedContext(), state(), {
    tenantId: ID.tenantB,
    organizationId: ID.organizationA,
    legacyBranchId: 10,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "resource_not_found");
});

test("another branch with the same visible resource id is hidden", () => {
  const decision = decide(verifiedContext(), state(), {
    tenantId: ID.tenantA,
    organizationId: ID.organizationA,
    legacyBranchId: 11,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "resource_not_found");
});

test("revoked or expired membership and assignment state invalidates the signed context", () => {
  assert.equal(
    decide(verifiedContext(), state({ membership: { status: "REVOKED" } })).reason,
    "membership_inactive",
  );
  assert.equal(
    decide(verifiedContext(), state({ assignment: { status: "REVOKED" } })).reason,
    "assignment_inactive",
  );
  assert.equal(
    decide(
      verifiedContext(),
      state({ assignment: { validUntil: NOW } }),
    ).reason,
    "assignment_expired",
  );
});

test("policy and assignment-set changes make existing signed contexts stale", () => {
  assert.equal(
    decide(verifiedContext(), state({ tenant: { policyVersion: 4 } })).reason,
    "policy_mismatch",
  );
  const changed = state();
  changed.assignments = [];
  assert.equal(decide(verifiedContext(), changed).reason, "assignment_set_mismatch");
});

test("explicit deny wins over allow", () => {
  const resolved = state();
  resolved.assignments[0].capabilities.push({
    key: "students.view",
    effect: "DENY",
    status: "ACTIVE",
    stepUpRequired: false,
    approvalRequired: false,
  });
  assert.equal(decide(verifiedContext(), resolved).reason, "explicit_deny");
});

test("step-up and approval metadata are enforced after allow resolution", () => {
  const stepUp = state();
  stepUp.assignments[0].capabilities[0].stepUpRequired = true;
  assert.equal(decide(verifiedContext(), stepUp).reason, "step_up_required");
  const malformedStepUp = evaluateActiveTenantCapability({
    context: verifiedContext(),
    state: stepUp,
    capabilityKey: "students.view",
    resource: {
      type: "student",
      id: "student-1",
      tenantId: ID.tenantA,
      organizationId: ID.organizationA,
      legacyBranchId: 10,
    },
    stepUpSatisfied: "yes" as never,
    now: NOW,
  });
  assert.equal(malformedStepUp.reason, "step_up_required");

  const approval = state();
  approval.assignments[0].capabilities[0].approvalRequired = true;
  const denied = evaluateActiveTenantCapability({
    context: verifiedContext(),
    state: approval,
    capabilityKey: "students.view",
    resource: {
      type: "student",
      id: "student-1",
      tenantId: ID.tenantA,
      organizationId: ID.organizationA,
      legacyBranchId: 10,
    },
    now: NOW,
  });
  assert.equal(denied.reason, "approval_required");
});

test("human membership cannot carry service or AI role packages", () => {
  assert.equal(
    decide(
      verifiedContext(),
      state({ assignment: { rolePackagePrincipalType: "AI" } }),
    ).reason,
    "principal_type_mismatch",
  );
  assert.equal(
    decide(
      verifiedContext(),
      state({ principal: { principalType: "SERVICE" } }),
    ).reason,
    "principal_type_mismatch",
  );
});

test("unevaluated assignment constraints deny instead of silently broadening access", () => {
  assert.equal(
    decide(
      verifiedContext(),
      state({ assignment: { constraintDocument: { country: "TR" } } }),
    ).reason,
    "unsupported_constraint",
  );
});

test("the additive migration forces tenant RLS and keeps receipt tables immutable", () => {
  const migration = readFileSync(
    new URL(
      "../../../lib/db/drizzle/0054_authorization_corridor_foundation.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const table of [
    "tenants",
    "organizations",
    "memberships",
    "policy_versions",
    "authorization_change_receipts",
    "access_assignments",
    "access_decision_receipts",
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`));
    assert.match(migration, new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`));
  }
  assert.doesNotMatch(migration, /CREATE POLICY[^;]+FOR DELETE/is);
  assert.match(migration, /authorization_change_receipts_immutable/);
  assert.match(migration, /access_decision_receipts_immutable/);
  assert.match(migration, /access_assignments_tenant_membership_fk/);
  assert.match(
    migration,
    /FOREIGN KEY \("tenant_id", "grant_receipt_id", "id", "grant_receipt_type"\)/,
  );
  assert.match(migration, /access_decision_receipts_tenant_policy_fk/);
});
