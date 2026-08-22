import type { Pool, PoolClient, QueryResultRow } from "pg";

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
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 2_500;
const DEFAULT_STATEMENT_TIMEOUT_MS = 4_000;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 10_000;

type RpcRow = QueryResultRow & { result: unknown };

export type PostgresActiveContextSelectionConsumptionAttemptLedgerOptions = {
  pool: Pool;
  expectedRole: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
};

export class ActiveContextSelectionAttemptLedgerCommitOutcomeUnknownError extends Error {
  readonly code = "ACTIVE_CONTEXT_SELECTION_ATTEMPT_LEDGER_COMMIT_OUTCOME_UNKNOWN";

  constructor() {
    super("active_context_selection_attempt_ledger_commit_outcome_unknown");
    this.name = "ActiveContextSelectionAttemptLedgerCommitOutcomeUnknownError";
  }
}

function isTimeout(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validIdentity(value: unknown): value is SelectionConsumptionAttemptIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    exactKeys(input, [
      "attemptId", "cellId", "contextId", "environmentId", "idempotencyKeyHash",
      "membershipId", "principalId", "requestHash", "selectionId", "sessionGeneration",
      "tenantId",
    ]) &&
    UUID_V7_RE.test(String(input.attemptId)) &&
    UUID_RE.test(String(input.tenantId)) &&
    UUID_V7_RE.test(String(input.contextId)) &&
    UUID_RE.test(String(input.selectionId)) &&
    UUID_RE.test(String(input.principalId)) &&
    UUID_RE.test(String(input.membershipId)) &&
    Number.isSafeInteger(input.sessionGeneration) &&
    Number(input.sessionGeneration) > 0 &&
    SHA256_RE.test(String(input.idempotencyKeyHash)) &&
    SHA256_RE.test(String(input.requestHash))
  );
}

function validTenant(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function validAttemptId(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_RE.test(value);
}

function validResultHash(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function outcomeForFailure(reason: SelectionConsumptionAttemptFailure): {
  outcome: "DENIED" | "CONFLICT" | "ERROR";
  reasonCode: SelectionConsumptionAttemptFailure;
} {
  if (reason === "AUTHORIZATION_DENIED") {
    return { outcome: "DENIED", reasonCode: reason };
  }
  if (reason === "CONFLICT") return { outcome: "CONFLICT", reasonCode: reason };
  return { outcome: "ERROR", reasonCode: "INTERNAL_ERROR" };
}

export class PostgresActiveContextSelectionConsumptionAttemptLedger
  implements SelectionConsumptionAttemptLedger
{
  private readonly pool: Pool;
  private readonly expectedRole: string;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;

  constructor(options: PostgresActiveContextSelectionConsumptionAttemptLedgerOptions) {
    const lockTimeoutMs = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const statementTimeoutMs = options?.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    const idleTransactionTimeoutMs =
      options?.idleTransactionTimeoutMs ?? DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS;
    if (
      !options?.pool ||
      !ROLE_RE.test(options.expectedRole) ||
      !isTimeout(lockTimeoutMs, 10_000) ||
      !isTimeout(statementTimeoutMs, 15_000) ||
      !isTimeout(idleTransactionTimeoutMs, 30_000) ||
      lockTimeoutMs > statementTimeoutMs ||
      statementTimeoutMs >= idleTransactionTimeoutMs
    ) {
      throw new Error("active_context_selection_attempt_ledger_configuration_invalid");
    }
    this.pool = options.pool;
    this.expectedRole = options.expectedRole;
    this.lockTimeoutMs = lockTimeoutMs;
    this.statementTimeoutMs = statementTimeoutMs;
    this.idleTransactionTimeoutMs = idleTransactionTimeoutMs;
  }

  private async transaction<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!validTenant(tenantId)) {
      throw new Error("active_context_selection_attempt_ledger_tenant_invalid");
    }
    const client = await this.pool.connect();
    let transactionStarted = false;
    let releaseError: Error | undefined;
    try {
      const identity = await client.query<{
        current_user: string;
        tenant_setting: string | null;
      }>(
        `SELECT current_user,
                nullif(current_setting('app.tenant_id', true), '') AS tenant_setting`,
      );
      if (
        identity.rowCount !== 1 ||
        identity.rows[0]?.current_user !== this.expectedRole ||
        identity.rows[0]?.tenant_setting !== null
      ) {
        throw new Error("active_context_selection_attempt_ledger_identity_invalid");
      }
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      transactionStarted = true;
      await client.query(
        `SELECT set_config('lock_timeout', $1, true),
                set_config('statement_timeout', $2, true),
                set_config('idle_in_transaction_session_timeout', $3, true),
                set_config('app.tenant_id', $4, true)`,
        [
          `${this.lockTimeoutMs}ms`,
          `${this.statementTimeoutMs}ms`,
          `${this.idleTransactionTimeoutMs}ms`,
          tenantId.toLowerCase(),
        ],
      );
      const result = await operation(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
          transactionStarted = false;
        } catch (rollbackError) {
          releaseError = rollbackError instanceof Error
            ? rollbackError
            : new Error("active_context_selection_attempt_ledger_rollback_failed");
        }
      }
      throw error instanceof Error
        ? error
        : new Error("active_context_selection_attempt_ledger_transaction_failed");
    } finally {
      client.release(releaseError);
    }
  }

  private async rpc<T>(client: PoolClient, name: string, tenantId: string, payload: Record<string, unknown>): Promise<T> {
    const result = await client.query<RpcRow>(
      `SELECT fas_session_v1.${name}($1::jsonb) AS result`,
      [JSON.stringify(payload)],
    );
    if (result.rowCount !== 1) {
      throw new Error("active_context_selection_attempt_ledger_rpc_cardinality");
    }
    const value = result.rows[0]?.result;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("active_context_selection_attempt_ledger_rpc_result_invalid");
    }
    void tenantId;
    return value as T;
  }

  async start(input: SelectionConsumptionAttemptIdentity): Promise<void> {
    if (!validIdentity(input)) {
      throw new Error("active_context_selection_attempt_ledger_identity_invalid");
    }
    await this.transaction(input.tenantId, async (client) => {
      const result = await this.rpc<Record<string, unknown>>(
        client,
        "start_selection_consumption_attempt",
        input.tenantId,
        input as unknown as Record<string, unknown>,
      );
      if (
        !exactKeys(result, ["attemptId", "replayed", "status"]) ||
        !validAttemptId(result.attemptId) ||
        result.attemptId !== input.attemptId.toLowerCase() ||
        typeof result.replayed !== "boolean" ||
        !["STARTED", "PENDING", "TERMINAL"].includes(String(result.status))
      ) {
        throw new Error("active_context_selection_attempt_ledger_start_result_invalid");
      }
    });
  }

  async complete(input: { attemptId: string; tenantId: string; resultHash: string }): Promise<void> {
    if (!validAttemptId(input?.attemptId) || !validTenant(input?.tenantId) || !validResultHash(input?.resultHash)) {
      throw new Error("active_context_selection_attempt_ledger_complete_invalid");
    }
    await this.finish(input.tenantId, {
      attemptId: input.attemptId,
      tenantId: input.tenantId,
      phase: "TERMINAL",
      outcome: "COMPLETED",
      reasonCode: "COMMAND_COMPLETED",
      resultHash: input.resultHash,
    });
  }

  async reconcile(input: { attemptId: string; tenantId: string; resultHash: string }): Promise<void> {
    if (!validAttemptId(input?.attemptId) || !validTenant(input?.tenantId) || !validResultHash(input?.resultHash)) {
      throw new Error("active_context_selection_attempt_ledger_reconcile_invalid");
    }
    await this.finish(input.tenantId, {
      attemptId: input.attemptId,
      tenantId: input.tenantId,
      phase: "TERMINAL",
      outcome: "COMPLETED",
      reasonCode: "COMMAND_RECONCILED",
      resultHash: input.resultHash,
    });
  }

  async pending(input: { attemptId: string; tenantId: string; reason: "COMMIT_OUTCOME_UNKNOWN" }): Promise<void> {
    if (!validAttemptId(input?.attemptId) || !validTenant(input?.tenantId) || input.reason !== "COMMIT_OUTCOME_UNKNOWN") {
      throw new Error("active_context_selection_attempt_ledger_pending_invalid");
    }
    await this.finish(input.tenantId, {
      attemptId: input.attemptId,
      tenantId: input.tenantId,
      phase: "RECONCILIATION",
      outcome: "PENDING",
      reasonCode: input.reason,
      resultHash: null,
    });
  }

  async fail(input: { attemptId: string; tenantId: string; reason: SelectionConsumptionAttemptFailure }): Promise<void> {
    if (!validAttemptId(input?.attemptId) || !validTenant(input?.tenantId) || !["AUTHORIZATION_DENIED", "CONFLICT", "INTERNAL_ERROR"].includes(input.reason)) {
      throw new Error("active_context_selection_attempt_ledger_failure_invalid");
    }
    const mapped = outcomeForFailure(input.reason);
    await this.finish(input.tenantId, {
      attemptId: input.attemptId,
      tenantId: input.tenantId,
      phase: "TERMINAL",
      outcome: mapped.outcome,
      reasonCode: mapped.reasonCode,
      resultHash: null,
    });
  }

  private async finish(tenantId: string, payload: Record<string, unknown>): Promise<void> {
    await this.transaction(tenantId, async (client) => {
      const result = await this.rpc<Record<string, unknown>>(
        client,
        "finish_selection_consumption_attempt",
        tenantId,
        payload,
      );
      if (
        !exactKeys(result, ["attemptId", "replayed", "status"]) ||
        !validAttemptId(result.attemptId) ||
        result.attemptId !== String(payload.attemptId).toLowerCase() ||
        typeof result.replayed !== "boolean" ||
        !["PENDING", "TERMINAL"].includes(String(result.status))
      ) {
        throw new Error("active_context_selection_attempt_ledger_finish_result_invalid");
      }
    });
  }
}

export function createPostgresActiveContextSelectionConsumptionAttemptLedger(
  options: PostgresActiveContextSelectionConsumptionAttemptLedgerOptions,
): PostgresActiveContextSelectionConsumptionAttemptLedger {
  return new PostgresActiveContextSelectionConsumptionAttemptLedger(options);
}
