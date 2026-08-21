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
  type ChangeSetApprovalInsert,
  type ChangeSetCommandClaim,
  type ChangeSetCommandClaimResult,
  type ChangeSetCommandStore,
  type ChangeSetCommandSuccess,
  type ChangeSetCommandTransaction,
  type ChangeSetTransitionReceiptInsert,
  type MutationAssurance,
  type StoredR1ChangeSet,
} from "../src/lib/changeSetCommand.js";

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
          stepUpRequired: key !== "control_plane.change.create",
          approvalRequired: false,
        })),
      },
    ],
  };
}

type ClaimRow = ChangeSetCommandClaim & {
  status: "CLAIMED" | "COMPLETED";
  result: ChangeSetCommandSuccess | null;
};

class MemoryStore implements ChangeSetCommandStore {
  claims = new Map<string, ClaimRow>();
  changes = new Map<string, StoredR1ChangeSet>();
  receipts: ChangeSetTransitionReceiptInsert[] = [];
  approvals: ChangeSetApprovalInsert[] = [];
  accessDecisions: AccessDecisionReceiptInsert[] = [];
  events: string[] = [];

  constructor(
    readonly stateResolver: (
      context: VerifiedActiveTenantContext,
    ) => ResolvedActiveContextState,
    readonly assurance: MutationAssurance,
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
          claims.set(key, { ...claim, status: "CLAIMED", result: null });
          return { kind: "CLAIMED" };
        }
        if (
          existing.requestHash !== claim.requestHash ||
          existing.actorPrincipalId !== claim.actorPrincipalId
        )
          return { kind: "CONFLICT" };
        if (existing.status !== "COMPLETED") return { kind: "IN_PROGRESS" };
        return {
          kind: "REPLAY",
          requestHash: existing.requestHash,
          actorPrincipalId: existing.actorPrincipalId,
          result: existing.result,
        } satisfies ChangeSetCommandClaimResult;
      },
      loadChangeSetForUpdate: async (tenantId, changeSetId) => {
        requireTenant(tenantId);
        events.push("LOAD_CHANGE_SET");
        const value = changes.get(changeSetId);
        return value?.tenantId === tenantId ? structuredClone(value) : null;
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
        changes.set(id, {
          id,
          tenantId: draft.tenantId,
          makerPrincipalId: draft.makerPrincipalId,
          targetScope: draft.targetScope,
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
        row.changeSetId = completion.changeSetId;
      },
    };
    const result = await operation(tx);
    this.claims = claims;
    this.changes = changes;
    this.receipts = receipts;
    this.approvals = approvals;
    this.accessDecisions = accessDecisions;
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
    baseVersion: 1,
    proposedVersion: 2,
    baseConfig: {
      flagKey: "journey.beta",
      enabled: false,
      cohortPercent: 0,
      reason: "Baseline state.",
    },
    proposedConfig: {
      flagKey: "journey.beta",
      enabled: true,
      cohortPercent: 5,
      reason: "Bounded canary.",
    },
    dataClass: "INTERNAL" as const,
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
    (active) => resolvedState(active, ["control_plane.change.create"]),
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
    "INSERT_ACCESS_DECISION",
    "CLAIM",
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
    (active) => resolvedState(active, ["control_plane.change.create"]),
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
    (active) => resolvedState(active, ["control_plane.change.create"]),
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

test("runtime scope, clock, generated IDs, and replay projections fail closed", async () => {
  const context = verifiedContext("maker");
  const makeStore = () =>
    new MemoryStore(
      (active) => resolvedState(active, ["control_plane.change.create"]),
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
  claim.result = {
    ...(claim.result as ChangeSetCommandSuccess),
    extra: true,
  } as ChangeSetCommandSuccess;
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

test("the first command slice rejects publish targets and client-supplied authority evidence", async () => {
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
      evidence: {},
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
      toState: "APPROVED",
      reasonCode: "attempt_forged_receipt",
      evidence: { stepUpReceiptId: ID.stepUp },
    },
    dependencies,
  });
  assert.deepEqual(forged, {
    ok: false,
    reason: "transition_rejected",
    detail: "reserved_or_invalid_evidence",
  });
  assert.equal(store.claims.size, 0);
  assert.equal(store.accessDecisions.length, 0);
});

test("approval writes decision, transition, state, and completion in one fixed order", async () => {
  const context = verifiedContext("checker");
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.change.approve"]),
    { impersonating: false, stepUpSatisfied: true, stepUpReceiptId: ID.stepUp },
  );
  store.changes.set(ID.existingChangeSet, existingChangeSet());
  const dependencies = { store, nextUuidV7: idFactory(200), now: () => NOW };
  const command = {
    idempotencyKey: "approve:existing-change:0001",
    changeSetId: ID.existingChangeSet,
    expectedVersion: 4,
    toState: "APPROVED" as const,
    reasonCode: "independent_review_passed",
    evidence: { checklistPassed: true },
  };
  const result = await executeTransitionR1ChangeSetCommand({
    context,
    command,
    dependencies,
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  assert.equal(result.result.status, "APPROVED");
  assert.equal(result.result.version, 5);
  assert.equal(store.approvals.length, 1);
  assert.equal(store.receipts.length, 1);
  assert.deepEqual(store.events, [
    "SET_TENANT",
    "LOAD_CHANGE_SET",
    "RESOLVE_STATE",
    "RESOLVE_ASSURANCE",
    "INSERT_ACCESS_DECISION",
    "CLAIM",
    "LOAD_RECEIPT_HASH",
    "INSERT_APPROVAL",
    "INSERT_TRANSITION_RECEIPT",
    "UPDATE_CHANGE_SET",
    "COMPLETE_COMMAND",
  ]);
  assert.equal(store.approvals[0].checkerPrincipalId, ID.checker);
  assert.equal(store.approvals[0].reviewRound, 1);
  assert.equal(store.receipts[0].actorPrincipalId, ID.checker);
  assert.equal(store.accessDecisions.length, 1);

  const replay = await executeTransitionR1ChangeSetCommand({
    context,
    command,
    dependencies,
  });
  assert.equal(replay.ok, true);
  if (!replay.ok) throw new Error(replay.reason);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, result.result);
  assert.equal(store.approvals.length, 1);
  assert.equal(store.receipts.length, 1);
  assert.equal(store.accessDecisions.length, 2);
});

test("maker self-approval and invalid transition evidence roll back their claims", async () => {
  const maker = verifiedContext("maker");
  const store = new MemoryStore(
    (active) => resolvedState(active, ["control_plane.change.approve"]),
    { impersonating: false, stepUpSatisfied: true, stepUpReceiptId: ID.stepUp },
  );
  store.changes.set(ID.existingChangeSet, existingChangeSet());
  const result = await executeTransitionR1ChangeSetCommand({
    context: maker,
    command: {
      idempotencyKey: "approve:existing-change:0002",
      changeSetId: ID.existingChangeSet,
      expectedVersion: 4,
      toState: "APPROVED",
      reasonCode: "attempt_self_approval",
      evidence: {},
    },
    dependencies: { store, nextUuidV7: idFactory(300), now: () => NOW },
  });
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("unexpected allow");
  assert.equal(result.reason, "transition_rejected");
  assert.equal(result.detail, "maker_checker_conflict");
  assert.equal(store.claims.size, 0);
  assert.equal(store.approvals.length, 0);
  assert.equal(store.receipts.length, 0);
  assert.equal(store.accessDecisions.length, 0);
  assert.equal(store.changes.get(ID.existingChangeSet)?.status, "IN_REVIEW");
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
