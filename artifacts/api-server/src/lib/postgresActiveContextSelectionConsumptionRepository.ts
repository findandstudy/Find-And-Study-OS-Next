import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  ActiveContextSelectionState,
  ActiveContextSelectionLockInput,
  ActiveContextSelectionLockRepository,
  ActiveContextSelectionTransaction,
} from "./activeContextSelectionConsumption";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 2_500;
const DEFAULT_STATEMENT_TIMEOUT_MS = 4_000;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 10_000;

type LockRow = QueryResultRow & { result: unknown };

export type PostgresActiveContextSelectionConsumptionRepositoryOptions = {
  pool: Pool;
  expectedRole: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
};

export class ActiveContextSelectionConsumptionCommitOutcomeUnknownError extends Error {
  readonly code = "ACTIVE_CONTEXT_SELECTION_CONSUMPTION_COMMIT_OUTCOME_UNKNOWN";

  constructor() {
    super("active_context_selection_consumption_commit_outcome_unknown");
    this.name = "ActiveContextSelectionConsumptionCommitOutcomeUnknownError";
  }
}

function isTimeout(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function isBranch(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function isValidInput(value: unknown): value is ActiveContextSelectionLockInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).sort().join("\0") ===
      [
        "legacyBranchId",
        "membershipId",
        "observedAt",
        "organizationId",
        "principalId",
        "selectionId",
        "sessionGeneration",
        "tenantId",
      ]
        .sort()
        .join("\0") &&
    UUID_V7_RE.test(String(input.tenantId)) &&
    UUID_V7_RE.test(String(input.selectionId)) &&
    UUID_V7_RE.test(String(input.principalId)) &&
    UUID_V7_RE.test(String(input.membershipId)) &&
    (input.organizationId === null || UUID_V7_RE.test(String(input.organizationId))) &&
    isBranch(input.legacyBranchId) &&
    (input.legacyBranchId === null || input.organizationId !== null) &&
    Number.isSafeInteger(input.sessionGeneration) &&
    Number(input.sessionGeneration) > 0 &&
    Number.isSafeInteger(input.observedAt) &&
    Number(input.observedAt) >= 0
  );
}

async function rollback(client: PoolClient): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error("active_context_selection_consumption_rollback_failed");
  }
}

function transactionView(client: PoolClient): ActiveContextSelectionTransaction {
  return {
    query: async <T extends Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
    ) => {
      if (typeof text !== "string" || text.trim().length === 0) {
        throw new Error("active_context_selection_consumption_query_invalid");
      }
      const result = await client.query<T>(text, values ? [...values] : undefined);
      return { rows: result.rows, rowCount: result.rowCount };
    },
  };
}

export class PostgresActiveContextSelectionConsumptionRepository
  implements ActiveContextSelectionLockRepository
{
  private readonly pool: Pool;
  private readonly expectedRole: string;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;

  constructor(options: PostgresActiveContextSelectionConsumptionRepositoryOptions) {
    const lockTimeoutMs = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const statementTimeoutMs =
      options?.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
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
      throw new Error("active_context_selection_consumption_configuration_invalid");
    }
    this.pool = options.pool;
    this.expectedRole = options.expectedRole;
    this.lockTimeoutMs = lockTimeoutMs;
    this.statementTimeoutMs = statementTimeoutMs;
    this.idleTransactionTimeoutMs = idleTransactionTimeoutMs;
  }

  async withLockedSelection<T>(
    input: ActiveContextSelectionLockInput,
    operation: (
      state: ActiveContextSelectionState,
      transaction?: ActiveContextSelectionTransaction,
    ) => Promise<T>,
  ): Promise<T> {
    if (!isValidInput(input) || typeof operation !== "function") {
      throw new Error("active_context_selection_consumption_input_invalid");
    }
    const client = await this.pool.connect();
    let transactionStarted = false;
    let releaseWithError: Error | undefined;
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
        throw new Error("active_context_selection_consumption_identity_invalid");
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
          input.tenantId.toLowerCase(),
        ],
      );
      const result = await client.query<LockRow>(
        `SELECT fas_session_v1.lock_selection_for_consumption(
           $1::uuid, $2::uuid, $3::bigint
         ) AS result`,
        [input.tenantId, input.selectionId, input.observedAt],
      );
      if (
        result.rowCount !== 1 ||
        result.rows[0]?.result === null ||
        result.rows[0]?.result === undefined
      ) {
        throw new Error("active_context_selection_consumption_selection_missing");
      }
      const value = await operation(
        result.rows[0].result as ActiveContextSelectionState,
        transactionView(client),
      );
      await client.query("SELECT 1 AS transaction_alive");
      try {
        await client.query("COMMIT");
        transactionStarted = false;
      } catch (error) {
        transactionStarted = false;
        releaseWithError = error instanceof Error
          ? error
          : new ActiveContextSelectionConsumptionCommitOutcomeUnknownError();
        throw new ActiveContextSelectionConsumptionCommitOutcomeUnknownError();
      }
      return value;
    } catch (error) {
      if (transactionStarted) {
        releaseWithError = await rollback(client);
        transactionStarted = false;
      } else if (releaseWithError === undefined) {
        releaseWithError = error instanceof Error
          ? error
          : new Error("active_context_selection_consumption_failed");
      }
      throw error instanceof Error
        ? error
        : new Error("active_context_selection_consumption_failed");
    } finally {
      client.release(releaseWithError);
    }
  }
}

export function createPostgresActiveContextSelectionConsumptionRepository(
  options: PostgresActiveContextSelectionConsumptionRepositoryOptions,
): PostgresActiveContextSelectionConsumptionRepository {
  return new PostgresActiveContextSelectionConsumptionRepository(options);
}
