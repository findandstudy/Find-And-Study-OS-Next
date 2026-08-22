import crypto from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ID_RE = /^[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const DEPLOYMENT_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{16,256}$/;
const DEFAULT_LOCK_TIMEOUT_MS = 2_500;
const DEFAULT_STATEMENT_TIMEOUT_MS = 4_000;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 10_000;

export type ActiveContextSelectionCommand =
  | {
      type: "SELECT";
      targetTenantId: string;
      targetMembershipId: string;
      expectedSelectionId: string | null;
      expectedGeneration: number;
    }
  | {
      type: "REVOKE";
      expectedSelectionId: string;
      expectedGeneration: number;
    };

export type ActiveContextSelectionLifecycleResult = {
  commandId: string;
  outcome: "SELECTED" | "UNCHANGED" | "REVOKED";
  selectionId: string;
  sessionGeneration: number;
  tenantId: string;
  principalId: string;
  membershipId: string;
  requestHash: string;
  resultHash: string;
  replayed: boolean;
};

export type PostgresActiveContextSelectionLifecycleOptions = {
  pool: Pool;
  expectedRole: string;
  environmentId: string;
  cellId: string;
  idempotencySecret: Uint8Array;
  nextUuidV7?: (observedAt: number) => string;
  now?: () => number;
  lockTimeoutMs?: number;
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
};

export class ActiveContextSelectionCommitOutcomeUnknownError extends Error {
  readonly code = "ACTIVE_CONTEXT_SELECTION_COMMIT_OUTCOME_UNKNOWN";
  readonly commandId: string;
  readonly requestHash: string;

  constructor(commandId: string, requestHash: string) {
    super("active_context_selection_commit_outcome_unknown");
    this.name = "ActiveContextSelectionCommitOutcomeUnknownError";
    this.commandId = commandId;
    this.requestHash = requestHash;
  }
}

type LifecycleRow = QueryResultRow & { result: unknown };

class RetryableLifecycleTransactionError extends Error {
  constructor() {
    super("active_context_selection_lifecycle_retryable_transaction");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function isTimeout(value: unknown, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum;
}

function uuidV7(observedAt: number): string {
  const bytes = crypto.randomBytes(16);
  const timestamp = BigInt(observedAt);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number((timestamp >> BigInt((5 - index) * 8)) & 0xffn);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function sha256Parts(domain: string, parts: readonly string[]): string {
  const hash = crypto.createHash("sha256").update(domain, "utf8");
  for (const part of parts) hash.update("\0", "ascii").update(part, "utf8");
  return hash.digest("hex");
}

function sessionFingerprint(sessionId: string): string {
  return crypto.createHash("sha256").update(sessionId, "ascii").digest("hex");
}

function idempotencyKeyHash(secret: Uint8Array, key: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update("fas.active-context-selection-idempotency.v1\0", "utf8")
    .update(key, "utf8")
    .digest("hex");
}

function requestHash(
  fingerprint: string,
  command: ActiveContextSelectionCommand,
): string {
  return sha256Parts("fas.active-context-selection-request.v1", [
    fingerprint,
    command.type,
    command.type === "SELECT" ? command.targetTenantId.toLowerCase() : "",
    command.type === "SELECT" ? command.targetMembershipId.toLowerCase() : "",
    command.expectedSelectionId?.toLowerCase() ?? "",
    String(command.expectedGeneration),
  ]);
}

function expectedResultHash(value: Omit<ActiveContextSelectionLifecycleResult, "resultHash" | "requestHash" | "replayed">) {
  return sha256Parts("fas.active-context-selection-result.v1", [
    value.commandId,
    value.outcome,
    value.selectionId,
    String(value.sessionGeneration),
    value.tenantId,
    value.principalId,
    value.membershipId,
  ]);
}

function parseResult(
  value: unknown,
  expectedRequestHash: string,
  command: ActiveContextSelectionCommand,
): ActiveContextSelectionLifecycleResult | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "commandId",
      "membershipId",
      "outcome",
      "principalId",
      "replayed",
      "requestHash",
      "resultHash",
      "selectionId",
      "sessionGeneration",
      "tenantId",
    ]) ||
    !UUID_V7_RE.test(String(value.commandId)) ||
    !["SELECTED", "UNCHANGED", "REVOKED"].includes(String(value.outcome)) ||
    !UUID_V7_RE.test(String(value.selectionId)) ||
    !Number.isSafeInteger(value.sessionGeneration) ||
    Number(value.sessionGeneration) < 1 ||
    !UUID_V7_RE.test(String(value.tenantId)) ||
    !UUID_V7_RE.test(String(value.principalId)) ||
    !UUID_V7_RE.test(String(value.membershipId)) ||
    value.requestHash !== expectedRequestHash ||
    typeof value.resultHash !== "string" ||
    !SHA256_RE.test(value.resultHash) ||
    typeof value.replayed !== "boolean"
  ) {
    return null;
  }
  const parsed: ActiveContextSelectionLifecycleResult = {
    commandId: String(value.commandId).toLowerCase(),
    outcome: value.outcome as ActiveContextSelectionLifecycleResult["outcome"],
    selectionId: String(value.selectionId).toLowerCase(),
    sessionGeneration: Number(value.sessionGeneration),
    tenantId: String(value.tenantId).toLowerCase(),
    principalId: String(value.principalId).toLowerCase(),
    membershipId: String(value.membershipId).toLowerCase(),
    requestHash: String(value.requestHash),
    resultHash: String(value.resultHash),
    replayed: value.replayed,
  };
  if (
    (command.type === "SELECT" &&
      (parsed.tenantId !== command.targetTenantId.toLowerCase() ||
        parsed.membershipId !== command.targetMembershipId.toLowerCase() ||
        parsed.outcome === "REVOKED")) ||
    (command.type === "REVOKE" && parsed.outcome !== "REVOKED") ||
    (command.type === "SELECT" &&
      command.expectedSelectionId === null &&
      parsed.outcome !== "SELECTED") ||
    (command.type === "SELECT" &&
      command.expectedSelectionId !== null &&
      ((parsed.outcome === "UNCHANGED" &&
        (parsed.selectionId !== command.expectedSelectionId ||
          parsed.sessionGeneration !== command.expectedGeneration)) ||
        (parsed.outcome === "SELECTED" &&
          parsed.sessionGeneration !== command.expectedGeneration + 1))) ||
    (command.type === "REVOKE" &&
      (parsed.selectionId !== command.expectedSelectionId ||
        parsed.sessionGeneration !== command.expectedGeneration)) ||
    parsed.resultHash !== expectedResultHash(parsed)
  ) {
    return null;
  }
  return parsed;
}

function validateCommand(command: unknown): ActiveContextSelectionCommand {
  if (!isRecord(command) || typeof command.type !== "string") {
    throw new Error("active_context_selection_command_invalid");
  }
  if (
    command.type === "REVOKE" &&
    exactKeys(command, ["expectedGeneration", "expectedSelectionId", "type"]) &&
    UUID_V7_RE.test(String(command.expectedSelectionId)) &&
    Number.isSafeInteger(command.expectedGeneration) &&
    Number(command.expectedGeneration) > 0
  ) {
    return {
      type: "REVOKE",
      expectedSelectionId: String(command.expectedSelectionId).toLowerCase(),
      expectedGeneration: Number(command.expectedGeneration),
    };
  }
  if (
    command.type === "SELECT" &&
    exactKeys(command, [
      "expectedGeneration",
      "expectedSelectionId",
      "targetMembershipId",
      "targetTenantId",
      "type",
    ]) &&
    UUID_V7_RE.test(String(command.targetTenantId)) &&
    UUID_V7_RE.test(String(command.targetMembershipId)) &&
    (command.expectedSelectionId === null ||
      UUID_V7_RE.test(String(command.expectedSelectionId))) &&
    Number.isSafeInteger(command.expectedGeneration) &&
    ((command.expectedSelectionId === null && command.expectedGeneration === 0) ||
      (command.expectedSelectionId !== null && Number(command.expectedGeneration) > 0))
  ) {
    return {
      type: "SELECT",
      targetTenantId: String(command.targetTenantId).toLowerCase(),
      targetMembershipId: String(command.targetMembershipId).toLowerCase(),
      expectedSelectionId:
        command.expectedSelectionId === null
          ? null
          : String(command.expectedSelectionId).toLowerCase(),
      expectedGeneration: Number(command.expectedGeneration),
    };
  }
  throw new Error("active_context_selection_command_invalid");
}

async function rollback(client: PoolClient) {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error
      ? error
      : new Error("active_context_selection_lifecycle_rollback_failed");
  }
}

export class PostgresActiveContextSelectionLifecycle {
  private readonly pool: Pool;
  private readonly expectedRole: string;
  private readonly environmentId: string;
  private readonly cellId: string;
  private readonly idempotencySecret: Buffer;
  private readonly nextUuidV7: (observedAt: number) => string;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;
  private readonly statementTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;

  constructor(options: PostgresActiveContextSelectionLifecycleOptions) {
    if (
      !options?.pool ||
      !ROLE_RE.test(options.expectedRole) ||
      !DEPLOYMENT_ID_RE.test(options.environmentId) ||
      !DEPLOYMENT_ID_RE.test(options.cellId) ||
      !(options.idempotencySecret instanceof Uint8Array) ||
      options.idempotencySecret.byteLength < 32 ||
      (options.nextUuidV7 !== undefined && typeof options.nextUuidV7 !== "function") ||
      (options.now !== undefined && typeof options.now !== "function")
    ) {
      throw new Error("active_context_selection_lifecycle_configuration_invalid");
    }
    const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    const idleTransactionTimeoutMs =
      options.idleTransactionTimeoutMs ?? DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS;
    if (
      !isTimeout(lockTimeoutMs, 10_000) ||
      !isTimeout(statementTimeoutMs, 15_000) ||
      !isTimeout(idleTransactionTimeoutMs, 30_000) ||
      lockTimeoutMs > statementTimeoutMs ||
      statementTimeoutMs >= idleTransactionTimeoutMs
    ) {
      throw new Error("active_context_selection_lifecycle_configuration_invalid");
    }
    this.pool = options.pool;
    this.expectedRole = options.expectedRole;
    this.environmentId = options.environmentId;
    this.cellId = options.cellId;
    this.idempotencySecret = Buffer.from(options.idempotencySecret);
    this.nextUuidV7 = options.nextUuidV7 ?? uuidV7;
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = lockTimeoutMs;
    this.statementTimeoutMs = statementTimeoutMs;
    this.idleTransactionTimeoutMs = idleTransactionTimeoutMs;
  }

  async execute(input: {
    sessionId: string;
    idempotencyKey: string;
    command: unknown;
  }): Promise<ActiveContextSelectionLifecycleResult> {
    if (
      !input ||
      !isRecord(input) ||
      !exactKeys(input, ["command", "idempotencyKey", "sessionId"]) ||
      typeof input.sessionId !== "string" ||
      !SESSION_ID_RE.test(input.sessionId) ||
      typeof input.idempotencyKey !== "string" ||
      !IDEMPOTENCY_KEY_RE.test(input.idempotencyKey)
    ) {
      throw new Error("active_context_selection_lifecycle_input_invalid");
    }
    const command = validateCommand(input.command);
    const observedAt = this.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
      throw new Error("active_context_selection_lifecycle_clock_invalid");
    }
    const fingerprint = sessionFingerprint(input.sessionId);
    const request = requestHash(fingerprint, command);
    const ids = {
      commandId: this.nextUuidV7(observedAt),
      selectionId: this.nextUuidV7(observedAt),
    };
    if (!UUID_V7_RE.test(ids.commandId) || !UUID_V7_RE.test(ids.selectionId)) {
      throw new Error("active_context_selection_lifecycle_uuid_invalid");
    }
    const parameters = {
      sessionId: input.sessionId,
      sessionFingerprint: fingerprint,
      command,
      idempotencyKeyHash: idempotencyKeyHash(
        this.idempotencySecret,
        input.idempotencyKey,
      ),
      requestHash: request,
      ...ids,
      observedAt,
    };

    const first = await this.executeWithConcurrencyRetry(parameters);
    if (!first.uncertain) return first.result;
    const replay = await this.executeWithConcurrencyRetry(parameters);
    if (replay.uncertain) {
      throw new ActiveContextSelectionCommitOutcomeUnknownError(
        ids.commandId,
        request,
      );
    }
    return replay.result;
  }

  private async executeWithConcurrencyRetry(input: {
    sessionId: string;
    sessionFingerprint: string;
    command: ActiveContextSelectionCommand;
    idempotencyKeyHash: string;
    requestHash: string;
    commandId: string;
    selectionId: string;
    observedAt: number;
  }) {
    try {
      return await this.executeOnce(input);
    } catch (error) {
      if (!(error instanceof RetryableLifecycleTransactionError)) throw error;
      return this.executeOnce(input);
    }
  }

  private async executeOnce(input: {
    sessionId: string;
    sessionFingerprint: string;
    command: ActiveContextSelectionCommand;
    idempotencyKeyHash: string;
    requestHash: string;
    commandId: string;
    selectionId: string;
    observedAt: number;
  }): Promise<{ uncertain: false; result: ActiveContextSelectionLifecycleResult } | { uncertain: true; result: ActiveContextSelectionLifecycleResult }> {
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
        throw new Error("active_context_selection_lifecycle_identity_invalid");
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
      const row = await client.query<LifecycleRow>(
        `SELECT fas_session_lifecycle_v1.apply_self_selection_command(
           $1::text, $2::text, $3::text, $4::uuid, $5::uuid,
           $6::uuid, $7::bigint, $8::text, $9::text,
           $10::uuid, $11::uuid, $12::text, $13::text, $14::bigint
         ) AS result`,
        [
          input.sessionId,
          input.sessionFingerprint,
          input.command.type,
          input.command.type === "SELECT" ? input.command.targetTenantId : null,
          input.command.type === "SELECT" ? input.command.targetMembershipId : null,
          input.command.expectedSelectionId,
          input.command.expectedGeneration,
          input.idempotencyKeyHash,
          input.requestHash,
          input.commandId,
          input.selectionId,
          this.environmentId,
          this.cellId,
          input.observedAt,
        ],
      );
      const parsed =
        row.rowCount === 1
          ? parseResult(row.rows[0]?.result, input.requestHash, input.command)
          : null;
      if (!parsed) {
        throw new Error("active_context_selection_lifecycle_result_invalid");
      }
      try {
        await client.query("COMMIT");
        transactionStarted = false;
        return { uncertain: false, result: parsed };
      } catch (error) {
        transactionStarted = false;
        releaseWithError = error instanceof Error
          ? error
          : new Error("active_context_selection_lifecycle_commit_failed");
        return { uncertain: true, result: parsed };
      }
    } catch (error) {
      if (!transactionStarted && releaseWithError === undefined) {
        releaseWithError = error instanceof Error
          ? error
          : new Error("active_context_selection_lifecycle_preflight_failed");
      }
      if (transactionStarted) {
        const rollbackError = await rollback(client);
        releaseWithError = rollbackError;
        transactionStarted = false;
        if (
          rollbackError === undefined &&
          isRecord(error) &&
          (error.code === "40001" || error.code === "40P01")
        ) {
          throw new RetryableLifecycleTransactionError();
        }
      }
      throw error instanceof Error
        ? error
        : new Error("active_context_selection_lifecycle_failed");
    } finally {
      client.release(releaseWithError);
    }
  }
}

export function createPostgresActiveContextSelectionLifecycle(
  options: PostgresActiveContextSelectionLifecycleOptions,
): PostgresActiveContextSelectionLifecycle {
  return new PostgresActiveContextSelectionLifecycle(options);
}
