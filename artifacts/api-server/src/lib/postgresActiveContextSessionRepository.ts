import crypto from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { ActiveContextSessionRepository } from "./activeContextSessionGateway";

const SESSION_ID_RE = /^[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 2_500;
const DEFAULT_STATEMENT_TIMEOUT_MS = 4_000;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 10_000;

type SessionResolverRow = QueryResultRow & { result: unknown };

export type PostgresActiveContextSessionRepositoryOptions = {
  pool: Pool;
  expectedRole: string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
};

function isTimeout(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function validateInput(input: {
  sessionId: string;
  sessionFingerprint: string;
  observedAt: number;
}) {
  const fingerprint =
    typeof input?.sessionId === "string" && SESSION_ID_RE.test(input.sessionId)
      ? crypto.createHash("sha256").update(input.sessionId, "ascii").digest("hex")
      : null;
  if (
    !fingerprint ||
    typeof input.sessionFingerprint !== "string" ||
    !SHA256_RE.test(input.sessionFingerprint) ||
    input.sessionFingerprint !== fingerprint ||
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt < 0
  ) {
    throw new Error("active_context_session_repository_input_invalid");
  }
}

async function rollback(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error("active_context_session_repository_rollback_failed");
  }
}

export class PostgresActiveContextSessionRepository
  implements ActiveContextSessionRepository
{
  private readonly pool: Pool;
  private readonly expectedRole: string;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;

  constructor(options: PostgresActiveContextSessionRepositoryOptions) {
    if (!options?.pool || !ROLE_RE.test(options.expectedRole)) {
      throw new Error("active_context_session_repository_configuration_invalid");
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
      throw new Error("active_context_session_repository_configuration_invalid");
    }
    this.pool = options.pool;
    this.expectedRole = options.expectedRole;
    this.lockTimeoutMs = lockTimeoutMs;
    this.statementTimeoutMs = statementTimeoutMs;
    this.idleTransactionTimeoutMs = idleTransactionTimeoutMs;
  }

  async withLockedCurrentSession(
    input: {
      sessionId: string;
      sessionFingerprint: string;
      observedAt: number;
    },
    operation: (state: unknown) => Promise<string>,
  ): Promise<string> {
    validateInput(input);
    if (typeof operation !== "function") {
      throw new Error("active_context_session_repository_operation_invalid");
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
        throw new Error("active_context_session_repository_identity_invalid");
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
      const resolved = await client.query<SessionResolverRow>(
        `SELECT fas_session_v1.resolve_session_for_active_context_bound(
           $1::text, $2::text, $3::bigint
         ) AS result`,
        [input.sessionId, input.sessionFingerprint, input.observedAt],
      );
      if (resolved.rowCount !== 1 || resolved.rows[0]?.result === undefined) {
        throw new Error("active_context_session_repository_result_invalid");
      }

      const token = await operation(resolved.rows[0].result);
      if (typeof token !== "string" || token.length < 1 || token.length > 16_384) {
        throw new Error("active_context_session_repository_operation_result_invalid");
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
        : new Error("active_context_session_repository_failed");
    } finally {
      client.release(releaseWithError);
    }
  }
}

export function createPostgresActiveContextSessionRepository(
  options: PostgresActiveContextSessionRepositoryOptions,
): PostgresActiveContextSessionRepository {
  return new PostgresActiveContextSessionRepository(options);
}
