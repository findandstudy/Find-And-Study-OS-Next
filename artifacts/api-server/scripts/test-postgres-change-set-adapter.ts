import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

import {
  signActiveTenantContext,
  verifyActiveTenantContext,
  type ActiveTenantContextClaims,
} from "../src/lib/activeTenantContext.js";
import {
  executeCreateR1ChangeSetCommand,
  executeTransitionR1ChangeSetCommand,
} from "../src/lib/changeSetCommand.js";
import {
  fingerprintChangeSetEvidencePublicKey,
  issueChangeSetEvidenceEnvelope,
  type ChangeSetEvidenceSigner,
} from "../src/lib/changeSetEvidenceEnvelope.js";
import { canonicalJson } from "../src/lib/jsonCanonical.js";
import { PostgresChangeSetCommandStore } from "../src/lib/postgresChangeSetCommandStore.js";
import { PostgresChangeSetEvidenceIssuer } from "../src/lib/postgresChangeSetEvidenceIssuer.js";

const { Client, Pool } = pg;

const adminUrl = requiredUrl("PG_GATE_ADMIN_URL");
const migratorUrl = requiredUrl("PG_GATE_MIGRATOR_URL");
const executorUrl = requiredUrl("PG_GATE_EXECUTOR_URL");
const evidenceIssuerUrl = requiredUrl("PG_GATE_EVIDENCE_ISSUER_URL");
const databaseName = new URL(adminUrl).pathname.slice(1);

assert.match(databaseName, /^fas_it_[a-z0-9_]+$/);
for (const value of [adminUrl, migratorUrl, executorUrl, evidenceIssuerUrl]) {
  const parsed = new URL(value);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.port, "5432");
  assert.equal(parsed.pathname.slice(1), databaseName);
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "");
}

const ROLE = {
  commandOwner: "fas_cp_owner",
  commandExecutor: "fas_cp_executor",
  evidenceOwner: "fas_evidence_owner",
  evidenceIssuer: "fas_evidence_issuer",
} as const;

const ID = {
  tenant: "018f5000-0000-7000-8000-000000000001",
  humanPrincipal: "018f5000-0000-7000-8000-000000000002",
  humanMembership: "018f5000-0000-7000-8000-000000000003",
  policy: "018f5000-0000-7000-8000-000000000004",
  roleDefinition: "018f5000-0000-7000-8000-000000000005",
  rolePackage: "018f5000-0000-7000-8000-000000000006",
  grantReceipt: "018f5000-0000-7000-8000-000000000007",
  assignment: "018f5000-0000-7000-8000-000000000008",
  context: "018f5000-0000-7000-8000-000000000009",
  configuration: "018f5000-0000-7000-8000-00000000000a",
  createCommand: "018f5000-0000-7000-8000-00000000000b",
  createAccess: "018f5000-0000-7000-8000-00000000000c",
  changeSet: "018f5000-0000-7000-8000-00000000000d",
  evidencePrincipal: "018f5000-0000-7000-8000-00000000000e",
  evidenceGrant: "018f5000-0000-7000-8000-00000000000f",
  evidenceRequest: "018f5000-0000-7000-8000-000000000010",
  evidenceReceipt: "018f5000-0000-7000-8000-000000000011",
  transitionCommand: "018f5000-0000-7000-8000-000000000012",
  transitionAccess: "018f5000-0000-7000-8000-000000000013",
  transitionReceipt: "018f5000-0000-7000-8000-000000000014",
  rollbackProbe: "018f5000-0000-7000-8000-000000000015",
} as const;

const NOW = Date.now();
const activeContextSecret = crypto.randomBytes(48).toString("base64url");
const evidenceKeys = crypto.generateKeyPairSync("ed25519");
const evidenceIssuerId = "fas-adapter-evidence-service";
const evidenceKeyId = "adapter-test-key-1";
const evidenceToolId = "fas-evidence-service";
const evidenceToolVersion = "test-v1";
const baselineConfig = {
  flagKey: "journey.beta",
  enabled: false,
  cohortPercent: 0,
  reason: "Baseline state.",
};
const proposedConfig = {
  flagKey: "journey.beta",
  enabled: true,
  cohortPercent: 5,
  reason: "Bounded adapter verification.",
};

function requiredUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(typeof value === "string" ? value : canonicalJson(value), "utf8")
    .digest("hex");
}

async function withClient<T>(url: string, operation: (client: pg.Client) => Promise<T>) {
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

async function bootstrapAuthority() {
  await withClient(adminUrl, async (admin) => {
    await admin.query(`
      GRANT CONNECT ON DATABASE ${databaseName} TO ${ROLE.commandExecutor}, ${ROLE.evidenceIssuer};
      GRANT USAGE ON SCHEMA public, fas_cp_v1 TO ${ROLE.commandOwner};
      GRANT USAGE ON SCHEMA public, fas_evidence_v1 TO ${ROLE.evidenceOwner};
      GRANT USAGE ON SCHEMA fas_cp_v1 TO ${ROLE.commandExecutor};
      GRANT USAGE ON SCHEMA fas_evidence_v1 TO ${ROLE.evidenceIssuer};

      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM
        ${ROLE.commandOwner}, ${ROLE.commandExecutor}, ${ROLE.evidenceOwner}, ${ROLE.evidenceIssuer};
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM
        ${ROLE.commandOwner}, ${ROLE.commandExecutor}, ${ROLE.evidenceOwner}, ${ROLE.evidenceIssuer};

      GRANT SELECT, UPDATE ON TABLE
        public.tenants,
        public.principals,
        public.memberships,
        public.policy_versions,
        public.access_assignments,
        public.role_package_versions,
        public.role_definitions,
        public.role_package_capabilities,
        public.capability_definitions,
        public.r1_configuration_snapshots,
        public.change_sets,
        public.change_set_command_receipts,
        public.change_set_transition_receipts,
        public.change_set_evidence_receipts,
        public.change_set_evidence_issuers,
        public.change_set_evidence_signing_keys,
        public.change_set_evidence_issuer_tenant_grants,
        public.change_set_evidence_requests
      TO ${ROLE.commandOwner};
      GRANT INSERT ON TABLE
        public.access_decision_receipts,
        public.change_set_command_attempt_receipts,
        public.change_set_command_receipts,
        public.change_sets,
        public.change_set_approvals,
        public.change_set_transition_receipts
      TO ${ROLE.commandOwner};

      GRANT SELECT, UPDATE ON TABLE
        public.change_set_evidence_issuers,
        public.change_set_evidence_signing_keys,
        public.change_set_evidence_issuer_tenant_grants,
        public.change_set_evidence_requests,
        public.change_sets,
        public.memberships,
        public.policy_versions,
        public.change_set_command_receipts
      TO ${ROLE.evidenceOwner};
      GRANT INSERT ON TABLE public.change_set_evidence_receipts TO ${ROLE.evidenceOwner};
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
       WHERE namespace.nspname IN ('fas_cp_v1', 'fas_evidence_v1')
       ORDER BY namespace.nspname, procedure.proname`,
    );
    assert.ok(functions.rowCount && functions.rowCount >= 16);
    for (const fn of functions.rows) {
      assert.match(fn.function_name, /^[a-z][a-z0-9_]+$/);
      const owner =
        fn.schema_name === "fas_cp_v1" ? ROLE.commandOwner : ROLE.evidenceOwner;
      await admin.query(
        `ALTER FUNCTION ${fn.schema_name}.${fn.function_name}(${fn.identity_arguments}) OWNER TO ${owner}`,
      );
    }
    await admin.query(`
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_cp_v1 FROM PUBLIC, ${ROLE.commandExecutor};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_evidence_v1 FROM PUBLIC, ${ROLE.evidenceIssuer};
      GRANT EXECUTE ON FUNCTION
        fas_cp_v1.load_authoritative_configuration(uuid, text, text, jsonb),
        fas_cp_v1.resolve_active_context(uuid, uuid, uuid, uuid, uuid[]),
        fas_cp_v1.claim_command(jsonb),
        fas_cp_v1.load_change_set(uuid, uuid),
        fas_cp_v1.load_transition_evidence(uuid, uuid, uuid, text),
        fas_cp_v1.load_latest_transition_hash(uuid, uuid),
        fas_cp_v1.insert_access_decision(jsonb),
        fas_cp_v1.insert_command_attempt(jsonb),
        fas_cp_v1.consume_transition_evidence(uuid, uuid, uuid, uuid[], bigint),
        fas_cp_v1.insert_change_set(jsonb),
        fas_cp_v1.insert_approval(jsonb),
        fas_cp_v1.insert_transition_receipt(jsonb),
        fas_cp_v1.update_change_set(jsonb),
        fas_cp_v1.complete_command(uuid, jsonb)
      TO ${ROLE.commandExecutor};
      GRANT EXECUTE ON FUNCTION
        fas_evidence_v1.load_verification_context(uuid, text, text, uuid),
        fas_evidence_v1.persist_receipt(uuid, jsonb)
      TO ${ROLE.evidenceIssuer};
    `);
  });
}

async function verifyAuthoritySplit() {
  await withClient(adminUrl, async (admin) => {
    const roles = await admin.query(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls, rolcanlogin
       FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [[ROLE.commandOwner, ROLE.commandExecutor, ROLE.evidenceOwner, ROLE.evidenceIssuer]],
    );
    assert.equal(roles.rowCount, 4);
    for (const role of roles.rows) {
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolcreatedb, false);
      assert.equal(role.rolcreaterole, false);
      assert.equal(role.rolinherit, false);
      assert.equal(role.rolreplication, false);
      assert.equal(role.rolbypassrls, false);
      assert.equal(
        role.rolcanlogin,
        role.rolname === ROLE.commandExecutor || role.rolname === ROLE.evidenceIssuer,
      );
    }
    const memberships = await admin.query(
      `SELECT count(*)::int AS count FROM pg_auth_members membership
       JOIN pg_roles member_role ON member_role.oid = membership.member
       WHERE member_role.rolname = ANY($1::text[])`,
      [[ROLE.commandOwner, ROLE.commandExecutor, ROLE.evidenceOwner, ROLE.evidenceIssuer]],
    );
    assert.equal(memberships.rows[0].count, 0);
    for (const role of [ROLE.commandExecutor, ROLE.evidenceIssuer]) {
      const privileges = await admin.query(
        `SELECT count(*)::int AS count
         FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_schema = 'public'`,
        [role],
      );
      assert.equal(privileges.rows[0].count, 0);
    }
    const owners = await admin.query(
      `SELECT namespace.nspname, owner_role.rolname, count(*)::int AS count
       FROM pg_proc procedure
       JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
       JOIN pg_roles owner_role ON owner_role.oid = procedure.proowner
       WHERE namespace.nspname IN ('fas_cp_v1', 'fas_evidence_v1')
       GROUP BY namespace.nspname, owner_role.rolname ORDER BY namespace.nspname`,
    );
    assert.deepEqual(owners.rows, [
      { nspname: "fas_cp_v1", rolname: ROLE.commandOwner, count: 15 },
      { nspname: "fas_evidence_v1", rolname: ROLE.evidenceOwner, count: 3 },
    ]);
  });
}

async function seedFoundation() {
  await withClient(migratorUrl, async (migrator) => {
    await migrator.query("BEGIN");
    try {
      await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [ID.tenant]);
      await migrator.query(
        `INSERT INTO public.principals
          (id, principal_type, issuer, subject, status, risk_state)
         VALUES
          ($1, 'HUMAN', 'adapter-gate', 'maker', 'ACTIVE', 'NORMAL'),
          ($2, 'SERVICE', 'adapter-gate', 'evidence-service', 'ACTIVE', 'NORMAL')`,
        [ID.humanPrincipal, ID.evidencePrincipal],
      );
      await migrator.query(
        `INSERT INTO public.tenants
          (id, slug, legal_name, display_name, status, home_region, policy_version)
         VALUES ($1, 'adapter-gate', 'Adapter Gate', 'Adapter Gate', 'ACTIVE', 'test-ci', 1)`,
        [ID.tenant],
      );
      await migrator.query(
        `INSERT INTO public.memberships
          (id, tenant_id, principal_id, status, valid_from)
         VALUES ($1, $2, $3, 'ACTIVE', statement_timestamp() - interval '1 minute')`,
        [ID.humanMembership, ID.tenant, ID.humanPrincipal],
      );
      await migrator.query(
        `INSERT INTO public.policy_versions
          (id, tenant_id, version_number, checksum, state, predicate_document, effective_at)
         VALUES ($1, $2, 1, $3, 'ACTIVE', '{}'::jsonb, statement_timestamp() - interval '1 minute')`,
        [ID.policy, ID.tenant, sha256("adapter-policy")],
      );
      await migrator.query(
        `INSERT INTO public.capability_definitions
          (key, description, risk_class, step_up_required, approval_required, status)
         VALUES
          ('control_plane.flag.create', 'Create registered R1 flag proposal', 'HIGH', false, false, 'ACTIVE'),
          ('control_plane.change.validate', 'Validate R1 proposal', 'HIGH', false, false, 'ACTIVE')
         ON CONFLICT (key) DO NOTHING`,
      );
      await migrator.query(
        `INSERT INTO public.role_definitions
          (id, key, display_name, purpose, principal_type, status)
         VALUES ($1, 'platform.adapter_tester', 'Adapter tester', 'Disposable CI only', 'HUMAN', 'ACTIVE')`,
        [ID.roleDefinition],
      );
      await migrator.query(
        `INSERT INTO public.role_package_versions
          (id, role_definition_id, version_number, status, default_scope_type,
           constraint_document, checksum, effective_at)
         VALUES ($1, $2, 1, 'ACTIVE', 'TENANT', '{}'::jsonb, $3,
                 statement_timestamp() - interval '1 minute')`,
        [ID.rolePackage, ID.roleDefinition, sha256("adapter-role-package")],
      );
      await migrator.query(
        `INSERT INTO public.role_package_capabilities
          (role_package_version_id, capability_key, effect)
         VALUES
          ($1, 'control_plane.flag.create', 'ALLOW'),
          ($1, 'control_plane.change.validate', 'ALLOW')`,
        [ID.rolePackage],
      );
      await migrator.query(
        `INSERT INTO public.authorization_change_receipts (
          id, tenant_id, receipt_type, actor_principal_id, actor_membership_id,
          resource_type, resource_id, reason_code, correlation_id, evidence,
          receipt_hash
        ) VALUES (
          $1, $2, 'GRANT', $3, $4, 'ACCESS_ASSIGNMENT', $5,
          'adapter_test', 'adapter-test-grant', '{}'::jsonb, $6
        )`,
        [
          ID.grantReceipt,
          ID.tenant,
          ID.humanPrincipal,
          ID.humanMembership,
          ID.assignment,
          sha256("adapter-grant-receipt"),
        ],
      );
      await migrator.query(
        `INSERT INTO public.access_assignments (
          id, tenant_id, membership_id, role_package_version_id, scope_type,
          constraint_document, status, valid_from, granted_by_principal_id,
          granted_by_membership_id, grant_receipt_id, grant_receipt_type
        ) VALUES (
          $1, $2, $3, $4, 'TENANT', '{}'::jsonb, 'ACTIVE',
          statement_timestamp() - interval '1 minute', $5, $3, $6, 'GRANT'
        )`,
        [
          ID.assignment,
          ID.tenant,
          ID.humanMembership,
          ID.rolePackage,
          ID.humanPrincipal,
          ID.grantReceipt,
        ],
      );
      await migrator.query(
        `INSERT INTO public.r1_configuration_snapshots (
          id, tenant_id, change_type, configuration_key, target_scope_type,
          version, config, config_hash
        ) VALUES ($1, $2, 'FEATURE_FLAG', 'journey.beta', 'TENANT', 1, $3::jsonb, $4)`,
        [ID.configuration, ID.tenant, JSON.stringify(baselineConfig), sha256(baselineConfig)],
      );
      await migrator.query("COMMIT");
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  });
}

function verifiedContext() {
  const claims: ActiveTenantContextClaims = {
    tokenVersion: 1,
    contextId: ID.context,
    tenantId: ID.tenant,
    organizationId: null,
    legacyBranchId: null,
    principalId: ID.humanPrincipal,
    membershipId: ID.humanMembership,
    assignmentIds: [ID.assignment],
    policyVersionId: ID.policy,
    policyVersion: 1,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 10 * 60_000,
  };
  const result = verifyActiveTenantContext(
    signActiveTenantContext(claims, activeContextSecret),
    activeContextSecret,
    NOW,
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.reason);
  return result.context;
}

function uuidFactory(values: readonly string[]) {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (!value) throw new Error("adapter test UUID queue exhausted");
    return value;
  };
}

function evidenceSigner(): ChangeSetEvidenceSigner {
  return {
    issuerId: evidenceIssuerId,
    issuerPrincipalId: ID.evidencePrincipal,
    keyId: evidenceKeyId,
    algorithm: "Ed25519",
    environmentId: "test-ci",
    cellId: "cell-a",
    state: "ACTIVE",
    validFrom: NOW - 60_000,
    signUntil: NOW + 60 * 60_000,
    sign: async (payload) => crypto.sign(null, payload, evidenceKeys.privateKey),
  };
}

async function main() {
  await bootstrapAuthority();
  await verifyAuthoritySplit();
  await seedFoundation();

  const executorPool = new Pool({
    connectionString: executorUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  const issuerPool = new Pool({
    connectionString: evidenceIssuerUrl,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  try {
    const store = new PostgresChangeSetCommandStore(executorPool, {
      expectedRole: ROLE.commandExecutor,
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
    const created = await executeCreateR1ChangeSetCommand({
      context,
      command: {
        idempotencyKey: "adapter-create-0001",
        changeType: "FEATURE_FLAG",
        title: "Journey beta adapter verification",
        purpose: "Prove the default-unwired PostgreSQL command adapter.",
        targetScope: { type: "TENANT", organizationId: null, legacyBranchId: null },
        proposedConfig,
      },
      dependencies: {
        store,
        now: () => NOW,
        nextUuidV7: uuidFactory([ID.createCommand, ID.createAccess, ID.changeSet]),
      },
    });
    assert.deepEqual(created, {
      ok: true,
      replayed: false,
      result: {
        changeSetId: ID.changeSet,
        status: "DRAFT",
        version: 1,
        transitionReceiptId: null,
        approvalReceiptId: null,
      },
    });

    const challengeNonce = crypto.randomBytes(32).toString("base64url");
    await withClient(migratorUrl, async (migrator) => {
      const publicKeySpki = evidenceKeys.publicKey.export({ format: "der", type: "spki" });
      const fingerprint = fingerprintChangeSetEvidencePublicKey(evidenceKeys.publicKey);
      assert.ok(fingerprint);
      await migrator.query("BEGIN");
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [ID.tenant]);
        await migrator.query(
          `INSERT INTO public.change_set_evidence_issuers
            (id, principal_id, environment_id, cell_id, state)
           VALUES ($1, $2, 'test-ci', 'cell-a', 'ACTIVE')`,
          [evidenceIssuerId, ID.evidencePrincipal],
        );
        await migrator.query(
          `INSERT INTO public.change_set_evidence_signing_keys (
            issuer_id, key_id, algorithm, public_key_spki_base64,
            public_key_fingerprint_sha256, state, valid_from, sign_until, verify_until
          ) VALUES ($1, $2, 'Ed25519', $3, $4, 'ACTIVE',
            to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))`,
          [
            evidenceIssuerId,
            evidenceKeyId,
            publicKeySpki.toString("base64"),
            fingerprint,
            NOW - 60_000,
            NOW + 60 * 60_000,
            NOW + 2 * 60 * 60_000,
          ],
        );
        await migrator.query(
          `INSERT INTO public.change_set_evidence_issuer_tenant_grants (
            id, tenant_id, issuer_id, kind, tool_id, tool_version, state,
            valid_from, valid_until
          ) VALUES ($1, $2, $3, 'VALIDATION', $4, $5, 'ACTIVE',
            to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0))`,
          [
            ID.evidenceGrant,
            ID.tenant,
            evidenceIssuerId,
            evidenceToolId,
            evidenceToolVersion,
            NOW - 60_000,
            NOW + 60 * 60_000,
          ],
        );
        await migrator.query(
          `INSERT INTO public.change_set_evidence_requests (
            id, tenant_id, change_set_id, target_state, kind,
            requested_by_principal_id, requested_by_membership_id,
            subject_hash, policy_version_id, tool_id, tool_version,
            challenge_nonce_hash, state, expires_at, created_at
          ) VALUES ($1, $2, $3, 'VALIDATED', 'VALIDATION', $4, $5, $6, $7,
            $8, $9, $10, 'OPEN', to_timestamp($11 / 1000.0),
            to_timestamp($12 / 1000.0))`,
          [
            ID.evidenceRequest,
            ID.tenant,
            ID.changeSet,
            ID.humanPrincipal,
            ID.humanMembership,
            sha256(proposedConfig),
            ID.policy,
            evidenceToolId,
            evidenceToolVersion,
            sha256(challengeNonce),
            NOW + 10 * 60_000,
            NOW - 1_000,
          ],
        );
        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });

    const envelope = await issueChangeSetEvidenceEnvelope(
      {
        receiptId: ID.evidenceReceipt,
        evidenceRequestId: ID.evidenceRequest,
        challengeNonce,
        issuerTenantGrantId: ID.evidenceGrant,
        tenantId: ID.tenant,
        changeSetId: ID.changeSet,
        targetState: "VALIDATED",
        kind: "VALIDATION",
        requestedByPrincipalId: ID.humanPrincipal,
        requestedByMembershipId: ID.humanMembership,
        subjectHash: sha256(proposedConfig),
        policyVersionId: ID.policy,
        toolId: evidenceToolId,
        toolVersion: evidenceToolVersion,
        outcome: "PASSED",
        artifactCount: null,
        artifactManifestHash: null,
        ttlMs: 5 * 60_000,
      },
      evidenceSigner(),
      NOW,
    );
    const issuer = new PostgresChangeSetEvidenceIssuer({
      pool: issuerPool,
      expectedRole: ROLE.evidenceIssuer,
      expectedEnvironmentId: "test-ci",
      expectedCellId: "cell-a",
      now: () => NOW,
    });
    assert.deepEqual(
      await issuer.persistVerifiedEnvelope({
        expectedTenantId: ID.tenant,
        token: envelope.token,
      }),
      { receiptId: ID.evidenceReceipt },
    );
    await mustFail(
      () =>
        issuer.persistVerifiedEnvelope({
          expectedTenantId: ID.tenant,
          token: `${envelope.token.slice(0, -1)}${envelope.token.endsWith("A") ? "B" : "A"}`,
        }),
      /verification_failed|envelope_hint_invalid/,
    );

    const transitioned = await executeTransitionR1ChangeSetCommand({
      context,
      command: {
        idempotencyKey: "adapter-transition-0001",
        changeSetId: ID.changeSet,
        expectedVersion: 1,
        toState: "VALIDATED",
        reasonCode: "adapter_validation_passed",
      },
      dependencies: {
        store,
        now: () => NOW,
        nextUuidV7: uuidFactory([
          ID.transitionCommand,
          ID.transitionAccess,
          ID.transitionReceipt,
        ]),
      },
    });
    assert.deepEqual(transitioned, {
      ok: true,
      replayed: false,
      result: {
        changeSetId: ID.changeSet,
        status: "VALIDATED",
        version: 2,
        transitionReceiptId: ID.transitionReceipt,
        approvalReceiptId: null,
      },
    });

    const replayed = await executeTransitionR1ChangeSetCommand({
      context,
      command: {
        idempotencyKey: "adapter-transition-0001",
        changeSetId: ID.changeSet,
        expectedVersion: 1,
        toState: "VALIDATED",
        reasonCode: "adapter_validation_passed",
      },
      dependencies: {
        store,
        now: () => NOW,
        nextUuidV7: uuidFactory([
          "018f5000-0000-7000-8000-000000000016",
          "018f5000-0000-7000-8000-000000000017",
        ]),
      },
    });
    assert.equal(replayed.ok, true);
    if (replayed.ok) assert.equal(replayed.replayed, true);

    await store.transaction(async (tx) => {
      await tx.setLocalTenant(ID.tenant);
      throw new Error("adapter_rollback_probe");
    }).then(
      () => assert.fail("rollback probe must fail"),
      (error: unknown) => assert.match(String(error), /adapter_rollback_probe/),
    );

    for (const pool of [executorPool, issuerPool]) {
      const client = await pool.connect();
      try {
        const clean = await client.query(
          `SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant_setting`,
        );
        assert.equal(clean.rows[0].tenant_setting, null);
      } finally {
        client.release();
      }
    }

    await withClient(executorUrl, async (executor) => {
      await mustFail(
        () => executor.query("SELECT * FROM public.change_sets"),
        /permission denied/,
      );
      await mustFail(
        () =>
          executor.query("SELECT fas_cp_v1.load_change_set($1,$2)", [
            ID.tenant,
            ID.changeSet,
          ]),
        /tenant context mismatch/,
      );
      await mustFail(
        () => executor.query("SELECT fas_evidence_v1.load_verification_context($1,$2,$3,$4)", [
          ID.tenant,
          evidenceIssuerId,
          evidenceKeyId,
          ID.evidenceGrant,
        ]),
        /permission denied/,
      );
    });
    await withClient(evidenceIssuerUrl, async (evidenceRole) => {
      await mustFail(
        () => evidenceRole.query("SELECT * FROM public.change_set_evidence_receipts"),
        /permission denied/,
      );
      await mustFail(
        () =>
          evidenceRole.query(
            "SELECT fas_evidence_v1.load_verification_context($1,$2,$3,$4)",
            [ID.tenant, evidenceIssuerId, evidenceKeyId, ID.evidenceGrant],
          ),
        /tenant context mismatch/,
      );
      await mustFail(
        () => evidenceRole.query("SELECT fas_cp_v1.load_change_set($1,$2)", [
          ID.tenant,
          ID.changeSet,
        ]),
        /permission denied/,
      );
    });

    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [ID.tenant]);
        const evidence = await migrator.query(
          `SELECT consumed_by_command_receipt_id, consumed_at IS NOT NULL AS consumed
           FROM public.change_set_evidence_receipts
           WHERE tenant_id = $1 AND id = $2`,
          [ID.tenant, ID.evidenceReceipt],
        );
        assert.deepEqual(evidence.rows, [
          { consumed_by_command_receipt_id: ID.transitionCommand, consumed: true },
        ]);
        const state = await migrator.query(
          `SELECT status, version::int FROM public.change_sets
           WHERE tenant_id = $1 AND id = $2`,
          [ID.tenant, ID.changeSet],
        );
        assert.deepEqual(state.rows, [{ status: "VALIDATED", version: 2 }]);
        await migrator.query("ROLLBACK");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });
  } finally {
    await Promise.all([executorPool.end(), issuerPool.end()]);
  }
  console.log(
    "[postgres-adapter-gate] PASS: EXECUTE-only roles, real command store, signed evidence, replay, rollback, and pool cleanup",
  );
}

await main();
