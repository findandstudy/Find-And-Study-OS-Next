import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  signActiveTenantContext,
  verifyActiveTenantContext,
  type ResolvedActiveContextState,
  type VerifiedActiveTenantContext,
} from "../src/lib/activeTenantContext.js";
import {
  ChangeSetCommitOutcomeUnknownError,
  ChangeSetCommitReconciliationPendingError,
  executeCreateR1ChangeSetCommand,
  executeTransitionR1ChangeSetCommand,
  type AccessDecisionReceiptInsert,
  type AuthoritativeR1Configuration,
  type ChangeSetApprovalInsert,
  type ChangeSetCommandAuditAttempt,
  type ChangeSetCommandAuditStart,
  type ChangeSetCommandAuditWriter,
  type ChangeSetCommandClaim,
  type ChangeSetCommandClaimResult,
  type ChangeSetCommandResult,
  type ChangeSetCommandAttemptReceiptInsert,
  type ChangeSetCommandStore,
  type ChangeSetCommandSuccess,
  type ChangeSetCommandTransaction,
  type ChangeSetTransitionReceiptInsert,
  type MutationAssurance,
  type StoredR1ChangeSet,
  type VerifiedTransitionEvidence,
} from "../src/lib/changeSetCommand.js";
import type { R1ChangeSetDraft } from "../src/lib/changeSetPolicy.js";
import { canonicalJson } from "../src/lib/jsonCanonical.js";

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
  configurationKey: "journey.beta",
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
  commandAttempts: ChangeSetCommandAttemptReceiptInsert[] = [];
  drafts: R1ChangeSetDraft[] = [];
  consumedEvidenceIds = new Set<string>();
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
    context: VerifiedActiveTenantContext,
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
    const commandAttempts = structuredClone(this.commandAttempts);
    const drafts = structuredClone(this.drafts);
    const consumedEvidenceIds = new Set(this.consumedEvidenceIds);
    const events: string[] = [];
    const activeTenant = context.tenantId;
    events.push("SET_TENANT");
    const requireTenant = (tenantId: string) => {
      if (activeTenant !== tenantId) throw new Error("tenant context missing");
    };
    const tx: ChangeSetCommandTransaction = {
      loadAuthoritativeR1ConfigurationForUpdate: async ({
        tenantId,
        changeType,
        configurationKey,
        targetScope,
      }) => {
        requireTenant(tenantId);
        events.push("LOAD_AUTHORITATIVE_CONFIG");
        if (!this.authoritative) return null;
        const activeIndex = drafts.findIndex(
          (draft) =>
            draft.tenantId === tenantId &&
            draft.changeType === changeType &&
            draft.configurationKey === configurationKey &&
            JSON.stringify(draft.targetScope) === JSON.stringify(targetScope),
        );
        return {
          ...structuredClone(this.authoritative),
          activeProposalId:
            this.authoritative.activeProposalId ??
            (activeIndex >= 0 ? [...changes.keys()][activeIndex] : null),
        };
      },
      resolveActiveContextStateForUpdate: async (context) => {
        requireTenant(context.tenantId);
        events.push("RESOLVE_STATE");
        return this.stateResolver(context);
      },
      resolveMutationAssuranceForUpdate: async (context) => {
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
          existing.contextId !== claim.contextId ||
          existing.actorPrincipalId !== claim.actorPrincipalId ||
          existing.actorMembershipId !== claim.actorMembershipId
        )
          return { kind: "CONFLICT", commandReceiptId: existing.id };
        if (existing.status !== "COMPLETED") {
          return { kind: "IN_PROGRESS", commandReceiptId: existing.id };
        }
        return {
          kind: "REPLAY",
          commandReceiptId: existing.id,
          requestHash: existing.requestHash,
          contextId: existing.contextId,
          actorPrincipalId: existing.actorPrincipalId,
          actorMembershipId: existing.actorMembershipId,
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
              number | null,
            ]
          >,
        ) => ({
          receipts: receiptSpecs.map(([id, kind, artifactCount]) => {
            const outcome = "PASSED" as const;
            const artifactManifestHash =
              kind === "TEST_ARTIFACT" ? "d".repeat(64) : null;
            const outcomeHash = crypto
              .createHash("sha256")
              .update(
                canonicalJson({
                  kind,
                  outcome,
                  artifactCount,
                  artifactManifestHash,
                }),
                "utf8",
              )
              .digest("hex");
            return {
              id,
              kind,
              issuer: "fas-evidence-service",
              toolVersion: "test-v1",
              tenantId,
              changeSetId,
              targetState: toState,
              requestedByPrincipalId: actorPrincipalId,
              requestedByMembershipId:
                actorPrincipalId === ID.maker
                  ? ID.makerMembership
                  : ID.checkerMembership,
              subjectHash: changeSet.proposedHash,
              policyVersionId: changeSet.approvalPolicyVersion,
              outcome,
              artifactCount,
              artifactManifestHash,
              outcomeHash,
              issuedAt: NOW - 1_000,
              expiresAt: NOW + 60_000,
              consumedAt: consumedEvidenceIds.has(id) ? NOW : null,
            };
          }),
        });
        if (toState === "VALIDATED") {
          return envelope([[ID.validationReceipt, "VALIDATION", null]]);
        }
        if (toState === "SIMULATED") {
          return envelope([[ID.simulationReceipt, "SIMULATION", null]]);
        }
        if (toState === "IN_REVIEW") {
          return envelope(
            [
              [ID.testArtifactReceipt, "TEST_ARTIFACT", 1],
              [ID.rollbackPlanReceipt, "ROLLBACK_PLAN", null],
              [ID.canaryPlanReceipt, "CANARY_PLAN", null],
            ],
          );
        }
        return envelope([[ID.validationReceipt, "VALIDATION", null]]);
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
      insertCommandAttemptReceipt: async (receipt) => {
        requireTenant(receipt.tenantId);
        events.push("INSERT_COMMAND_ATTEMPT");
        commandAttempts.push(receipt);
      },
      consumeVerifiedTransitionEvidence: async ({
        tenantId,
        changeSetId,
        receiptIds,
      }) => {
        requireTenant(tenantId);
        events.push("CONSUME_VERIFIED_EVIDENCE");
        if (!changes.has(changeSetId)) return false;
        if (receiptIds.some((id) => consumedEvidenceIds.has(id))) return false;
        receiptIds.forEach((id) => consumedEvidenceIds.add(id));
        return true;
      },
      insertChangeSet: async ({ id, draft }) => {
        requireTenant(draft.tenantId);
        events.push("INSERT_CHANGE_SET");
        drafts.push(structuredClone(draft));
        changes.set(id, {
          id,
          tenantId: draft.tenantId,
          configurationKey: draft.configurationKey,
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
    this.commandAttempts = commandAttempts;
    this.drafts = drafts;
    this.consumedEvidenceIds = consumedEvidenceIds;
    this.events.push(...events);
    return result;
  }
}

class CommitAcknowledgementLossStore extends MemoryStore {
  transactionCalls = 0;

  constructor(
    stateResolver: (
      context: VerifiedActiveTenantContext,
    ) => ResolvedActiveContextState,
    assurance: MutationAssurance,
    private acknowledgementsToLose: number,
  ) {
    super(stateResolver, assurance);
  }

  override async transaction<T>(
    context: VerifiedActiveTenantContext,
    operation: (transaction: ChangeSetCommandTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionCalls += 1;
    const result = await super.transaction(context, operation);
    if (this.acknowledgementsToLose > 0) {
      this.acknowledgementsToLose -= 1;
      throw new ChangeSetCommitOutcomeUnknownError();
    }
    return result;
  }
}

function idFactory(start = 100) {
  let counter = start;
  return () =>
    `018f2000-0000-7000-8000-${(counter++).toString(16).padStart(12, "0")}`;
}

function evidenceOutcomeHash(
  kind:
    | "VALIDATION"
    | "SIMULATION"
    | "TEST_ARTIFACT"
    | "ROLLBACK_PLAN"
    | "CANARY_PLAN",
  artifactCount: number | null,
  artifactManifestHash: string | null = null,
) {
  return crypto
    .createHash("sha256")
    .update(
      canonicalJson({
        kind,
        outcome: "PASSED",
        artifactCount,
        artifactManifestHash,
      }),
      "utf8",
    )
    .digest("hex");
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
    configurationKey: "journey.beta",
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
    "LOAD_AUTHORITATIVE_CONFIG",
    "RESOLVE_STATE",
    "RESOLVE_ASSURANCE",
    "INSERT_ACCESS_DECISION",
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

  const wrongIdentity = new MemoryStore(stateResolver, assurance, {
    ...DEFAULT_AUTHORITATIVE_CONFIGURATION,
    configurationKey: "another.flag",
  });
  const identityRejected = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:wrong-config-identity:0001"),
    dependencies: {
      store: wrongIdentity,
      nextUuidV7: idFactory(),
      now: () => NOW,
    },
  });
  assert.deepEqual(identityRejected, {
    ok: false,
    reason: "draft_rejected",
    detail: "authoritative_baseline_unavailable",
  });
  assert.equal(wrongIdentity.claims.size, 0);
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

test("context expiry and authorization revoke during a locked command roll the transaction back", async () => {
  const context = verifiedContext("maker");
  const expiringStore = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
  );
  const clockValues = [NOW, NOW, NOW + 60_000];
  const expired = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:expires-during-lock:0001"),
    dependencies: {
      store: expiringStore,
      nextUuidV7: idFactory(),
      now: () => clockValues.shift() ?? NOW + 60_000,
    },
  });
  assert.deepEqual(expired, { ok: false, reason: "unverified_context" });
  assert.equal(expiringStore.claims.size, 0);
  assert.equal(expiringStore.accessDecisions.length, 0);
  assert.equal(expiringStore.changes.size, 0);

  let resolutions = 0;
  const revokedStore = new MemoryStore(
    (active) => {
      resolutions += 1;
      const value = resolvedState(active, ["control_plane.flag.create"]);
      if (resolutions > 1) value.membership.status = "REVOKED";
      return value;
    },
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
  );
  const revoked = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:revoked-during-lock:0001"),
    dependencies: {
      store: revokedStore,
      nextUuidV7: idFactory(),
      now: () => NOW,
    },
  });
  assert.equal(revoked.ok, false);
  if (revoked.ok) throw new Error("unexpected allow");
  assert.equal(revoked.reason, "authorization_denied");
  assert.equal(revoked.authorizationReason, "membership_inactive");
  assert.equal(revokedStore.claims.size, 0);
  assert.equal(revokedStore.accessDecisions.length, 0);
  assert.equal(revokedStore.changes.size, 0);
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
  assert.equal(denied.accessDecisions.length, 1);
  assert.equal(denied.accessDecisions[0].decision, "DENY");
  assert.equal(denied.accessDecisions[0].reasonCode, "capability_missing");

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
  assert.equal(impersonating.accessDecisions.length, 1);
  assert.equal(impersonating.accessDecisions[0].decision, "DENY");
  assert.equal(
    impersonating.accessDecisions[0].reasonCode,
    "impersonation_forbidden",
  );
});

test("malformed mutation assurance fails closed before an idempotency claim", async () => {
  const context = verifiedContext("maker");
  for (const assurance of [
    {
      impersonating: undefined,
      stepUpSatisfied: false,
      stepUpReceiptId: null,
    },
    {
      impersonating: false,
      stepUpSatisfied: "yes",
      stepUpReceiptId: ID.stepUp,
    },
    {
      impersonating: false,
      stepUpSatisfied: true,
      stepUpReceiptId: null,
    },
  ]) {
    const store = new MemoryStore(
      (active) => resolvedState(active, ["control_plane.flag.create"]),
      assurance as unknown as MutationAssurance,
    );
    const result = await executeCreateR1ChangeSetCommand({
      context,
      command: createCommand(`create:bad-assurance:${store.accessDecisions.length}:0001`),
      dependencies: { store, nextUuidV7: idFactory(62), now: () => NOW },
    });
    assert.deepEqual(result, { ok: false, reason: "invalid_mutation_assurance" });
    assert.equal(store.claims.size, 0);
    assert.equal(store.accessDecisions.length, 1);
    assert.equal(store.accessDecisions[0].reasonCode, "invalid_mutation_assurance");
  }
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
  assert.equal(store.commandAttempts.length, 1);
  assert.equal(store.commandAttempts[0].outcome, "CONFLICT");
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
  const smuggledScope = await executeCreateR1ChangeSetCommand({
    context,
    command: {
      ...createCommand("create:scope-smuggling:0001"),
      targetScope: {
        type: "TENANT",
        organizationId: null,
        legacyBranchId: null,
        tenantId: ID.tenant,
      } as unknown as ReturnType<typeof createCommand>["targetScope"],
    },
    dependencies: {
      store: makeStore(),
      nextUuidV7: idFactory(),
      now: () => NOW,
    },
  });
  assert.deepEqual(smuggledScope, {
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
    "LOAD_RECEIPT_HASH",
    "LOAD_VERIFIED_EVIDENCE",
    "RESOLVE_STATE",
    "RESOLVE_ASSURANCE",
    "INSERT_ACCESS_DECISION",
    "CONSUME_VERIFIED_EVIDENCE",
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
    requestedByMembershipId: ID.makerMembership,
    subjectHash: "b".repeat(64),
    policyVersionId: ID.policy,
    outcome: "PASSED" as const,
    artifactCount: null,
    artifactManifestHash: null,
    outcomeHash: evidenceOutcomeHash("VALIDATION", null),
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
      },
    },
    {
      label: "policy",
      override: {
        receipts: [{ ...validReceipt, policyVersionId: ID.package }],
      },
    },
    {
      label: "membership",
      override: {
        receipts: [
          { ...validReceipt, requestedByMembershipId: ID.checkerMembership },
        ],
      },
    },
    {
      label: "issuer-tool",
      override: {
        receipts: [{ ...validReceipt, toolVersion: "unregistered-v9" }],
      },
    },
    {
      label: "failed-outcome",
      override: {
        receipts: [
          {
            ...validReceipt,
            outcome: "FAILED",
            outcomeHash: crypto
              .createHash("sha256")
              .update(
                canonicalJson({
                  kind: "VALIDATION",
                  outcome: "FAILED",
                  artifactCount: null,
                  artifactManifestHash: null,
                }),
                "utf8",
              )
              .digest("hex"),
          },
        ],
      } as unknown as VerifiedTransitionEvidence,
    },
    {
      label: "unexpected-artifact-manifest",
      override: {
        receipts: [
          { ...validReceipt, artifactManifestHash: "c".repeat(64) },
        ],
      },
    },
    {
      label: "outcome-hash",
      override: {
        receipts: [{ ...validReceipt, outcomeHash: "c".repeat(64) }],
      },
    },
    {
      label: "kind",
      override: {
        receipts: [{ ...validReceipt, kind: "SIMULATION" }],
      },
    },
    {
      label: "expired",
      override: {
        receipts: [{ ...validReceipt, expiresAt: NOW }],
      },
    },
    {
      label: "cross-change-set",
      override: {
        receipts: [{ ...validReceipt, changeSetId: ID.tenant }],
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

test("transition evidence is consumed atomically and cannot be reused by another command", async () => {
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
  const dependencies = { store, nextUuidV7: idFactory(800), now: () => NOW };
  const base = {
    changeSetId: ID.existingChangeSet,
    expectedVersion: 1,
    toState: "VALIDATED" as const,
    reasonCode: "consume_validation_receipt",
  };
  const first = await executeTransitionR1ChangeSetCommand({
    context,
    command: { ...base, idempotencyKey: "validate:consume-once:0001" },
    dependencies,
  });
  assert.equal(first.ok, true);
  assert.equal(store.consumedEvidenceIds.has(ID.validationReceipt), true);

  store.changes.set(ID.existingChangeSet, {
    ...existingChangeSet(),
    status: "DRAFT",
    version: 1,
    reviewRound: 0,
  });
  const reused = await executeTransitionR1ChangeSetCommand({
    context,
    command: { ...base, idempotencyKey: "validate:consume-once:0002" },
    dependencies,
  });
  assert.deepEqual(reused, {
    ok: false,
    reason: "transition_rejected",
    detail: "verified_evidence_unavailable",
  });
  assert.equal(store.claims.size, 1);
  assert.equal(store.receipts.length, 1);
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

class MemoryAuditWriter implements ChangeSetCommandAuditWriter {
  starts: ChangeSetCommandAuditStart[] = [];
  results: ChangeSetCommandResult[] = [];
  reconciledResults: ChangeSetCommandResult[] = [];
  commitOutcomesUnknown = 0;
  unexpectedErrors = 0;
  failStart = false;

  async startAttempt(
    input: ChangeSetCommandAuditStart,
  ): Promise<ChangeSetCommandAuditAttempt> {
    if (this.failStart) throw new Error("audit_start_failed");
    this.starts.push(structuredClone(input));
    return {
      attemptId: ID.makerContext,
      recordResult: async (result) => {
        this.results.push(structuredClone(result));
      },
      recordReconciledResult: async (result) => {
        this.reconciledResults.push(structuredClone(result));
      },
      recordCommitOutcomeUnknown: async () => {
        this.commitOutcomesUnknown += 1;
      },
      recordUnexpectedError: async () => {
        this.unexpectedErrors += 1;
      },
    };
  }
}

test("durable audit start is fail-closed before business mutation", async () => {
  const context = verifiedContext("maker");
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
  );
  const auditWriter = new MemoryAuditWriter();
  auditWriter.failStart = true;

  await assert.rejects(
    executeCreateR1ChangeSetCommand({
      context,
      command: createCommand("create:audit-start-failure:0001"),
      dependencies: {
        store,
        auditWriter,
        nextUuidV7: idFactory(500),
        now: () => NOW,
      },
    }),
    /audit_start_failed/,
  );
  assert.deepEqual(store.events, []);
  assert.equal(store.changes.size, 0);
});

test("durable audit records expected rollback results outside the business transaction", async () => {
  const context = verifiedContext("maker");
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
    null,
  );
  const auditWriter = new MemoryAuditWriter();
  const result = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:audit-rollback:0001"),
    dependencies: {
      store,
      auditWriter,
      nextUuidV7: idFactory(520),
      now: () => NOW,
    },
  });

  assert.deepEqual(result, {
    ok: false,
    reason: "draft_rejected",
    detail: "authoritative_baseline_unavailable",
  });
  assert.equal(auditWriter.starts.length, 1);
  assert.deepEqual(auditWriter.results, [result]);
  assert.equal(store.changes.size, 0);
});

test("durable audit records unexpected command errors and preserves the original failure", async () => {
  const auditWriter = new MemoryAuditWriter();
  const context = verifiedContext("maker");
  const failingStore: ChangeSetCommandStore = {
    transaction: async () => {
      throw new Error("business_connection_lost");
    },
  };

  await assert.rejects(
    executeCreateR1ChangeSetCommand({
      context,
      command: createCommand("create:audit-error:0001"),
      dependencies: {
        store: failingStore,
        auditWriter,
        nextUuidV7: idFactory(540),
        now: () => NOW,
      },
    }),
    /business_connection_lost/,
  );
  assert.equal(auditWriter.starts.length, 1);
  assert.equal(auditWriter.unexpectedErrors, 1);
  assert.deepEqual(auditWriter.results, []);
});

test("ambiguous commit acknowledgement is resolved by one canonical idempotent replay", async () => {
  const context = verifiedContext("maker");
  const store = new CommitAcknowledgementLossStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
    1,
  );
  const auditWriter = new MemoryAuditWriter();
  const result = await executeCreateR1ChangeSetCommand({
    context,
    command: createCommand("create:ambiguous-commit:0001"),
    dependencies: {
      store,
      auditWriter,
      nextUuidV7: idFactory(560),
      now: () => NOW,
    },
  });

  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.replayed, true);
  assert.equal(store.transactionCalls, 2);
  assert.equal(store.changes.size, 1);
  assert.deepEqual(auditWriter.results, []);
  assert.deepEqual(auditWriter.reconciledResults, [result]);
  assert.equal(auditWriter.commitOutcomesUnknown, 0);
  assert.equal(auditWriter.unexpectedErrors, 0);
});

test("unresolved ambiguous commit remains non-terminal and exposes its audit attempt", async () => {
  const context = verifiedContext("maker");
  const store = new CommitAcknowledgementLossStore(
    (active) => resolvedState(active, ["control_plane.flag.create"]),
    { impersonating: false, stepUpSatisfied: false, stepUpReceiptId: null },
    2,
  );
  const auditWriter = new MemoryAuditWriter();

  await assert.rejects(
    executeCreateR1ChangeSetCommand({
      context,
      command: createCommand("create:ambiguous-pending:0001"),
      dependencies: {
        store,
        auditWriter,
        nextUuidV7: idFactory(580),
        now: () => NOW,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof ChangeSetCommitReconciliationPendingError);
      assert.equal(error.attemptId, ID.makerContext);
      return true;
    },
  );
  assert.equal(store.transactionCalls, 2);
  assert.equal(store.changes.size, 1);
  assert.equal(auditWriter.commitOutcomesUnknown, 1);
  assert.deepEqual(auditWriter.results, []);
  assert.deepEqual(auditWriter.reconciledResults, []);
  assert.equal(auditWriter.unexpectedErrors, 0);
});

test("0061 permits only typed pending and reconciled commit audit states", () => {
  const migration = readFileSync(
    new URL(
      "../../../lib/db/drizzle/0061_change_set_commit_reconciliation.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /LOCK TABLE public\.change_set_command_audit_events IN ACCESS EXCLUSIVE MODE/);
  assert.match(
    migration,
    /phase = 'RECONCILIATION'[\s\S]+outcome = 'PENDING'[\s\S]+reason_code = 'COMMIT_OUTCOME_UNKNOWN'/,
  );
  assert.match(
    migration,
    /reason_code IN \('COMMAND_COMPLETED', 'COMMAND_RECONCILED'\)/,
  );
  assert.doesNotMatch(migration, /GRANT EXECUTE|CREATE ROLE|CREATE USER/);
});

test("0060 durable audit adapter is tenant-bound, append-only, and default-unwired", () => {
  const migration = readFileSync(
    new URL(
      "../../../lib/db/drizzle/0060_change_set_durable_audit_adapter.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /LOCK TABLE public\.change_set_command_audit_events IN ACCESS EXCLUSIVE MODE/,
  );
  assert.match(migration, /CREATE SCHEMA fas_audit_v1/);
  assert.match(migration, /REVOKE ALL ON SCHEMA fas_audit_v1 FROM PUBLIC/);
  assert.match(migration, /change set audit RPC tenant context mismatch/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /audit change set identity may be bound only by the terminal event/);
  assert.match(
    migration,
    /phase <> 'TERMINAL'[\s\S]+outcome <> 'SUCCESS'[\s\S]+change_set_id IS NOT NULL/,
  );
  assert.doesNotMatch(migration, /GRANT EXECUTE|CREATE ROLE|CREATE USER/);
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

test("0057 binds tenant branches, memberships, policy, and single-use evidence", () => {
  const migration = readFileSync(
    new URL(
      "../../../lib/db/drizzle/0057_authorization_control_plane_db_hardening.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /requires empty default-unwired authorization\/control-plane tables/,
  );
  assert.match(migration, /tenant_organization_legacy_branches/);
  assert.match(migration, /memberships_tenant_id_id_principal_id_uq/);
  assert.match(migration, /change_sets_tenant_organization_branch_fk/);
  assert.match(migration, /change_sets_one_active_proposal_per_target_uidx/);
  assert.match(migration, /change_set_evidence_receipts/);
  assert.match(migration, /change_set_command_attempt_receipts/);
  assert.match(migration, /change set evidence is single-use/);
  assert.match(migration, /change_set_transition_receipts_tenant_command_uq/);
  assert.match(
    migration,
    /transition command completion requires its exact transition receipt/,
  );
  assert.match(
    migration,
    /transition command completion requires the exact typed evidence set/,
  );
  assert.match(
    migration,
    /transition receipt requires its atomically completed command and state/,
  );
  assert.match(migration, /FROM public\.policy_versions policy[\s\S]+FOR UPDATE/);
  assert.match(migration, /FROM public\.memberships membership[\s\S]+FOR UPDATE/);
  assert.match(
    migration,
    /change set evidence must be consumed by its bound transition command/,
  );
  assert.match(migration, /policy_version_id/);
  assert.match(migration, /actor_membership_id/);
  assert.match(migration, /FROM public\.change_sets/);
  assert.match(migration, /FROM public\.change_set_transition_receipts/);
  assert.match(migration, /SET search_path TO pg_catalog, public/);
  assert.doesNotMatch(
    migration,
    /ON public\.change_set_evidence_receipts FOR DELETE/,
  );
});
