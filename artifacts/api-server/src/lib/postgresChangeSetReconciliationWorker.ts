import crypto from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import {
  verifyStoredChangeSetCommandSuccess,
  type ChangeSetCommandResult,
} from "./changeSetCommand";
import {
  PostgresChangeSetAuditWriter,
  type ChangeSetPendingReconciliationIdentity,
} from "./postgresChangeSetAuditWriter";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9._:-]{2,95}$/;
const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

type RpcRow = QueryResultRow & { result: unknown };

type ReconciliationJob = ChangeSetPendingReconciliationIdentity & {
  id: string;
  attemptCount: number;
  maxAttempts: number;
};

type CommandOutcome =
  | { state: "NOT_FOUND" | "CLAIMED" | "INVALID" }
  | {
      state: "COMPLETED";
      changeSetId: string;
      result: unknown;
      resultHash: string;
    };

export type ChangeSetReconciliationRunResult =
  | { kind: "EMPTY" }
  | { kind: "RETRY"; attemptId: string; reason: "COMMAND_NOT_FOUND" | "COMMAND_IN_PROGRESS" }
  | { kind: "RESOLVED"; attemptId: string; changeSetId: string }
  | {
      kind: "ESCALATED";
      attemptId: string;
      reason: "COMMAND_NOT_FOUND" | "COMMAND_IN_PROGRESS" | "COMMAND_INVALID";
    };

export type PostgresChangeSetReconciliationWorkerOptions = {
  pool: Pool;
  expectedRole: string;
  auditWriter: PostgresChangeSetAuditWriter;
  leaseSeconds?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function parseJob(value: unknown): ReconciliationJob | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "actorMembershipId",
      "actorPrincipalId",
      "attemptCount",
      "attemptId",
      "capability",
      "commandType",
      "contextId",
      "id",
      "idempotencyKeyHash",
      "maxAttempts",
      "policyVersionId",
      "requestHash",
      "targetState",
      "tenantId",
    ]) ||
    typeof value.id !== "string" ||
    !UUID_V7_RE.test(value.id) ||
    typeof value.tenantId !== "string" ||
    !UUID_RE.test(value.tenantId) ||
    typeof value.attemptId !== "string" ||
    !UUID_V7_RE.test(value.attemptId) ||
    typeof value.contextId !== "string" ||
    !UUID_V7_RE.test(value.contextId) ||
    typeof value.actorPrincipalId !== "string" ||
    !UUID_RE.test(value.actorPrincipalId) ||
    typeof value.actorMembershipId !== "string" ||
    !UUID_RE.test(value.actorMembershipId) ||
    typeof value.policyVersionId !== "string" ||
    !UUID_RE.test(value.policyVersionId) ||
    !["CREATE", "TRANSITION"].includes(String(value.commandType)) ||
    !(
      (value.commandType === "CREATE" && value.targetState === null) ||
      (value.commandType === "TRANSITION" &&
        ["VALIDATED", "SIMULATED", "IN_REVIEW"].includes(
          String(value.targetState),
        ))
    ) ||
    typeof value.capability !== "string" ||
    !IDENTIFIER_RE.test(value.capability) ||
    typeof value.idempotencyKeyHash !== "string" ||
    !SHA256_RE.test(value.idempotencyKeyHash) ||
    typeof value.requestHash !== "string" ||
    !SHA256_RE.test(value.requestHash) ||
    !Number.isSafeInteger(value.attemptCount) ||
    Number(value.attemptCount) < 1 ||
    !Number.isSafeInteger(value.maxAttempts) ||
    Number(value.maxAttempts) < Number(value.attemptCount) ||
    Number(value.maxAttempts) > 12
  ) {
    return null;
  }
  return value as ReconciliationJob;
}

function parseOutcome(value: unknown): CommandOutcome | null {
  if (!isRecord(value) || typeof value.state !== "string") return null;
  if (["NOT_FOUND", "CLAIMED", "INVALID"].includes(value.state)) {
    return exactKeys(value, ["state"])
      ? (value as CommandOutcome)
      : null;
  }
  if (
    value.state !== "COMPLETED" ||
    !exactKeys(value, ["changeSetId", "result", "resultHash", "state"]) ||
    typeof value.changeSetId !== "string" ||
    !UUID_V7_RE.test(value.changeSetId) ||
    typeof value.resultHash !== "string" ||
    !SHA256_RE.test(value.resultHash)
  ) {
    return null;
  }
  return value as CommandOutcome;
}

export class PostgresChangeSetReconciliationWorker {
  private readonly pool: Pool;
  private readonly expectedRole: string;
  private readonly auditWriter: PostgresChangeSetAuditWriter;
  private readonly leaseSeconds: number;

  constructor(options: PostgresChangeSetReconciliationWorkerOptions) {
    if (
      !options?.pool ||
      !ROLE_RE.test(options.expectedRole) ||
      !(options.auditWriter instanceof PostgresChangeSetAuditWriter) ||
      !Number.isSafeInteger(options.leaseSeconds ?? 60) ||
      Number(options.leaseSeconds ?? 60) < 30 ||
      Number(options.leaseSeconds ?? 60) > 300
    ) {
      throw new Error("change_set_reconciliation_worker_configuration_invalid");
    }
    this.pool = options.pool;
    this.expectedRole = options.expectedRole;
    this.auditWriter = options.auditWriter;
    this.leaseSeconds = options.leaseSeconds ?? 60;
  }

  private async transaction<T>(
    tenantId: string,
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    if (!UUID_RE.test(tenantId)) {
      throw new Error("change_set_reconciliation_tenant_invalid");
    }
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
        throw new Error("change_set_reconciliation_worker_identity_invalid");
      }
      await client.query("BEGIN");
      transactionStarted = true;
      const tenant = await client.query<{ tenant_id: string }>(
        `SELECT set_config('app.tenant_id', $1, true) AS tenant_id`,
        [tenantId.toLowerCase()],
      );
      if (tenant.rows[0]?.tenant_id !== tenantId.toLowerCase()) {
        throw new Error("change_set_reconciliation_tenant_not_set");
      }
      const result = await operation(client);
      await client.query("COMMIT");
      transactionStarted = false;
      return result;
    } catch (error) {
      const normalized =
        error instanceof Error
          ? error
          : new Error("change_set_reconciliation_transaction_failed");
      if (transactionStarted) {
        try {
          await client.query("ROLLBACK");
          transactionStarted = false;
        } catch (rollbackError) {
          releaseError =
            rollbackError instanceof Error
              ? rollbackError
              : new Error("change_set_reconciliation_rollback_failed");
        }
      }
      throw normalized;
    } finally {
      client.release(releaseError);
    }
  }

  private async rpc<T>(
    tenantId: string,
    name: "claim_due_job" | "load_command_outcome" | "reschedule_job" | "complete_job",
    values: readonly unknown[],
  ): Promise<T> {
    return this.transaction(tenantId, async (client) => {
      const placeholders = values.map((_, index) => `$${index + 1}`).join(", ");
      const result = await client.query<RpcRow>(
        `SELECT fas_repair_v1.${name}(${placeholders}) AS result`,
        [...values],
      );
      if (result.rowCount !== 1) {
        throw new Error("change_set_reconciliation_rpc_cardinality");
      }
      return result.rows[0]?.result as T;
    });
  }

  private async complete(
    job: ReconciliationJob,
    leaseTokenHash: string,
    input:
      | { status: "RESOLVED"; resolution: "COMMITTED"; changeSetId: string }
      | {
          status: "ESCALATED";
          resolution: "NO_COMMAND" | "INCOMPLETE_COMMAND" | "INVALID_COMMAND";
          errorCode: "COMMAND_NOT_FOUND" | "COMMAND_IN_PROGRESS" | "COMMAND_INVALID";
        },
  ) {
    await this.rpc<void>(job.tenantId, "complete_job", [
      job.tenantId,
      job.id,
      leaseTokenHash,
      input.status,
      input.resolution,
      input.status === "RESOLVED" ? input.changeSetId : null,
      input.status === "ESCALATED" ? input.errorCode : null,
    ]);
  }

  async runOnce(tenantId: string): Promise<ChangeSetReconciliationRunResult> {
    const normalizedTenant = tenantId.toLowerCase();
    const leaseTokenHash = crypto.randomBytes(32).toString("hex");
    const jobValue = await this.rpc<unknown>(normalizedTenant, "claim_due_job", [
      normalizedTenant,
      leaseTokenHash,
      this.leaseSeconds,
    ]);
    if (jobValue === null) return { kind: "EMPTY" };
    const job = parseJob(jobValue);
    if (!job || job.tenantId !== normalizedTenant) {
      throw new Error("change_set_reconciliation_job_invalid");
    }
    const outcomeValue = await this.rpc<unknown>(
      normalizedTenant,
      "load_command_outcome",
      [normalizedTenant, job.id, leaseTokenHash],
    );
    const outcome = parseOutcome(outcomeValue);
    if (!outcome) {
      throw new Error("change_set_reconciliation_outcome_invalid");
    }

    if (outcome.state === "COMPLETED") {
      const success = verifyStoredChangeSetCommandSuccess({
        result: outcome.result,
        resultHash: outcome.resultHash,
      });
      if (success && success.changeSetId === outcome.changeSetId) {
        const result: ChangeSetCommandResult = {
          ok: true,
          replayed: true,
          result: success,
        };
        await this.auditWriter.finalizePendingReconciliation(job, result);
        await this.complete(job, leaseTokenHash, {
          status: "RESOLVED",
          resolution: "COMMITTED",
          changeSetId: success.changeSetId,
        });
        return {
          kind: "RESOLVED",
          attemptId: job.attemptId,
          changeSetId: success.changeSetId,
        };
      }
      await this.auditWriter.finalizePendingReconciliation(job, null);
      await this.complete(job, leaseTokenHash, {
        status: "ESCALATED",
        resolution: "INVALID_COMMAND",
        errorCode: "COMMAND_INVALID",
      });
      return {
        kind: "ESCALATED",
        attemptId: job.attemptId,
        reason: "COMMAND_INVALID",
      };
    }

    const reason =
      outcome.state === "NOT_FOUND"
        ? ("COMMAND_NOT_FOUND" as const)
        : outcome.state === "CLAIMED"
          ? ("COMMAND_IN_PROGRESS" as const)
          : ("COMMAND_INVALID" as const);
    if (reason !== "COMMAND_INVALID" && job.attemptCount < job.maxAttempts) {
      const delaySeconds = Math.min(300, 5 * 2 ** (job.attemptCount - 1));
      await this.rpc<void>(normalizedTenant, "reschedule_job", [
        normalizedTenant,
        job.id,
        leaseTokenHash,
        delaySeconds,
        reason,
      ]);
      return { kind: "RETRY", attemptId: job.attemptId, reason };
    }

    await this.auditWriter.finalizePendingReconciliation(job, null);
    await this.complete(job, leaseTokenHash, {
      status: "ESCALATED",
      resolution:
        reason === "COMMAND_NOT_FOUND"
          ? "NO_COMMAND"
          : reason === "COMMAND_IN_PROGRESS"
            ? "INCOMPLETE_COMMAND"
            : "INVALID_COMMAND",
      errorCode: reason,
    });
    return { kind: "ESCALATED", attemptId: job.attemptId, reason };
  }
}
