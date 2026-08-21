import crypto from "node:crypto";
import {
  evaluateActiveTenantCapability,
  type ActiveContextDecisionReason,
  type ResolvedActiveContextState,
  type VerifiedActiveTenantContext,
} from "./activeTenantContext";
import {
  createR1ChangeSetDraft,
  evaluateR1ChangeSetTransition,
  requiredCapabilityForChangeSetTarget,
  type ChangeSetScope,
  type ChangeSetSnapshot,
  type ChangeSetState,
  type R1ChangeSetDraft,
  type R1DataClass,
} from "./changeSetPolicy";
import { canonicalJson } from "./jsonCanonical";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/;
const EARLY_COMMAND_TARGETS: readonly ChangeSetState[] = [
  "DRAFT",
  "VALIDATED",
  "SIMULATED",
  "IN_REVIEW",
  "APPROVED",
  "RETURNED",
  "REJECTED",
];
const RESERVED_EVIDENCE_KEYS = new Set([
  "decision",
  "reviewRound",
  "approvalReceiptId",
  "stepUpReceiptId",
]);

export type ChangeSetCommandSuccess = {
  changeSetId: string;
  status: ChangeSetState;
  version: number;
  transitionReceiptId: string | null;
  approvalReceiptId: string | null;
};

export type ChangeSetCommandFailureReason =
  | "invalid_idempotency_key"
  | "invalid_generated_id"
  | "invalid_clock"
  | "impersonation_forbidden"
  | "authorization_denied"
  | "change_set_not_found"
  | "idempotency_key_reused"
  | "command_in_progress"
  | "replay_result_invalid"
  | "draft_rejected"
  | "transition_rejected";

export type ChangeSetCommandResult =
  | { ok: true; replayed: boolean; result: ChangeSetCommandSuccess }
  | {
      ok: false;
      reason: ChangeSetCommandFailureReason;
      detail?: string;
      authorizationReason?: ActiveContextDecisionReason;
    };

export type CreateR1ChangeSetCommand = {
  idempotencyKey: string;
  changeType: string;
  title: string;
  purpose: string;
  targetScope: ChangeSetScope;
  baseVersion: number;
  proposedVersion: number;
  baseConfig: unknown;
  proposedConfig: unknown;
  dataClass: R1DataClass;
};

export type TransitionR1ChangeSetCommand = {
  idempotencyKey: string;
  changeSetId: string;
  expectedVersion: number;
  toState: ChangeSetState;
  reasonCode: string;
  evidence: Record<string, unknown>;
};

export type StoredR1ChangeSet = ChangeSetSnapshot & {
  targetScope: ChangeSetScope;
};

export type MutationAssurance = {
  impersonating: boolean;
  stepUpSatisfied: boolean;
  stepUpReceiptId: string | null;
};

export type ChangeSetCommandClaim = {
  id: string;
  tenantId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  contextId: string;
  actorPrincipalId: string;
  commandType: "CREATE" | "TRANSITION";
  changeSetId: string | null;
  claimedAt: number;
};

export type ChangeSetCommandClaimResult =
  | { kind: "CLAIMED" }
  | {
      kind: "REPLAY";
      requestHash: string;
      actorPrincipalId: string;
      result: unknown;
    }
  | { kind: "CONFLICT" }
  | { kind: "IN_PROGRESS" };

export type ChangeSetApprovalInsert = {
  id: string;
  tenantId: string;
  changeSetId: string;
  reviewRound: number;
  checkerPrincipalId: string;
  decision: "APPROVED" | "RETURNED" | "REJECTED";
  reasonCode: string;
  approvalPolicyVersion: string;
  stepUpReceiptId: string;
  evidence: Record<string, unknown>;
  decisionHash: string;
  createdAt: number;
};

export type ChangeSetTransitionReceiptInsert = {
  id: string;
  tenantId: string;
  changeSetId: string;
  sequence: number;
  actorPrincipalId: string;
  fromState: ChangeSetState;
  toState: ChangeSetState;
  reasonCode: string;
  policyVersion: string;
  evidence: Record<string, unknown>;
  evidenceHash: string;
  previousHash: string | null;
  receiptHash: string;
  occurredAt: number;
};

export type AccessDecisionReceiptInsert = {
  id: string;
  tenantId: string;
  contextId: string;
  actorPrincipalId: string;
  membershipId: string;
  assignmentIds: string[];
  rolePackageVersionIds: string[];
  capabilityKey: string;
  resourceType: string;
  resourceId: string;
  decision: "ALLOW";
  reasonCode: "allowed";
  policyVersionId: string;
  correlationId: string;
  occurredAt: number;
};

export interface ChangeSetCommandTransaction {
  setLocalTenant(tenantId: string): Promise<void>;
  resolveActiveContextState(
    context: VerifiedActiveTenantContext,
  ): Promise<ResolvedActiveContextState>;
  resolveMutationAssurance(
    context: VerifiedActiveTenantContext,
  ): Promise<MutationAssurance>;
  claimCommand(
    claim: ChangeSetCommandClaim,
  ): Promise<ChangeSetCommandClaimResult>;
  loadChangeSetForUpdate(
    tenantId: string,
    changeSetId: string,
  ): Promise<StoredR1ChangeSet | null>;
  loadLatestTransitionReceiptHash(
    tenantId: string,
    changeSetId: string,
  ): Promise<string | null>;
  insertAccessDecisionReceipt(
    input: AccessDecisionReceiptInsert,
  ): Promise<void>;
  insertChangeSet(input: {
    id: string;
    draft: R1ChangeSetDraft;
  }): Promise<void>;
  insertApproval(input: ChangeSetApprovalInsert): Promise<void>;
  insertTransitionReceipt(
    input: ChangeSetTransitionReceiptInsert,
  ): Promise<void>;
  updateChangeSet(input: {
    tenantId: string;
    changeSetId: string;
    expectedVersion: number;
    next: Extract<
      ReturnType<typeof evaluateR1ChangeSetTransition>,
      { allowed: true }
    >["next"];
    statusReason: string;
  }): Promise<void>;
  completeCommand(input: {
    commandReceiptId: string;
    changeSetId: string;
    result: ChangeSetCommandSuccess;
    resultHash: string;
    completedAt: number;
  }): Promise<void>;
}

export interface ChangeSetCommandStore {
  transaction<T>(
    operation: (transaction: ChangeSetCommandTransaction) => Promise<T>,
  ): Promise<T>;
}

export type ChangeSetCommandDependencies = {
  store: ChangeSetCommandStore;
  nextUuidV7: () => string;
  now?: () => number;
};

class RollbackCommand extends Error {
  constructor(readonly result: ChangeSetCommandResult) {
    super(result.ok ? "unexpected_success" : result.reason);
  }
}

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_RE.test(value);
}

function hashValue(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function hashIdempotencyKey(value: string): string {
  return crypto
    .createHash("sha256")
    .update(`fas-change-set-command-v1:${value}`, "utf8")
    .digest("hex");
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validScope(value: unknown): value is ChangeSetScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as Partial<ChangeSetScope>;
  if (scope.type === "TENANT") {
    return scope.organizationId === null && scope.legacyBranchId === null;
  }
  if (scope.type === "ORGANIZATION") {
    return isUuidV7(scope.organizationId) && scope.legacyBranchId === null;
  }
  return (
    scope.type === "LEGACY_BRANCH" &&
    isUuidV7(scope.organizationId) &&
    Number.isSafeInteger(scope.legacyBranchId) &&
    Number(scope.legacyBranchId) > 0
  );
}

function scopeResource(
  tenantId: string,
  scope: ChangeSetScope,
  type: string,
  id: string,
) {
  return {
    type,
    id,
    tenantId,
    organizationId: scope.organizationId,
    legacyBranchId: scope.legacyBranchId,
  };
}

function parseReplayResult(value: unknown): ChangeSetCommandSuccess | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Partial<ChangeSetCommandSuccess>;
  const keys = Object.keys(value).sort();
  if (
    canonicalJson(keys) !==
    canonicalJson(
      [
        "approvalReceiptId",
        "changeSetId",
        "status",
        "transitionReceiptId",
        "version",
      ].sort(),
    )
  )
    return null;
  if (
    !isUuidV7(result.changeSetId) ||
    typeof result.status !== "string" ||
    ![
      "DRAFT",
      "VALIDATED",
      "SIMULATED",
      "IN_REVIEW",
      "APPROVED",
      "SCHEDULED",
      "CANARY",
      "PUBLISHED",
      "OBSERVING",
      "EFFECTIVE",
      "RETURNED",
      "REJECTED",
      "FAILED",
      "ROLLED_BACK",
      "REVOKED",
    ].includes(result.status) ||
    !Number.isSafeInteger(result.version) ||
    Number(result.version) < 1 ||
    !(
      result.transitionReceiptId === null ||
      isUuidV7(result.transitionReceiptId)
    ) ||
    !(result.approvalReceiptId === null || isUuidV7(result.approvalReceiptId))
  )
    return null;
  return result as ChangeSetCommandSuccess;
}

function replayOrFailure(
  claim: ChangeSetCommandClaimResult,
  requestHash: string,
  actorPrincipalId: string,
): ChangeSetCommandResult | null {
  if (claim.kind === "CLAIMED") return null;
  if (claim.kind === "CONFLICT") {
    return { ok: false, reason: "idempotency_key_reused" };
  }
  if (claim.kind === "IN_PROGRESS") {
    return { ok: false, reason: "command_in_progress" };
  }
  if (
    claim.requestHash !== requestHash ||
    claim.actorPrincipalId !== actorPrincipalId
  )
    return { ok: false, reason: "idempotency_key_reused" };
  const result = parseReplayResult(claim.result);
  return result
    ? { ok: true, replayed: true, result }
    : { ok: false, reason: "replay_result_invalid" };
}

async function resolveAuthorization(input: {
  tx: ChangeSetCommandTransaction;
  context: VerifiedActiveTenantContext;
  capabilityKey: string;
  resource: ReturnType<typeof scopeResource>;
  now: number;
}) {
  const state = await input.tx.resolveActiveContextState(input.context);
  const assurance = await input.tx.resolveMutationAssurance(input.context);
  if (assurance.impersonating) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        reason: "impersonation_forbidden" as const,
      },
    };
  }
  const decision = evaluateActiveTenantCapability({
    context: input.context,
    state,
    capabilityKey: input.capabilityKey,
    resource: input.resource,
    stepUpSatisfied: assurance.stepUpSatisfied,
    approvalSatisfied: false,
    now: input.now,
  });
  if (!decision.allowed) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        reason: "authorization_denied" as const,
        authorizationReason: decision.reason,
      },
    };
  }
  return { ok: true as const, assurance, decisionReceipt: decision.receipt };
}

function freshUuidV7(dependencies: ChangeSetCommandDependencies): string {
  const candidate = dependencies.nextUuidV7();
  if (!isUuidV7(candidate))
    throw new RollbackCommand({ ok: false, reason: "invalid_generated_id" });
  return candidate.toLowerCase();
}

export async function executeCreateR1ChangeSetCommand(input: {
  context: VerifiedActiveTenantContext;
  command: CreateR1ChangeSetCommand;
  dependencies: ChangeSetCommandDependencies;
}): Promise<ChangeSetCommandResult> {
  if (!validIdempotencyKey(input.command.idempotencyKey)) {
    return { ok: false, reason: "invalid_idempotency_key" };
  }
  if (!validScope(input.command.targetScope)) {
    return { ok: false, reason: "draft_rejected", detail: "invalid_scope" };
  }
  const now = input.dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, reason: "invalid_clock" };
  }
  const requestHash = hashValue({
    commandType: "CREATE",
    tenantId: input.context.tenantId,
    actorPrincipalId: input.context.principalId,
    command: { ...input.command, idempotencyKey: undefined },
  });
  try {
    return await input.dependencies.store.transaction(async (tx) => {
      await tx.setLocalTenant(input.context.tenantId);
      const resourceId =
        input.command.targetScope.organizationId ?? input.context.tenantId;
      const authorization = await resolveAuthorization({
        tx,
        context: input.context,
        capabilityKey: "control_plane.change.create",
        resource: scopeResource(
          input.context.tenantId,
          input.command.targetScope,
          "CHANGE_SET_COLLECTION",
          resourceId,
        ),
        now,
      });
      if (!authorization.ok) return authorization.result;

      const commandReceiptId = freshUuidV7(input.dependencies);
      const accessDecisionReceiptId = freshUuidV7(input.dependencies);
      const changeSetId = freshUuidV7(input.dependencies);
      await tx.insertAccessDecisionReceipt({
        id: accessDecisionReceiptId,
        ...authorization.decisionReceipt,
        decision: "ALLOW",
        reasonCode: "allowed",
        correlationId: commandReceiptId,
        occurredAt: now,
      });
      const claim = await tx.claimCommand({
        id: commandReceiptId,
        tenantId: input.context.tenantId,
        idempotencyKeyHash: hashIdempotencyKey(input.command.idempotencyKey),
        requestHash,
        contextId: input.context.contextId,
        actorPrincipalId: input.context.principalId,
        commandType: "CREATE",
        changeSetId: null,
        claimedAt: now,
      });
      const replay = replayOrFailure(
        claim,
        requestHash,
        input.context.principalId,
      );
      if (replay) return replay;

      const draft = createR1ChangeSetDraft({
        tenantId: input.context.tenantId,
        changeType: input.command.changeType,
        title: input.command.title,
        purpose: input.command.purpose,
        ownerPrincipalId: input.context.principalId,
        makerPrincipalId: input.context.principalId,
        targetScope: input.command.targetScope,
        baseVersion: input.command.baseVersion,
        proposedVersion: input.command.proposedVersion,
        baseConfig: input.command.baseConfig,
        proposedConfig: input.command.proposedConfig,
        dataClass: input.command.dataClass,
        approvalPolicyVersion: input.context.policyVersionId,
      });
      if (!draft.ok) {
        throw new RollbackCommand({
          ok: false,
          reason: "draft_rejected",
          detail: draft.reason,
        });
      }
      await tx.insertChangeSet({ id: changeSetId, draft: draft.draft });
      const result: ChangeSetCommandSuccess = {
        changeSetId,
        status: "DRAFT",
        version: 1,
        transitionReceiptId: null,
        approvalReceiptId: null,
      };
      await tx.completeCommand({
        commandReceiptId,
        changeSetId,
        result,
        resultHash: hashValue(result),
        completedAt: now,
      });
      return { ok: true, replayed: false, result };
    });
  } catch (error) {
    if (error instanceof RollbackCommand) return error.result;
    throw error;
  }
}

export async function executeTransitionR1ChangeSetCommand(input: {
  context: VerifiedActiveTenantContext;
  command: TransitionR1ChangeSetCommand;
  dependencies: ChangeSetCommandDependencies;
}): Promise<ChangeSetCommandResult> {
  if (!validIdempotencyKey(input.command.idempotencyKey)) {
    return { ok: false, reason: "invalid_idempotency_key" };
  }
  if (!isUuidV7(input.command.changeSetId)) {
    return { ok: false, reason: "change_set_not_found" };
  }
  if (!EARLY_COMMAND_TARGETS.includes(input.command.toState)) {
    return {
      ok: false,
      reason: "transition_rejected",
      detail: "unsupported_command_target",
    };
  }
  if (
    !isRecord(input.command.evidence) ||
    Object.keys(input.command.evidence).some((key) =>
      RESERVED_EVIDENCE_KEYS.has(key),
    )
  ) {
    return {
      ok: false,
      reason: "transition_rejected",
      detail: "reserved_or_invalid_evidence",
    };
  }
  const capabilityKey = requiredCapabilityForChangeSetTarget(
    input.command.toState,
  );
  if (!capabilityKey) {
    return {
      ok: false,
      reason: "transition_rejected",
      detail: "invalid_transition",
    };
  }
  const now = input.dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, reason: "invalid_clock" };
  }
  const requestHash = hashValue({
    commandType: "TRANSITION",
    tenantId: input.context.tenantId,
    actorPrincipalId: input.context.principalId,
    command: { ...input.command, idempotencyKey: undefined },
  });
  try {
    return await input.dependencies.store.transaction(async (tx) => {
      await tx.setLocalTenant(input.context.tenantId);
      const changeSet = await tx.loadChangeSetForUpdate(
        input.context.tenantId,
        input.command.changeSetId,
      );
      if (!changeSet) return { ok: false, reason: "change_set_not_found" };

      const authorization = await resolveAuthorization({
        tx,
        context: input.context,
        capabilityKey,
        resource: scopeResource(
          input.context.tenantId,
          changeSet.targetScope,
          "CHANGE_SET",
          changeSet.id,
        ),
        now,
      });
      if (!authorization.ok) return authorization.result;

      const commandReceiptId = freshUuidV7(input.dependencies);
      const accessDecisionReceiptId = freshUuidV7(input.dependencies);
      await tx.insertAccessDecisionReceipt({
        id: accessDecisionReceiptId,
        ...authorization.decisionReceipt,
        decision: "ALLOW",
        reasonCode: "allowed",
        correlationId: commandReceiptId,
        occurredAt: now,
      });
      const claim = await tx.claimCommand({
        id: commandReceiptId,
        tenantId: input.context.tenantId,
        idempotencyKeyHash: hashIdempotencyKey(input.command.idempotencyKey),
        requestHash,
        contextId: input.context.contextId,
        actorPrincipalId: input.context.principalId,
        commandType: "TRANSITION",
        changeSetId: changeSet.id,
        claimedAt: now,
      });
      const replay = replayOrFailure(
        claim,
        requestHash,
        input.context.principalId,
      );
      if (replay) return replay;

      const approvalTarget = ["APPROVED", "RETURNED", "REJECTED"].includes(
        input.command.toState,
      );
      const approvalReceiptId = approvalTarget
        ? freshUuidV7(input.dependencies)
        : null;
      const transitionReceiptId = freshUuidV7(input.dependencies);
      const previousReceiptHash = await tx.loadLatestTransitionReceiptHash(
        input.context.tenantId,
        changeSet.id,
      );
      const policyEvidence: Record<string, unknown> = {
        ...input.command.evidence,
      };
      if (approvalTarget) {
        policyEvidence.decision = input.command.toState;
        policyEvidence.reviewRound = changeSet.reviewRound;
        policyEvidence.approvalReceiptId = approvalReceiptId;
        policyEvidence.stepUpReceiptId =
          authorization.assurance.stepUpReceiptId;
      }
      const transition = evaluateR1ChangeSetTransition({
        changeSet,
        actor: {
          tenantId: input.context.tenantId,
          principalId: input.context.principalId,
          capabilities: [capabilityKey],
          stepUpReceiptId: authorization.assurance.stepUpSatisfied
            ? authorization.assurance.stepUpReceiptId
            : null,
          impersonating: authorization.assurance.impersonating,
        },
        expectedVersion: input.command.expectedVersion,
        toState: input.command.toState,
        reasonCode: input.command.reasonCode,
        policyVersion: input.context.policyVersionId,
        evidence: policyEvidence,
        previousReceiptHash,
        now,
      });
      if (!transition.allowed) {
        throw new RollbackCommand({
          ok: false,
          reason: "transition_rejected",
          detail: transition.reason,
        });
      }

      if (approvalTarget && approvalReceiptId) {
        const decision = input.command.toState as
          | "APPROVED"
          | "RETURNED"
          | "REJECTED";
        const approvalEvidence = {
          ...input.command.evidence,
          reviewRound: changeSet.reviewRound,
        };
        await tx.insertApproval({
          id: approvalReceiptId,
          tenantId: input.context.tenantId,
          changeSetId: changeSet.id,
          reviewRound: changeSet.reviewRound,
          checkerPrincipalId: input.context.principalId,
          decision,
          reasonCode: input.command.reasonCode,
          approvalPolicyVersion: input.context.policyVersionId,
          stepUpReceiptId: authorization.assurance.stepUpReceiptId as string,
          evidence: approvalEvidence,
          decisionHash: hashValue({
            tenantId: input.context.tenantId,
            changeSetId: changeSet.id,
            reviewRound: changeSet.reviewRound,
            checkerPrincipalId: input.context.principalId,
            decision,
            reasonCode: input.command.reasonCode,
            approvalPolicyVersion: input.context.policyVersionId,
            stepUpReceiptId: authorization.assurance.stepUpReceiptId,
            evidenceHash: hashValue(approvalEvidence),
            createdAt: now,
          }),
          createdAt: now,
        });
      }
      await tx.insertTransitionReceipt({
        id: transitionReceiptId,
        ...transition.receipt,
      });
      await tx.updateChangeSet({
        tenantId: input.context.tenantId,
        changeSetId: changeSet.id,
        expectedVersion: input.command.expectedVersion,
        next: transition.next,
        statusReason: input.command.reasonCode,
      });
      const result: ChangeSetCommandSuccess = {
        changeSetId: changeSet.id,
        status: transition.next.status,
        version: transition.next.version,
        transitionReceiptId,
        approvalReceiptId,
      };
      await tx.completeCommand({
        commandReceiptId,
        changeSetId: changeSet.id,
        result,
        resultHash: hashValue(result),
        completedAt: now,
      });
      return { ok: true, replayed: false, result };
    });
  } catch (error) {
    if (error instanceof RollbackCommand) return error.result;
    throw error;
  }
}

export function isValidChangeSetCommandHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}
