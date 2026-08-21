import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { canonicalJson } from "../src/lib/jsonCanonical.js";

const { Client } = pg;
const mode = process.argv[2];
const adminUrl = process.env.PG_GATE_ADMIN_URL ?? "";
const migratorUrl = process.env.PG_GATE_MIGRATOR_URL ?? "";
const appUrl = process.env.PG_GATE_APP_URL ?? "";

function safeTarget(value: string, label: string) {
  assert.ok(value, `${label} is required`);
  const target = new URL(value);
  assert.equal(target.protocol, "postgresql:");
  assert.ok(["127.0.0.1", "localhost"].includes(target.hostname));
  assert.equal(target.port, "5432");
  assert.match(target.pathname.slice(1), /^fas_it_[a-z0-9_]+$/);
  assert.equal(target.search, "");
  assert.equal(target.hash, "");
  return target;
}

const adminTarget = safeTarget(adminUrl, "PG_GATE_ADMIN_URL");
const migratorTarget = safeTarget(migratorUrl, "PG_GATE_MIGRATOR_URL");
const appTarget = safeTarget(appUrl, "PG_GATE_APP_URL");
assert.equal(process.env.ALLOW_LIVE_INTEGRATIONS, "false");
assert.equal(adminTarget.pathname, migratorTarget.pathname);
assert.equal(adminTarget.pathname, appTarget.pathname);
assert.equal(adminTarget.hostname, migratorTarget.hostname);
assert.equal(adminTarget.hostname, appTarget.hostname);
assert.equal(adminTarget.port, migratorTarget.port);
assert.equal(adminTarget.port, appTarget.port);
assert.equal(adminTarget.username, "postgres");
assert.equal(migratorTarget.username, "fas_migrator");
assert.equal(appTarget.username, "fas_app");
assert.notEqual(adminUrl, migratorUrl);
assert.notEqual(migratorUrl, appUrl);

const databaseName = adminTarget.pathname.slice(1);
const migratorRole = "fas_migrator";
const appRole = "fas_app";

async function withClient<T>(url: string, fn: (client: pg.Client) => Promise<T>) {
  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  await client.connect();
  try {
    const identity = await client.query(
      "SELECT current_user, current_database(), inet_server_port() AS server_port",
    );
    assert.equal(identity.rows[0].current_user, new URL(url).username);
    assert.equal(identity.rows[0].current_database, databaseName);
    assert.equal(identity.rows[0].server_port, 5432);
    return await fn(client);
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

async function setup() {
  await withClient(adminUrl, async (client) => {
    await client.query(`
      CREATE ROLE ${migratorRole}
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
        PASSWORD 'fas_migrator_it_2026';
      CREATE ROLE ${appRole}
        LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS
        PASSWORD 'fas_app_it_2026';
      ALTER DATABASE ${databaseName} OWNER TO ${migratorRole};
      REVOKE TEMPORARY ON DATABASE ${databaseName} FROM PUBLIC;
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      GRANT USAGE, CREATE ON SCHEMA public TO ${migratorRole};
      ALTER ROLE ${migratorRole} SET statement_timeout = '15s';
      ALTER ROLE ${migratorRole} SET lock_timeout = '5s';
      ALTER ROLE ${appRole} SET statement_timeout = '15s';
      ALTER ROLE ${appRole} SET lock_timeout = '5s';
      ALTER ROLE ${appRole} SET idle_in_transaction_session_timeout = '15s';
    `);
  });
  console.log("[postgres-gate] disposable authority split prepared");
}

const ID = {
  tenantA: "018f3000-0000-7000-8000-000000000001",
  organizationA: "018f3000-0000-7000-8000-000000000002",
  principalA: "018f3000-0000-7000-8000-000000000003",
  membershipA: "018f3000-0000-7000-8000-000000000004",
  policyA: "018f3000-0000-7000-8000-000000000005",
  tenantB: "018f3000-0000-7000-8000-000000000101",
  organizationB: "018f3000-0000-7000-8000-000000000102",
  principalB: "018f3000-0000-7000-8000-000000000103",
  membershipB: "018f3000-0000-7000-8000-000000000104",
  policyB: "018f3000-0000-7000-8000-000000000105",
  changeSet: "018f3000-0000-7000-8000-000000000201",
  duplicateChangeSet: "018f3000-0000-7000-8000-000000000202",
  raceChangeSet: "018f3000-0000-7000-8000-00000000020d",
  command: "018f3000-0000-7000-8000-000000000203",
  commandTwo: "018f3000-0000-7000-8000-000000000204",
  commandThree: "018f3000-0000-7000-8000-000000000205",
  context: "018f3000-0000-7000-8000-000000000206",
  contextTwo: "018f3000-0000-7000-8000-000000000207",
  contextThree: "018f3000-0000-7000-8000-000000000208",
  evidence: "018f3000-0000-7000-8000-000000000209",
  racingEvidence: "018f3000-0000-7000-8000-00000000020a",
  transition: "018f3000-0000-7000-8000-00000000020b",
  decision: "018f3000-0000-7000-8000-00000000020c",
  transitionTwo: "018f3000-0000-7000-8000-00000000020e",
  transitionThree: "018f3000-0000-7000-8000-00000000020f",
  evidenceLessTransition: "018f3000-0000-7000-8000-000000000210",
} as const;

const baseHash = "a".repeat(64);
const proposedHash = "b".repeat(64);
const validationOutcomeHash = crypto
  .createHash("sha256")
  .update(
    canonicalJson({
      artifactCount: null,
      kind: "VALIDATION",
      outcome: "PASSED",
    }),
    "utf8",
  )
  .digest("hex");
const TENANT_OWNED_TABLES = [
  "tenants",
  "organizations",
  "memberships",
  "policy_versions",
  "authorization_change_receipts",
  "access_assignments",
  "access_decision_receipts",
  "tenant_organization_legacy_branches",
  "change_sets",
  "change_set_approvals",
  "change_set_transition_receipts",
  "change_set_command_receipts",
  "change_set_evidence_receipts",
  "change_set_command_attempt_receipts",
] as const;

async function setTenant(client: pg.Client, tenantId: string) {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

async function inTenantTransaction<T>(
  client: pg.Client,
  tenantId: string,
  fn: () => Promise<T>,
) {
  await client.query("BEGIN");
  try {
    await setTenant(client, tenantId);
    const result = await fn();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function seedTenant(
  client: pg.Client,
  input: {
    tenantId: string;
    organizationId: string;
    principalId: string;
    membershipId: string;
    policyId: string;
    branchId: number;
    slug: string;
  },
) {
  await inTenantTransaction(client, input.tenantId, async () => {
    await client.query(
      `INSERT INTO public.tenants
        (id, slug, legal_name, display_name, home_region)
       VALUES ($1, $2, $3, $3, 'eu-central')`,
      [input.tenantId, input.slug, `${input.slug} legal`],
    );
    await client.query(
      `INSERT INTO public.organizations
        (id, tenant_id, legal_name, display_name, organization_type)
       VALUES ($1, $2, $3, $3, 'OPERATING_ENTITY')`,
      [input.organizationId, input.tenantId, `${input.slug} org`],
    );
    await client.query(
      `INSERT INTO public.policy_versions
        (id, tenant_id, version_number, checksum, state, predicate_document, effective_at)
       VALUES ($1, $2, 1, $3, 'ACTIVE', '{}'::jsonb, now())`,
      [input.policyId, input.tenantId, baseHash],
    );
    await client.query(
      `INSERT INTO public.tenant_organization_legacy_branches
        (tenant_id, organization_id, legacy_branch_id) VALUES ($1, $2, $3)`,
      [input.tenantId, input.organizationId, input.branchId],
    );
    await client.query(
      `INSERT INTO public.memberships
        (id, tenant_id, organization_id, principal_id, status)
       VALUES ($1, $2, $3, $4, 'ACTIVE')`,
      [input.membershipId, input.tenantId, input.organizationId, input.principalId],
    );
  });
}

async function insertChangeSet(
  client: pg.Client,
  id: string,
  organizationScope = false,
) {
  await client.query(
    `INSERT INTO public.change_sets (
      id, tenant_id, change_type, configuration_key, title, purpose,
      owner_principal_id, owner_membership_id, maker_principal_id,
      maker_membership_id, target_scope_type, target_organization_id,
      base_version, base_hash,
      proposed_version, proposed_hash, base_config, proposed_config,
      compatibility_range, data_class, semantic_diff, approval_policy_version,
      approval_policy_version_id, rollout_strategy, canary_scope,
      abort_conditions, rollback_strategy
    ) VALUES (
      $1, $2, 'FEATURE_FLAG', 'journey.beta', 'Journey beta', 'DB gate',
      $3, $4, $3, $4, $8, $9, 0, $5, 1, $6,
      '{"flagKey":"journey.beta","enabled":false}'::jsonb,
      '{"flagKey":"journey.beta","enabled":true}'::jsonb,
      '>=1', 'INTERNAL', '{"changed":["enabled"]}'::jsonb,
      $7, $7, '{"mode":"all"}'::jsonb, '{}'::jsonb,
      '[{"metric":"error_rate","op":"gt","value":0}]'::jsonb,
      '{"mode":"restore_base"}'::jsonb
    )`,
    [
      id,
      ID.tenantA,
      ID.principalA,
      ID.membershipA,
      baseHash,
      proposedHash,
      ID.policyA,
      organizationScope ? "ORGANIZATION" : "TENANT",
      organizationScope ? ID.organizationA : null,
    ],
  );
}

async function seedControlPlane(client: pg.Client) {
  await inTenantTransaction(client, ID.tenantA, async () => {
    await insertChangeSet(client, ID.changeSet);
    await insertChangeSet(client, ID.raceChangeSet, true);
    await client.query(
      `INSERT INTO public.change_set_command_receipts (
        id, tenant_id, idempotency_key_hash, request_hash, context_id,
        actor_principal_id, actor_membership_id, command_type, target_state, change_set_id
      ) VALUES
        ($1, $4, $7, $8, $10, $5, $6, 'TRANSITION', 'VALIDATED', $9),
        ($2, $4, $11, $8, $12, $5, $6, 'TRANSITION', 'VALIDATED', $15),
        ($3, $4, $13, $8, $14, $5, $6, 'TRANSITION', 'VALIDATED', $15)`,
      [
        ID.command,
        ID.commandTwo,
        ID.commandThree,
        ID.tenantA,
        ID.principalA,
        ID.membershipA,
        "1".repeat(64),
        "2".repeat(64),
        ID.changeSet,
        ID.context,
        "3".repeat(64),
        ID.contextTwo,
        "4".repeat(64),
        ID.contextThree,
        ID.raceChangeSet,
      ],
    );
    for (const [evidenceId, changeSetId] of [
      [ID.evidence, ID.changeSet],
      [ID.racingEvidence, ID.raceChangeSet],
    ] as const) {
      await client.query(
        `INSERT INTO public.change_set_evidence_receipts (
          id, tenant_id, change_set_id, target_state, kind, issuer, tool_version,
          requested_by_principal_id, requested_by_membership_id, subject_hash,
          policy_version_id, outcome, artifact_count, outcome_hash, issued_at, expires_at
        ) VALUES (
          $1, $2, $3, 'VALIDATED', 'VALIDATION', 'fas-evidence-service', 'test-v1',
          $4, $5, $6, $7, 'PASSED', NULL, $8, now(), now() + interval '30 minutes'
        )`,
        [
          evidenceId,
          ID.tenantA,
          changeSetId,
          ID.principalA,
          ID.membershipA,
          proposedHash,
          ID.policyA,
          validationOutcomeHash,
        ],
      );
    }
  });
}

async function grantRuntime(admin: pg.Client) {
  await admin.query(`
    GRANT CONNECT ON DATABASE ${databaseName} TO ${appRole};
    GRANT USAGE ON SCHEMA public TO ${appRole};
    GRANT SELECT ON TABLE public.memberships TO ${appRole};
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
      ON ALL TABLES IN SCHEMA public FROM ${appRole};
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${appRole};
  `);
}

async function verifyRoles(admin: pg.Client) {
  const result = await admin.query(
    `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls
     FROM pg_roles WHERE rolname IN ($1, $2) ORDER BY rolname`,
    [appRole, migratorRole],
  );
  assert.equal(result.rowCount, 2);
  for (const role of result.rows) {
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolcreatedb, false);
    assert.equal(role.rolcreaterole, false);
    assert.equal(role.rolinherit, false);
    assert.equal(role.rolbypassrls, false);
  }
  const membership = await admin.query(
    `SELECT count(*)::int AS count
     FROM pg_auth_members member
     JOIN pg_roles granted ON granted.oid = member.roleid
     JOIN pg_roles recipient ON recipient.oid = member.member
     WHERE granted.rolname = $1 AND recipient.rolname = $2`,
    [migratorRole, appRole],
  );
  assert.equal(membership.rows[0].count, 0);

  const ownership = await admin.query(
    `SELECT tableowner, count(*)::int AS count
     FROM pg_tables
     WHERE schemaname = 'public'
       AND tablename = ANY($1::text[])
     GROUP BY tableowner`,
    [TENANT_OWNED_TABLES],
  );
  assert.deepEqual(ownership.rows, [
    { tableowner: migratorRole, count: TENANT_OWNED_TABLES.length },
  ]);
  const rls = await admin.query(
    `SELECT relation.relname, relation.relrowsecurity, relation.relforcerowsecurity
     FROM pg_class relation
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relname = ANY($1::text[])
     ORDER BY relation.relname`,
    [TENANT_OWNED_TABLES],
  );
  assert.equal(rls.rowCount, TENANT_OWNED_TABLES.length);
  for (const relation of rls.rows) {
    assert.equal(relation.relrowsecurity, true, `${relation.relname} must enable RLS`);
    assert.equal(
      relation.relforcerowsecurity,
      true,
      `${relation.relname} must force RLS`,
    );
  }
}

async function verifyAtomicDdlRollback(migrator: pg.Client) {
  await migrator.query("BEGIN");
  try {
    await migrator.query("CREATE TABLE public.pg_gate_atomic_probe (id integer)");
    assert.equal(
      (
        await migrator.query(
          "SELECT to_regclass('public.pg_gate_atomic_probe') IS NOT NULL AS exists",
        )
      ).rows[0].exists,
      true,
    );
    await migrator.query("SELECT missing_column FROM public.pg_gate_atomic_probe");
    assert.fail("injected migration failure should abort");
  } catch (error) {
    assert.equal(
      (error as { code?: string }).code,
      "42703",
      "the injected failure must be the expected undefined-column error",
    );
    await migrator.query("ROLLBACK");
  }
  const result = await migrator.query(
    "SELECT to_regclass('public.pg_gate_atomic_probe') AS relation",
  );
  assert.equal(result.rows[0].relation, null);
  assert.equal(
    (
      await migrator.query(
        "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
      )
    ).rows[0].count,
    58,
  );
}

async function verifyOwnerNoContext(migrator: pg.Client) {
  for (const table of TENANT_OWNED_TABLES) {
    const result = await migrator.query(
      `SELECT count(*)::int AS count FROM public.${table}`,
    );
    assert.equal(result.rows[0].count, 0, `${table} must hide rows without context`);
  }
}

async function verifyRlsAndCleanup(app: pg.Client) {
  await inTenantTransaction(app, ID.tenantA, async () => {
    const rows = await app.query("SELECT id FROM public.memberships ORDER BY id");
    assert.deepEqual(rows.rows.map((row) => row.id), [ID.membershipA]);
  });
  assert.equal(
    (await app.query("SELECT count(*)::int AS count FROM public.memberships")).rows[0]
      .count,
    0,
  );
  assert.equal(
    (await app.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0]
      .tenant,
    "",
  );

  await app.query("BEGIN");
  await setTenant(app, ID.tenantA);
  assert.equal(
    (await app.query("SELECT count(*)::int AS count FROM public.memberships")).rows[0]
      .count,
    1,
  );
  await app.query("ROLLBACK");
  assert.equal(
    (await app.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0]
      .tenant,
    "",
  );

  await app.query("BEGIN");
  await setTenant(app, ID.tenantA);
  await mustFail(
    () => app.query("SELECT definitely_missing_column FROM public.memberships"),
    /definitely_missing_column/,
  );
  await app.query("ROLLBACK");
  assert.equal(
    (await app.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0]
      .tenant,
    "",
  );

}

async function verifyComposites(migrator: pg.Client) {
  await migrator.query("BEGIN");
  await setTenant(migrator, ID.tenantA);
  await mustFail(
    () =>
      migrator.query(
        `INSERT INTO public.change_set_command_receipts (
          id, tenant_id, idempotency_key_hash, request_hash, context_id,
          actor_principal_id, actor_membership_id, command_type, target_state, change_set_id
        ) VALUES (
          '018f3000-0000-7000-8000-000000000301', $1, $2, $3,
          '018f3000-0000-7000-8000-000000000302', $4, $5,
          'CREATE', NULL, NULL
        )`,
        [
          ID.tenantB,
          "5".repeat(64),
          "6".repeat(64),
          ID.principalB,
          ID.membershipB,
        ],
      ),
    /row-level security policy/,
  );
  await migrator.query("ROLLBACK");

  await migrator.query("BEGIN");
  await setTenant(migrator, ID.tenantA);
  await mustFail(
    () =>
      migrator.query(
        `INSERT INTO public.change_set_command_receipts (
          id, tenant_id, idempotency_key_hash, request_hash, context_id,
          actor_principal_id, actor_membership_id, command_type, target_state, change_set_id
        ) VALUES (
          '018f3000-0000-7000-8000-000000000304', $1, $2, $3,
          '018f3000-0000-7000-8000-000000000305', $4, $5,
          'TRANSITION', NULL, $6
        )`,
        [
          ID.tenantA,
          "8".repeat(64),
          "9".repeat(64),
          ID.principalA,
          ID.membershipA,
          ID.raceChangeSet,
        ],
      ),
    /change_set_command_receipts_target_state_chk/,
  );
  await migrator.query("ROLLBACK");

  await migrator.query("BEGIN");
  await setTenant(migrator, ID.tenantA);
  await mustFail(
    () =>
      migrator.query(
        `INSERT INTO public.memberships
          (id, tenant_id, organization_id, legacy_branch_id, principal_id, status)
         VALUES ('018f3000-0000-7000-8000-000000000302', $1, $2, 7201, $3, 'ACTIVE')`,
        [ID.tenantA, ID.organizationA, ID.principalA],
      ),
    /memberships_tenant_organization_branch_fk/,
  );
  await migrator.query("ROLLBACK");

  await migrator.query("BEGIN");
  await setTenant(migrator, ID.tenantA);
  await mustFail(
    () =>
      migrator.query(
        `INSERT INTO public.access_decision_receipts (
          id, tenant_id, context_id, actor_principal_id, membership_id,
          assignment_ids, role_package_version_ids, capability_key,
          resource_type, resource_id, decision, reason_code,
          policy_version_id, correlation_id
        ) VALUES (
          $1, $2, $3, $4, $5, '{}'::uuid[], '{}'::uuid[],
          'control_plane.change.validate', 'CHANGE_SET', $6,
          'DENY', 'tuple_mismatch', $7, 'pg-gate'
        )`,
        [
          ID.decision,
          ID.tenantA,
          ID.context,
          ID.principalB,
          ID.membershipA,
          ID.changeSet,
          ID.policyA,
        ],
      ),
    /access_decision_receipts_actor_membership_fk/,
  );
  await migrator.query("ROLLBACK");
}

async function verifyProposalAndEvidence(migrator: pg.Client) {
  await migrator.query("BEGIN");
  await setTenant(migrator, ID.tenantA);
  await mustFail(
    () => insertChangeSet(migrator, ID.duplicateChangeSet),
    /change_sets_one_active_proposal_per_target_uidx/,
  );
  await migrator.query("ROLLBACK");

  await migrator.query("BEGIN");
  await setTenant(migrator, ID.tenantA);
  await migrator.query(
    `INSERT INTO public.change_set_transition_receipts (
      id, command_receipt_id, tenant_id, change_set_id, sequence, actor_principal_id,
      actor_membership_id, from_state, to_state, reason_code, policy_version,
      policy_version_id, evidence, evidence_hash, previous_hash, receipt_hash
    ) VALUES (
      $1, $2, $3, $4, 2, $5, $6, 'DRAFT', 'VALIDATED', 'missing_evidence', $7, $7,
      '{}'::jsonb, $8, NULL, $9
    )`,
    [
      ID.evidenceLessTransition,
      ID.commandTwo,
      ID.tenantA,
      ID.raceChangeSet,
      ID.principalA,
      ID.membershipA,
      ID.policyA,
      "a".repeat(64),
      "b".repeat(64),
    ],
  );
  await migrator.query(
    `UPDATE public.change_sets
     SET status = 'VALIDATED', version = 2,
         validation_result = '{"passed":true}'::jsonb, updated_at = now()
     WHERE tenant_id = $1 AND id = $2 AND version = 1`,
    [ID.tenantA, ID.raceChangeSet],
  );
  await mustFail(
    () =>
      migrator.query(
        `UPDATE public.change_set_command_receipts
         SET status = 'COMPLETED', result = '{"status":"VALIDATED"}'::jsonb,
             result_hash = $1, version = 2, completed_at = now()
         WHERE tenant_id = $2 AND id = $3`,
        ["c".repeat(64), ID.tenantA, ID.commandTwo],
      ),
    /exact typed evidence set/,
  );
  await migrator.query("ROLLBACK");

  await inTenantTransaction(migrator, ID.tenantA, async () => {
    await migrator.query(
      `UPDATE public.change_set_evidence_receipts
       SET consumed_at = now(), consumed_by_command_receipt_id = $1
       WHERE tenant_id = $2 AND id = $3`,
      [ID.command, ID.tenantA, ID.evidence],
    );
    await migrator.query(
      `INSERT INTO public.change_set_transition_receipts (
        id, command_receipt_id, tenant_id, change_set_id, sequence, actor_principal_id,
        actor_membership_id, from_state, to_state, reason_code, policy_version,
        policy_version_id, evidence, evidence_hash, previous_hash, receipt_hash
      ) VALUES (
        $1, $9, $2, $3, 2, $4, $5, 'DRAFT', 'VALIDATED', 'pg_gate', $6, $6,
        '{}'::jsonb, $7, NULL, $8
      )`,
      [
        ID.transition,
        ID.tenantA,
        ID.changeSet,
        ID.principalA,
        ID.membershipA,
        ID.policyA,
        "e".repeat(64),
          "d".repeat(64),
          ID.command,
      ],
    );
    await migrator.query(
      `UPDATE public.change_sets
       SET status = 'VALIDATED', version = 2,
           validation_result = '{"passed":true}'::jsonb, updated_at = now()
       WHERE tenant_id = $1 AND id = $2 AND version = 1`,
      [ID.tenantA, ID.changeSet],
    );
    await migrator.query(
      `UPDATE public.change_set_command_receipts
       SET status = 'COMPLETED', result = '{"status":"VALIDATED"}'::jsonb,
           result_hash = $1, version = 2, completed_at = now()
       WHERE tenant_id = $2 AND id = $3`,
      ["c".repeat(64), ID.tenantA, ID.command],
    );
  });

  await migrator.query("BEGIN");
  await setTenant(migrator, ID.tenantA);
  await mustFail(
    () =>
      migrator.query(
        `UPDATE public.change_set_evidence_receipts
         SET consumed_at = now(), consumed_by_command_receipt_id = $1
         WHERE tenant_id = $2 AND id = $3`,
        [ID.commandTwo, ID.tenantA, ID.evidence],
      ),
    /single-use/,
  );
  await migrator.query("ROLLBACK");
}

async function consumeEvidence(commandId: string) {
  const transitionReceiptId =
    commandId === ID.commandTwo ? ID.transitionTwo : ID.transitionThree;
  const receiptHash = commandId === ID.commandTwo ? "8".repeat(64) : "9".repeat(64);
  const resultHash = commandId === ID.commandTwo ? "6".repeat(64) : "7".repeat(64);
  return withClient(migratorUrl, (client) =>
    inTenantTransaction(client, ID.tenantA, async () => {
      const result = await client.query(
        `UPDATE public.change_set_evidence_receipts
         SET consumed_at = now(), consumed_by_command_receipt_id = $1
         WHERE tenant_id = $2 AND id = $3 AND consumed_at IS NULL`,
        [commandId, ID.tenantA, ID.racingEvidence],
      );
      if (result.rowCount === 0) return 0;
      await client.query(
        `INSERT INTO public.change_set_transition_receipts (
          id, command_receipt_id, tenant_id, change_set_id, sequence, actor_principal_id,
          actor_membership_id, from_state, to_state, reason_code, policy_version,
          policy_version_id, evidence, evidence_hash, previous_hash, receipt_hash
        ) VALUES (
          $1, $9, $2, $3, 2, $4, $5, 'DRAFT', 'VALIDATED', 'pg_race', $6, $6,
          '{}'::jsonb, $7, NULL, $8
        )`,
        [
          transitionReceiptId,
          ID.tenantA,
          ID.raceChangeSet,
          ID.principalA,
          ID.membershipA,
          ID.policyA,
          "e".repeat(64),
          receiptHash,
          commandId,
        ],
      );
      const state = await client.query(
        `UPDATE public.change_sets
         SET status = 'VALIDATED', version = 2,
             validation_result = '{"passed":true}'::jsonb, updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'DRAFT' AND version = 1`,
        [ID.tenantA, ID.raceChangeSet],
      );
      assert.equal(state.rowCount, 1);
      const completed = await client.query(
        `UPDATE public.change_set_command_receipts
         SET status = 'COMPLETED', result = '{"status":"VALIDATED"}'::jsonb,
             result_hash = $1, version = 2, completed_at = now()
         WHERE tenant_id = $2 AND id = $3 AND status = 'CLAIMED'`,
        [resultHash, ID.tenantA, commandId],
      );
      assert.equal(completed.rowCount, 1);
      return result.rowCount;
    }),
  );
}

async function verifyEvidenceRace() {
  const results = await Promise.all([
    consumeEvidence(ID.commandTwo),
    consumeEvidence(ID.commandThree),
  ]);
  assert.deepEqual(results.sort(), [0, 1]);
}

async function verifyRevokeSerialization() {
  await withClient(migratorUrl, async (holder) => {
    await holder.query("BEGIN");
    await setTenant(holder, ID.tenantA);
    await holder.query(
      `UPDATE public.change_set_evidence_receipts
       SET consumed_at = now(), consumed_by_command_receipt_id = $1
       WHERE tenant_id = $2 AND id = $3 AND consumed_at IS NULL`,
      [ID.commandTwo, ID.tenantA, ID.racingEvidence],
    );

    await withClient(migratorUrl, async (contender) => {
      for (const mutation of [
        {
          sql: `UPDATE public.policy_versions
                SET state = 'REVOKED', revoked_at = now()
                WHERE tenant_id = $1 AND id = $2`,
          values: [ID.tenantA, ID.policyA],
        },
        {
          sql: `UPDATE public.memberships
                SET status = 'REVOKED', version = version + 1, updated_at = now()
                WHERE tenant_id = $1 AND id = $2`,
          values: [ID.tenantA, ID.membershipA],
        },
      ]) {
        await contender.query("BEGIN");
        await setTenant(contender, ID.tenantA);
        await contender.query("SET LOCAL lock_timeout = '250ms'");
        await mustFail(
          () => contender.query(mutation.sql, mutation.values),
          /lock timeout/,
        );
        await contender.query("ROLLBACK");
      }
    });
    await holder.query("ROLLBACK");
  });
}

async function verifyRuntimeDenials(app: pg.Client) {
  await mustFail(
    () => app.query("SELECT id FROM public.change_sets LIMIT 1"),
    /permission denied/,
  );
  await mustFail(
    () => app.query("CREATE TABLE public.runtime_escape (id integer)"),
    /permission denied/,
  );
  for (const table of [
    "users",
    "documents",
    "portal_credentials",
    "invoices",
    "change_sets",
    "change_set_command_receipts",
    "change_set_transition_receipts",
  ]) {
    await mustFail(
      () => app.query(`UPDATE public.${table} SET id = id WHERE false`),
      /permission denied/,
    );
  }
  await mustFail(
    () => app.query("CREATE TEMP TABLE runtime_temp_escape (id integer)"),
    /permission denied/,
  );
  await mustFail(() => app.query("CREATE ROLE runtime_escalation"), /permission denied/);
  await mustFail(() => app.query(`SET ROLE ${migratorRole}`), /permission denied/);
  await mustFail(
    () =>
      app.query(
        `INSERT INTO public.change_set_evidence_receipts (
          id, tenant_id, change_set_id, target_state, kind, issuer, tool_version,
          requested_by_principal_id, requested_by_membership_id, subject_hash,
          policy_version_id, outcome, outcome_hash, issued_at, expires_at
        ) VALUES (
          '018f3000-0000-7000-8000-000000000303', $1, $2, 'VALIDATED',
          'VALIDATION', 'forged', 'forged', $3, $4, $5, $6, 'PASSED', $7,
          now(), now() + interval '30 minutes'
        )`,
        [
          ID.tenantA,
          ID.changeSet,
          ID.principalA,
          ID.membershipA,
          proposedHash,
          ID.policyA,
          "7".repeat(64),
        ],
      ),
    /permission denied/,
  );
  await mustFail(
    () =>
      app.query(
        `UPDATE public.principals SET status = 'ACTIVE' WHERE id = $1`,
        [ID.principalA],
      ),
    /permission denied/,
  );
  await app.query("BEGIN");
  await setTenant(app, ID.tenantA);
  await mustFail(
    () =>
      app.query("DELETE FROM public.change_set_transition_receipts WHERE id = $1", [
        ID.transition,
      ]),
    /permission denied/,
  );
  await app.query("ROLLBACK");
}

async function verifyConcurrentTenants() {
  const read = (tenantId: string) =>
    withClient(appUrl, (client) =>
      inTenantTransaction(client, tenantId, async () => {
        const result = await client.query("SELECT tenant_id FROM public.memberships");
        return result.rows.map((row) => row.tenant_id);
      }),
    );
  const [a, b] = await Promise.all([read(ID.tenantA), read(ID.tenantB)]);
  assert.deepEqual(a, [ID.tenantA]);
  assert.deepEqual(b, [ID.tenantB]);
}

async function verify() {
  await withClient(adminUrl, async (admin) => {
    await verifyRoles(admin);
    await grantRuntime(admin);
  });
  await withClient(migratorUrl, async (migrator) => {
    const version = Number((await migrator.query("SHOW server_version_num")).rows[0].server_version_num);
    assert.ok(version >= 160_000 && version < 170_000);
    const migrationCount = await migrator.query(
      "SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations",
    );
    assert.equal(migrationCount.rows[0].count, 58);
    await verifyAtomicDdlRollback(migrator);
    await migrator.query(
      `INSERT INTO public.branches (id, name) VALUES
        (7101, 'PG Gate Tenant A'), (7201, 'PG Gate Tenant B')`,
    );
    await migrator.query(
      `INSERT INTO public.principals
        (id, principal_type, issuer, subject, status)
       VALUES
        ($1, 'HUMAN', 'pg-gate', 'tenant-a-maker', 'ACTIVE'),
        ($2, 'HUMAN', 'pg-gate', 'tenant-b-maker', 'ACTIVE')`,
      [ID.principalA, ID.principalB],
    );
    await migrator.query(
      `INSERT INTO public.capability_definitions
        (key, description, risk_class, status)
       VALUES ('control_plane.change.validate', 'PG gate capability', 'HIGH', 'ACTIVE')`,
    );
    await seedTenant(migrator, {
      tenantId: ID.tenantA,
      organizationId: ID.organizationA,
      principalId: ID.principalA,
      membershipId: ID.membershipA,
      policyId: ID.policyA,
      branchId: 7101,
      slug: "pg-gate-a",
    });
    await seedTenant(migrator, {
      tenantId: ID.tenantB,
      organizationId: ID.organizationB,
      principalId: ID.principalB,
      membershipId: ID.membershipB,
      policyId: ID.policyB,
      branchId: 7201,
      slug: "pg-gate-b",
    });
    await seedControlPlane(migrator);
    await verifyComposites(migrator);
    await verifyProposalAndEvidence(migrator);
    await verifyOwnerNoContext(migrator);
    assert.equal(
      (await migrator.query("SELECT count(*)::int AS count FROM public.memberships"))
        .rows[0].count,
      0,
      "FORCE RLS must constrain the table owner without tenant context",
    );
  });
  await withClient(appUrl, async (app) => {
    await verifyRlsAndCleanup(app);
    await verifyRuntimeDenials(app);
  });
  await verifyConcurrentTenants();
  await verifyRevokeSerialization();
  await verifyEvidenceRace();
  console.log(
    "[postgres-gate] PASS: PG16 migrations, authority split, FORCE RLS, composite bindings, immutable receipts, and evidence concurrency",
  );
}

if (mode === "setup") await setup();
else if (mode === "verify") await verify();
else throw new Error("usage: test-postgres-control-plane-gate.ts <setup|verify>");
