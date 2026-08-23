import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  AuthoritativeActiveContextRepository,
  AuthoritativeActiveContextRequest,
} from "./authoritativeActiveContextIssuance";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 2_500;
const DEFAULT_STATEMENT_TIMEOUT_MS = 4_000;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 10_000;

type ResolverRow = QueryResultRow & { result: unknown };

export type PostgresAuthoritativeActiveContextRepositoryOptions = {
  pool: Pool;
  expectedRole: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
};

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_RE.test(value);
}

function isTimeout(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function validateInput(
  value: AuthoritativeActiveContextRequest & { observedAt: number },
) {
  if (
    !value ||
    !isUuidV7(value.authenticatedPrincipalId) ||
    !isUuidV7(value.tenantId) ||
    !(value.organizationId === null || isUuidV7(value.organizationId)) ||
    !(
      value.legacyBranchId === null ||
      (Number.isSafeInteger(value.legacyBranchId) && Number(value.legacyBranchId) > 0)
    ) ||
    (value.legacyBranchId !== null && value.organizationId === null) ||
    !Number.isSafeInteger(value.observedAt) ||
    value.observedAt < 0
  ) {
    throw new Error("active_context_resolver_input_invalid");
  }
}

async function rollback(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error("active_context_resolver_rollback_failed");
  }
}

export class PostgresAuthoritativeActiveContextRepository
  implements AuthoritativeActiveContextRepository
{
  private readonly expectedRole: string;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;

  constructor(options: PostgresAuthoritativeActiveContextRepositoryOptions) {
    if (!options?.pool || !ROLE_RE.test(options.expectedRole)) {
      throw new Error("active_context_resolver_configuration_invalid");
    }
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const statementTimeoutMs =
      options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    const idleTransactionTimeoutMs =
      options.idleTransactionTimeoutMs ?? DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS;
    if (
      !isTimeout(lockTimeoutMs, 10_000) ||
      !isTimeout(statementTimeoutMs, 15_000) ||
      !isTimeout(idleTransactionTimeoutMs, 30_000) ||
      lockTimeoutMs > statementTimeoutMs ||
      statementTimeoutMs >= idleTransactionTimeoutMs
    ) {
      throw new Error("active_context_resolver_configuration_invalid");
    }
    this.expectedRole = options.expectedRole;
    this.lockTimeoutMs = lockTimeoutMs;
    this.statementTimeoutMs = statementTimeoutMs;
    this.idleTransactionTimeoutMs = idleTransactionTimeoutMs;
    this.pool = options.pool;
  }

  private readonly pool: Pool;

  async withLockedCurrentState(
    input: AuthoritativeActiveContextRequest & { observedAt: number },
    operation: (state: unknown) => Promise<string>,
  ): Promise<string> {
    validateInput(input);
    if (typeof operation !== "function") {
      throw new Error("active_context_resolver_operation_invalid");
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
        throw new Error("active_context_resolver_identity_invalid");
      }

      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
      transactionStarted = true;
      await client.query(
        `SELECT set_config('lock_timeout', $1, true),
                set_config('statement_timeout', $2, true),
                set_config('idle_in_transaction_session_timeout', $3, true)`,
        [
          `${this.lockTimeoutMs}ms`,
          `${this.statementTimeoutMs}ms`,
          `${this.idleTransactionTimeoutMs}ms`,
        ],
      );
      const tenant = await client.query<{ tenant_id: string }>(
        `SELECT set_config('app.tenant_id', $1, true) AS tenant_id`,
        [input.tenantId.toLowerCase()],
      );
      if (tenant.rowCount !== 1 || tenant.rows[0]?.tenant_id !== input.tenantId.toLowerCase()) {
        throw new Error("active_context_resolver_tenant_not_set");
      }

      const resolved = await client.query<ResolverRow>(
        `SELECT fas_auth_v1.resolve_active_context_for_issuance(
           $1::uuid, $2::uuid, $3::uuid, $4::integer, $5::bigint
         ) AS result`,
        [
          input.tenantId,
          input.authenticatedPrincipalId,
          input.organizationId,
          input.legacyBranchId,
          input.observedAt,
        ],
      );
      if (resolved.rowCount !== 1 || resolved.rows[0]?.result === undefined) {
        throw new Error("active_context_resolver_result_invalid");
      }

      const token = await operation(resolved.rows[0].result);
      if (typeof token !== "string" || token.length < 1 || token.length > 16_384) {
        throw new Error("active_context_resolver_operation_result_invalid");
      }

      await client.query("SELECT 1 AS transaction_alive");
      await client.query("COMMIT");
      transactionStarted = false;
      return token;
    } catch (error) {
      if (transactionStarted) {
        releaseWithError = await rollback(client);
        transactionStarted = false;
      }
      throw error instanceof Error
        ? error
        : new Error("active_context_resolver_failed");
    } finally {
      client.release(releaseWithError);
    }
  }
}

export function createPostgresAuthoritativeActiveContextRepository(
  options: PostgresAuthoritativeActiveContextRepositoryOptions,
): PostgresAuthoritativeActiveContextRepository {
  return new PostgresAuthoritativeActiveContextRepository(options);
}
