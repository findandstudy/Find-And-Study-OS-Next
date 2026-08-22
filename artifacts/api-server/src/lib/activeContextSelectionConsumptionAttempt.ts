const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9-]{1,62}$/;

export type SelectionConsumptionAttemptIdentity = {
  attemptId: string;
  tenantId: string;
  contextId: string;
  selectionId: string;
  sessionGeneration: number;
  principalId: string;
  membershipId: string;
  idempotencyKeyHash: string;
  requestHash: string;
  environmentId: string;
  cellId: string;
};

export type SelectionConsumptionAttemptFailure =
  | "AUTHORIZATION_DENIED"
  | "CONFLICT"
  | "INTERNAL_ERROR";

export type SelectionConsumptionAttemptLedger = {
  start(input: SelectionConsumptionAttemptIdentity): Promise<void>;
  complete(input: {
    attemptId: string;
    resultHash: string;
  }): Promise<void>;
  pending(input: {
    attemptId: string;
    reason: "COMMIT_OUTCOME_UNKNOWN";
  }): Promise<void>;
  fail(input: {
    attemptId: string;
    reason: SelectionConsumptionAttemptFailure;
  }): Promise<void>;
};

export type RunSelectionConsumptionAttemptOptions<T> = {
  attempt: SelectionConsumptionAttemptIdentity;
  ledger: SelectionConsumptionAttemptLedger;
  operation: () => Promise<T>;
  resultHash: (value: T) => string;
  isCommitOutcomeUnknown?: (error: unknown) => boolean;
  classifyFailure?: (error: unknown) => SelectionConsumptionAttemptFailure;
};

export class SelectionConsumptionAttemptCommitOutcomeUnknownError extends Error {
  readonly code = "ACTIVE_CONTEXT_SELECTION_ATTEMPT_COMMIT_OUTCOME_UNKNOWN";
  readonly attemptId: string;

  constructor(attemptId: string) {
    super("active_context_selection_attempt_commit_outcome_unknown");
    this.name = "SelectionConsumptionAttemptCommitOutcomeUnknownError";
    this.attemptId = attemptId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validIdentity(value: unknown): value is SelectionConsumptionAttemptIdentity {
  if (!isRecord(value)) return false;
  if (
    !exactKeys(value, [
      "attemptId",
      "cellId",
      "contextId",
      "environmentId",
      "idempotencyKeyHash",
      "membershipId",
      "principalId",
      "requestHash",
      "selectionId",
      "sessionGeneration",
      "tenantId",
    ])
  ) {
    return false;
  }
  return (
    UUID_V7_RE.test(String(value.attemptId)) &&
    UUID_RE.test(String(value.tenantId)) &&
    UUID_V7_RE.test(String(value.contextId)) &&
    UUID_RE.test(String(value.selectionId)) &&
    Number.isSafeInteger(value.sessionGeneration) &&
    Number(value.sessionGeneration) > 0 &&
    UUID_RE.test(String(value.principalId)) &&
    UUID_RE.test(String(value.membershipId)) &&
    SHA256_RE.test(String(value.idempotencyKeyHash)) &&
    SHA256_RE.test(String(value.requestHash)) &&
    IDENTIFIER_RE.test(String(value.environmentId)) &&
    IDENTIFIER_RE.test(String(value.cellId))
  );
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function defaultCommitUnknown(error: unknown): boolean {
  return (
    isRecord(error) &&
    error.code === "ACTIVE_CONTEXT_SELECTION_CONSUMPTION_COMMIT_OUTCOME_UNKNOWN"
  );
}

function defaultFailure(_error: unknown): SelectionConsumptionAttemptFailure {
  return "INTERNAL_ERROR";
}

/**
 * Runs one privileged selection-bound operation with an outer, durable-attempt
 * contract. The ledger must be append-only/idempotent in its implementation;
 * this coordinator deliberately never persists raw errors, request bodies or
 * session identifiers.
 */
export async function runSelectionConsumptionAttempt<T>(
  options: RunSelectionConsumptionAttemptOptions<T>,
): Promise<T> {
  if (
    !options ||
    !validIdentity(options.attempt) ||
    !isRecord(options.ledger) ||
    typeof options.ledger.start !== "function" ||
    typeof options.ledger.complete !== "function" ||
    typeof options.ledger.pending !== "function" ||
    typeof options.ledger.fail !== "function" ||
    typeof options.operation !== "function" ||
    typeof options.resultHash !== "function" ||
    (options.isCommitOutcomeUnknown !== undefined &&
      typeof options.isCommitOutcomeUnknown !== "function") ||
    (options.classifyFailure !== undefined &&
      typeof options.classifyFailure !== "function")
  ) {
    throw new Error("active_context_selection_attempt_configuration_invalid");
  }

  const attempt = options.attempt;
  await options.ledger.start(attempt);
  try {
    const value = await options.operation();
    const resultHash = options.resultHash(value);
    if (!validHash(resultHash)) {
      throw new Error("active_context_selection_attempt_result_hash_invalid");
    }
    await options.ledger.complete({
      attemptId: attempt.attemptId,
      resultHash,
    });
    return value;
  } catch (error) {
    const isUnknown = (options.isCommitOutcomeUnknown ?? defaultCommitUnknown)(
      error,
    );
    if (isUnknown) {
      await options.ledger.pending({
        attemptId: attempt.attemptId,
        reason: "COMMIT_OUTCOME_UNKNOWN",
      });
      throw new SelectionConsumptionAttemptCommitOutcomeUnknownError(
        attempt.attemptId,
      );
    }
    await options.ledger.fail({
      attemptId: attempt.attemptId,
      reason: (options.classifyFailure ?? defaultFailure)(error),
    });
    throw error instanceof Error
      ? error
      : new Error("active_context_selection_attempt_failed");
  }
}
