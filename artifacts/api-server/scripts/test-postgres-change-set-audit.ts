import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

import {
  signActiveTenantContext,
  verifyActiveTenantContext,
} from "../src/lib/activeTenantContext.js";
import {
  executeCreateR1ChangeSetCommand,
  type ChangeSetCommandAuditStart,
} from "../src/lib/changeSetCommand.js";
import { canonicalJson } from "../src/lib/jsonCanonical.js";
import { PostgresChangeSetAuditWriter } from "../src/lib/postgresChangeSetAuditWriter.js";
import { PostgresChangeSetCommandStore } from "../src/lib/postgresChangeSetCommandStore.js";

const { Client, Pool } = pg;

const adminUrl = requiredUrl("PG_GATE_ADMIN_URL");
const migratorUrl = requiredUrl("PG_GATE_MIGRATOR_URL");
const executorUrl = requiredUrl("PG_GATE_EXECUTOR_URL");
const auditWriterUrl = requiredUrl("PG_GATE_AUDIT_WRITER_URL");
const databaseName = new URL(adminUrl).pathname.slice(1);

for (const value of [adminUrl, migratorUrl, executorUrl, auditWriterUrl]) {
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
      GRANT CONNECT ON DATABASE ${databaseName} TO ${ROLE.auditWriter};
      GRANT USAGE ON SCHEMA public, fas_audit_v1 TO ${ROLE.auditOwner};
      GRANT USAGE ON SCHEMA fas_audit_v1 TO ${ROLE.auditWriter};
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${ROLE.auditOwner}, ${ROLE.auditWriter};
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${ROLE.auditOwner}, ${ROLE.auditWriter};
      GRANT SELECT, INSERT ON TABLE public.change_set_command_audit_events
        TO ${ROLE.auditOwner};
    `);
    const functions = await admin.query<{
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
    assert.equal(functions.rowCount, 3);
    for (const fn of functions.rows) {
      await admin.query(
        `ALTER FUNCTION ${fn.schema_name}.${fn.function_name}(${fn.identity_arguments}) OWNER TO ${ROLE.auditOwner}`,
      );
    }
    await admin.query(`
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_audit_v1 FROM PUBLIC, ${ROLE.auditWriter};
      GRANT EXECUTE ON FUNCTION
        fas_audit_v1.load_attempt_tail(uuid, uuid),
        fas_audit_v1.append_event(uuid, jsonb)
      TO ${ROLE.auditWriter};
    `);
  });
}

function verifiedContext() {
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
  const verified = verifyActiveTenantContext(token, secret, NOW);
  if (!verified.ok) throw new Error(verified.reason);
  return verified.context;
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
      ]),
    });
    const store = new PostgresChangeSetCommandStore(executorPool, {
      expectedRole: ROLE.executor,
      expectedEnvironmentId: "test-ci",
      expectedCellId: "cell-a",
      now: () => NOW,
      resolveMutationAssurance: async () => ({
        impersonating: false,
        stepUpSatisfied: false,
        stepUpReceiptId: null,
      }),
    });
    const context = verifiedContext();
    const replay = await executeCreateR1ChangeSetCommand({
      context,
      command: {
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
      },
      dependencies: {
        store,
        auditWriter,
        now: () => NOW,
        nextUuidV7: uuidFactory([
          "018f6000-0000-7000-8000-000000000101",
          "018f6000-0000-7000-8000-000000000102",
        ]),
      },
    });
    assert.equal(replay.ok, true);
    if (replay.ok) {
      assert.equal(replay.replayed, true);
      assert.equal(replay.result.changeSetId, ID.changeSet);
    }

    const rejected = await executeCreateR1ChangeSetCommand({
      context,
      command: {
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
      },
      dependencies: {
        store,
        auditWriter,
        now: () => NOW,
        nextUuidV7: uuidFactory([
          "018f6000-0000-7000-8000-000000000103",
          "018f6000-0000-7000-8000-000000000104",
        ]),
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

    const rows = await loadAuditRows([
      ID.successAttempt,
      ID.rejectAttempt,
      ID.raceAttempt,
    ]);
    assert.equal(rows.length, 6);
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
    await Promise.all([executorPool.end(), auditPool.end()]);
  }
  console.log(
    "[postgres-audit-gate] PASS: durable start/terminal chains, rollback survival, HMAC verification, tenant denial, role split, and concurrency",
  );
}

await main();
