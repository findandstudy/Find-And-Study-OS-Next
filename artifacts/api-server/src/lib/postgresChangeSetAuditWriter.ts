import crypto from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  hashChangeSetCommandIdempotencyKey,
  type ChangeSetCommandAuditAttempt,
  type ChangeSetCommandAuditStart,
  type ChangeSetCommandAuditWriter,
  type ChangeSetCommandResult,
} from "./changeSetCommand";
import { canonicalJson } from "./jsonCanonical";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9._:-]{2,95}$/;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/;

type AuditOutcome = "DENY" | "REJECT" | "CONFLICT" | "ERROR" | "SUCCESS";
type AuditReason =
  | "AUTHORIZATION_DENIED"
  | "EVIDENCE_REJECTED"
  | "MUTATION_REJECTED"
  | "IDEMPOTENCY_CONFLICT"
  | "COMMAND_IN_PROGRESS"
  | "INTERNAL_ERROR"
  | "COMMAND_COMPLETED"
  | "COMMAND_RECONCILED"
  | "COMMIT_OUTCOME_UNKNOWN";

type AuditEvent = {
  id: string;
  tenantId: string;
  attemptId: string;
  sequence: number;
  contextId: string;
  actorPrincipalId: string;
  actorMembershipId: string;
  changeSetId: string | null;
  commandType: "CREATE" | "TRANSITION";
  targetState: string | null;
  capability: string;
  policyVersionId: string;
  phase: "ATTEMPT_STARTED" | "RECONCILIATION" | "TERMINAL";
  outcome: "STARTED" | "PENDING" | AuditOutcome;
  reasonCode: "REQUEST_ACCEPTED" | AuditReason;
  idempotencyKeyFingerprint: string;
  requestFingerprint: string;
  fingerprintKeyId: string;
  previousHash: string | null;
  eventHash: string;
};

type RpcRow = QueryResultRow & { result: unknown };

export type PostgresChangeSetAuditWriterOptions = {
  pool: Pool;
  expectedRole: string;
  fingerprintKeyId: string;
  fingerprintKey: Buffer;
  nextUuidV7: () => string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hmac(key: Buffer, domain: string, value: string): string {
  return crypto
    .createHmac("sha256", key)
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function secureHashEqual(left: string, right: string): boolean {
  if (!SHA256_RE.test(left) || !SHA256_RE.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function eventHash(key: Buffer, event: Omit<AuditEvent, "eventHash">): string {
  return hmac(
    key,
    "fas.change-set.command-audit.event.v1",
    canonicalJson({
      schemaVersion: 1,
      audience: "fas.change-set.command-audit",
      ...event,
    }),
  );
}

function validAuditStart(input: ChangeSetCommandAuditStart): boolean {
  return (
    isRecord(input) &&
    UUID_RE.test(input.tenantId) &&
    UUID_V7_RE.test(input.contextId) &&
    UUID_RE.test(input.actorPrincipalId) &&
    UUID_RE.test(input.actorMembershipId) &&
    UUID_RE.test(input.policyVersionId) &&
    ["CREATE", "TRANSITION"].includes(input.commandType) &&
    ((input.commandType === "CREATE" && input.targetState === null) ||
      (input.commandType === "TRANSITION" &&
        ["VALIDATED", "SIMULATED", "IN_REVIEW"].includes(
          input.targetState ?? "",
        ))) &&
    IDENTIFIER_RE.test(input.capability) &&
    IDEMPOTENCY_KEY_RE.test(input.idempotencyKey) &&
    SHA256_RE.test(input.requestHash)
  );
}

function parseTail(value: unknown): AuditEvent | null {
  if (!isRecord(value)) return null;
  const exactKeys = [
    "actorMembershipId",
    "actorPrincipalId",
    "attemptId",
    "capability",
    "changeSetId",
    "commandType",
    "contextId",
    "eventHash",
    "fingerprintKeyId",
    "id",
    "idempotencyKeyFingerprint",
    "outcome",
    "phase",
    "policyVersionId",
    "previousHash",
    "reasonCode",
    "requestFingerprint",
    "sequence",
    "targetState",
    "tenantId",
  ].sort();
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson(exactKeys)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    !UUID_V7_RE.test(value.id) ||
    typeof value.tenantId !== "string" ||
    !UUID_RE.test(value.tenantId) ||
    typeof value.attemptId !== "string" ||
    !UUID_V7_RE.test(value.attemptId) ||
    !Number.isSafeInteger(value.sequence) ||
    Number(value.sequence) < 1 ||
    typeof value.contextId !== "string" ||
    !UUID_V7_RE.test(value.contextId) ||
    typeof value.actorPrincipalId !== "string" ||
    !UUID_RE.test(value.actorPrincipalId) ||
    typeof value.actorMembershipId !== "string" ||
    !UUID_RE.test(value.actorMembershipId) ||
    !(value.changeSetId === null ||
      (typeof value.changeSetId === "string" && UUID_RE.test(value.changeSetId))) ||
    !["CREATE", "TRANSITION"].includes(String(value.commandType)) ||
    !(value.targetState === null || typeof value.targetState === "string") ||
    typeof value.capability !== "string" ||
    !IDENTIFIER_RE.test(value.capability) ||
    typeof value.policyVersionId !== "string" ||
    !UUID_RE.test(value.policyVersionId) ||
    !["ATTEMPT_STARTED", "RECONCILIATION", "TERMINAL"].includes(
      String(value.phase),
    ) ||
    typeof value.outcome !== "string" ||
    typeof value.reasonCode !== "string" ||
    typeof value.idempotencyKeyFingerprint !== "string" ||
    !SHA256_RE.test(value.idempotencyKeyFingerprint) ||
    typeof value.requestFingerprint !== "string" ||
    !SHA256_RE.test(value.requestFingerprint) ||
    typeof value.fingerprintKeyId !== "string" ||
    !IDENTIFIER_RE.test(value.fingerprintKeyId) ||
    !(value.previousHash === null ||
      (typeof value.previousHash === "string" && SHA256_RE.test(value.previousHash))) ||
    typeof value.eventHash !== "string" ||
    !SHA256_RE.test(value.eventHash)
  ) {
    return null;
  }
  return value as AuditEvent;
}

function terminalForResult(result: ChangeSetCommandResult): {
  changeSetId: string | null;
  outcome: AuditOutcome;
  reasonCode: AuditReason;
} {
  if (result.ok) {
    if (!UUID_RE.test(result.result.changeSetId)) {
      return { changeSetId: null, outcome: "ERROR", reasonCode: "INTERNAL_ERROR" };
    }
    return {
      changeSetId: result.result.changeSetId.toLowerCase(),
      outcome: "SUCCESS",
      reasonCode: "COMMAND_COMPLETED",
    };
  }
  if (
    [
      "unverified_context",
      "impersonation_forbidden",
      "invalid_mutation_assurance",
      "authorization_denied",
    ].includes(result.reason)
  ) {
    return { changeSetId: null, outcome: "DENY", reasonCode: "AUTHORIZATION_DENIED" };
  }
  if (result.reason === "idempotency_key_reused") {
    return { changeSetId: null, outcome: "CONFLICT", reasonCode: "IDEMPOTENCY_CONFLICT" };
  }
  if (result.reason === "command_in_progress") {
    return { changeSetId: null, outcome: "CONFLICT", reasonCode: "COMMAND_IN_PROGRESS" };
  }
  if (
    ["invalid_clock", "invalid_generated_id", "replay_result_invalid"].includes(
      result.reason,
    )
  ) {
    return { changeSetId: null, outcome: "ERROR", reasonCode: "INTERNAL_ERROR" };
  }
  if (
    result.reason === "transition_rejected" &&
    typeof result.detail === "string" &&
    result.detail.includes("evidence")
  ) {
    return { changeSetId: null, outcome: "REJECT", reasonCode: "EVIDENCE_REJECTED" };
  }
  return { changeSetId: null, outcome: "REJECT", reasonCode: "MUTATION_REJECTED" };
}

function reconciledTerminalForResult(result: ChangeSetCommandResult): {
  changeSetId: string | null;
  outcome: AuditOutcome;
  reasonCode: AuditReason;
} {
  const terminal = terminalForResult(result);
  return terminal.outcome === "SUCCESS"
    ? { ...terminal, reasonCode: "COMMAND_RECONCILED" }
    : terminal;
}

export class PostgresChangeSetAuditWriter implements ChangeSetCommandAuditWriter {
  private readonly pool: Pool;
  private readonly expectedRole: string;
  private readonly fingerprintKeyId: string;
  private readonly fingerprintKey: Buffer;
  private readonly nextUuidV7: () => string;

  constructor(options: PostgresChangeSetAuditWriterOptions) {
    if (
      !options?.pool ||
      !ROLE_RE.test(options.expectedRole) ||
      !IDENTIFIER_RE.test(options.fingerprintKeyId) ||
      !Buffer.isBuffer(options.fingerprintKey) ||
      options.fingerprintKey.length < 32 ||
      typeof options.nextUuidV7 !== "function"
    ) {
      throw new Error("change_set_audit_writer_configuration_invalid");
    }
    this.pool = options.pool;
    this.expectedRole = options.expectedRole;
    this.fingerprintKeyId = options.fingerprintKeyId;
    this.fingerprintKey = Buffer.from(options.fingerprintKey);
    this.nextUuidV7 = options.nextUuidV7;
  }

  private freshUuidV7(): string {
    const value = this.nextUuidV7();
    if (!UUID_V7_RE.test(value)) throw new Error("change_set_audit_uuid_invalid");
    return value.toLowerCase();
  }

  private async rpc<T>(
    client: PoolClient,
    name: "load_attempt_tail" | "append_event",
    values: readonly unknown[],
  ): Promise<T> {
    const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
    const result = await client.query<RpcRow>(
      `SELECT fas_audit_v1.${name}(${placeholders}) AS result`,
      [...values],
    );
    if (result.rowCount !== 1) throw new Error("change_set_audit_rpc_cardinality");
    return result.rows[0]?.result as T;
  }

  private async transaction<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let transactionStarted = false;
    let releaseError: Error | undefined;
    try {
      const identity = await client.query<{
        current_user: string;
        tenant_setting: string | null;
      }>(
        `SELECT current_user, nullif(current_setting('app.tenant_id', true), '') AS tenant_setting`,
      );
      if (
        identity.rowCount !== 1 ||
        identity.rows[0]?.current_user !== this.expectedRole ||
        identity.rows[0]?.tenant_setting !== null
      ) {
        throw new Error("change_set_audit_writer_identity_invalid");
      }
      await client.query("BEGIN");
      transactionStarted = true;
      const tenant = await client.query<{ tenant_id: string }>(
        `SELECT set_config('app.tenant_id', $1, true) AS tenant_id`,
        [tenantId],
      );
      if (tenant.rows[0]?.tenant_id !== tenantId) {
        throw new Error("change_set_audit_tenant_not_set");
      }
      const result = await operation(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error("change_set_audit_transaction_failed");
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
          transactionStarted = false;
        } catch (rollbackError) {
          releaseError =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("change_set_audit_rollback_failed");
        }
      }
      throw normalized;
    } finally {
      client.release(releaseError);
    }
  }

  private buildEvent(
    event: Omit<AuditEvent, "eventHash">,
  ): AuditEvent {
    return { ...event, eventHash: eventHash(this.fingerprintKey, event) };
  }

  async startAttempt(
    input: ChangeSetCommandAuditStart,
  ): Promise<ChangeSetCommandAuditAttempt> {
    if (!validAuditStart(input)) {
      throw new Error("change_set_audit_start_invalid");
    }
    const attemptId = this.freshUuidV7();
    const event = this.buildEvent({
      id: this.freshUuidV7(),
      tenantId: input.tenantId.toLowerCase(),
      attemptId,
      sequence: 1,
      contextId: input.contextId.toLowerCase(),
      actorPrincipalId: input.actorPrincipalId.toLowerCase(),
      actorMembershipId: input.actorMembershipId.toLowerCase(),
      changeSetId: null,
      commandType: input.commandType,
      targetState: input.targetState,
      capability: input.capability,
      policyVersionId: input.policyVersionId.toLowerCase(),
      phase: "ATTEMPT_STARTED",
      outcome: "STARTED",
      reasonCode: "REQUEST_ACCEPTED",
      idempotencyKeyFingerprint: hmac(
        this.fingerprintKey,
        "fas.change-set.command-audit.idempotency.v1",
        hashChangeSetCommandIdempotencyKey(input.idempotencyKey),
      ),
      requestFingerprint: hmac(
        this.fingerprintKey,
        "fas.change-set.command-audit.request.v1",
        input.requestHash,
      ),
      fingerprintKeyId: this.fingerprintKeyId,
      previousHash: null,
    });

    await this.transaction(event.tenantId, async (client) => {
      const tail = await this.rpc<unknown>(client, "load_attempt_tail", [
        event.tenantId,
        event.attemptId,
      ]);
      if (tail !== null) throw new Error("change_set_audit_attempt_collision");
      await this.rpc<void>(client, "append_event", [
        event.tenantId,
        JSON.stringify(event),
      ]);
    });

    const authenticTail = (tailValue: unknown) => {
      const tail = parseTail(tailValue);
      if (!tail) throw new Error("change_set_audit_tail_invalid");
      const { eventHash: storedHash, ...tailWithoutHash } = tail;
      const validStart =
        tail.sequence === 1 && tail.phase === "ATTEMPT_STARTED";
      const validPending =
        tail.sequence === 2 &&
        tail.phase === "RECONCILIATION" &&
        tail.outcome === "PENDING" &&
        tail.reasonCode === "COMMIT_OUTCOME_UNKNOWN";
      if (
        (!validStart && !validPending) ||
        tail.attemptId !== event.attemptId ||
        tail.tenantId !== event.tenantId ||
        !secureHashEqual(
          storedHash,
          eventHash(this.fingerprintKey, tailWithoutHash),
        )
      ) {
        throw new Error("change_set_audit_tail_authenticity_invalid");
      }
      return { tail, storedHash, tailWithoutHash };
    };

    const recordTerminal = async (
      terminal: ReturnType<typeof terminalForResult>,
    ) => {
      await this.transaction(event.tenantId, async (client) => {
        const tailValue = await this.rpc<unknown>(client, "load_attempt_tail", [
          event.tenantId,
          event.attemptId,
        ]);
        const { tail, storedHash, tailWithoutHash } = authenticTail(tailValue);
        const terminalEvent = this.buildEvent({
          ...tailWithoutHash,
          id: this.freshUuidV7(),
          sequence: tail.sequence + 1,
          changeSetId: terminal.changeSetId,
          phase: "TERMINAL",
          outcome: terminal.outcome,
          reasonCode: terminal.reasonCode,
          previousHash: storedHash,
        });
        await this.rpc<void>(client, "append_event", [
          event.tenantId,
          JSON.stringify(terminalEvent),
        ]);
      });
    };

    const recordCommitOutcomeUnknown = async () => {
      await this.transaction(event.tenantId, async (client) => {
        const tailValue = await this.rpc<unknown>(client, "load_attempt_tail", [
          event.tenantId,
          event.attemptId,
        ]);
        const { tail, storedHash, tailWithoutHash } = authenticTail(tailValue);
        if (tail.phase === "RECONCILIATION") return;
        const pendingEvent = this.buildEvent({
          ...tailWithoutHash,
          id: this.freshUuidV7(),
          sequence: 2,
          changeSetId: null,
          phase: "RECONCILIATION",
          outcome: "PENDING",
          reasonCode: "COMMIT_OUTCOME_UNKNOWN",
          previousHash: storedHash,
        });
        await this.rpc<void>(client, "append_event", [
          event.tenantId,
          JSON.stringify(pendingEvent),
        ]);
      });
    };

    return Object.freeze({
      attemptId,
      recordResult: async (result: ChangeSetCommandResult) => {
        await recordTerminal(terminalForResult(result));
      },
      recordReconciledResult: async (result: ChangeSetCommandResult) => {
        await recordTerminal(reconciledTerminalForResult(result));
      },
      recordCommitOutcomeUnknown,
      recordUnexpectedError: async () => {
        await recordTerminal({
          changeSetId: null,
          outcome: "ERROR",
          reasonCode: "INTERNAL_ERROR",
        });
      },
    });
  }
}
