import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

import {
  signActiveTenantContext,
  type VerifiedActiveTenantContext,
} from "../src/lib/activeTenantContext.js";
import {
  hashChangeSetCommandIdempotencyKey,
  type ChangeSetCommandAuditStart,
} from "../src/lib/changeSetCommand.js";
import { bindChangeSetRequestContext } from "../src/lib/changeSetRequestContext.js";
import { canonicalJson } from "../src/lib/jsonCanonical.js";
import { PostgresChangeSetAuditWriter } from "../src/lib/postgresChangeSetAuditWriter.js";
import { PostgresChangeSetCommandStore } from "../src/lib/postgresChangeSetCommandStore.js";
import { PostgresChangeSetReconciliationWorker } from "../src/lib/postgresChangeSetReconciliationWorker.js";

const { Client, Pool } = pg;

const adminUrl = requiredUrl("PG_GATE_ADMIN_URL");
const migratorUrl = requiredUrl("PG_GATE_MIGRATOR_URL");
const executorUrl = requiredUrl("PG_GATE_EXECUTOR_URL");
const auditWriterUrl = requiredUrl("PG_GATE_AUDIT_WRITER_URL");
const repairWorkerUrl = requiredUrl("PG_GATE_REPAIR_WORKER_URL");
const databaseName = new URL(adminUrl).pathname.slice(1);

for (const value of [
  adminUrl,
  migratorUrl,
  executorUrl,
  auditWriterUrl,
  repairWorkerUrl,
]) {
  const parsed = new URL(value);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.port, "5432");
  assert.equal(parsed.pathname.slice(1), databaseName);
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "");
}
assert.match(databaseName, /^fas_it_[a-z0-9_]+$/);

const ROLE = {
  auditOwner: "fas_audit_owner",
  auditWriter: "fas_audit_writer",
  executor: "fas_cp_executor",
  repairOwner: "fas_repair_owner",
  repairWorker: "fas_repair_worker",
} as const;

const ID = {
  tenant: "018f5000-0000-7000-8000-000000000001",
  principal: "018f5000-0000-7000-8000-000000000002",
  membership: "018f5000-0000-7000-8000-000000000003",
  policy: "018f5000-0000-7000-8000-000000000004",
  assignment: "018f5000-0000-7000-8000-000000000008",
  context: "018f5000-0000-7000-8000-000000000009",
  changeSet: "018f5000-0000-7000-8000-00000000000d",
  successAttempt: "018f6000-0000-7000-8000-000000000001",
  successStart: "018f6000-0000-7000-8000-000000000002",
  successTerminal: "018f6000-0000-7000-8000-000000000003",
  rejectAttempt: "018f6000-0000-7000-8000-000000000004",
  rejectStart: "018f6000-0000-7000-8000-000000000005",
  rejectTerminal: "018f6000-0000-7000-8000-000000000006",
  raceAttempt: "018f6000-0000-7000-8000-000000000007",
  raceStart: "018f6000-0000-7000-8000-000000000008",
  raceTerminal: "018f6000-0000-7000-8000-000000000009",
  invalidAttempt: "018f6000-0000-7000-8000-00000000000a",
  invalidStart: "018f6000-0000-7000-8000-00000000000b",
  invalidTerminal: "018f6000-0000-7000-8000-00000000000c",
  reconcileAttempt: "018f6000-0000-7000-8000-00000000000d",
  reconcileStart: "018f6000-0000-7000-8000-00000000000e",
  reconcilePending: "018f6000-0000-7000-8000-00000000000f",
  reconcileTerminal: "018f6000-0000-7000-8000-000000000010",
  reconcileJob: "018f6000-0000-7000-8000-000000000020",
  cancellationAttempt: "018f6000-0000-7000-8000-000000000011",
  cancellationStart: "018f6000-0000-7000-8000-000000000012",
  cancellationTerminal: "018f6000-0000-7000-8000-000000000013",
  missingAttempt: "018f6000-0000-7000-8000-000000000021",
  missingStart: "018f6000-0000-7000-8000-000000000022",
  missingPending: "018f6000-0000-7000-8000-000000000023",
  missingJob: "018f6000-0000-7000-8000-000000000024",
  missingTerminal: "018f6000-0000-7000-8000-000000000025",
} as const;

const NOW = Date.now();
const auditKey = crypto.randomBytes(48);
const auditKeyId = "audit-test-key-1";

function requiredUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function withClient<T>(
  url: string,
  operation: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function mustFail(operation: () => Promise<unknown>, pattern: RegExp) {
  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, pattern);
    return true;
  });
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("audit test synchronization timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function uuidFactory(values: readonly string[]) {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (!value) throw new Error("audit test UUID queue exhausted");
    return value;
  };
}

function hmac(domain: string, value: string): string {
  return crypto
    .createHmac("sha256", auditKey)
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function expectedEventHash(row: Record<string, unknown>): string {
  const event = {
    id: row.id,
    tenantId: row.tenantId,
    attemptId: row.attemptId,
    sequence: row.sequence,
    contextId: row.contextId,
    actorPrincipalId: row.actorPrincipalId,
    actorMembershipId: row.actorMembershipId,
    changeSetId: row.changeSetId,
    commandType: row.commandType,
    targetState: row.targetState,
    capability: row.capability,
    policyVersionId: row.policyVersionId,
    phase: row.phase,
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    idempotencyKeyFingerprint: row.idempotencyKeyFingerprint,
    requestFingerprint: row.requestFingerprint,
    fingerprintKeyId: row.fingerprintKeyId,
    previousHash: row.previousHash,
  };
  return hmac(
    "fas.change-set.command-audit.event.v1",
    canonicalJson({
      schemaVersion: 1,
      audience: "fas.change-set.command-audit",
      ...event,
    }),
  );
}

async function bootstrapAuditAuthority() {
  await withClient(adminUrl, async (admin) => {
    await admin.query(`
      CREATE ROLE ${ROLE.repairOwner}
        NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      CREATE ROLE ${ROLE.repairWorker}
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
      ALTER ROLE ${ROLE.repairWorker} SET statement_timeout = '15s';
      ALTER ROLE ${ROLE.repairWorker} SET lock_timeout = '5s';
      ALTER ROLE ${ROLE.repairWorker} SET idle_in_transaction_session_timeout = '15s';
      GRANT CONNECT ON DATABASE ${databaseName} TO ${ROLE.auditWriter}, ${ROLE.repairWorker};
      GRANT USAGE ON SCHEMA public, fas_audit_v1 TO ${ROLE.auditOwner};
      GRANT USAGE ON SCHEMA fas_audit_v1 TO ${ROLE.auditWriter};
      GRANT USAGE ON SCHEMA public, fas_repair_v1 TO ${ROLE.repairOwner};
      GRANT USAGE ON SCHEMA fas_repair_v1 TO ${ROLE.repairWorker};
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM
        ${ROLE.auditOwner}, ${ROLE.auditWriter}, ${ROLE.repairOwner}, ${ROLE.repairWorker};
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM
        ${ROLE.auditOwner}, ${ROLE.auditWriter}, ${ROLE.repairOwner}, ${ROLE.repairWorker};
      GRANT SELECT, INSERT ON TABLE public.change_set_command_audit_events
        TO ${ROLE.auditOwner};
      GRANT SELECT, INSERT ON TABLE public.change_set_reconciliation_jobs
        TO ${ROLE.auditOwner};
      GRANT SELECT, UPDATE ON TABLE public.change_set_reconciliation_jobs
        TO ${ROLE.repairOwner};
      GRANT SELECT ON TABLE public.change_set_command_receipts
        TO ${ROLE.repairOwner};
    `);
    const auditFunctions = await admin.query<{
      schema_name: string;
      function_name: string;
      identity_arguments: string;
    }>(
      `SELECT namespace.nspname AS schema_name,
              procedure.proname AS function_name,
              pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'fas_audit_v1'
       ORDER BY procedure.proname`,
    );
    assert.equal(auditFunctions.rowCount, 4);
    for (const fn of auditFunctions.rows) {
      await admin.query(
        `ALTER FUNCTION ${fn.schema_name}.${fn.function_name}(${fn.identity_arguments}) OWNER TO ${ROLE.auditOwner}`,
      );
    }
    const repairFunctions = await admin.query<{
      schema_name: string;
      function_name: string;
      identity_arguments: string;
    }>(
      `SELECT namespace.nspname AS schema_name,
              procedure.proname AS function_name,
              pg_get_function_identity_arguments(procedure.oid) AS identity_arguments
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       WHERE namespace.nspname = 'fas_repair_v1'
       ORDER BY procedure.proname`,
    );
    assert.equal(repairFunctions.rowCount, 5);
    for (const fn of repairFunctions.rows) {
      await admin.query(
        `ALTER FUNCTION ${fn.schema_name}.${fn.function_name}(${fn.identity_arguments}) OWNER TO ${ROLE.repairOwner}`,
      );
    }
    await admin.query(`
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_audit_v1 FROM PUBLIC, ${ROLE.auditWriter};
      GRANT EXECUTE ON FUNCTION
        fas_audit_v1.load_attempt_tail(uuid, uuid),
        fas_audit_v1.append_event(uuid, jsonb),
        fas_audit_v1.schedule_reconciliation_job(uuid, jsonb)
      TO ${ROLE.auditWriter};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_repair_v1 FROM PUBLIC, ${ROLE.repairWorker};
      GRANT EXECUTE ON FUNCTION
        fas_repair_v1.claim_due_job(uuid, text, integer),
        fas_repair_v1.load_command_outcome(uuid, uuid, text),
        fas_repair_v1.reschedule_job(uuid, uuid, text, integer, text),
        fas_repair_v1.complete_job(uuid, uuid, text, text, text, uuid, text)
      TO ${ROLE.repairWorker};
    `);
  });
}

function activeContextFixture() {
  const secret = crypto.randomBytes(48).toString("base64url");
  const token = signActiveTenantContext(
    {
      tokenVersion: 1,
      contextId: ID.context,
      tenantId: ID.tenant,
      organizationId: null,
      legacyBranchId: null,
      principalId: ID.principal,
      membershipId: ID.membership,
      assignmentIds: [ID.assignment],
      policyVersionId: ID.policy,
      policyVersion: 1,
      issuedAt: NOW - 1_000,
      expiresAt: NOW + 60_000,
    },
    secret,
  );
  return { token, secret };
}

async function loadAuditRows(attemptIds: readonly string[]) {
  return withClient(migratorUrl, async (migrator) => {
    await migrator.query("BEGIN");
    try {
      await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [ID.tenant]);
      const rows = await migrator.query(
        `SELECT
          id::text AS "id", tenant_id::text AS "tenantId",
          attempt_id::text AS "attemptId", sequence,
          context_id::text AS "contextId",
          actor_principal_id::text AS "actorPrincipalId",
          actor_membership_id::text AS "actorMembershipId",
          change_set_id::text AS "changeSetId", command_type AS "commandType",
          target_state AS "targetState", capability,
          policy_version_id::text AS "policyVersionId", phase, outcome,
          reason_code AS "reasonCode",
          idempotency_key_fingerprint AS "idempotencyKeyFingerprint",
          request_fingerprint AS "requestFingerprint",
          fingerprint_key_id AS "fingerprintKeyId",
          previous_hash AS "previousHash", event_hash AS "eventHash"
         FROM public.change_set_command_audit_events
         WHERE tenant_id = $1 AND attempt_id = ANY($2::uuid[])
         ORDER BY attempt_id, sequence`,
        [ID.tenant, attemptIds],
      );
      await migrator.query("COMMIT");
      return rows.rows as Array<Record<string, unknown>>;
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  });
}

async function makeReconciliationDue(
  attemptId: string,
  maxAttempts?: number,
) {
  await withClient(migratorUrl, async (migrator) => {
    await migrator.query("BEGIN");
    try {
      await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        ID.tenant,
      ]);
      const updated = await migrator.query(
        `UPDATE public.change_set_reconciliation_jobs
         SET available_at = statement_timestamp() - interval '1 second',
             max_attempts = COALESCE($3, max_attempts),
             updated_at = statement_timestamp()
         WHERE tenant_id = $1 AND attempt_id = $2`,
        [ID.tenant, attemptId, maxAttempts ?? null],
      );
      assert.equal(updated.rowCount, 1);
      await migrator.query("COMMIT");
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  });
}

async function loadReconciliationJobs() {
  return withClient(migratorUrl, async (migrator) => {
    await migrator.query("BEGIN");
    try {
      await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        ID.tenant,
      ]);
      const rows = await migrator.query(
        `SELECT attempt_id::text AS "attemptId", status, attempt_count AS "attemptCount",
                resolution, resolved_change_set_id::text AS "resolvedChangeSetId",
                last_error_code AS "lastErrorCode", lease_token_hash AS "leaseTokenHash"
         FROM public.change_set_reconciliation_jobs
         WHERE tenant_id = $1
         ORDER BY attempt_id`,
        [ID.tenant],
      );
      await migrator.query("COMMIT");
      return rows.rows as Array<Record<string, unknown>>;
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  });
}

async function main() {
  await bootstrapAuditAuthority();
  const executorPool = new Pool({
    connectionString: executorUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  const auditPool = new Pool({
    connectionString: auditWriterUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  const repairPool = new Pool({
    connectionString: repairWorkerUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  try {
    const auditWriter = new PostgresChangeSetAuditWriter({
      pool: auditPool,
      expectedRole: ROLE.auditWriter,
      fingerprintKeyId: auditKeyId,
      fingerprintKey: auditKey,
      nextUuidV7: uuidFactory([
        ID.successAttempt,
        ID.successStart,
        ID.successTerminal,
        ID.rejectAttempt,
        ID.rejectStart,
        ID.rejectTerminal,
        ID.raceAttempt,
        ID.raceStart,
        ID.raceTerminal,
        ID.reconcileAttempt,
        ID.reconcileStart,
        ID.reconcilePending,
        ID.reconcileJob,
        ID.reconcileTerminal,
        ID.missingAttempt,
        ID.missingStart,
        ID.missingPending,
        ID.missingJob,
        ID.missingTerminal,
        ID.cancellationAttempt,
        ID.cancellationStart,
        ID.cancellationTerminal,
      ]),
    });
    const reconciliationWorker = new PostgresChangeSetReconciliationWorker({
      pool: repairPool,
      expectedRole: ROLE.repairWorker,
      auditWriter,
      leaseSeconds: 60,
    });
    let cancellationArmed = false;
    let resolveCancellationBackendPid: (pid: number) => void = () => undefined;
    const cancellationBackendPid = new Promise<number>((resolve) => {
      resolveCancellationBackendPid = resolve;
    });
    const store = new PostgresChangeSetCommandStore(executorPool, {
      expectedRole: ROLE.executor,
      expectedEnvironmentId: "test-ci",
      expectedCellId: "cell-a",
      now: () => NOW,
      resolveMutationAssurance: async ({ client }) => {
        if (cancellationArmed) {
          cancellationArmed = false;
          const backend = await client.query<{ pid: number }>(
            "SELECT pg_backend_pid()::int AS pid",
          );
          const pid = backend.rows[0]?.pid;
          if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
            throw new Error("audit_cancellation_backend_pid_invalid");
          }
          resolveCancellationBackendPid(Number(pid));
          await client.query("SELECT pg_sleep(30)");
        }
        return {
          impersonating: false,
          stepUpSatisfied: false,
          stepUpReceiptId: null,
        };
      },
    });
    const contextFixture = activeContextFixture();
    const bindRequestGateway = (ids: readonly string[]) => {
      let storeContext: VerifiedActiveTenantContext | undefined;
      const binding = bindChangeSetRequestContext({
        activeContextToken: contextFixture.token,
        activeContextSigningSecret: contextFixture.secret,
        requestIdentity: {
          authenticatedPrincipalId: ID.principal,
          tenantId: ID.tenant,
          organizationId: null,
          legacyBranchId: null,
        },
        createStore: (boundContext) => {
          storeContext = boundContext;
          return store;
        },
        createAuditWriter: (boundContext) => {
          assert.equal(boundContext, storeContext);
          return auditWriter;
        },
        now: () => NOW,
        nextUuidV7: uuidFactory(ids),
      });
      assert.equal(binding.ok, true);
      if (!binding.ok) throw new Error(binding.error.reason);
      if (!storeContext) throw new Error("request_context_factory_not_called");
      return { gateway: binding.gateway, context: storeContext };
    };
    const requestBinding = bindRequestGateway([
      "018f6000-0000-7000-8000-000000000101",
      "018f6000-0000-7000-8000-000000000102",
    ]);
    const context = requestBinding.context;
    const replay = await requestBinding.gateway.executeCreate({
      idempotencyKey: "adapter-create-0001",
      changeType: "FEATURE_FLAG",
      title: "Journey beta adapter verification",
      purpose: "Prove the default-unwired PostgreSQL command adapter.",
      targetScope: { type: "TENANT", organizationId: null, legacyBranchId: null },
      proposedConfig: {
        flagKey: "journey.beta",
        enabled: true,
        cohortPercent: 5,
        reason: "Bounded adapter verification.",
      },
    });
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.replayed, true);
      assert.equal(replay.result.changeSetId, ID.changeSet);
    }

    const rejected = await bindRequestGateway([
      "018f6000-0000-7000-8000-000000000103",
      "018f6000-0000-7000-8000-000000000104",
    ]).gateway.executeCreate({
      idempotencyKey: "adapter-audit-reject-0001",
      changeType: "FEATURE_FLAG",
      title: "Second active proposal",
      purpose: "Prove that business rollback leaves a terminal audit event.",
      targetScope: { type: "TENANT", organizationId: null, legacyBranchId: null },
      proposedConfig: {
        flagKey: "journey.beta",
        enabled: true,
        cohortPercent: 10,
        reason: "This proposal must be rejected.",
      },
    });
    assert.deepEqual(rejected, {
      ok: false,
      reason: "draft_rejected",
      detail: "active_proposal_exists",
    });

    const start: ChangeSetCommandAuditStart = {
      tenantId: ID.tenant,
      contextId: ID.context,
      actorPrincipalId: ID.principal,
      actorMembershipId: ID.membership,
      policyVersionId: ID.policy,
      commandType: "TRANSITION",
      targetState: "VALIDATED",
      capability: "control_plane.change.validate",
      idempotencyKey: "audit-race-command-0001",
      requestHash: "a".repeat(64),
    };
    const racingAttempt = await auditWriter.startAttempt(start);
    const race = await Promise.allSettled([
      racingAttempt.recordResult(replay),
      racingAttempt.recordResult(replay),
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(race.filter((result) => result.status === "rejected").length, 1);

    const committedRequestHash = await withClient(
      migratorUrl,
      async (migrator) => {
        await migrator.query("BEGIN");
        try {
          await migrator.query(
            `SELECT set_config('app.tenant_id', $1, true)`,
            [ID.tenant],
          );
          const command = await migrator.query<{ requestHash: string }>(
            `SELECT request_hash AS "requestHash"
             FROM public.change_set_command_receipts
             WHERE tenant_id = $1 AND idempotency_key_hash = $2`,
            [
              ID.tenant,
              hashChangeSetCommandIdempotencyKey("adapter-create-0001"),
            ],
          );
          assert.equal(command.rowCount, 1);
          await migrator.query("COMMIT");
          return command.rows[0]!.requestHash;
        } catch (error) {
          await migrator.query("ROLLBACK");
          throw error;
        }
      },
    );
    const reconciliationAttempt = await auditWriter.startAttempt({
      ...start,
      commandType: "CREATE",
      targetState: null,
      capability: "control_plane.change.create.feature_flag",
      idempotencyKey: "adapter-create-0001",
      requestHash: committedRequestHash,
    });
    assert.equal(reconciliationAttempt.attemptId, ID.reconcileAttempt);
    await reconciliationAttempt.recordCommitOutcomeUnknown();
    await makeReconciliationDue(ID.reconcileAttempt);
    assert.deepEqual(await reconciliationWorker.runOnce(ID.tenant), {
      kind: "RESOLVED",
      attemptId: ID.reconcileAttempt,
      changeSetId: ID.changeSet,
    });

    const missingAttempt = await auditWriter.startAttempt({
      ...start,
      commandType: "CREATE",
      targetState: null,
      capability: "control_plane.change.create.feature_flag",
      idempotencyKey: "audit-reconciliation-missing-0001",
      requestHash: "f".repeat(64),
    });
    assert.equal(missingAttempt.attemptId, ID.missingAttempt);
    await missingAttempt.recordCommitOutcomeUnknown();
    await makeReconciliationDue(ID.missingAttempt, 2);
    assert.deepEqual(await reconciliationWorker.runOnce(ID.tenant), {
      kind: "RETRY",
      attemptId: ID.missingAttempt,
      reason: "COMMAND_NOT_FOUND",
    });
    await makeReconciliationDue(ID.missingAttempt);
    const missingRace = await Promise.all([
      reconciliationWorker.runOnce(ID.tenant),
      reconciliationWorker.runOnce(ID.tenant),
    ]);
    assert.equal(
      missingRace.filter((result) => result.kind === "ESCALATED").length,
      1,
    );
    assert.equal(
      missingRace.filter((result) => result.kind === "EMPTY").length,
      1,
    );
    assert.deepEqual(
      missingRace.find((result) => result.kind === "ESCALATED"),
      {
        kind: "ESCALATED",
        attemptId: ID.missingAttempt,
        reason: "COMMAND_NOT_FOUND",
      },
    );

    cancellationArmed = true;
    const cancelledCommand = bindRequestGateway([
      "018f6000-0000-7000-8000-000000000105",
      "018f6000-0000-7000-8000-000000000106",
      "018f6000-0000-7000-8000-000000000107",
    ]).gateway.executeCreate({
      idempotencyKey: "audit-cancellation-command-0001",
      changeType: "FEATURE_FLAG",
      title: "Durable cancellation audit verification",
      purpose: "Prove cancellation rollback leaves a terminal audit error.",
      targetScope: {
        type: "TENANT",
        organizationId: null,
        legacyBranchId: null,
      },
      proposedConfig: {
        flagKey: "journey.beta",
        enabled: true,
        cohortPercent: 10,
        reason: "This command is cancelled before its claim.",
      },
    });
    const cancellationOutcome = cancelledCommand.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const cancelledPid = await within(
      Promise.race([
        cancellationBackendPid,
        cancellationOutcome.then((outcome): never => {
          if (outcome.kind === "rejected") throw outcome.error;
          throw new Error("audit_cancellation_command_resolved_before_backend_ready");
        }),
      ]),
      10_000,
    );
    const cancellation = await withClient(adminUrl, (admin) =>
      admin.query<{ cancelled: boolean }>(
        "SELECT pg_cancel_backend($1)::boolean AS cancelled",
        [cancelledPid],
      ),
    );
    assert.equal(cancellation.rows[0]?.cancelled, true);
    const cancelledOutcome = await cancellationOutcome;
    assert.equal(cancelledOutcome.kind, "rejected");
    if (cancelledOutcome.kind === "rejected") {
      assert.ok(cancelledOutcome.error instanceof Error);
      assert.equal(
        (cancelledOutcome.error as Error & { code?: string }).code,
        "57014",
      );
    }

    const rows = await loadAuditRows([
      ID.successAttempt,
      ID.rejectAttempt,
      ID.raceAttempt,
      ID.reconcileAttempt,
      ID.missingAttempt,
      ID.cancellationAttempt,
    ]);
    assert.equal(rows.length, 14);
    for (const row of rows) {
      assert.equal(row.eventHash, expectedEventHash(row));
      assert.match(String(row.idempotencyKeyFingerprint), /^[0-9a-f]{64}$/);
      assert.match(String(row.requestFingerprint), /^[0-9a-f]{64}$/);
      assert.notEqual(row.idempotencyKeyFingerprint, "adapter-create-0001");
    }
    const successRows = rows.filter((row) => row.attemptId === ID.successAttempt);
    assert.deepEqual(
      successRows.map((row) => [row.sequence, row.phase, row.outcome, row.changeSetId]),
      [
        [1, "ATTEMPT_STARTED", "STARTED", null],
        [2, "TERMINAL", "SUCCESS", ID.changeSet],
      ],
    );
    const rejectRows = rows.filter((row) => row.attemptId === ID.rejectAttempt);
    assert.deepEqual(
      rejectRows.map((row) => [row.sequence, row.phase, row.outcome, row.changeSetId]),
      [
        [1, "ATTEMPT_STARTED", "STARTED", null],
        [2, "TERMINAL", "REJECT", null],
      ],
    );
    const reconciliationRows = rows.filter(
      (row) => row.attemptId === ID.reconcileAttempt,
    );
    assert.deepEqual(
      reconciliationRows.map((row) => [
        row.sequence,
        row.phase,
        row.outcome,
        row.reasonCode,
        row.changeSetId,
      ]),
      [
        [1, "ATTEMPT_STARTED", "STARTED", "REQUEST_ACCEPTED", null],
        [
          2,
          "RECONCILIATION",
          "PENDING",
          "COMMIT_OUTCOME_UNKNOWN",
          null,
        ],
        [
          3,
          "TERMINAL",
          "SUCCESS",
          "COMMAND_RECONCILED",
          ID.changeSet,
        ],
      ],
    );
    const missingRows = rows.filter(
      (row) => row.attemptId === ID.missingAttempt,
    );
    assert.deepEqual(
      missingRows.map((row) => [
        row.sequence,
        row.phase,
        row.outcome,
        row.reasonCode,
        row.changeSetId,
      ]),
      [
        [1, "ATTEMPT_STARTED", "STARTED", "REQUEST_ACCEPTED", null],
        [
          2,
          "RECONCILIATION",
          "PENDING",
          "COMMIT_OUTCOME_UNKNOWN",
          null,
        ],
        [3, "TERMINAL", "ERROR", "INTERNAL_ERROR", null],
      ],
    );
    const cancellationRows = rows.filter(
      (row) => row.attemptId === ID.cancellationAttempt,
    );
    assert.deepEqual(
      cancellationRows.map((row) => [
        row.sequence,
        row.phase,
        row.outcome,
        row.reasonCode,
        row.changeSetId,
      ]),
      [
        [1, "ATTEMPT_STARTED", "STARTED", "REQUEST_ACCEPTED", null],
        [2, "TERMINAL", "ERROR", "INTERNAL_ERROR", null],
      ],
    );

    assert.deepEqual(await loadReconciliationJobs(), [
      {
        attemptId: ID.reconcileAttempt,
        status: "RESOLVED",
        attemptCount: 1,
        resolution: "COMMITTED",
        resolvedChangeSetId: ID.changeSet,
        lastErrorCode: null,
        leaseTokenHash: null,
      },
      {
        attemptId: ID.missingAttempt,
        status: "ESCALATED",
        attemptCount: 2,
        resolution: "NO_COMMAND",
        resolvedChangeSetId: null,
        lastErrorCode: "COMMAND_NOT_FOUND",
        leaseTokenHash: null,
      },
    ]);
    assert.deepEqual(
      await reconciliationWorker.runOnce(
        "018f3000-0000-7000-8000-000000000101",
      ),
      { kind: "EMPTY" },
    );
    const reusedRepairClient = await repairPool.connect();
    try {
      const clean = await reusedRepairClient.query<{
        tenantSetting: string | null;
      }>(
        `SELECT nullif(current_setting('app.tenant_id', true), '') AS "tenantSetting"`,
      );
      assert.equal(clean.rows[0]?.tenantSetting, null);
    } finally {
      reusedRepairClient.release();
    }

    await withClient(auditWriterUrl, async (writer) => {
      await mustFail(
        () => writer.query("SELECT * FROM public.change_set_command_audit_events"),
        /permission denied/,
      );
      await mustFail(
        () => writer.query("SELECT fas_audit_v1.load_attempt_tail($1,$2)", [
          ID.tenant,
          ID.successAttempt,
        ]),
        /tenant context mismatch/,
      );
      await writer.query("BEGIN");
      try {
        await writer.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          "018f3000-0000-7000-8000-000000000101",
        ]);
        await mustFail(
          () => writer.query("SELECT fas_audit_v1.load_attempt_tail($1,$2)", [
            ID.tenant,
            ID.successAttempt,
          ]),
          /tenant context mismatch/,
        );
      } finally {
        await writer.query("ROLLBACK");
      }
    });

    await withClient(repairWorkerUrl, async (worker) => {
      await mustFail(
        () => worker.query("SELECT * FROM public.change_set_reconciliation_jobs"),
        /permission denied/,
      );
      await mustFail(
        () =>
          worker.query(
            "SELECT fas_repair_v1.claim_due_job($1,$2,$3)",
            [ID.tenant, "a".repeat(64), 60],
          ),
        /tenant context mismatch/,
      );
      await mustFail(
        () =>
          worker.query("SELECT fas_audit_v1.load_attempt_tail($1,$2)", [
            ID.tenant,
            ID.reconcileAttempt,
          ]),
        /permission denied/,
      );
    });

    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [ID.tenant]);
        const common = [
          ID.tenant,
          ID.invalidAttempt,
          ID.context,
          ID.principal,
          ID.membership,
          ID.policy,
        ];
        await migrator.query(
          `INSERT INTO public.change_set_command_audit_events (
            id, tenant_id, attempt_id, sequence, context_id, actor_principal_id,
            actor_membership_id, command_type, target_state, capability,
            policy_version_id, phase, outcome, reason_code,
            idempotency_key_fingerprint, request_fingerprint, fingerprint_key_id,
            previous_hash, event_hash
          ) VALUES ($1,$2,$3,1,$4,$5,$6,'CREATE',NULL,'control_plane.flag.create',
            $7,'ATTEMPT_STARTED','STARTED','REQUEST_ACCEPTED',$8,$9,$10,NULL,$11)`,
          [
            ID.invalidStart,
            ...common,
            "b".repeat(64),
            "c".repeat(64),
            auditKeyId,
            "d".repeat(64),
          ],
        );
        await mustFail(
          () => migrator.query(
            `INSERT INTO public.change_set_command_audit_events (
              id, tenant_id, attempt_id, sequence, context_id, actor_principal_id,
              actor_membership_id, command_type, target_state, capability,
              policy_version_id, phase, outcome, reason_code,
              idempotency_key_fingerprint, request_fingerprint, fingerprint_key_id,
              previous_hash, event_hash
            ) VALUES ($1,$2,$3,2,$4,$5,$6,'CREATE',NULL,'control_plane.flag.create',
              $7,'TERMINAL','SUCCESS','COMMAND_COMPLETED',$8,$9,$10,$11,$12)`,
            [
              ID.invalidTerminal,
              ...common,
              "b".repeat(64),
              "c".repeat(64),
              auditKeyId,
              "d".repeat(64),
              "e".repeat(64),
            ],
          ),
          /terminal_success_change_set_chk/,
        );
      } finally {
        await migrator.query("ROLLBACK");
      }
    });
  } finally {
    await Promise.all([executorPool.end(), auditPool.end(), repairPool.end()]);
  }
  console.log(
    "[postgres-audit-gate] PASS: durable start/terminal chains, scheduled receipt-only reconciliation, exhausted no-command escalation, SQLSTATE 57014 cancellation audit, rollback survival, HMAC verification, tenant denial, role split, and concurrency",
  );
}

await main();
