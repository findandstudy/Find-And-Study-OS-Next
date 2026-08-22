import type {
  SelectionConsumptionAttemptFailure,
  SelectionConsumptionAttemptIdentity,
  SelectionConsumptionAttemptLedger,
} from "./activeContextSelectionConsumptionAttempt";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;

export type PendingSelectionConsumptionAttempt =
  SelectionConsumptionAttemptIdentity & {
    status: "PENDING";
    attemptCount: number;
    maxAttempts: number;
    leaseToken: string;
  };

export type SelectionConsumptionStoredOutcome =
  | { state: "COMPLETED"; resultHash: string }
  | { state: "NOT_FOUND" | "IN_PROGRESS" | "INVALID" };

export type SelectionConsumptionRepairStore = {
  claimDue(tenantId: string): Promise<PendingSelectionConsumptionAttempt | null>;
  loadOutcome(
    attempt: PendingSelectionConsumptionAttempt,
  ): Promise<SelectionConsumptionStoredOutcome>;
  reschedule(
    attempt: PendingSelectionConsumptionAttempt,
    reason: "NOT_FOUND" | "IN_PROGRESS",
  ): Promise<void>;
  resolve(
    attempt: PendingSelectionConsumptionAttempt,
  ): Promise<void>;
  escalate(
    attempt: PendingSelectionConsumptionAttempt,
    reason: "INVALID" | "NOT_FOUND" | "IN_PROGRESS",
  ): Promise<void>;
};

export type SelectionConsumptionRepairRunResult =
  | { kind: "EMPTY" }
  | { kind: "RETRY"; attemptId: string; reason: "NOT_FOUND" | "IN_PROGRESS" }
  | { kind: "RESOLVED"; attemptId: string }
  | { kind: "ESCALATED"; attemptId: string; reason: "INVALID" | "NOT_FOUND" | "IN_PROGRESS" };

export type ActiveContextSelectionConsumptionRepairWorkerOptions = {
  store: SelectionConsumptionRepairStore;
  ledger: SelectionConsumptionAttemptLedger;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validAttempt(value: unknown): value is PendingSelectionConsumptionAttempt {
  if (!isRecord(value)) return false;
  const identityKeys = [
    "attemptId", "cellId", "contextId", "environmentId", "idempotencyKeyHash",
    "leaseToken", "maxAttempts", "membershipId", "principalId", "requestHash",
    "selectionId", "sessionGeneration", "status", "tenantId", "attemptCount",
  ];
  return (
    exactKeys(value, identityKeys) &&
    typeof value.attemptId === "string" && UUID_V7_RE.test(value.attemptId) &&
    typeof value.tenantId === "string" && UUID_RE.test(value.tenantId) &&
    typeof value.contextId === "string" && UUID_V7_RE.test(value.contextId) &&
    typeof value.selectionId === "string" && UUID_RE.test(value.selectionId) &&
    typeof value.principalId === "string" && UUID_RE.test(value.principalId) &&
    typeof value.membershipId === "string" && UUID_RE.test(value.membershipId) &&
    Number.isSafeInteger(value.sessionGeneration) && Number(value.sessionGeneration) > 0 &&
    SHA256_RE.test(String(value.idempotencyKeyHash)) &&
    SHA256_RE.test(String(value.requestHash)) &&
    value.status === "PENDING" &&
    Number.isSafeInteger(value.attemptCount) && Number(value.attemptCount) >= 1 &&
    Number.isSafeInteger(value.maxAttempts) && Number(value.maxAttempts) >= Number(value.attemptCount) &&
    Number(value.maxAttempts) <= 12 &&
    typeof value.leaseToken === "string" && value.leaseToken.length >= 16 && value.leaseToken.length <= 256
  );
}

function validOutcome(value: unknown): value is SelectionConsumptionStoredOutcome {
  if (!isRecord(value) || typeof value.state !== "string") return false;
  if (["NOT_FOUND", "IN_PROGRESS", "INVALID"].includes(value.state)) {
    return exactKeys(value, ["state"]);
  }
  return (
    value.state === "COMPLETED" &&
    exactKeys(value, ["resultHash", "state"]) &&
    typeof value.resultHash === "string" && SHA256_RE.test(value.resultHash)
  );
}

function failureForReason(reason: "INVALID" | "NOT_FOUND" | "IN_PROGRESS"): SelectionConsumptionAttemptFailure {
  return reason === "INVALID" ? "INTERNAL_ERROR" : "CONFLICT";
}

export class ActiveContextSelectionConsumptionRepairWorker {
  private readonly store: SelectionConsumptionRepairStore;
  private readonly ledger: SelectionConsumptionAttemptLedger;

  constructor(options: ActiveContextSelectionConsumptionRepairWorkerOptions) {
    if (
      !options || !isRecord(options.store) || !isRecord(options.ledger) ||
      typeof options.store.claimDue !== "function" ||
      typeof options.store.loadOutcome !== "function" ||
      typeof options.store.reschedule !== "function" ||
      typeof options.store.resolve !== "function" ||
      typeof options.store.escalate !== "function" ||
      typeof options.ledger.reconcile !== "function" ||
      typeof options.ledger.fail !== "function"
    ) {
      throw new Error("active_context_selection_repair_worker_configuration_invalid");
    }
    this.store = options.store;
    this.ledger = options.ledger;
  }

  async runOnce(tenantId: string): Promise<SelectionConsumptionRepairRunResult> {
    if (typeof tenantId !== "string" || !UUID_RE.test(tenantId)) {
      throw new Error("active_context_selection_repair_worker_tenant_invalid");
    }
    const attempt = await this.store.claimDue(tenantId.toLowerCase());
    if (attempt === null) return { kind: "EMPTY" };
    if (!validAttempt(attempt) || attempt.tenantId.toLowerCase() !== tenantId.toLowerCase()) {
      throw new Error("active_context_selection_repair_worker_attempt_invalid");
    }
    const outcome = await this.store.loadOutcome(attempt);
    if (!validOutcome(outcome)) {
      await this.ledger.fail({
        tenantId: attempt.tenantId,
        attemptId: attempt.attemptId,
        reason: "INTERNAL_ERROR",
      });
      await this.store.escalate(attempt, "INVALID");
      return { kind: "ESCALATED", attemptId: attempt.attemptId, reason: "INVALID" };
    }
    if (outcome.state === "COMPLETED") {
      await this.ledger.reconcile({
        tenantId: attempt.tenantId,
        attemptId: attempt.attemptId,
        resultHash: outcome.resultHash,
      });
      await this.store.resolve(attempt);
      return { kind: "RESOLVED", attemptId: attempt.attemptId };
    }
    if (outcome.state === "INVALID" || attempt.attemptCount >= attempt.maxAttempts) {
      await this.ledger.fail({
        tenantId: attempt.tenantId,
        attemptId: attempt.attemptId,
        reason: failureForReason(outcome.state),
      });
      await this.store.escalate(attempt, outcome.state);
      return { kind: "ESCALATED", attemptId: attempt.attemptId, reason: outcome.state };
    }
    await this.store.reschedule(attempt, outcome.state);
    return { kind: "RETRY", attemptId: attempt.attemptId, reason: outcome.state };
  }
}
