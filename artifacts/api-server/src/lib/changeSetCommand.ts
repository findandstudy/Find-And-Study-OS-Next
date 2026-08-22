import crypto from "node:crypto";
import {
  evaluateActiveTenantCapability,
  isVerifiedActiveTenantContext,
  type ActiveContextDecisionReason,
  type ResolvedActiveContextState,
  type VerifiedActiveTenantContext,
} from "./activeTenantContext";
import {
  createR1ChangeSetDraft,
  deriveR1ConfigurationKey,
  evaluateR1ChangeSetTransition,
  normalizeChangeSetScope,
  R1_CHANGE_TYPES,
  R1_FEATURE_FLAG_REGISTRY,
  requiredCapabilityForChangeSetTarget,
  type ChangeSetScope,
  type ChangeSetSnapshot,
  type ChangeSetState,
  type R1ChangeSetDraft,
  type R1ChangeType,
  type R1DataClass,
} from "./changeSetPolicy";
import { canonicalJson } from "./jsonCanonical";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/;
const EARLY_COMMAND_TARGETS: readonly ChangeSetState[] = [
  "VALIDATED",
  "SIMULATED",
  "IN_REVIEW",
];
const TRUSTED_EVIDENCE_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "fas-evidence-service": ["test-v1"],
};
export type ChangeSetCommandSuccess = {
  changeSetId: string;
  status: ChangeSetState;
  version: number;
  transitionReceiptId: string | null;
  approvalReceiptId: string | null;
};

export type ChangeSetCommandFailureReason =
  | "unverified_context"
  | "invalid_idempotency_key"
  | "invalid_generated_id"
  | "invalid_clock"
  | "impersonation_forbidden"
  | "invalid_mutation_assurance"
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
  proposedConfig: unknown;
};

export type AuthoritativeR1Configuration = {
  configurationKey: string;
  version: number;
  config: unknown;
  activeProposalId: string | null;
};

export type VerifiedTransitionEvidenceReceipt = {
  id: string;
  kind:
    | "VALIDATION"
    | "SIMULATION"
    | "TEST_ARTIFACT"
    | "ROLLBACK_PLAN"
    | "CANARY_PLAN";
  issuer: string;
  toolVersion: string;
  tenantId: string;
  changeSetId: string;
  targetState: ChangeSetState;
  requestedByPrincipalId: string;
  requestedByMembershipId: string;
  subjectHash: string;
  policyVersionId: string;
  outcome: "PASSED" | "FAILED";
  artifactCount: number | null;
  artifactManifestHash: string | null;
  outcomeHash: string;
  issuedAt: number;
  expiresAt: number;
  consumedAt: null;
};

export type VerifiedTransitionEvidence = {
  receipts: VerifiedTransitionEvidenceReceipt[];
};

export type TransitionR1ChangeSetCommand = {
  idempotencyKey: string;
  changeSetId: string;
  expectedVersion: number;
  toState: ChangeSetState;
  reasonCode: string;
};

export type StoredR1ChangeSet = ChangeSetSnapshot & {
  configurationKey: string;
  targetScope: ChangeSetScope;
  proposedHash: string;
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
  actorMembershipId: string;
  commandType: "CREATE" | "TRANSITION";
  targetState: ChangeSetState | null;
  changeSetId: string | null;
  claimedAt: number;
};

export type ChangeSetCommandClaimResult =
  | { kind: "CLAIMED" }
  | {
      kind: "REPLAY";
      commandReceiptId: string;
      requestHash: string;
      contextId: string;
      actorPrincipalId: string;
      actorMembershipId: string;
      result: unknown;
      resultHash: unknown;
    }
  | { kind: "CONFLICT"; commandReceiptId: string }
  | { kind: "IN_PROGRESS"; commandReceiptId: string };

export type ChangeSetApprovalInsert = {
  id: string;
  tenantId: string;
  changeSetId: string;
  reviewRound: number;
  checkerPrincipalId: string;
  checkerMembershipId: string;
  decision: "APPROVED" | "RETURNED" | "REJECTED";
  reasonCode: string;
  approvalPolicyVersion: string;
  approvalPolicyVersionId: string;
  stepUpReceiptId: string;
  evidence: Record<string, unknown>;
  decisionHash: string;
  createdAt: number;
};

export type ChangeSetTransitionReceiptInsert = {
  id: string;
  commandReceiptId: string;
  tenantId: string;
  changeSetId: string;
  sequence: number;
  actorPrincipalId: string;
  actorMembershipId: string;
  fromState: ChangeSetState;
  toState: ChangeSetState;
  reasonCode: string;
  policyVersion: string;
  policyVersionId: string;
  evidence: Record<string, unknown>;
  evidenceHash: string;
  previousHash: string | null;
  receiptHash: string;
  occurredAt: number;
};

export type ChangeSetCommandAttemptReceiptInsert = {
  id: string;
  tenantId: string;
  contextId: string;
  actorPrincipalId: string;
  actorMembershipId: string;
  commandReceiptId: string;
  requestHash: string;
  outcome: "CONFLICT" | "IN_PROGRESS";
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
  decision: "ALLOW" | "DENY";
  reasonCode:
    | ActiveContextDecisionReason
    | "impersonation_forbidden"
    | "invalid_mutation_assurance";
  policyVersionId: string;
  correlationId: string;
  occurredAt: number;
};

export interface ChangeSetCommandTransaction {
  loadAuthoritativeR1ConfigurationForUpdate(input: {
    tenantId: string;
    changeType: string;
    configurationKey: string;
    targetScope: ChangeSetScope;
  }): Promise<AuthoritativeR1Configuration | null>;
  resolveActiveContextStateForUpdate(
    context: VerifiedActiveTenantContext,
  ): Promise<ResolvedActiveContextState>;
  resolveMutationAssuranceForUpdate(
    context: VerifiedActiveTenantContext,
  ): Promise<MutationAssurance>;
  claimCommand(
    claim: ChangeSetCommandClaim,
  ): Promise<ChangeSetCommandClaimResult>;
  loadChangeSetForUpdate(
    tenantId: string,
    changeSetId: string,
  ): Promise<StoredR1ChangeSet | null>;
  loadVerifiedTransitionEvidenceForUpdate(input: {
    tenantId: string;
    changeSetId: string;
    actorPrincipalId: string;
    toState: ChangeSetState;
  }): Promise<VerifiedTransitionEvidence | null>;
  loadLatestTransitionReceiptHash(
    tenantId: string,
    changeSetId: string,
  ): Promise<string | null>;
  insertAccessDecisionReceipt(
    input: AccessDecisionReceiptInsert,
  ): Promise<void>;
  insertCommandAttemptReceipt(
    input: ChangeSetCommandAttemptReceiptInsert,
  ): Promise<void>;
  consumeVerifiedTransitionEvidence(input: {
    tenantId: string;
    changeSetId: string;
    commandReceiptId: string;
    receiptIds: string[];
    consumedAt: number;
  }): Promise<boolean>;
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
    context: VerifiedActiveTenantContext,
    operation: (transaction: ChangeSetCommandTransaction) => Promise<T>,
  ): Promise<T>;
}

export type ChangeSetCommandAuditStart = {
  tenantId: string;
  contextId: string;
  actorPrincipalId: string;
  actorMembershipId: string;
  policyVersionId: string;
  commandType: "CREATE" | "TRANSITION";
  targetState: ChangeSetState | null;
  capability: string;
  idempotencyKey: string;
  requestHash: string;
};

export interface ChangeSetCommandAuditAttempt {
  recordResult(result: ChangeSetCommandResult): Promise<void>;
  recordUnexpectedError(): Promise<void>;
}

export interface ChangeSetCommandAuditWriter {
  startAttempt(
    input: ChangeSetCommandAuditStart,
  ): Promise<ChangeSetCommandAuditAttempt>;
}

export type ChangeSetCommandDependencies = {
  store: ChangeSetCommandStore;
  nextUuidV7: () => string;
  now?: () => number;
  auditWriter?: ChangeSetCommandAuditWriter;
};

class RollbackCommand extends Error {
  constructor(readonly result: ChangeSetCommandResult) {
    super(result.ok ? "unexpected_success" : result.reason);
  }
}

async function executeWithDurableAudit(input: {
  dependencies: ChangeSetCommandDependencies;
  audit: ChangeSetCommandAuditStart;
  operation: () => Promise<ChangeSetCommandResult>;
}): Promise<ChangeSetCommandResult> {
  const attempt = input.dependencies.auditWriter
    ? await input.dependencies.auditWriter.startAttempt(input.audit)
    : null;
  let result: ChangeSetCommandResult;
  try {
    result = await input.operation();
  } catch (error) {
    if (error instanceof RollbackCommand) {
      result = error.result;
    } else {
      if (attempt) {
        try {
          await attempt.recordUnexpectedError();
        } catch (auditError) {
          throw new AggregateError(
            [error, auditError],
            "change_set_command_and_terminal_audit_failed",
          );
        }
      }
      throw error;
    }
  }
  await attempt?.recordResult(result);
  return result;
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

function isR1ChangeType(value: unknown): value is R1ChangeType {
  return R1_CHANGE_TYPES.includes(value as R1ChangeType);
}

const R1_CREATE_POLICY: Record<
  R1ChangeType,
  { capabilityKey: string; dataClass: R1DataClass }
> = {
  BRAND: { capabilityKey: "control_plane.brand.create", dataClass: "PUBLIC" },
  LOCALE: {
    capabilityKey: "control_plane.locale.create",
    dataClass: "PUBLIC",
  },
  NOTIFICATION_TEMPLATE: {
    capabilityKey: "control_plane.notification.create",
    dataClass: "INTERNAL",
  },
  FEATURE_FLAG: {
    capabilityKey: "control_plane.flag.create",
    dataClass: "INTERNAL",
  },
  MAINTENANCE_BANNER: {
    capabilityKey: "control_plane.maintenance.create",
    dataClass: "PUBLIC",
  },
};

function resolveR1CreatePolicy(
  command: CreateR1ChangeSetCommand,
):
  | {
      ok: true;
      capabilityKey: string;
      dataClass: R1DataClass;
      configurationKey: string;
    }
  | { ok: false; detail: string } {
  if (!isR1ChangeType(command.changeType)) {
    return { ok: false, detail: "unsupported_change_type" };
  }
  const policy = R1_CREATE_POLICY[command.changeType];
  const configurationKey = deriveR1ConfigurationKey(
    command.changeType,
    command.proposedConfig,
  );
  if (configurationKey === null) {
    return { ok: false, detail: "invalid_config_shape" };
  }
  if (command.changeType !== "FEATURE_FLAG") {
    return { ok: true, ...policy, configurationKey };
  }
  if (!isRecord(command.proposedConfig)) {
    return { ok: false, detail: "invalid_config_shape" };
  }
  const flagKey = command.proposedConfig.flagKey;
  const registryEntry =
    typeof flagKey === "string"
      ? R1_FEATURE_FLAG_REGISTRY[
          flagKey as keyof typeof R1_FEATURE_FLAG_REGISTRY
        ]
      : undefined;
  if (!registryEntry) return { ok: false, detail: "unregistered_feature_flag" };
  return {
    ok: true,
    capabilityKey: registryEntry.requiredCapability,
    dataClass: policy.dataClass,
    configurationKey,
  };
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
  contextId: string,
  actorPrincipalId: string,
  actorMembershipId: string,
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
    claim.contextId !== contextId ||
    claim.actorPrincipalId !== actorPrincipalId ||
    claim.actorMembershipId !== actorMembershipId
  )
    return { ok: false, reason: "idempotency_key_reused" };
  if (
    !isValidChangeSetCommandHash(claim.resultHash) ||
    hashValue(claim.result) !== claim.resultHash
  ) {
    return { ok: false, reason: "replay_result_invalid" };
  }
  const result = parseReplayResult(claim.result);
  return result
    ? { ok: true, replayed: true, result }
    : { ok: false, reason: "replay_result_invalid" };
}

function commandCorrelationId(
  claim: ChangeSetCommandClaimResult,
  freshCommandReceiptId: string,
): string {
  if (claim.kind === "CLAIMED") return freshCommandReceiptId;
  if (!isUuidV7(claim.commandReceiptId)) {
    throw new RollbackCommand({ ok: false, reason: "replay_result_invalid" });
  }
  return claim.commandReceiptId.toLowerCase();
}

function validVerifiedTransitionEvidence(
  value: VerifiedTransitionEvidence | null,
  input: {
    changeSet: StoredR1ChangeSet;
    toState: ChangeSetState;
    policyVersionId: string;
    actorPrincipalId: string;
    actorMembershipId: string;
    now: number;
  },
): value is VerifiedTransitionEvidence {
  const requiredKinds: Partial<
    Record<ChangeSetState, VerifiedTransitionEvidenceReceipt["kind"][]>
  > = {
    VALIDATED: ["VALIDATION"],
    SIMULATED: ["SIMULATION"],
    IN_REVIEW: ["TEST_ARTIFACT", "ROLLBACK_PLAN", "CANARY_PLAN"],
  };
  const expectedKinds = requiredKinds[input.toState];
  if (
    !value ||
    !expectedKinds ||
    !Array.isArray(value.receipts) ||
    value.receipts.length !== expectedKinds.length ||
    value.receipts.some(
      (receipt) =>
        !isUuidV7(receipt.id) ||
        !expectedKinds.includes(receipt.kind) ||
        !Object.hasOwn(TRUSTED_EVIDENCE_TOOLS, receipt.issuer) ||
        !TRUSTED_EVIDENCE_TOOLS[receipt.issuer]?.includes(
          receipt.toolVersion,
        ) ||
        receipt.tenantId !== input.changeSet.tenantId ||
        receipt.changeSetId !== input.changeSet.id ||
        receipt.targetState !== input.toState ||
        receipt.requestedByPrincipalId !== input.actorPrincipalId ||
        receipt.requestedByMembershipId !== input.actorMembershipId ||
        receipt.subjectHash !== input.changeSet.proposedHash ||
        receipt.policyVersionId !== input.policyVersionId ||
        receipt.outcome !== "PASSED" ||
        (receipt.kind === "TEST_ARTIFACT"
          ? !Number.isSafeInteger(receipt.artifactCount) ||
            Number(receipt.artifactCount) < 1 ||
            !isValidChangeSetCommandHash(receipt.artifactManifestHash)
          : receipt.artifactCount !== null ||
            receipt.artifactManifestHash !== null) ||
        !SHA256_RE.test(receipt.outcomeHash) ||
        receipt.outcomeHash !==
          hashValue({
            kind: receipt.kind,
            outcome: receipt.outcome,
            artifactCount: receipt.artifactCount,
            artifactManifestHash: receipt.artifactManifestHash,
          }) ||
        !Number.isSafeInteger(receipt.issuedAt) ||
        !Number.isSafeInteger(receipt.expiresAt) ||
        receipt.issuedAt > input.now ||
        receipt.expiresAt <= input.now ||
        receipt.expiresAt - receipt.issuedAt > 60 * 60 * 1000 ||
        receipt.consumedAt !== null,
    ) ||
    new Set(value.receipts.map((receipt) => receipt.id.toLowerCase())).size !==
      value.receipts.length ||
    new Set(value.receipts.map((receipt) => receipt.kind)).size !==
      expectedKinds.length
  ) {
    return false;
  }
  return true;
}

function policyEvidenceFromReceipts(
  value: VerifiedTransitionEvidence,
  toState: ChangeSetState,
): Record<string, unknown> {
  const receiptIds = value.receipts.map((receipt) => receipt.id);
  if (toState === "VALIDATED") {
    return { validationPassed: true, evidenceReceiptIds: receiptIds };
  }
  if (toState === "SIMULATED") {
    return { simulationPassed: true, evidenceReceiptIds: receiptIds };
  }
  return {
    rollbackReady: true,
    canaryPrepared: true,
    testEvidenceCount: value.receipts
      .filter((receipt) => receipt.kind === "TEST_ARTIFACT")
      .reduce((total, receipt) => total + Number(receipt.artifactCount), 0),
    evidenceReceiptIds: receiptIds,
  };
}

async function resolveAuthorization(input: {
  tx: ChangeSetCommandTransaction;
  context: VerifiedActiveTenantContext;
  capabilityKey: string;
  resource: ReturnType<typeof scopeResource>;
  now: number;
}) {
  const state = await input.tx.resolveActiveContextStateForUpdate(input.context);
  const assurance = await input.tx.resolveMutationAssuranceForUpdate(
    input.context,
  );
  const validAssurance =
    isRecord(assurance) &&
    typeof assurance.impersonating === "boolean" &&
    typeof assurance.stepUpSatisfied === "boolean" &&
    (assurance.stepUpReceiptId === null ||
      (typeof assurance.stepUpReceiptId === "string" &&
        isUuidV7(assurance.stepUpReceiptId))) &&
    ((assurance.stepUpSatisfied && assurance.stepUpReceiptId !== null) ||
      (!assurance.stepUpSatisfied && assurance.stepUpReceiptId === null));
  if (!validAssurance) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
        reason: "invalid_mutation_assurance" as const,
      },
      decisionReceipt: {
        tenantId: input.context.tenantId,
        contextId: input.context.contextId,
        actorPrincipalId: input.context.principalId,
        membershipId: input.context.membershipId,
        assignmentIds: [...input.context.assignmentIds],
        rolePackageVersionIds: [
          ...new Set(
            state.assignments.map(
              (assignment) => assignment.rolePackageVersionId,
            ),
          ),
        ].sort(),
        capabilityKey: input.capabilityKey,
        resourceType: input.resource.type,
        resourceId: input.resource.id,
        decision: "DENY" as const,
        reasonCode: "invalid_mutation_assurance" as const,
        policyVersionId: input.context.policyVersionId,
      },
    };
  }
  if (assurance.impersonating) {
    return {
      ok: false as const,
      result: {
        ok: false as const,
          reason: "impersonation_forbidden" as const,
        },
      decisionReceipt: {
        tenantId: input.context.tenantId,
        contextId: input.context.contextId,
        actorPrincipalId: input.context.principalId,
        membershipId: input.context.membershipId,
        assignmentIds: [...input.context.assignmentIds],
        rolePackageVersionIds: [
          ...new Set(
            state.assignments.map(
              (assignment) => assignment.rolePackageVersionId,
            ),
          ),
        ].sort(),
        capabilityKey: input.capabilityKey,
        resourceType: input.resource.type,
        resourceId: input.resource.id,
        decision: "DENY" as const,
        reasonCode: "impersonation_forbidden" as const,
        policyVersionId: input.context.policyVersionId,
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
      decisionReceipt: decision.receipt,
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

function freshCommandNow(dependencies: ChangeSetCommandDependencies): number {
  const now = dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RollbackCommand({ ok: false, reason: "invalid_clock" });
  }
  return now;
}

function requireCurrentContext(
  context: VerifiedActiveTenantContext,
  now: number,
): void {
  if (!isVerifiedActiveTenantContext(context, now)) {
    throw new RollbackCommand({ ok: false, reason: "unverified_context" });
  }
}

export async function executeCreateR1ChangeSetCommand(input: {
  context: VerifiedActiveTenantContext;
  command: CreateR1ChangeSetCommand;
  dependencies: ChangeSetCommandDependencies;
}): Promise<ChangeSetCommandResult> {
  const now = input.dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, reason: "invalid_clock" };
  }
  if (!isVerifiedActiveTenantContext(input.context, now)) {
    return { ok: false, reason: "unverified_context" };
  }
  if (!isRecord(input.command)) {
    return {
      ok: false,
      reason: "draft_rejected",
      detail: "invalid_command_shape",
    };
  }
  const commandKeys = Object.keys(
    input.command as Record<string, unknown>,
  ).sort();
  const allowedCommandKeys = [
    "changeType",
    "idempotencyKey",
    "proposedConfig",
    "purpose",
    "targetScope",
    "title",
  ].sort();
  if (canonicalJson(commandKeys) !== canonicalJson(allowedCommandKeys)) {
    return {
      ok: false,
      reason: "draft_rejected",
      detail: "invalid_command_shape",
    };
  }
  const createPolicy = resolveR1CreatePolicy(input.command);
  if (!createPolicy.ok) {
    return {
      ok: false,
      reason: "draft_rejected",
      detail: createPolicy.detail,
    };
  }
  if (!validIdempotencyKey(input.command.idempotencyKey)) {
    return { ok: false, reason: "invalid_idempotency_key" };
  }
  const targetScope = normalizeChangeSetScope(input.command.targetScope);
  if (!targetScope) {
    return { ok: false, reason: "draft_rejected", detail: "invalid_scope" };
  }
  if (targetScope.type === "LEGACY_BRANCH") {
    return {
      ok: false,
      reason: "draft_rejected",
      detail: "legacy_branch_scope_unbound",
    };
  }
  const requestHash = hashValue({
    commandType: "CREATE",
    tenantId: input.context.tenantId,
    actorPrincipalId: input.context.principalId,
    command: {
      ...input.command,
      targetScope,
      idempotencyKey: undefined,
    },
  });
  return executeWithDurableAudit({
    dependencies: input.dependencies,
    audit: {
      tenantId: input.context.tenantId,
      contextId: input.context.contextId,
      actorPrincipalId: input.context.principalId,
      actorMembershipId: input.context.membershipId,
      policyVersionId: input.context.policyVersionId,
      commandType: "CREATE",
      targetState: null,
      capability: createPolicy.capabilityKey,
      idempotencyKey: input.command.idempotencyKey,
      requestHash,
    },
    operation: () => input.dependencies.store.transaction(input.context, async (tx) => {
      const authorizationNow = freshCommandNow(input.dependencies);
      requireCurrentContext(input.context, authorizationNow);
      const resourceId =
        targetScope.organizationId ?? input.context.tenantId;
      const authorization = await resolveAuthorization({
        tx,
        context: input.context,
        capabilityKey: createPolicy.capabilityKey,
        resource: scopeResource(
          input.context.tenantId,
          targetScope,
          `CHANGE_SET_${input.command.changeType}`,
          resourceId,
        ),
        now: authorizationNow,
      });
      if (!authorization.ok) {
        const denialReceiptId = freshUuidV7(input.dependencies);
        await tx.insertAccessDecisionReceipt({
          id: denialReceiptId,
          ...authorization.decisionReceipt,
          correlationId: denialReceiptId,
          occurredAt: authorizationNow,
        });
        return authorization.result;
      }

      const commandReceiptId = freshUuidV7(input.dependencies);
      const accessDecisionReceiptId = freshUuidV7(input.dependencies);
      const claim = await tx.claimCommand({
        id: commandReceiptId,
        tenantId: input.context.tenantId,
        idempotencyKeyHash: hashIdempotencyKey(input.command.idempotencyKey),
        requestHash,
        contextId: input.context.contextId,
        actorPrincipalId: input.context.principalId,
        actorMembershipId: input.context.membershipId,
        commandType: "CREATE",
        targetState: null,
        changeSetId: null,
        claimedAt: authorizationNow,
      });
      const replay = replayOrFailure(
        claim,
        requestHash,
        input.context.contextId,
        input.context.principalId,
        input.context.membershipId,
      );
      if (
        replay &&
        (claim.kind === "CONFLICT" || claim.kind === "IN_PROGRESS")
      ) {
        const existingCommandReceiptId = commandCorrelationId(
          claim,
          commandReceiptId,
        );
        await tx.insertCommandAttemptReceipt({
          id: freshUuidV7(input.dependencies),
          tenantId: input.context.tenantId,
          contextId: input.context.contextId,
          actorPrincipalId: input.context.principalId,
          actorMembershipId: input.context.membershipId,
          commandReceiptId: existingCommandReceiptId,
          requestHash,
          outcome: claim.kind,
          occurredAt: authorizationNow,
        });
        return replay;
      }
      const correlationId = commandCorrelationId(claim, commandReceiptId);
      if (replay) {
        const replayNow = freshCommandNow(input.dependencies);
        requireCurrentContext(input.context, replayNow);
        const replayAuthorization = await resolveAuthorization({
          tx,
          context: input.context,
          capabilityKey: createPolicy.capabilityKey,
          resource: scopeResource(
            input.context.tenantId,
            targetScope,
            `CHANGE_SET_${input.command.changeType}`,
            resourceId,
          ),
          now: replayNow,
        });
        if (!replayAuthorization.ok) {
          throw new RollbackCommand(replayAuthorization.result);
        }
        await tx.insertAccessDecisionReceipt({
          id: accessDecisionReceiptId,
          ...replayAuthorization.decisionReceipt,
          decision: "ALLOW",
          reasonCode: "allowed",
          correlationId,
          occurredAt: replayNow,
        });
        return replay;
      }

      const authoritative = await tx.loadAuthoritativeR1ConfigurationForUpdate({
        tenantId: input.context.tenantId,
        changeType: input.command.changeType,
        configurationKey: createPolicy.configurationKey,
        targetScope,
      });
      if (
        !authoritative ||
        authoritative.configurationKey !== createPolicy.configurationKey ||
        !Number.isSafeInteger(authoritative.version) ||
        authoritative.version < 0 ||
        !(
          authoritative.activeProposalId === null ||
          isUuidV7(authoritative.activeProposalId)
        )
      ) {
        throw new RollbackCommand({
          ok: false,
          reason: "draft_rejected",
          detail: "authoritative_baseline_unavailable",
        });
      }
      if (authoritative.activeProposalId !== null) {
        throw new RollbackCommand({
          ok: false,
          reason: "draft_rejected",
          detail: "active_proposal_exists",
        });
      }
      const mutationNow = freshCommandNow(input.dependencies);
      requireCurrentContext(input.context, mutationNow);
      const currentAuthorization = await resolveAuthorization({
        tx,
        context: input.context,
        capabilityKey: createPolicy.capabilityKey,
        resource: scopeResource(
          input.context.tenantId,
          targetScope,
          `CHANGE_SET_${input.command.changeType}`,
          resourceId,
        ),
        now: mutationNow,
      });
      if (!currentAuthorization.ok) {
        throw new RollbackCommand(currentAuthorization.result);
      }
      await tx.insertAccessDecisionReceipt({
        id: accessDecisionReceiptId,
        ...currentAuthorization.decisionReceipt,
        decision: "ALLOW",
        reasonCode: "allowed",
        correlationId,
        occurredAt: mutationNow,
      });
      const changeSetId = freshUuidV7(input.dependencies);
      const draft = createR1ChangeSetDraft({
        tenantId: input.context.tenantId,
        changeType: input.command.changeType,
        title: input.command.title,
        purpose: input.command.purpose,
        ownerPrincipalId: input.context.principalId,
        ownerMembershipId: input.context.membershipId,
        makerPrincipalId: input.context.principalId,
        makerMembershipId: input.context.membershipId,
        targetScope,
        baseVersion: authoritative.version,
        proposedVersion: authoritative.version + 1,
        baseConfig: authoritative.config,
        proposedConfig: input.command.proposedConfig,
        dataClass: createPolicy.dataClass,
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
        completedAt: freshCommandNow(input.dependencies),
      });
      return { ok: true, replayed: false, result };
    }),
  });
}

export async function executeTransitionR1ChangeSetCommand(input: {
  context: VerifiedActiveTenantContext;
  command: TransitionR1ChangeSetCommand;
  dependencies: ChangeSetCommandDependencies;
}): Promise<ChangeSetCommandResult> {
  const now = input.dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, reason: "invalid_clock" };
  }
  if (!isVerifiedActiveTenantContext(input.context, now)) {
    return { ok: false, reason: "unverified_context" };
  }
  if (!isRecord(input.command)) {
    return {
      ok: false,
      reason: "transition_rejected",
      detail: "invalid_command_shape",
    };
  }
  const commandKeys = Object.keys(
    input.command as Record<string, unknown>,
  ).sort();
  const allowedCommandKeys = [
    "changeSetId",
    "expectedVersion",
    "idempotencyKey",
    "reasonCode",
    "toState",
  ].sort();
  if (canonicalJson(commandKeys) !== canonicalJson(allowedCommandKeys)) {
    return {
      ok: false,
      reason: "transition_rejected",
      detail: "invalid_command_shape",
    };
  }
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
  const requestHash = hashValue({
    commandType: "TRANSITION",
    tenantId: input.context.tenantId,
    actorPrincipalId: input.context.principalId,
    command: { ...input.command, idempotencyKey: undefined },
  });
  return executeWithDurableAudit({
    dependencies: input.dependencies,
    audit: {
      tenantId: input.context.tenantId,
      contextId: input.context.contextId,
      actorPrincipalId: input.context.principalId,
      actorMembershipId: input.context.membershipId,
      policyVersionId: input.context.policyVersionId,
      commandType: "TRANSITION",
      targetState: input.command.toState,
      capability: capabilityKey,
      idempotencyKey: input.command.idempotencyKey,
      requestHash,
    },
    operation: () => input.dependencies.store.transaction(input.context, async (tx) => {
      const changeSet = await tx.loadChangeSetForUpdate(
        input.context.tenantId,
        input.command.changeSetId,
      );
      if (!changeSet) return { ok: false, reason: "change_set_not_found" };
      const targetScope = normalizeChangeSetScope(changeSet.targetScope);
      if (!targetScope) {
        throw new RollbackCommand({
          ok: false,
          reason: "transition_rejected",
          detail: "invalid_scope",
        });
      }
      if (targetScope.type === "LEGACY_BRANCH") {
        return {
          ok: false,
          reason: "transition_rejected",
          detail: "legacy_branch_scope_unbound",
        };
      }

      const authorizationNow = freshCommandNow(input.dependencies);
      requireCurrentContext(input.context, authorizationNow);
      const authorization = await resolveAuthorization({
        tx,
        context: input.context,
        capabilityKey,
        resource: scopeResource(
          input.context.tenantId,
          targetScope,
          "CHANGE_SET",
          changeSet.id,
        ),
        now: authorizationNow,
      });
      if (!authorization.ok) {
        const denialReceiptId = freshUuidV7(input.dependencies);
        await tx.insertAccessDecisionReceipt({
          id: denialReceiptId,
          ...authorization.decisionReceipt,
          correlationId: denialReceiptId,
          occurredAt: authorizationNow,
        });
        return authorization.result;
      }

      const commandReceiptId = freshUuidV7(input.dependencies);
      const accessDecisionReceiptId = freshUuidV7(input.dependencies);
      const claim = await tx.claimCommand({
        id: commandReceiptId,
        tenantId: input.context.tenantId,
        idempotencyKeyHash: hashIdempotencyKey(input.command.idempotencyKey),
        requestHash,
        contextId: input.context.contextId,
        actorPrincipalId: input.context.principalId,
        actorMembershipId: input.context.membershipId,
        commandType: "TRANSITION",
        targetState: input.command.toState,
        changeSetId: changeSet.id,
        claimedAt: authorizationNow,
      });
      const replay = replayOrFailure(
        claim,
        requestHash,
        input.context.contextId,
        input.context.principalId,
        input.context.membershipId,
      );
      if (
        replay &&
        (claim.kind === "CONFLICT" || claim.kind === "IN_PROGRESS")
      ) {
        const existingCommandReceiptId = commandCorrelationId(
          claim,
          commandReceiptId,
        );
        await tx.insertCommandAttemptReceipt({
          id: freshUuidV7(input.dependencies),
          tenantId: input.context.tenantId,
          contextId: input.context.contextId,
          actorPrincipalId: input.context.principalId,
          actorMembershipId: input.context.membershipId,
          commandReceiptId: existingCommandReceiptId,
          requestHash,
          outcome: claim.kind,
          occurredAt: authorizationNow,
        });
        return replay;
      }
      const correlationId = commandCorrelationId(claim, commandReceiptId);
      if (replay) {
        const replayNow = freshCommandNow(input.dependencies);
        requireCurrentContext(input.context, replayNow);
        const replayAuthorization = await resolveAuthorization({
          tx,
          context: input.context,
          capabilityKey,
          resource: scopeResource(
            input.context.tenantId,
            targetScope,
            "CHANGE_SET",
            changeSet.id,
          ),
          now: replayNow,
        });
        if (!replayAuthorization.ok) {
          throw new RollbackCommand(replayAuthorization.result);
        }
        await tx.insertAccessDecisionReceipt({
          id: accessDecisionReceiptId,
          ...replayAuthorization.decisionReceipt,
          decision: "ALLOW",
          reasonCode: "allowed",
          correlationId,
          occurredAt: replayNow,
        });
        return replay;
      }

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
      const verifiedEvidence = await tx.loadVerifiedTransitionEvidenceForUpdate(
        {
          tenantId: input.context.tenantId,
          changeSetId: changeSet.id,
          actorPrincipalId: input.context.principalId,
          toState: input.command.toState,
        },
      );
      const mutationNow = freshCommandNow(input.dependencies);
      requireCurrentContext(input.context, mutationNow);
      const currentAuthorization = await resolveAuthorization({
        tx,
        context: input.context,
        capabilityKey,
        resource: scopeResource(
          input.context.tenantId,
          targetScope,
          "CHANGE_SET",
          changeSet.id,
        ),
        now: mutationNow,
      });
      if (!currentAuthorization.ok) {
        throw new RollbackCommand(currentAuthorization.result);
      }
      if (
        !validVerifiedTransitionEvidence(verifiedEvidence, {
          changeSet,
          toState: input.command.toState,
          policyVersionId: input.context.policyVersionId,
          actorPrincipalId: input.context.principalId,
          actorMembershipId: input.context.membershipId,
          now: mutationNow,
        })
      ) {
        throw new RollbackCommand({
          ok: false,
          reason: "transition_rejected",
          detail: "verified_evidence_unavailable",
        });
      }
      const policyEvidence = policyEvidenceFromReceipts(
        verifiedEvidence,
        input.command.toState,
      );
      await tx.insertAccessDecisionReceipt({
        id: accessDecisionReceiptId,
        ...currentAuthorization.decisionReceipt,
        decision: "ALLOW",
        reasonCode: "allowed",
        correlationId,
        occurredAt: mutationNow,
      });
      if (approvalTarget) {
        policyEvidence.decision = input.command.toState;
        policyEvidence.reviewRound = changeSet.reviewRound;
        policyEvidence.approvalReceiptId = approvalReceiptId;
        policyEvidence.stepUpReceiptId =
          currentAuthorization.assurance.stepUpReceiptId;
      }
      const transition = evaluateR1ChangeSetTransition({
        changeSet,
        actor: {
          tenantId: input.context.tenantId,
          principalId: input.context.principalId,
          capabilities: [capabilityKey],
          stepUpReceiptId: currentAuthorization.assurance.stepUpSatisfied
            ? currentAuthorization.assurance.stepUpReceiptId
            : null,
          impersonating: currentAuthorization.assurance.impersonating,
        },
        expectedVersion: input.command.expectedVersion,
        toState: input.command.toState,
        reasonCode: input.command.reasonCode,
        policyVersion: input.context.policyVersionId,
        evidence: policyEvidence,
        previousReceiptHash,
        now: mutationNow,
      });
      if (!transition.allowed) {
        throw new RollbackCommand({
          ok: false,
          reason: "transition_rejected",
          detail: transition.reason,
        });
      }

      const evidenceConsumed = await tx.consumeVerifiedTransitionEvidence({
        tenantId: input.context.tenantId,
        changeSetId: changeSet.id,
        commandReceiptId,
        receiptIds: verifiedEvidence.receipts.map((receipt) => receipt.id),
        consumedAt: mutationNow,
      });
      if (!evidenceConsumed) {
        throw new RollbackCommand({
          ok: false,
          reason: "transition_rejected",
          detail: "verified_evidence_consumption_conflict",
        });
      }

      if (approvalTarget && approvalReceiptId) {
        const decision = input.command.toState as
          | "APPROVED"
          | "RETURNED"
          | "REJECTED";
        const approvalEvidence = {
          ...policyEvidence,
          reviewRound: changeSet.reviewRound,
        };
        await tx.insertApproval({
          id: approvalReceiptId,
          tenantId: input.context.tenantId,
          changeSetId: changeSet.id,
          reviewRound: changeSet.reviewRound,
          checkerPrincipalId: input.context.principalId,
          checkerMembershipId: input.context.membershipId,
          decision,
          reasonCode: input.command.reasonCode,
          approvalPolicyVersion: input.context.policyVersionId,
          approvalPolicyVersionId: input.context.policyVersionId,
          stepUpReceiptId: currentAuthorization.assurance
            .stepUpReceiptId as string,
          evidence: approvalEvidence,
          decisionHash: hashValue({
            tenantId: input.context.tenantId,
            changeSetId: changeSet.id,
            reviewRound: changeSet.reviewRound,
            checkerPrincipalId: input.context.principalId,
            decision,
            reasonCode: input.command.reasonCode,
            approvalPolicyVersion: input.context.policyVersionId,
            stepUpReceiptId: currentAuthorization.assurance.stepUpReceiptId,
            evidenceHash: hashValue(approvalEvidence),
            createdAt: mutationNow,
          }),
          createdAt: mutationNow,
        });
      }
      await tx.insertTransitionReceipt({
        id: transitionReceiptId,
        commandReceiptId,
        actorMembershipId: input.context.membershipId,
        policyVersionId: input.context.policyVersionId,
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
        completedAt: freshCommandNow(input.dependencies),
      });
      return { ok: true, replayed: false, result };
    }),
  });
}

export function isValidChangeSetCommandHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}
