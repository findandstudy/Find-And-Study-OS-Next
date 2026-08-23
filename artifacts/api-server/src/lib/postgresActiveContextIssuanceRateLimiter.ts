import crypto from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type {
  ActiveContextIssuanceRateLimiter,
  ActiveContextRateLimitInput,
} from "./activeContextSessionGateway";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 2_500;
const DEFAULT_STATEMENT_TIMEOUT_MS = 4_000;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 10_000;

type RateLimitRow = QueryResultRow & { result: unknown };

export type PostgresActiveContextIssuanceRateLimiterOptions = {
  pool: Pool;
  expectedRole: string;
  nextUuidV7?: (observedAt: number) => string;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
};

function isTimeout(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function uuidV7(observedAt: number): string {
  const bytes = crypto.randomBytes(16);
  const timestamp = BigInt(observedAt);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp >> BigInt((5 - index) * 8) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateInput(input: ActiveContextRateLimitInput) {
  if (
    !input ||
    input.operation !== "ACTIVE_CONTEXT_ISSUE" ||
    !SHA256_RE.test(input.sessionFingerprint) ||
    !Number.isSafeInteger(input.sessionGeneration) ||
    input.sessionGeneration <= 0 ||
    !UUID_V7_RE.test(input.authenticatedPrincipalId) ||
    !UUID_V7_RE.test(input.tenantId) ||
    !SHA256_RE.test(input.subjectHash) ||
    !Number.isSafeInteger(input.observedAt) ||
    input.observedAt < 0
  ) {
    throw new Error("active_context_rate_limiter_input_invalid");
  }
}

async function rollback(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error("active_context_rate_limiter_rollback_failed");
  }
}

export class PostgresActiveContextIssuanceRateLimiter
  implements ActiveContextIssuanceRateLimiter
{
  private readonly pool: Pool;
  private readonly expectedRole: string;
  private readonly nextUuidV7: (observedAt: number) => string;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;

  constructor(options: PostgresActiveContextIssuanceRateLimiterOptions) {
    if (!options?.pool || !ROLE_RE.test(options.expectedRole)) {
      throw new Error("active_context_rate_limiter_configuration_invalid");
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
      statementTimeoutMs >= idleTransactionTimeoutMs ||
      (options.nextUuidV7 !== undefined && typeof options.nextUuidV7 !== "function")
    ) {
      throw new Error("active_context_rate_limiter_configuration_invalid");
    }
    this.pool = options.pool;
    this.expectedRole = options.expectedRole;
    this.nextUuidV7 = options.nextUuidV7 ?? uuidV7;
    this.lockTimeoutMs = lockTimeoutMs;
    this.statementTimeoutMs = statementTimeoutMs;
    this.idleTransactionTimeoutMs = idleTransactionTimeoutMs;
  }

  async consume(input: ActiveContextRateLimitInput): Promise<unknown> {
    validateInput(input);
    const permitId = this.nextUuidV7(input.observedAt);
    if (!UUID_V7_RE.test(permitId)) {
      throw new Error("active_context_rate_limiter_permit_id_invalid");
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
        throw new Error("active_context_rate_limiter_identity_invalid");
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
      const consumed = await client.query<RateLimitRow>(
        `SELECT fas_rate_limit_v1.consume_active_context_issuance(
           $1::uuid, $2::text, $3::text, $4::bigint,
           $5::uuid, $6::bigint, $7::uuid
         ) AS result`,
        [
          input.tenantId,
          input.subjectHash,
          input.sessionFingerprint,
          input.sessionGeneration,
          input.authenticatedPrincipalId,
          input.observedAt,
          permitId,
        ],
      );
      if (consumed.rowCount !== 1 || consumed.rows[0]?.result === undefined) {
        throw new Error("active_context_rate_limiter_result_invalid");
      }
      await client.query("COMMIT");
      transactionStarted = false;
      return consumed.rows[0].result;
    } catch (error) {
      if (transactionStarted) {
        releaseWithError = await rollback(client);
        transactionStarted = false;
      }
      throw error instanceof Error
        ? error
        : new Error("active_context_rate_limiter_failed");
    } finally {
      client.release(releaseWithError);
    }
  }
}

export function createPostgresActiveContextIssuanceRateLimiter(
  options: PostgresActiveContextIssuanceRateLimiterOptions,
): PostgresActiveContextIssuanceRateLimiter {
  return new PostgresActiveContextIssuanceRateLimiter(options);
}
