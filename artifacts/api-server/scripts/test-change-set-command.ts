import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  signActiveTenantContext,
  verifyActiveTenantContext,
  type ResolvedActiveContextState,
  type VerifiedActiveTenantContext,
} from "../src/lib/activeTenantContext.js";
import {
  executeCreateR1ChangeSetCommand,
  executeTransitionR1ChangeSetCommand,
  type AccessDecisionReceiptInsert,
  type AuthoritativeR1Configuration,
  type ChangeSetApprovalInsert,
  type ChangeSetCommandClaim,
  type ChangeSetCommandClaimResult,
  type ChangeSetCommandStore,
  type ChangeSetCommandSuccess,
  type ChangeSetCommandTransaction,
  type ChangeSetTransitionReceiptInsert,
  type MutationAssurance,
  type StoredR1ChangeSet,
  type VerifiedTransitionEvidence,
} from "../src/lib/changeSetCommand.js";
import type { R1ChangeSetDraft } from "../src/lib/changeSetPolicy.js";

const NOW = 2_000_000_000_000;
const SECRET = "change-set-command-test-secret-32-bytes-minimum";
const ID = {
  tenant: "018f2000-0000-7000-8000-000000000001",
  organization: "018f2000-0000-7000-8000-000000000002",
  maker: "018f2000-0000-7000-8000-000000000003",
  checker: "018f2000-0000-7000-8000-000000000004",
  makerMembership: "018f2000-0000-7000-8000-000000000005",
  checkerMembership: "018f2000-0000-7000-8000-000000000006",
  makerAssignment: "018f2000-0000-7000-8000-000000000007",
  checkerAssignment: "018f2000-0000-7000-8000-000000000008",
  package: "018f2000-0000-7000-8000-000000000009",
  policy: "018f2000-0000-7000-8000-00000000000a",
  makerContext: "018f2000-0000-7000-8000-00000000000b",
  checkerContext: "018f2000-0000-7000-8000-00000000000c",
  stepUp: "018f2000-0000-7000-8000-00000000000d",
  existingChangeSet: "018f2000-0000-7000-8000-00000000000e",
  validationReceipt: "018f2000-0000-7000-8000-00000000000f",
  simulationReceipt: "018f2000-0000-7000-8000-000000000010",
  testArtifactReceipt: "018f2000-0000-7000-8000-000000000011",
  rollbackPlanReceipt: "018f2000-0000-7000-8000-000000000012",
  canaryPlanReceipt: "018f2000-0000-7000-8000-000000000013",
};

function verifiedContext(principal: "maker" | "checker") {
  const maker = principal === "maker";
  const token = signActiveTenantContext(
    {
      tokenVersion: 1,
      contextId: maker ? ID.makerContext : ID.checkerContext,
      tenantId: ID.tenant,
      organizationId: null,
      legacyBranchId: null,
      principalId: maker ? ID.maker : ID.checker,
      membershipId: maker ? ID.makerMembership : ID.checkerMembership,
      assignmentIds: [maker ? ID.makerAssignment : ID.checkerAssignment],
      policyVersionId: ID.policy,
      policyVersion: 1,
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 60_000,
    },
    SECRET,
  );
  const verified = verifyActiveTenantContext(token, SECRET, NOW);
  if (!verified.ok) throw new Error(verified.reason);
  return verified.context;
}

function resolvedState(
  context: VerifiedActiveTenantContext,
  capabilities: string[],
): ResolvedActiveContextState {
  return {
    tenant: { id: ID.tenant, status: "ACTIVE", policyVersion: 1 },
    principal: {
      id: context.principalId,
      principalType: "HUMAN",
      status: "ACTIVE",
      riskState: "NORMAL",
    },
    membership: {
      id: context.membershipId,
      tenantId: ID.tenant,
      organizationId: null,
      legacyBranchId: null,
      principalId: context.principalId,
      status: "ACTIVE",
      validFrom: NOW - 10_000,
      validUntil: null,
    },
    policy: {
      id: ID.policy,
      tenantId: ID.tenant,
      version: 1,
      state: "ACTIVE",
      effectiveAt: NOW - 10_000,
      revokedAt: null,
    },
    assignments: [
      {
        id: context.assignmentIds[0],
        tenantId: ID.tenant,
        membershipId: context.membershipId,
        status: "ACTIVE",
        validFrom: NOW - 10_000,
        validUntil: null,
        scopeType: "TENANT",
        organizationId: null,
        legacyBranchId: null,
        constraintDocument: {},
        rolePackageVersionId: ID.package,
        rolePackageStatus: "ACTIVE",
        rolePackagePrincipalType: "HUMAN",
        rolePackageEffectiveAt: NOW - 10_000,
        rolePackageDeprecatedAt: null,
        capabilities: capabilities.map((key) => ({
          key,
          effect: "ALLOW",
          status: "ACTIVE",
          stepUpRequired: !key.endsWith(".create"),
          approvalRequired: false,
        })),
      },
    ],
  };
}

type ClaimRow = ChangeSetCommandClaim & {
  status: "CLAIMED" | "COMPLETED";
  result: ChangeSetCommandSuccess | null;
  resultHash: string | null;
};

const DEFAULT_AUTHORITATIVE_CONFIGURATION: AuthoritativeR1Configuration = {
  version: 1,
  activeProposalId: null,
  config: {
    flagKey: "journey.beta",
    enabled: false,
    cohortPercent: 0,
    reason: "Baseline state.",
  },
};

class MemoryStore implements ChangeSetCommandStore {
  claims = new Map<string, ClaimRow>();
  changes = new Map<string, StoredR1ChangeSet>();
  receipts: ChangeSetTransitionReceiptInsert[] = [];
  approvals: ChangeSetApprovalInsert[] = [];
  accessDecisions: AccessDecisionReceiptInsert[] = [];
  drafts: R1ChangeSetDraft[] = [];
  verifiedEvidenceOverride: VerifiedTransitionEvidence | null | undefined;
  events: string[] = [];

  constructor(
    readonly stateResolver: (
      context: VerifiedActiveTenantContext,
    ) => ResolvedActiveContextState,
    readonly assurance: MutationAssurance,
    readonly authoritative: AuthoritativeR1Configuration | null = DEFAULT_AUTHORITATIVE_CONFIGURATION,
  ) {}

  async transaction<T>(
    operation: (transaction: ChangeSetCommandTransaction) => Promise<T>,
  ): Promise<T> {
    const claims = new Map(
      [...this.claims].map(([key, value]) => [key, structuredClone(value)]),
    );
    const changes = new Map(
      [...this.changes].map(([key, value]) => [key, structuredClone(value)]),
    );
    const receipts = structuredClone(this.receipts);
    const approvals = structuredClone(this.approvals);
    const accessDecisions = structuredClone(this.accessDecisions);
    const drafts = structuredClone(this.drafts);
    const events: string[] = [];
    let activeTenant: string | null = null;
    const requireTenant = (tenantId: string) => {
      if (activeTenant !== tenantId) throw new Error("tenant context missing");
    };
    const tx: ChangeSetCommandTransaction = {
      setLocalTenant: async (tenantId) => {
        activeTenant = tenantId;
        events.push("SET_TENANT");
      },
      loadAuthoritativeR1ConfigurationForUpdate: async ({
        tenantId,
        changeType,
        targetScope,
      }) => {
        requireTenant(tenantId);
        events.push("LOAD_AUTHORITATIVE_CONFIG");
        if (!this.authoritative) return null;
        const activeIndex = drafts.findIndex(
          (draft) =>
            draft.tenantId === tenantId &&
            draft.changeType === changeType &&
            JSON.stringify(draft.targetScope) === JSON.stringify(targetScope),
        );
        return {
          ...structuredClone(this.authoritative),
          activeProposalId:
            this.authoritative.activeProposalId ??
            (activeIndex >= 0 ? [...changes.keys()][activeIndex] : null),
        };
      },
      resolveActiveContextState: async (context) => {
        requireTenant(context.tenantId);
        events.push("RESOLVE_STATE");
        return this.stateResolver(context);
      },
      resolveMutationAssurance: async (context) => {
        requireTenant(context.tenantId);
        events.push("RESOLVE_ASSURANCE");
        return this.assurance;
      },
      claimCommand: async (claim) => {
        requireTenant(claim.tenantId);
        events.push("CLAIM");
        const key = `${claim.tenantId}:${claim.idempotencyKeyHash}`;
        const existing = claims.get(key);
        if (!existing) {
          claims.set(key, {
            ...claim,
            status: "CLAIMED",
            result: null,
            resultHash: null,
          });
          return { kind: "CLAIMED" };
        }
        if (
          existing.requestHash !== claim.requestHash ||
          existing.actorPrincipalId !== claim.actorPrincipalId
        )
          return { kind: "CONFLICT", commandReceiptId: existing.id };
        if (existing.status !== "COMPLETED") {
          return { kind: "IN_PROGRESS", commandReceiptId: existing.id };
        }
        return {
          kind: "REPLAY",
          commandReceiptId: existing.id,
          requestHash: existing.requestHash,
          actorPrincipalId: existing.actorPrincipalId,
          result: existing.result,
          resultHash: existing.resultHash,
        } satisfies ChangeSetCommandClaimResult;
      },
      loadChangeSetForUpdate: async (tenantId, changeSetId) => {
        requireTenant(tenantId);
        events.push("LOAD_CHANGE_SET");
        const value = changes.get(changeSetId);
        return value?.tenantId === tenantId ? structuredClone(value) : null;
      },
      loadVerifiedTransitionEvidenceForUpdate: async ({
        tenantId,
        changeSetId,
        actorPrincipalId,
        toState,
      }) => {
        requireTenant(tenantId);
        events.push("LOAD_VERIFIED_EVIDENCE");
        const changeSet = changes.get(changeSetId);
        if (!changeSet) return null;
        if (this.verifiedEvidenceOverride !== undefined) {
          return this.verifiedEvidenceOverride
            ? structuredClone(this.verifiedEvidenceOverride)
            : null;
        }
        const envelope = (
          receiptSpecs: Array<
            readonly [
              string,
              (
                | "VALIDATION"
                | "SIMULATION"
                | "TEST_ARTIFACT"
                | "ROLLBACK_PLAN"
                | "CANARY_PLAN"
              ),
            ]
          >,
          evidence: Record<string, unknown>,
        ) => ({
          receipts: receiptSpecs.map(([id, kind]) => ({
            id,
            kind,
            issuer: "fas-evidence-service",
            toolVersion: "test-v1",
            tenantId,
            changeSetId,
            targetState: toState,
            requestedByPrincipalId: actorPrincipalId,
            subjectHash: changeSet.proposedHash,
            policyVersionId: changeSet.approvalPolicyVersion,
            issuedAt: NOW - 1_000,
            expiresAt: NOW + 60_000,
            consumedAt: null,
          })),
          evidence,
        });
        if (toState === "VALIDATED") {
          return envelope([[ID.validationReceipt, "VALIDATION"]], {
            validationPassed: true,
          });
        }
        if (toState === "SIMULATED") {
          return envelope([[ID.simulationReceipt, "SIMULATION"]], {
            simulationPassed: true,
          });
        }
        if (toState === "IN_REVIEW") {
          return envelope(
            [
              [ID.testArtifactReceipt, "TEST_ARTIFACT"],
              [ID.rollbackPlanReceipt, "ROLLBACK_PLAN"],
              [ID.canaryPlanReceipt, "CANARY_PLAN"],
            ],
            {
              rollbackReady: true,
              canaryPrepared: true,
              testEvidenceCount: 1,
            },
          );
        }
        return envelope([[ID.validationReceipt, "VALIDATION"]], {});
      },
      loadLatestTransitionReceiptHash: async (tenantId, changeSetId) => {
        requireTenant(tenantId);
        events.push("LOAD_RECEIPT_HASH");
        return (
          receipts
            .filter(
              (receipt) =>
                receipt.tenantId === tenantId &&
                receipt.changeSetId === changeSetId,
            )
            .sort((left, right) => right.sequence - left.sequence)[0]
            ?.receiptHash ?? null
        );
      },
      insertAccessDecisionReceipt: async (receipt) => {
        requireTenant(receipt.tenantId);
        events.push("INSERT_ACCESS_DECISION");
        accessDecisions.push(receipt);
      },
      insertChangeSet: async ({ id, draft }) => {
        requireTenant(draft.tenantId);
        events.push("INSERT_CHANGE_SET");
        drafts.push(structuredClone(draft));
        changes.set(id, {
          id,
          tenantId: draft.tenantId,
          makerPrincipalId: draft.makerPrincipalId,
          targetScope: draft.targetScope,
          proposedHash: draft.proposedHash,
          status: draft.status,
          version: draft.version,
          reviewRound: draft.reviewRound,
          riskTier: draft.riskTier,
          approvalPolicyVersion: draft.approvalPolicyVersion,
          observationWindowSeconds: draft.observationWindowSeconds,
          scheduledAt: null,
          publishedAt: null,
          observationStartedAt: null,
        });
      },
      insertApproval: async (approval) => {
        requireTenant(approval.tenantId);
        events.push("INSERT_APPROVAL");
        approvals.push(approval);
      },
      insertTransitionReceipt: async (receipt) => {
        requireTenant(receipt.tenantId);
        events.push("INSERT_TRANSITION_RECEIPT");
        receipts.push(receipt);
      },
      updateChangeSet: async (update) => {
        requireTenant(update.tenantId);
        events.push("UPDATE_CHANGE_SET");
        const current = changes.get(update.changeSetId);
        if (!current || current.version !== update.expectedVersion) {
          throw new Error("optimistic concurrency conflict");
        }
        changes.set(update.changeSetId, {
          ...current,
          ...update.next,
          reviewRound: update.next.reviewRound ?? current.reviewRound,
          scheduledAt: update.next.scheduledAt ?? current.scheduledAt,
          publishedAt: update.next.publishedAt ?? current.publishedAt,
          observationStartedAt:
            update.next.observationStartedAt ?? current.observationStartedAt,
        });
      },
      completeCommand: async (completion) => {
        events.push("COMPLETE_COMMAND");
        const row = [...claims.values()].find(
          (claim) => claim.id === completion.commandReceiptId,
        );
        if (!row) throw new Error("claim not found");
        row.status = "COMPLETED";
        row.result = completion.result;
        row.resultHash = completion.resultHash;
        row.changeSetId = completion.changeSetId;
      },
    };
    const result = await operation(tx);
    this.claims = claims;
    this.changes = changes;
    this.receipts = receipts;
    this.approvals = approvals;
    this.accessDecisions = accessDecisions;
    this.drafts = drafts;
    this.events.push(...events);
    return result;
  }
}

function idFactory(start = 100) {
  let counter = start;
  return () =>
    `018f2000-0000-7000-8000-${(counter++).toString(16).padStart(12, "0")}`;
}

function createCommand(idempotencyKey = "create:journey-beta:0001") {
  return {
    idempotencyKey,
    changeType: "FEATURE_FLAG",
    title: "Enable journey beta",
    purpose: "Run a bounded and reversible tenant canary.",
    targetScope: {
      type: "TENANT" as const,
      organizationId: null,
      legacyBranchId: null,
    },
    proposedConfig: {
      flagKey: "journey.beta",
      enabled: true,
      cohortPercent: 5,
      reason: "Bounded canary.",
    },
  };
}

function existingChangeSet(): StoredR1ChangeSet {
  return {
    id: ID.existingChangeSet,
    tenantId: ID.tenant,
    makerPrincipalId: ID.maker,
    targetScope: {
      type: "TENANT",
      organizationId: null,
      legacyBranchId: null,
    },
    proposedHash: "b".repeat(64),
    status: "IN_REVIEW",
    version: 4,
    reviewRound: 1,
    riskTier: "R1",
    approvalPolicyVersion: ID.policy,
    observationWindowSeconds: 3600,
    scheduledAt: null,
    publishedAt: null,
    observationStartedAt: null,
  };
}

test("create derives authority from verified context and commits one idempotent draft", async () => {
  const context = verifiedContext("maker");
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
  );
  const dependencies = { store, nextUuidV7: idFactory(), now: () => NOW };
  const command = createCommand();
  const first = await executeCreateR1ChangeSetCommand({
    context,
    command,
    dependencies,
  });
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error(first.reason);
  assert.equal(first.replayed, false);
  assert.equal(store.changes.size, 1);
  assert.deepEqual(store.events, [
    "SET_TENANT",
    "RESOLVE_STATE",
    "RESOLVE_ASSURANCE",
    "CLAIM",
    "INSERT_ACCESS_DECISION",
    "LOAD_AUTHORITATIVE_CONFIG",
    "INSERT_CHANGE_SET",
    "COMPLETE_COMMAND",
  ]);

  const replay = await executeCreateR1ChangeSetCommand({
    context,
    command,
    dependencies,
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) throw new Error(replay.reason);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(store.changes.size, 1);
  assert.equal(
    store.events.filter((event) => event === "INSERT_CHANGE_SET").length,
    1,
  );
  assert.equal(store.accessDecisions.length, 2);
  assert.equal(store.drafts[0].baseVersion, 1);
  assert.equal(store.drafts[0].proposedVersion, 2);
  assert.equal(
    store.accessDecisions[0].correlationId,
    store.accessDecisions[1].correlationId,
  );
});

test("create rejects client authority fields and requires a server baseline", async () => {
  const context = verifiedContext("maker");
  const stateResolver = (active: VerifiedActiveTenantContext) =>
    resolvedState(active, ["control_plane.flag.create"]);
  const assurance = {
    impersonating: false,
    stepUpSatisfied: false,
    stepUpReceiptId: null,
  };
  const suppliedAuthority = {
    ...createCommand("create:client-authority:0001"),
    baseVersion: 999,
    proposedVersion: 1_000,
    baseConfig: { flagKey: "journey.beta", enabled: true },
    dataClass: "PUBLIC",
  } as unknown as ReturnType<typeof createCommand>;
  const shapeRejected = await executeCreateR1ChangeSetCommand({
    context,
    command: suppliedAuthority,
    dependencies: {
      store: new MemoryStore(stateResolver, assurance),
      nextUuidV7: idFactory(),
      now: () => NOW,
    },
  });
  assert.deepEqual(shapeRejected, {
    ok: false,
    reason: "draft_rejected",
    detail: "invalid_command_shape",
  });

  const missingBaseline = new MemoryStore(stateResolver, assurance, null);
  const baselineRejected = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:missing-baseline:0001"),
    dependencies: {
      store: missingBaseline,
      nextUuidV7: idFactory(),
      now: () => NOW,
    },
  });
  assert.deepEqual(baselineRejected, {
    ok: false,
    reason: "draft_rejected",
    detail: "authoritative_baseline_unavailable",
  });
  assert.equal(missingBaseline.claims.size, 0);
  assert.equal(missingBaseline.accessDecisions.length, 0);
});

test("both command entrypoints reject an unverified runtime context", async () => {
  const copied = structuredClone(
    verifiedContext("maker"),
  ) as VerifiedActiveTenantContext;
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
  );
  const dependencies = { store, nextUuidV7: idFactory(), now: () => NOW };
  assert.deepEqual(
    await executeCreateR1ChangeSetCommand({
      context: copied,
      command: createCommand("create:forged-context:0001"),
      dependencies,
    }),
    { ok: false, reason: "unverified_context" },
  );
  assert.deepEqual(
    await executeTransitionR1ChangeSetCommand({
      context: copied,
      command: {
        idempotencyKey: "validate:forged-context:0001",
        changeSetId: ID.existingChangeSet,
        expectedVersion: 1,
        toState: "VALIDATED",
        reasonCode: "forged_context",
      },
      dependencies,
    }),
    { ok: false, reason: "unverified_context" },
  );
  assert.deepEqual(store.events, []);
});

test("a previously verified context fails closed after its TTL", async () => {
  const context = verifiedContext("maker");
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
  );
  const result = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:expired-context:0001"),
    dependencies: {
      store,
      nextUuidV7: idFactory(),
      now: () => NOW + 60_000,
    },
  });
  assert.deepEqual(result, { ok: false, reason: "unverified_context" });
  assert.deepEqual(store.events, []);
});

test("missing capability and impersonation deny before an idempotency claim", async () => {
  const context = verifiedContext("maker");
  const denied = new MemoryStore((active) => resolvedState(active, []), {
    impersonating: false,
    stepUpSatisfied: false,
    stepUpReceiptId: null,
  });
  const deniedResult = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand(),
    dependencies: { store: denied, nextUuidV7: idFactory(), now: () => NOW },
  });
  assert.equal(deniedResult.ok, false);
  if (deniedResult.ok) throw new Error("unexpected allow");
  assert.equal(deniedResult.reason, "authorization_denied");
  assert.equal(denied.claims.size, 0);

  const impersonating = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: true, stepUpSatisfied: true, stepUpReceiptId: ID.stepUp },
  );
  const impersonatedResult = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:journey-beta:0002"),
    dependencies: {
      store: impersonating,
      nextUuidV7: idFactory(),
      now: () => NOW,
    },
  });
  assert.equal(impersonatedResult.ok, false);
  if (impersonatedResult.ok) throw new Error("unexpected allow");
  assert.equal(impersonatedResult.reason, "impersonation_forbidden");
  assert.equal(impersonating.claims.size, 0);
});

test("idempotency key reuse with a changed request fails closed", async () => {
  const context = verifiedContext("maker");
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
  );
  const dependencies = { store, nextUuidV7: idFactory(), now: () => NOW };
  const first = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand(),
    dependencies,
  });
  assert.equal(first.ok, true);
  const reused = await executeCreateR1ChangeSetCommand({
    context,
    command: { ...createCommand(), title: "Different title" },
    dependencies,
  });
  assert.deepEqual(reused, { ok: false, reason: "idempotency_key_reused" });
  assert.equal(store.changes.size, 1);
});

test("a second active proposal for the same scope, type, and base is rejected", async () => {
  const context = verifiedContext("maker");
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
  );
  const dependencies = { store, nextUuidV7: idFactory(), now: () => NOW };
  const first = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:proposal-reservation:0001"),
    dependencies,
  });
  assert.equal(first.ok, true);
  const competing = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:proposal-reservation:0002"),
    dependencies,
  });
  assert.deepEqual(competing, {
    ok: false,
    reason: "draft_rejected",
    detail: "active_proposal_exists",
  });
  assert.equal(store.changes.size, 1);
  assert.equal(store.claims.size, 1);
});

test("runtime scope, clock, generated IDs, and replay projections fail closed", async () => {
  const context = verifiedContext("maker");
  const makeStore = () =>
    new MemoryStore(
      (active) => resolvedState(active, ["control_plane.flag.create"]),
      { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
    );
  const invalidScope = await executeCreateR1ChangeSetCommand({
    context,
    command: {
      ...createCommand("create:invalid-scope:0001"),
      targetScope: null as unknown as ReturnType<
        typeof createCommand
      >["targetScope"],
    },
    dependencies: {
      store: makeStore(),
      nextUuidV7: idFactory(),
      now: () => NOW,
    },
  });
  assert.deepEqual(invalidScope, {
    ok: false,
    reason: "draft_rejected",
    detail: "invalid_scope",
  });
  const invalidClock = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:invalid-clock:0001"),
    dependencies: {
      store: makeStore(),
      nextUuidV7: idFactory(),
      now: () => NaN,
    },
  });
  assert.deepEqual(invalidClock, { ok: false, reason: "invalid_clock" });

  const badIdStore = makeStore();
  const badId = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:invalid-id:000001"),
    dependencies: {
      store: badIdStore,
      nextUuidV7: () => "018f2000-0000-4000-8000-000000000001",
      now: () => NOW,
    },
  });
  assert.deepEqual(badId, { ok: false, reason: "invalid_generated_id" });
  assert.equal(badIdStore.claims.size, 0);

  const replayStore = makeStore();
  const command = createCommand("create:corrupt-replay:0001");
  const dependencies = {
    store: replayStore,
    nextUuidV7: idFactory(400),
    now: () => NOW,
  };
  const created = await executeCreateR1ChangeSetCommand({
    context,
    command,
    dependencies,
  });
  assert.equal(created.ok, true);
  const claim = [...replayStore.claims.values()][0];
  if (!claim.result) throw new Error("completed claim result missing");
  claim.result = {
    ...claim.result,
    version: claim.result.version + 1,
  };
  const corruptedReplay = await executeCreateR1ChangeSetCommand({
    context,
    command,
    dependencies,
  });
  assert.deepEqual(corruptedReplay, {
    ok: false,
    reason: "replay_result_invalid",
  });
});

test("validated transition is atomic, idempotent, and audit-correlated", async () => {
  const context = verifiedContext("maker");
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.change.validate"]),
    { impersonating: false, stepUpSatisfied: true, stepUpReceiptId: ID.stepUp },
  );
  store.changes.set(ID.existingChangeSet, {
    ...existingChangeSet(),
    status: "DRAFT",
    version: 1,
    reviewRound: 0,
  });
  const dependencies = { store, nextUuidV7: idFactory(450), now: () => NOW };
  const command = {
    idempotencyKey: "validate:existing-change:0001",
    changeSetId: ID.existingChangeSet,
    expectedVersion: 1,
    toState: "VALIDATED" as const,
    reasonCode: "validation_checks_passed",
  };
  const first = await executeTransitionR1ChangeSetCommand({
    context,
    command,
    dependencies,
  });
  assert.equal(first.ok, true);
  if (!first.ok) throw new Error(first.reason);
  assert.equal(first.replayed, false);
  assert.equal(first.result.status, "VALIDATED");
  assert.deepEqual(store.events, [
    "SET_TENANT",
    "LOAD_CHANGE_SET",
    "RESOLVE_STATE",
    "RESOLVE_ASSURANCE",
    "CLAIM",
    "INSERT_ACCESS_DECISION",
    "LOAD_RECEIPT_HASH",
    "LOAD_VERIFIED_EVIDENCE",
    "INSERT_TRANSITION_RECEIPT",
    "UPDATE_CHANGE_SET",
    "COMPLETE_COMMAND",
  ]);

  const replay = await executeTransitionR1ChangeSetCommand({
    context,
    command,
    dependencies,
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) throw new Error(replay.reason);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, first.result);
  assert.equal(store.receipts.length, 1);
  assert.equal(store.accessDecisions.length, 2);
  assert.equal(
    store.accessDecisions[0].correlationId,
    store.accessDecisions[1].correlationId,
  );
});

test("transition rejects missing or mismatched server-issued evidence receipts", async () => {
  const context = verifiedContext("maker");
  const makeStore = () => {
    const store = new MemoryStore(
      (active) => resolvedState(active, ["control_plane.change.validate"]),
      {
        impersonating: false,
        stepUpSatisfied: true,
        stepUpReceiptId: ID.stepUp,
      },
    );
    store.changes.set(ID.existingChangeSet, {
      ...existingChangeSet(),
      status: "DRAFT",
      version: 1,
      reviewRound: 0,
    });
    return store;
  };
  const validReceipt = {
    id: ID.validationReceipt,
    kind: "VALIDATION" as const,
    issuer: "fas-evidence-service",
    toolVersion: "test-v1",
    tenantId: ID.tenant,
    changeSetId: ID.existingChangeSet,
    targetState: "VALIDATED" as const,
    requestedByPrincipalId: ID.maker,
    subjectHash: "b".repeat(64),
    policyVersionId: ID.policy,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    consumedAt: null,
  };
  const cases: Array<{
    label: string;
    override: VerifiedTransitionEvidence | null;
  }> = [
    { label: "missing", override: null },
    {
      label: "subject",
      override: {
        receipts: [{ ...validReceipt, subjectHash: "c".repeat(64) }],
        evidence: { validationPassed: true },
      },
    },
    {
      label: "policy",
      override: {
        receipts: [{ ...validReceipt, policyVersionId: ID.package }],
        evidence: { validationPassed: true },
      },
    },
    {
      label: "kind",
      override: {
        receipts: [{ ...validReceipt, kind: "SIMULATION" }],
        evidence: { validationPassed: true },
      },
    },
    {
      label: "expired",
      override: {
        receipts: [{ ...validReceipt, expiresAt: NOW }],
        evidence: { validationPassed: true },
      },
    },
    {
      label: "cross-change-set",
      override: {
        receipts: [{ ...validReceipt, changeSetId: ID.tenant }],
        evidence: { validationPassed: true },
      },
    },
    {
      label: "consumed",
      override: {
        receipts: [
          {
            ...validReceipt,
            consumedAt: NOW,
          } as unknown as typeof validReceipt,
        ],
        evidence: { validationPassed: true },
      },
    },
  ];
  for (const { label, override } of cases) {
    const store = makeStore();
    store.verifiedEvidenceOverride = override;
    const result = await executeTransitionR1ChangeSetCommand({
      context,
      command: {
        idempotencyKey: `validate:evidence:${label}:0001`,
        changeSetId: ID.existingChangeSet,
        expectedVersion: 1,
        toState: "VALIDATED",
        reasonCode: "verify_server_evidence",
      },
      dependencies: { store, nextUuidV7: idFactory(), now: () => NOW },
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "transition_rejected",
      detail: "verified_evidence_unavailable",
    });
    assert.equal(store.claims.size, 0);
    assert.equal(store.receipts.length, 0);
  }
});

test("the first command slice rejects publish, decision, and client-supplied authority evidence", async () => {
  const context = verifiedContext("checker");
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.change.approve"]),
    { impersonating: false, stepUpSatisfied: true, stepUpReceiptId: ID.stepUp },
  );
  store.changes.set(ID.existingChangeSet, existingChangeSet());
  const dependencies = { store, nextUuidV7: idFactory(500), now: () => NOW };
  const publish = await executeTransitionR1ChangeSetCommand({
    context,
    command: {
      idempotencyKey: "publish:unsupported:0001",
      changeSetId: ID.existingChangeSet,
      expectedVersion: 4,
      toState: "PUBLISHED",
      reasonCode: "attempt_publish",
    },
    dependencies,
  });
  assert.deepEqual(publish, {
    ok: false,
    reason: "transition_rejected",
    detail: "unsupported_command_target",
  });
  const forged = await executeTransitionR1ChangeSetCommand({
    context,
    command: {
      idempotencyKey: "approve:forged-evidence:0001",
      changeSetId: ID.existingChangeSet,
      expectedVersion: 4,
      toState: "VALIDATED",
      reasonCode: "attempt_forged_receipt",
      evidence: { stepUpReceiptId: ID.stepUp },
    },
    dependencies,
  });
  assert.deepEqual(forged, {
    ok: false,
    reason: "transition_rejected",
    detail: "invalid_command_shape",
  });
  const suppliedTenant = await executeTransitionR1ChangeSetCommand({
    context,
    command: {
      idempotencyKey: "validate:client-tenant:0001",
      changeSetId: ID.existingChangeSet,
      expectedVersion: 4,
      toState: "VALIDATED",
      reasonCode: "attempt_client_tenant",
      tenantId: ID.tenant,
    } as unknown as Parameters<
      typeof executeTransitionR1ChangeSetCommand
    >[0]["command"],
    dependencies,
  });
  assert.deepEqual(suppliedTenant, {
    ok: false,
    reason: "transition_rejected",
    detail: "invalid_command_shape",
  });
  assert.equal(store.claims.size, 0);
  assert.equal(store.accessDecisions.length, 0);
});

test("approval, return, and rejection stay default-off until verified step-up receipts exist", async () => {
  const context = verifiedContext("checker");
  const store = new MemoryStore(
    (active) =>
      resolvedState(active, [
        "control_plane.change.approve",
        "control_plane.change.review",
      ]),
    { impersonating: false, stepUpSatisfied: true, stepUpReceiptId: ID.stepUp },
  );
  store.changes.set(ID.existingChangeSet, existingChangeSet());
  const dependencies = { store, nextUuidV7: idFactory(200), now: () => NOW };
  for (const toState of ["APPROVED", "RETURNED", "REJECTED"] as const) {
    const result = await executeTransitionR1ChangeSetCommand({
      context,
      command: {
        idempotencyKey: `${toState.toLowerCase()}:default-off:0001`,
        changeSetId: ID.existingChangeSet,
        expectedVersion: 4,
        toState,
        reasonCode: "step_up_issuer_not_wired",
      },
      dependencies,
    });
    assert.deepEqual(result, {
      ok: false,
      reason: "transition_rejected",
      detail: "unsupported_command_target",
    });
  }
  assert.deepEqual(store.events, []);
  assert.equal(store.claims.size, 0);
});

test("legacy branch create and transition scopes stay closed until composite binding", async () => {
  const maker = verifiedContext("maker");
  const store = new MemoryStore(
    (active) =>
      resolvedState(active, [
        "control_plane.flag.create",
        "control_plane.change.validate",
      ]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
  );
  const branchScope = {
    type: "LEGACY_BRANCH" as const,
    organizationId: ID.organization,
    legacyBranchId: 7,
  };
  const createResult = await executeCreateR1ChangeSetCommand({
    context: maker,
    command: {
      ...createCommand("create:legacy-branch:0001"),
      targetScope: branchScope,
    },
    dependencies: { store, nextUuidV7: idFactory(300), now: () => NOW },
  });
  assert.deepEqual(createResult, {
    ok: false,
    reason: "draft_rejected",
    detail: "legacy_branch_scope_unbound",
  });

  store.changes.set(ID.existingChangeSet, {
    ...existingChangeSet(),
    status: "DRAFT",
    version: 1,
    reviewRound: 0,
    targetScope: branchScope,
  });
  const transitionResult = await executeTransitionR1ChangeSetCommand({
    context: maker,
    command: {
      idempotencyKey: "validate:legacy-branch:0001",
      changeSetId: ID.existingChangeSet,
      expectedVersion: 1,
      toState: "VALIDATED",
      reasonCode: "validate_unbound_branch",
    },
    dependencies: { store, nextUuidV7: idFactory(400), now: () => NOW },
  });
  assert.deepEqual(transitionResult, {
    ok: false,
    reason: "transition_rejected",
    detail: "legacy_branch_scope_unbound",
  });
  assert.equal(store.claims.size, 0);
});

test("idempotency migration forces RLS and allows only one-way completion", () => {
  const migration = readFileSync(
    new URL(
      "../../../lib/db/drizzle/0056_change_set_command_idempotency.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /ALTER TABLE "change_set_command_receipts" ENABLE ROW LEVEL SECURITY/,
  );
  assert.match(
    migration,
    /ALTER TABLE "change_set_command_receipts" FORCE ROW LEVEL SECURITY/,
  );
  assert.doesNotMatch(migration, /CREATE POLICY[^;]+FOR DELETE/is);
  assert.match(migration, /UNIQUE \("tenant_id", "idempotency_key_hash"\)/);
  assert.match(migration, /change set command must start as a clean claim/);
  assert.match(
    migration,
    /change set command receipt permits only CLAIMED to COMPLETED/,
  );
  assert.match(migration, /change set command claim identity is immutable/);
  assert.match(
    migration,
    /change set command completion evidence is incomplete/,
  );
  assert.match(migration, /change_set_command_receipts_immutable_delete/);
});
