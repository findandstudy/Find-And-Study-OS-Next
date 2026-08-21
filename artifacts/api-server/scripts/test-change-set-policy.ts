import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  createR1ChangeSetDraft,
  evaluateR1ChangeSetTransition,
  type ChangeSetActor,
  type ChangeSetSnapshot,
  type ChangeSetState,
} from "../src/lib/changeSetPolicy.js";

const NOW = 2_000_000_000_000;
const ID = {
  tenantA: "018f1000-0000-7000-8000-000000000001",
  tenantB: "018f1000-0000-7000-8000-000000000002",
  maker: "018f1000-0000-7000-8000-000000000003",
  checker: "018f1000-0000-7000-8000-000000000004",
  changeSet: "018f1000-0000-7000-8000-000000000005",
  stepUp: "018f1000-0000-7000-8000-000000000006",
  approval: "018f1000-0000-7000-8000-000000000007",
  mutation: "018f1000-0000-7000-8000-000000000008",
  rollback: "018f1000-0000-7000-8000-000000000009",
  failure: "018f1000-0000-7000-8000-00000000000a",
  revocation: "018f1000-0000-7000-8000-00000000000b",
};

const allCapabilities = [
  "control_plane.change.return",
  "control_plane.change.validate",
  "control_plane.change.simulate",
  "control_plane.change.submit_review",
  "control_plane.change.approve",
  "control_plane.change.review",
  "control_plane.change.schedule",
  "control_plane.change.publish",
  "control_plane.change.observe",
  "control_plane.change.fail",
  "control_plane.change.rollback",
  "control_plane.change.revoke",
];

function snapshot(
  status: ChangeSetState,
  overrides: Partial<ChangeSetSnapshot> = {},
): ChangeSetSnapshot {
  return {
    id: ID.changeSet,
    tenantId: ID.tenantA,
    makerPrincipalId: ID.maker,
    status,
    version: 4,
    reviewRound: ["DRAFT", "VALIDATED", "SIMULATED"].includes(status) ? 0 : 1,
    riskTier: "R1",
    approvalPolicyVersion: "r1-policy-v1",
    observationWindowSeconds: 3600,
    scheduledAt: null,
    publishedAt: null,
    observationStartedAt: null,
    ...overrides,
  };
}

function actor(overrides: Partial<ChangeSetActor> = {}): ChangeSetActor {
  return {
    tenantId: ID.tenantA,
    principalId: ID.checker,
    capabilities: allCapabilities,
    stepUpReceiptId: ID.stepUp,
    impersonating: false,
    ...overrides,
  };
}

function transition(
  status: ChangeSetState,
  toState: ChangeSetState,
  evidence: Record<string, unknown>,
  options: {
    snapshot?: Partial<ChangeSetSnapshot>;
    actor?: Partial<ChangeSetActor>;
    expectedVersion?: number;
    now?: number;
  } = {},
) {
  const current = snapshot(status, options.snapshot);
  return evaluateR1ChangeSetTransition({
    changeSet: current,
    actor: actor(options.actor),
    expectedVersion: options.expectedVersion ?? current.version,
    toState,
    reasonCode: "reviewed_change",
    policyVersion: "r1-policy-v1",
    evidence,
    now: options.now ?? NOW,
  });
}

test("typed feature-flag draft derives R1 risk, hashes, semantic diff, and rollback", () => {
  const result = createR1ChangeSetDraft({
    tenantId: ID.tenantA,
    changeType: "FEATURE_FLAG",
    title: "Enable journey beta",
    purpose: "Canary the reversible journey beta for this tenant.",
    ownerPrincipalId: ID.checker,
    makerPrincipalId: ID.maker,
    targetScope: { type: "TENANT", organizationId: null, legacyBranchId: null },
    baseVersion: 7,
    proposedVersion: 8,
    baseConfig: {
      flagKey: "journey.beta",
      enabled: false,
      cohortPercent: 0,
      reason: "Baseline is disabled.",
    },
    proposedConfig: {
      flagKey: "journey.beta",
      enabled: true,
      cohortPercent: 5,
      reason: "Start a bounded internal canary.",
    },
    dataClass: "INTERNAL",
    approvalPolicyVersion: "r1-policy-v1",
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  assert.equal(result.draft.riskTier, "R1");
  assert.equal(result.draft.affectedTenantCount, 1);
  assert.deepEqual(result.draft.semanticDiff.changedKeys, [
    "cohortPercent",
    "enabled",
    "reason",
  ]);
  assert.notEqual(result.draft.baseHash, result.draft.proposedHash);
  assert.equal(result.draft.rollbackStrategy.hash, result.draft.baseHash);
  assert.equal(result.draft.observationWindowSeconds, 3600);
  assert.equal(result.draft.compatibilityRange, "change-set-policy-v1");
  assert.equal(result.draft.rolloutStrategy.canaryRequired, true);
  assert.equal(result.draft.abortConditions.length, 2);
  assert.equal(result.draft.reviewRound, 0);
});

test("code, schema, secret, arbitrary field, and no-op proposals never enter R1", () => {
  const common = {
    tenantId: ID.tenantA,
    title: "Safe change",
    purpose: "A sufficiently detailed and reversible configuration purpose.",
    ownerPrincipalId: ID.checker,
    makerPrincipalId: ID.maker,
    targetScope: {
      type: "TENANT",
      organizationId: null,
      legacyBranchId: null,
    } as const,
    baseVersion: 1,
    proposedVersion: 2,
    dataClass: "INTERNAL" as const,
    approvalPolicyVersion: "r1-policy-v1",
  };
  assert.deepEqual(
    createR1ChangeSetDraft({
      ...common,
      changeType: "DATABASE_SCHEMA",
      baseConfig: {},
      proposedConfig: {},
    }),
    { ok: false, reason: "unsupported_change_type" },
  );
  assert.equal(
    createR1ChangeSetDraft({
      ...common,
      changeType: "FEATURE_FLAG",
      baseConfig: {
        flagKey: "safe.flag",
        enabled: false,
        cohortPercent: 0,
        reason: "Safe baseline.",
      },
      proposedConfig: {
        flagKey: "safe.flag",
        enabled: true,
        cohortPercent: 5,
        reason: "Secret was added.",
        apiSecret: "sk-supersecretvalue123456789",
      },
    }).reason,
    "sensitive_material_forbidden",
  );
  assert.equal(
    createR1ChangeSetDraft({
      ...common,
      changeType: "FEATURE_FLAG",
      baseConfig: {
        flagKey: "safe.flag",
        enabled: false,
        cohortPercent: 0,
        reason: "Safe baseline.",
      },
      proposedConfig: {
        flagKey: "safe.flag",
        enabled: true,
        cohortPercent: 5,
        reason: "Safe canary.",
        arbitraryCommand: "run something",
      },
    }).reason,
    "invalid_config_shape",
  );
  assert.equal(
    createR1ChangeSetDraft({
      ...common,
      changeType: "NOTIFICATION_TEMPLATE",
      baseConfig: {
        templateKey: "application.update",
        locale: "en",
        subject: "Application update",
        body: "There is an update.",
        variableKeys: [],
      },
      proposedConfig: {
        templateKey: "application.update",
        locale: "en",
        subject: "Update for {{student.name}}",
        body: "There is an update.",
        variableKeys: [],
      },
    }).reason,
    "invalid_config_shape",
  );
  const same = {
    flagKey: "safe.flag",
    enabled: false,
    cohortPercent: 0,
    reason: "Safe baseline.",
  };
  assert.equal(
    createR1ChangeSetDraft({
      ...common,
      changeType: "FEATURE_FLAG",
      baseConfig: same,
      proposedConfig: { ...same },
    }).reason,
    "no_semantic_change",
  );
});

test("state skipping, stale versions, cross-tenant actors, and impersonation fail closed", () => {
  assert.equal(
    transition("DRAFT", "APPROVED", {}).reason,
    "invalid_transition",
  );
  assert.equal(
    transition(
      "DRAFT",
      "VALIDATED",
      { validationPassed: true },
      { expectedVersion: 3 },
    ).reason,
    "stale_version",
  );
  assert.equal(
    transition(
      "DRAFT",
      "VALIDATED",
      { validationPassed: true },
      { actor: { tenantId: ID.tenantB } },
    ).reason,
    "tenant_mismatch",
  );
  assert.equal(
    transition(
      "CANARY",
      "PUBLISHED",
      { canaryPassed: true, mutationReceiptId: ID.mutation },
      { actor: { impersonating: true } },
    ).reason,
    "impersonation_forbidden",
  );
});

test("validation, simulation, and review require explicit evidence", () => {
  assert.equal(
    transition("DRAFT", "VALIDATED", {}).reason,
    "validation_failed",
  );
  assert.equal(
    transition("VALIDATED", "SIMULATED", {}).reason,
    "simulation_failed",
  );
  assert.equal(
    transition("SIMULATED", "IN_REVIEW", { testEvidenceCount: 1 }).reason,
    "review_evidence_incomplete",
  );
  const submitted = transition("SIMULATED", "IN_REVIEW", {
    testEvidenceCount: 1,
    rollbackReady: true,
    canaryPrepared: true,
  });
  assert.equal(submitted.allowed, true);
  if (!submitted.allowed) throw new Error(submitted.reason);
  assert.equal(submitted.next.reviewRound, 1);
  assert.equal(submitted.next.checkerPrincipalId, null);
});

test("maker cannot approve and an independent checker needs step-up plus approval receipt", () => {
  const evidence = {
    decision: "APPROVED",
    approvalReceiptId: ID.approval,
    stepUpReceiptId: ID.stepUp,
    reviewRound: 1,
  };
  assert.equal(
    transition("IN_REVIEW", "APPROVED", evidence, {
      actor: { principalId: ID.maker },
    }).reason,
    "maker_checker_conflict",
  );
  assert.equal(
    transition("IN_REVIEW", "APPROVED", evidence, {
      actor: { stepUpReceiptId: null },
    }).reason,
    "step_up_required",
  );
  assert.equal(
    transition("IN_REVIEW", "APPROVED", {
      decision: "APPROVED",
      stepUpReceiptId: ID.stepUp,
      reviewRound: 1,
    }).reason,
    "approval_receipt_required",
  );
  assert.equal(
    transition("IN_REVIEW", "APPROVED", { ...evidence, reviewRound: 2 }).reason,
    "review_round_mismatch",
  );
  const approved = transition("IN_REVIEW", "APPROVED", evidence);
  assert.equal(approved.allowed, true);
  if (!approved.allowed) throw new Error(approved.reason);
  assert.equal(approved.next.checkerPrincipalId, ID.checker);
  assert.equal(approved.receipt.fromState, "IN_REVIEW");
  assert.equal(approved.receipt.toState, "APPROVED");
  assert.equal(approved.receipt.sequence, 5);
});

test("scheduling, canary, and publishing require time and execution receipts", () => {
  assert.equal(
    transition("APPROVED", "SCHEDULED", { scheduledAt: NOW - 1 }).reason,
    "schedule_invalid",
  );
  assert.equal(
    transition(
      "SCHEDULED",
      "CANARY",
      { mutationReceiptId: ID.mutation },
      { snapshot: { scheduledAt: NOW + 1 } },
    ).reason,
    "schedule_not_reached",
  );
  assert.equal(
    transition("SCHEDULED", "CANARY", {}, { snapshot: { scheduledAt: NOW } })
      .reason,
    "publish_receipt_required",
  );
  assert.equal(
    transition("CANARY", "PUBLISHED", { mutationReceiptId: ID.mutation })
      .reason,
    "canary_failed",
  );
  assert.equal(
    transition("CANARY", "PUBLISHED", {
      mutationReceiptId: ID.mutation,
      canaryPassed: true,
    }).allowed,
    true,
  );
});

test("R1 cannot become effective before one clean observation hour", () => {
  assert.equal(
    transition("PUBLISHED", "OBSERVING", {}).reason,
    "observation_baseline_missing",
  );
  assert.equal(
    transition(
      "OBSERVING",
      "EFFECTIVE",
      { guardrailsPassed: true, sloViolationCount: 0 },
      { snapshot: { observationStartedAt: NOW - 3_599_999 } },
    ).reason,
    "observation_window_incomplete",
  );
  assert.equal(
    transition(
      "OBSERVING",
      "EFFECTIVE",
      { guardrailsPassed: true, sloViolationCount: 1 },
      { snapshot: { observationStartedAt: NOW - 3_600_000 } },
    ).reason,
    "observation_guardrail_failed",
  );
  const effective = transition(
    "OBSERVING",
    "EFFECTIVE",
    { guardrailsPassed: true, sloViolationCount: 0 },
    { snapshot: { observationStartedAt: NOW - 3_600_000 } },
  );
  assert.equal(effective.allowed, true);
  if (!effective.allowed) throw new Error(effective.reason);
  assert.equal(effective.next.effectiveAt, NOW);
  assert.equal(effective.next.closedAt, NOW);
});

test("rollback is evidence-bearing and the receipt hash chains deterministically", () => {
  assert.equal(
    transition("PUBLISHED", "ROLLED_BACK", {}).reason,
    "rollback_evidence_required",
  );
  const first = evaluateR1ChangeSetTransition({
    changeSet: snapshot("PUBLISHED"),
    actor: actor(),
    expectedVersion: 4,
    toState: "ROLLED_BACK",
    reasonCode: "guardrail_abort",
    policyVersion: "r1-policy-v1",
    evidence: { rollbackApplied: true, rollbackReceiptId: ID.rollback },
    previousReceiptHash: "a".repeat(64),
    now: NOW,
  });
  const second = evaluateR1ChangeSetTransition({
    changeSet: snapshot("PUBLISHED"),
    actor: actor(),
    expectedVersion: 4,
    toState: "ROLLED_BACK",
    reasonCode: "guardrail_abort",
    policyVersion: "r1-policy-v1",
    evidence: { rollbackApplied: true, rollbackReceiptId: ID.rollback },
    previousReceiptHash: "a".repeat(64),
    now: NOW,
  });
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, true);
  if (!first.allowed || !second.allowed) throw new Error("rollback denied");
  assert.equal(first.receipt.receiptHash, second.receipt.receiptHash);
  assert.equal(first.receipt.previousHash, "a".repeat(64));
});

test("runtime-shaped invalid input, policy drift, failure, and revocation fail closed", () => {
  assert.equal(
    createR1ChangeSetDraft({
      tenantId: ID.tenantA,
      changeType: "FEATURE_FLAG",
      title: "Invalid scope",
      purpose: "Prove runtime input cannot bypass the typed scope union.",
      ownerPrincipalId: ID.checker,
      makerPrincipalId: ID.maker,
      targetScope: null as unknown as Parameters<
        typeof createR1ChangeSetDraft
      >[0]["targetScope"],
      baseVersion: 1,
      proposedVersion: 2,
      baseConfig: {
        flagKey: "safe.flag",
        enabled: false,
        cohortPercent: 0,
        reason: "Base state.",
      },
      proposedConfig: {
        flagKey: "safe.flag",
        enabled: true,
        cohortPercent: 5,
        reason: "Canary state.",
      },
      dataClass: "INTERNAL",
      approvalPolicyVersion: "r1-policy-v1",
    }).reason,
    "invalid_scope",
  );
  const invalidStatus = evaluateR1ChangeSetTransition({
    changeSet: snapshot("DRAFT", { status: "UNKNOWN" as ChangeSetState }),
    actor: actor(),
    expectedVersion: 4,
    toState: "VALIDATED",
    reasonCode: "invalid_runtime_state",
    policyVersion: "r1-policy-v1",
    evidence: { validationPassed: true },
    now: NOW,
  });
  assert.equal(invalidStatus.reason, "invalid_snapshot");
  assert.equal(
    evaluateR1ChangeSetTransition({
      changeSet: snapshot("DRAFT"),
      actor: actor(),
      expectedVersion: 4,
      toState: "VALIDATED",
      reasonCode: "stale_policy",
      policyVersion: "r1-policy-v0",
      evidence: { validationPassed: true },
      now: NOW,
    }).reason,
    "policy_version_mismatch",
  );
  assert.equal(
    transition("VALIDATED", "FAILED", {}).reason,
    "failure_evidence_required",
  );
  assert.equal(
    transition("VALIDATED", "FAILED", {
      failureRecorded: true,
      failureReceiptId: ID.failure,
    }).allowed,
    true,
  );
  assert.equal(
    transition("APPROVED", "REVOKED", {}).reason,
    "revocation_evidence_required",
  );
  assert.equal(
    transition("APPROVED", "REVOKED", {
      revocationRecorded: true,
      revocationReceiptId: ID.revocation,
    }).allowed,
    true,
  );
});

test("migration forces tenant RLS, immutable receipts, SoD, and state receipts", () => {
  const migration = readFileSync(
    new URL(
      "../../../lib/db/drizzle/0055_change_set_control_plane_foundation.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const table of [
    "change_sets",
    "change_set_approvals",
    "change_set_transition_receipts",
  ]) {
    assert.match(
      migration,
      new RegExp(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`),
    );
    assert.match(
      migration,
      new RegExp(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`),
    );
  }
  assert.doesNotMatch(migration, /CREATE POLICY[^;]+FOR DELETE/is);
  assert.match(migration, /change set maker cannot act as checker/);
  assert.match(
    migration,
    /transition receipt must be written before state mutation/,
  );
  assert.match(
    migration,
    /independent current-round decision receipt is required/,
  );
  assert.match(migration, /change_set_approvals_review_round_uq/);
  assert.match(migration, /change set decision requires IN_REVIEW state/);
  assert.match(migration, /change set decision review round mismatch/);
  assert.match(migration, /change set decision policy version mismatch/);
  assert.match(migration, /change set must be inserted in a clean DRAFT state/);
  assert.match(migration, /change_set_transition_receipts_chain/);
  assert.match(
    migration,
    /transition receipt sequence must follow current version/,
  );
  assert.match(migration, /transition receipt source state mismatch/);
  assert.match(migration, /transition receipt policy version mismatch/);
  assert.match(migration, /transition receipt previous hash mismatch/);
  assert.match(
    migration,
    /entering review must increment the review round exactly once/,
  );
  assert.match(migration, /entering review must clear the prior checker/);
  assert.match(
    migration,
    /change set checker can only change on a review decision/,
  );
  assert.match(migration, /change set identity and maker are immutable/);
  assert.match(
    migration,
    /validated change set payload and scope are immutable/,
  );
  assert.match(migration, /change_set_approvals_immutable/);
  assert.match(migration, /change_set_transition_receipts_immutable/);
});
