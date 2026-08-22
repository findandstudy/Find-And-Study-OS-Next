import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

import {
  signActiveTenantContext,
  verifyActiveTenantContext,
  type ActiveTenantContextClaims,
  type VerifiedActiveTenantContext,
} from "../src/lib/activeTenantContext.js";
import {
  executeCreateR1ChangeSetCommand,
  executeTransitionR1ChangeSetCommand,
  type ChangeSetCommandStore,
  type ChangeSetCommandTransaction,
  type ChangeSetCommandResult,
} from "../src/lib/changeSetCommand.js";
import {
  fingerprintChangeSetEvidencePublicKey,
  issueChangeSetEvidenceEnvelope,
  type ChangeSetEvidenceSigner,
} from "../src/lib/changeSetEvidenceEnvelope.js";
import { canonicalJson } from "../src/lib/jsonCanonical.js";
import {
  PostgresChangeSetCommandStore,
  type PostgresChangeSetCommandStoreOptions,
} from "../src/lib/postgresChangeSetCommandStore.js";
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
  createReplayCommand: "018f5000-0000-7000-8000-000000000018",
  evidencePrincipal: "018f3000-0000-7000-8000-000000000211",
  evidenceGrant: "018f5000-0000-7000-8000-00000000000f",
  evidenceRequest: "018f5000-0000-7000-8000-000000000010",
  evidenceReceipt: "018f5000-0000-7000-8000-000000000011",
  transitionCommand: "018f5000-0000-7000-8000-000000000012",
  transitionAccess: "018f5000-0000-7000-8000-000000000013",
  transitionReceipt: "018f5000-0000-7000-8000-000000000014",
  rollbackProbe: "018f5000-0000-7000-8000-000000000015",
  createReplayAccess: "018f5000-0000-7000-8000-000000000019",
  cancellationCommand: "018f5000-0000-7000-8000-00000000001a",
  cancellationAccess: "018f5000-0000-7000-8000-00000000001b",
  cancellationChangeSet: "018f5000-0000-7000-8000-00000000001c",
  membershipRaceCommand: "018f5000-0000-7000-8000-000000000020",
  membershipRaceAccess: "018f5000-0000-7000-8000-000000000021",
  membershipDeniedAccess: "018f5000-0000-7000-8000-000000000022",
  policyRaceCommand: "018f5000-0000-7000-8000-000000000023",
  policyRaceAccess: "018f5000-0000-7000-8000-000000000024",
  policyDeniedAccess: "018f5000-0000-7000-8000-000000000025",
  simulationGrant: "018f5000-0000-7000-8000-000000000030",
  testArtifactGrant: "018f5000-0000-7000-8000-000000000031",
  rollbackPlanGrant: "018f5000-0000-7000-8000-000000000032",
  canaryPlanGrant: "018f5000-0000-7000-8000-000000000033",
  simulationRequest: "018f5000-0000-7000-8000-000000000034",
  testArtifactRequest: "018f5000-0000-7000-8000-000000000035",
  rollbackPlanRequest: "018f5000-0000-7000-8000-000000000036",
  canaryPlanRequest: "018f5000-0000-7000-8000-000000000037",
  simulationEvidence: "018f5000-0000-7000-8000-000000000038",
  testArtifactEvidence: "018f5000-0000-7000-8000-000000000039",
  rollbackPlanEvidence: "018f5000-0000-7000-8000-00000000003a",
  canaryPlanEvidence: "018f5000-0000-7000-8000-00000000003b",
  simulationCommand: "018f5000-0000-7000-8000-00000000003c",
  simulationAccess: "018f5000-0000-7000-8000-00000000003d",
  simulationTransition: "018f5000-0000-7000-8000-00000000003e",
  submitCommand: "018f5000-0000-7000-8000-00000000003f",
  submitAccess: "018f5000-0000-7000-8000-000000000040",
  submitTransition: "018f5000-0000-7000-8000-000000000041",
  grantRaceIssuedRequest: "018f5000-0000-7000-8000-000000000042",
  grantRaceIssuedEvidence: "018f5000-0000-7000-8000-000000000043",
  grantRaceDeniedRequest: "018f5000-0000-7000-8000-000000000044",
  grantRaceDeniedEvidence: "018f5000-0000-7000-8000-000000000045",
  issuerRaceIssuedRequest: "018f5000-0000-7000-8000-000000000046",
  issuerRaceIssuedEvidence: "018f5000-0000-7000-8000-000000000047",
  issuerRaceDeniedRequest: "018f5000-0000-7000-8000-000000000048",
  issuerRaceDeniedEvidence: "018f5000-0000-7000-8000-000000000049",
} as const;

const NOW = Date.now();
const activeContextSecret = crypto.randomBytes(48).toString("base64url");
const evidenceKeys = crypto.generateKeyPairSync("ed25519");
const evidenceIssuerId = "fas-evidence-service";
const evidenceKeyId = "adapter-test-key-1";
const evidenceRaceKeyId = "adapter-test-key-race-1";
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
const createCommand = {
  idempotencyKey: "adapter-create-0001",
  changeType: "FEATURE_FLAG",
  title: "Journey beta adapter verification",
  purpose: "Prove the default-unwired PostgreSQL command adapter.",
  targetScope: {
    type: "TENANT" as const,
    organizationId: null,
    legacyBranchId: null,
  },
  proposedConfig,
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

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("adapter test synchronization timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForBackendLock(pid: number): Promise<void> {
  await withClient(adminUrl, async (admin) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const activity = await admin.query<{
        state: string | null;
        waitEventType: string | null;
      }>(
        `SELECT state, wait_event_type AS "waitEventType"
         FROM pg_stat_activity
         WHERE pid = $1`,
        [pid],
      );
      if (
        activity.rows[0]?.state === "active" &&
        activity.rows[0]?.waitEventType === "Lock"
      ) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("revocation_backend_did_not_wait_on_command_lock");
  });
}

async function executeCanonicalCreateReplay(input: {
  store: PostgresChangeSetCommandStore;
  ids: readonly string[];
}): Promise<ChangeSetCommandResult> {
  return executeCreateR1ChangeSetCommand({
    context: verifiedContext(),
    command: createCommand,
    dependencies: {
      store: input.store,
      now: () => NOW,
      nextUuidV7: uuidFactory(input.ids),
    },
  });
}

function pauseAfterEvidenceLoad(input: {
  store: ChangeSetCommandStore;
  ready: () => void;
  release: Promise<void>;
}): ChangeSetCommandStore {
  let armed = true;
  return {
    transaction: (context, operation) =>
      input.store.transaction(context, (transaction) => {
        const wrapped = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property === "loadVerifiedTransitionEvidenceForUpdate") {
              return async (
                evidenceInput: Parameters<
                  ChangeSetCommandTransaction["loadVerifiedTransitionEvidenceForUpdate"]
                >[0],
              ) => {
                const evidence = await target.loadVerifiedTransitionEvidenceForUpdate(
                  evidenceInput,
                );
                if (armed) {
                  armed = false;
                  input.ready();
                  await input.release;
                }
                return evidence;
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        return operation(wrapped);
      }),
  };
}

function pauseAfterEvidenceVerificationContextLoad(input: {
  pool: pg.Pool;
  ready: () => void;
  release: Promise<void>;
}): pg.Pool {
  let armed = true;
  return {
    connect: async () => {
      const client = await input.pool.connect();
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return async (text: string, values?: unknown[]) => {
              const result = await target.query(text, values);
              if (
                armed &&
                text.includes("fas_evidence_v1.load_verification_context")
              ) {
                armed = false;
                input.ready();
                await input.release;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
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
        public.principals,
        public.change_set_evidence_issuers,
        public.change_set_evidence_signing_keys,
        public.change_set_evidence_issuer_tenant_grants,
        public.change_set_evidence_requests,
        public.change_sets,
        public.memberships,
        public.policy_versions,
        public.change_set_command_receipts
      TO ${ROLE.evidenceOwner};
      GRANT SELECT, INSERT ON TABLE public.change_set_evidence_receipts
      TO ${ROLE.evidenceOwner};
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
      ALTER FUNCTION public.enforce_change_set_transition_finalization()
        OWNER TO ${ROLE.commandOwner};
      ALTER FUNCTION public.enforce_change_set_transition_finalization()
        SECURITY DEFINER;
      ALTER FUNCTION public.enforce_change_set_transition_finalization()
        SET search_path TO pg_catalog, public;
      ALTER FUNCTION public.enforce_change_set_evidence_finalization()
        OWNER TO ${ROLE.commandOwner};
      ALTER FUNCTION public.enforce_change_set_evidence_finalization()
        SECURITY DEFINER;
      ALTER FUNCTION public.enforce_change_set_evidence_finalization()
        SET search_path TO pg_catalog, public;
      ALTER FUNCTION public.enforce_change_set_evidence_request_finalization()
        OWNER TO ${ROLE.evidenceOwner};
      ALTER FUNCTION public.enforce_change_set_evidence_request_finalization()
        SECURITY DEFINER;
      ALTER FUNCTION public.enforce_change_set_evidence_request_finalization()
        SET search_path TO pg_catalog, public;
      REVOKE ALL ON FUNCTION
        public.enforce_change_set_transition_finalization(),
        public.enforce_change_set_evidence_finalization(),
        public.enforce_change_set_evidence_request_finalization()
      FROM PUBLIC, ${ROLE.commandExecutor}, ${ROLE.evidenceIssuer};
    `);
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
    const deferredTriggerAuthorities = await admin.query(
      `SELECT procedure.proname, owner_role.rolname, procedure.prosecdef
       FROM pg_proc procedure
       JOIN pg_roles owner_role ON owner_role.oid = procedure.proowner
       WHERE procedure.proname = ANY($1::text[])
       ORDER BY procedure.proname`,
      [[
        "enforce_change_set_evidence_finalization",
        "enforce_change_set_evidence_request_finalization",
        "enforce_change_set_transition_finalization",
      ]],
    );
    assert.deepEqual(deferredTriggerAuthorities.rows, [
      {
        proname: "enforce_change_set_evidence_finalization",
        rolname: ROLE.commandOwner,
        prosecdef: true,
      },
      {
        proname: "enforce_change_set_evidence_request_finalization",
        rolname: ROLE.evidenceOwner,
        prosecdef: true,
      },
      {
        proname: "enforce_change_set_transition_finalization",
        rolname: ROLE.commandOwner,
        prosecdef: true,
      },
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
         VALUES ($1, 'HUMAN', 'adapter-gate', 'maker', 'ACTIVE', 'NORMAL')`,
        [ID.humanPrincipal],
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
          ('control_plane.change.validate', 'Validate R1 proposal', 'HIGH', false, false, 'ACTIVE'),
          ('control_plane.change.simulate', 'Simulate R1 proposal', 'HIGH', false, false, 'ACTIVE'),
          ('control_plane.change.submit_review', 'Submit R1 proposal for review', 'HIGH', false, false, 'ACTIVE')
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
          ($1, 'control_plane.change.validate', 'ALLOW'),
          ($1, 'control_plane.change.simulate', 'ALLOW'),
          ($1, 'control_plane.change.submit_review', 'ALLOW')`,
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

function loseFirstCommitAcknowledgement(pool: pg.Pool): pg.Pool {
  let loseAcknowledgement = true;
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: unknown[]) => {
          const result = await client.query(text, values as never[] | undefined);
          if (loseAcknowledgement && text === "COMMIT") {
            loseAcknowledgement = false;
            throw new Error("simulated_commit_acknowledgement_loss");
          }
          return result;
        },
        release: (error?: boolean | Error) => client.release(error),
      } as unknown as pg.PoolClient;
    },
  } as unknown as pg.Pool;
}

function evidenceSigner(keyId = evidenceKeyId): ChangeSetEvidenceSigner {
  return {
    issuerId: evidenceIssuerId,
    issuerPrincipalId: ID.evidencePrincipal,
    keyId,
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
    const evidenceFailures: string[] = [];
    let storeNow = NOW;
    let cancellationArmed = false;
    let authorizationRaceGate:
      | {
          ready: (pid: number) => void;
          release: Promise<void>;
        }
      | null = null;
    let resolveCancellationBackendPid: (pid: number) => void = () => undefined;
    const cancellationBackendPid = new Promise<number>((resolve) => {
      resolveCancellationBackendPid = resolve;
    });
    const storeOptions: Omit<PostgresChangeSetCommandStoreOptions, "pool"> = {
      expectedRole: ROLE.commandExecutor,
      expectedEnvironmentId: "test-ci",
      expectedCellId: "cell-a",
      now: () => storeNow,
      resolveMutationAssurance: async ({ client }) => {
        if (authorizationRaceGate) {
          const gate = authorizationRaceGate;
          authorizationRaceGate = null;
          const backend = await client.query<{ pid: number }>(
            "SELECT pg_backend_pid()::int AS pid",
          );
          const pid = backend.rows[0]?.pid;
          if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
            throw new Error("authorization_race_backend_pid_invalid");
          }
          gate.ready(Number(pid));
          await gate.release;
        }
        if (cancellationArmed) {
          cancellationArmed = false;
          const backend = await client.query<{ pid: number }>(
            "SELECT pg_backend_pid()::int AS pid",
          );
          const pid = backend.rows[0]?.pid;
          if (!Number.isSafeInteger(pid) || Number(pid) <= 0) {
            throw new Error("cancellation_backend_pid_invalid");
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
      onEvidenceVerificationFailure: (reason: string) =>
        evidenceFailures.push(reason),
    };
    const contextTestStore = new PostgresChangeSetCommandStore(
      executorPool,
      storeOptions,
    );
    const context = verifiedContext();
    const proveAuthorizationRevocationRace = async (input: {
      authority: "MEMBERSHIP" | "POLICY";
      raceIds: readonly string[];
      deniedIds: readonly string[];
    }) => {
      const commandReady = deferred<number>();
      const releaseCommand = deferred<void>();
      authorizationRaceGate = {
        ready: commandReady.resolve,
        release: releaseCommand.promise,
      };
      const commandPromise = executeCanonicalCreateReplay({
        store,
        ids: input.raceIds,
      });
      const commandOutcome = commandPromise.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await within(
        Promise.race([
          commandReady.promise,
          commandOutcome.then((outcome): never => {
            if (outcome.kind === "rejected") throw outcome.error;
            throw new Error("authorization_race_command_finished_before_gate");
          }),
        ]),
        10_000,
      );

      const revoker = new Client({
        connectionString: migratorUrl,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 15_000,
        lock_timeout: 5_000,
        idle_in_transaction_session_timeout: 15_000,
      });
      await revoker.connect();
      let transactionOpen = false;
      try {
        await revoker.query("BEGIN");
        transactionOpen = true;
        await revoker.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          ID.tenant,
        ]);
        const backend = await revoker.query<{ pid: number }>(
          "SELECT pg_backend_pid()::int AS pid",
        );
        const revokerPid = Number(backend.rows[0]?.pid);
        assert.ok(Number.isSafeInteger(revokerPid) && revokerPid > 0);
        const revokeQuery =
          input.authority === "MEMBERSHIP"
            ? revoker.query(
                `UPDATE public.memberships
                 SET status = 'REVOKED', version = version + 1,
                     updated_at = statement_timestamp()
                 WHERE tenant_id = $1 AND id = $2`,
                [ID.tenant, ID.humanMembership],
              )
            : revoker.query(
                `UPDATE public.policy_versions
                 SET state = 'REVOKED', revoked_at = statement_timestamp()
                 WHERE tenant_id = $1 AND id = $2`,
                [ID.tenant, ID.policy],
              );
        const revokeOutcome = revokeQuery.then(
          (value) => ({ kind: "resolved" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        await within(
          Promise.race([
            waitForBackendLock(revokerPid),
            revokeOutcome.then((outcome): never => {
              if (outcome.kind === "rejected") throw outcome.error;
              throw new Error("revocation_did_not_wait_for_command_transaction");
            }),
          ]),
          10_000,
        );

        releaseCommand.resolve();
        const command = await commandOutcome;
        assert.equal(command.kind, "resolved");
        if (command.kind === "resolved") {
          assert.equal(command.value.ok, true);
          if (command.value.ok) assert.equal(command.value.replayed, true);
        }
        const revoked = await revokeOutcome;
        assert.equal(revoked.kind, "resolved");
        if (revoked.kind === "resolved") assert.equal(revoked.value.rowCount, 1);
        await revoker.query("COMMIT");
        transactionOpen = false;

        const denied = await executeCanonicalCreateReplay({
          store,
          ids: input.deniedIds,
        });
        assert.equal(denied.ok, false);
        if (!denied.ok) assert.equal(denied.reason, "authorization_denied");
      } finally {
        releaseCommand.resolve();
        authorizationRaceGate = null;
        if (transactionOpen) await revoker.query("ROLLBACK");
        await revoker.end();
      }

      await withClient(migratorUrl, async (migrator) => {
        await migrator.query("BEGIN");
        try {
          await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
            ID.tenant,
          ]);
          if (input.authority === "MEMBERSHIP") {
            await migrator.query(
              `UPDATE public.memberships
               SET status = 'ACTIVE', version = 1, valid_until = NULL,
                   updated_at = statement_timestamp()
               WHERE tenant_id = $1 AND id = $2`,
              [ID.tenant, ID.humanMembership],
            );
          } else {
            await migrator.query(
              `UPDATE public.policy_versions
               SET state = 'ACTIVE', revoked_at = NULL
               WHERE tenant_id = $1 AND id = $2`,
              [ID.tenant, ID.policy],
            );
          }
          await migrator.query("COMMIT");
        } catch (error) {
          await migrator.query("ROLLBACK");
          throw error;
        }
      });
    };
    await mustFail(
      () =>
        contextTestStore.transaction(
          { ...context } as VerifiedActiveTenantContext,
          async () => undefined,
        ),
      /transaction_context_unverified/,
    );
    await contextTestStore.transaction(context, async (transaction) => {
      assert.equal("setLocalTenant" in transaction, false);
      await mustFail(
        () =>
          transaction.resolveActiveContextStateForUpdate({
            ...context,
          } as VerifiedActiveTenantContext),
        /transaction_context_identity_mismatch/,
      );
      await mustFail(
        () =>
          transaction.insertCommandAttemptReceipt({
            id: ID.rollbackProbe,
            tenantId: ID.tenant,
            contextId: ID.context,
            actorPrincipalId: ID.evidencePrincipal,
            actorMembershipId: ID.humanMembership,
            commandReceiptId: ID.createCommand,
            requestHash: "a".repeat(64),
            outcome: "CONFLICT",
            occurredAt: NOW,
          }),
        /transaction_context_identity_mismatch/,
      );
      storeNow = context.expiresAt + 1;
      await mustFail(
        () => transaction.loadChangeSetForUpdate(ID.tenant, ID.changeSet),
        /transaction_context_expired/,
      );
      storeNow = NOW;
    });
    const store = new PostgresChangeSetCommandStore(
      loseFirstCommitAcknowledgement(executorPool),
      storeOptions,
    );
    const created = await executeCreateR1ChangeSetCommand({
      context,
      command: createCommand,
      dependencies: {
        store,
        now: () => NOW,
        nextUuidV7: uuidFactory([
          ID.createCommand,
          ID.createAccess,
          ID.changeSet,
          ID.createReplayCommand,
          ID.createReplayAccess,
        ]),
      },
    });
    assert.deepEqual(created, {
      ok: true,
      replayed: true,
      result: {
        changeSetId: ID.changeSet,
        status: "DRAFT",
        version: 1,
        transitionReceiptId: null,
        approvalReceiptId: null,
      },
    });

    await proveAuthorizationRevocationRace({
      authority: "MEMBERSHIP",
      raceIds: [ID.membershipRaceCommand, ID.membershipRaceAccess],
      deniedIds: [ID.membershipDeniedAccess],
    });
    await proveAuthorizationRevocationRace({
      authority: "POLICY",
      raceIds: [ID.policyRaceCommand, ID.policyRaceAccess],
      deniedIds: [ID.policyDeniedAccess],
    });

    cancellationArmed = true;
    const cancelledCommand = executeCreateR1ChangeSetCommand({
      context,
      command: {
        idempotencyKey: "adapter-cancellation-0001",
        changeType: "FEATURE_FLAG",
        title: "Cancellation rollback verification",
        purpose: "Prove query cancellation rolls back the bounded command.",
        targetScope: {
          type: "TENANT",
          organizationId: null,
          legacyBranchId: null,
        },
        proposedConfig: {
          ...proposedConfig,
          reason: "This command must be cancelled before its claim.",
        },
      },
      dependencies: {
        store,
        now: () => NOW,
        nextUuidV7: uuidFactory([
          ID.cancellationCommand,
          ID.cancellationAccess,
          ID.cancellationChangeSet,
        ]),
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
          throw new Error("cancellation_command_resolved_before_backend_ready");
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

    const reusedClient = await executorPool.connect();
    try {
      const clean = await reusedClient.query<{
        pid: number;
        tenantSetting: string | null;
      }>(
        `SELECT pg_backend_pid()::int AS pid,
                nullif(current_setting('app.tenant_id', true), '') AS "tenantSetting"`,
      );
      assert.equal(clean.rows[0]?.pid, cancelledPid);
      assert.equal(clean.rows[0]?.tenantSetting, null);
    } finally {
      reusedClient.release();
    }

    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          ID.tenant,
        ]);
        const partial = await migrator.query<{ count: number }>(
          `SELECT (
             (SELECT count(*) FROM public.change_set_command_receipts
              WHERE tenant_id = $1 AND id = $2)
             + (SELECT count(*) FROM public.access_decision_receipts
                WHERE tenant_id = $1 AND id = $3)
             + (SELECT count(*) FROM public.change_sets
                WHERE tenant_id = $1 AND id = $4)
           )::int AS count`,
          [
            ID.tenant,
            ID.cancellationCommand,
            ID.cancellationAccess,
            ID.cancellationChangeSet,
          ],
        );
        assert.equal(partial.rows[0]?.count, 0);
        await migrator.query("ROLLBACK");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
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
    }, `evidence failures: ${evidenceFailures.join(", ")}`);

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

    const raceEvidence = [
      {
        grantId: ID.simulationGrant,
        requestId: ID.simulationRequest,
        receiptId: ID.simulationEvidence,
        targetState: "SIMULATED" as const,
        kind: "SIMULATION" as const,
        challengeNonce: crypto.randomBytes(32).toString("base64url"),
        artifactCount: null,
        artifactManifestHash: null,
      },
      {
        grantId: ID.testArtifactGrant,
        requestId: ID.testArtifactRequest,
        receiptId: ID.testArtifactEvidence,
        targetState: "IN_REVIEW" as const,
        kind: "TEST_ARTIFACT" as const,
        challengeNonce: crypto.randomBytes(32).toString("base64url"),
        artifactCount: 1,
        artifactManifestHash: sha256("adapter-key-race-artifact"),
      },
      {
        grantId: ID.rollbackPlanGrant,
        requestId: ID.rollbackPlanRequest,
        receiptId: ID.rollbackPlanEvidence,
        targetState: "IN_REVIEW" as const,
        kind: "ROLLBACK_PLAN" as const,
        challengeNonce: crypto.randomBytes(32).toString("base64url"),
        artifactCount: null,
        artifactManifestHash: null,
      },
      {
        grantId: ID.canaryPlanGrant,
        requestId: ID.canaryPlanRequest,
        receiptId: ID.canaryPlanEvidence,
        targetState: "IN_REVIEW" as const,
        kind: "CANARY_PLAN" as const,
        challengeNonce: crypto.randomBytes(32).toString("base64url"),
        artifactCount: null,
        artifactManifestHash: null,
      },
    ];
    await withClient(migratorUrl, async (migrator) => {
      const publicKeySpki = evidenceKeys.publicKey.export({
        format: "der",
        type: "spki",
      });
      const fingerprint = fingerprintChangeSetEvidencePublicKey(
        evidenceKeys.publicKey,
      );
      assert.ok(fingerprint);
      await migrator.query("BEGIN");
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          ID.tenant,
        ]);
        await migrator.query(
          `INSERT INTO public.change_set_evidence_signing_keys (
            issuer_id, key_id, algorithm, public_key_spki_base64,
            public_key_fingerprint_sha256, state, valid_from, sign_until,
            verify_until
          ) VALUES ($1, $2, 'Ed25519', $3, $4, 'ACTIVE',
            to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0),
            to_timestamp($7 / 1000.0))`,
          [
            evidenceIssuerId,
            evidenceRaceKeyId,
            publicKeySpki.toString("base64"),
            fingerprint,
            NOW - 60_000,
            NOW + 60 * 60_000,
            NOW + 2 * 60 * 60_000,
          ],
        );
        for (const evidence of raceEvidence) {
          await migrator.query(
            `INSERT INTO public.change_set_evidence_issuer_tenant_grants (
              id, tenant_id, issuer_id, kind, tool_id, tool_version, state,
              valid_from, valid_until
            ) VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE',
              to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0))`,
            [
              evidence.grantId,
              ID.tenant,
              evidenceIssuerId,
              evidence.kind,
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
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
              'OPEN', to_timestamp($13 / 1000.0),
              to_timestamp($14 / 1000.0))`,
            [
              evidence.requestId,
              ID.tenant,
              ID.changeSet,
              evidence.targetState,
              evidence.kind,
              ID.humanPrincipal,
              ID.humanMembership,
              sha256(proposedConfig),
              ID.policy,
              evidenceToolId,
              evidenceToolVersion,
              sha256(evidence.challengeNonce),
              NOW + 10 * 60_000,
              NOW - 1_000,
            ],
          );
        }
        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });
    for (const evidence of raceEvidence) {
      const signed = await issueChangeSetEvidenceEnvelope(
        {
          receiptId: evidence.receiptId,
          evidenceRequestId: evidence.requestId,
          challengeNonce: evidence.challengeNonce,
          issuerTenantGrantId: evidence.grantId,
          tenantId: ID.tenant,
          changeSetId: ID.changeSet,
          targetState: evidence.targetState,
          kind: evidence.kind,
          requestedByPrincipalId: ID.humanPrincipal,
          requestedByMembershipId: ID.humanMembership,
          subjectHash: sha256(proposedConfig),
          policyVersionId: ID.policy,
          toolId: evidenceToolId,
          toolVersion: evidenceToolVersion,
          outcome: "PASSED",
          artifactCount: evidence.artifactCount,
          artifactManifestHash: evidence.artifactManifestHash,
          ttlMs: 5 * 60_000,
        },
        evidenceSigner(evidenceRaceKeyId),
        NOW,
      );
      assert.deepEqual(
        await issuer.persistVerifiedEnvelope({
          expectedTenantId: ID.tenant,
          token: signed.token,
        }),
        { receiptId: evidence.receiptId },
      );
    }

    const evidenceReady = deferred<void>();
    const releaseEvidence = deferred<void>();
    const evidenceRaceStore = pauseAfterEvidenceLoad({
      store,
      ready: () => evidenceReady.resolve(),
      release: releaseEvidence.promise,
    });
    const simulationPromise = executeTransitionR1ChangeSetCommand({
      context,
      command: {
        idempotencyKey: "adapter-key-race-simulation-0001",
        changeSetId: ID.changeSet,
        expectedVersion: 2,
        toState: "SIMULATED",
        reasonCode: "adapter_key_race_simulated",
      },
      dependencies: {
        store: evidenceRaceStore,
        now: () => NOW,
        nextUuidV7: uuidFactory([
          ID.simulationCommand,
          ID.simulationAccess,
          ID.simulationTransition,
        ]),
      },
    });
    const simulationOutcome = simulationPromise.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await within(
      Promise.race([
        evidenceReady.promise,
        simulationOutcome.then((outcome): never => {
          if (outcome.kind === "rejected") throw outcome.error;
          throw new Error("simulation_finished_before_evidence_lock_gate");
        }),
      ]),
      10_000,
    );

    const keyRevoker = new Client({
      connectionString: migratorUrl,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 15_000,
    });
    await keyRevoker.connect();
    let keyRevokerTransactionOpen = false;
    try {
      await keyRevoker.query("BEGIN");
      keyRevokerTransactionOpen = true;
      await keyRevoker.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        ID.tenant,
      ]);
      const backend = await keyRevoker.query<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      const keyRevokerPid = Number(backend.rows[0]?.pid);
      assert.ok(Number.isSafeInteger(keyRevokerPid) && keyRevokerPid > 0);
      const keyRevokeQuery = keyRevoker.query(
        `UPDATE public.change_set_evidence_signing_keys
         SET state = 'COMPROMISED', revoked_at = statement_timestamp()
         WHERE issuer_id = $1 AND key_id = $2`,
        [evidenceIssuerId, evidenceRaceKeyId],
      );
      const keyRevokeOutcome = keyRevokeQuery.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await within(
        Promise.race([
          waitForBackendLock(keyRevokerPid),
          keyRevokeOutcome.then((outcome): never => {
            if (outcome.kind === "rejected") throw outcome.error;
            throw new Error("key_revocation_did_not_wait_for_evidence_lock");
          }),
        ]),
        10_000,
      );

      releaseEvidence.resolve();
      const simulation = await simulationOutcome;
      assert.equal(simulation.kind, "resolved");
      if (simulation.kind === "resolved") {
        assert.deepEqual(simulation.value, {
          ok: true,
          replayed: false,
          result: {
            changeSetId: ID.changeSet,
            status: "SIMULATED",
            version: 3,
            transitionReceiptId: ID.simulationTransition,
            approvalReceiptId: null,
          },
        });
      }
      const keyRevoked = await keyRevokeOutcome;
      assert.equal(keyRevoked.kind, "resolved");
      if (keyRevoked.kind === "resolved") {
        assert.equal(keyRevoked.value.rowCount, 1);
      }
      await keyRevoker.query("COMMIT");
      keyRevokerTransactionOpen = false;
    } finally {
      releaseEvidence.resolve();
      if (keyRevokerTransactionOpen) await keyRevoker.query("ROLLBACK");
      await keyRevoker.end();
    }

    const submitAfterKeyRevocation = await executeTransitionR1ChangeSetCommand({
      context,
      command: {
        idempotencyKey: "adapter-key-revoked-submit-0001",
        changeSetId: ID.changeSet,
        expectedVersion: 3,
        toState: "IN_REVIEW",
        reasonCode: "adapter_key_revoked_submit",
      },
      dependencies: {
        store,
        now: () => NOW,
        nextUuidV7: uuidFactory([
          ID.submitCommand,
          ID.submitAccess,
          ID.submitTransition,
        ]),
      },
    });
    assert.deepEqual(submitAfterKeyRevocation, {
      ok: false,
      reason: "transition_rejected",
      detail: "verified_evidence_unavailable",
    });
    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          ID.tenant,
        ]);
        const partial = await migrator.query<{ count: number }>(
          `SELECT (
             (SELECT count(*) FROM public.change_set_command_receipts
              WHERE tenant_id = $1 AND id = $2)
             + (SELECT count(*) FROM public.access_decision_receipts
                WHERE tenant_id = $1 AND id = $3)
             + (SELECT count(*) FROM public.change_set_transition_receipts
                WHERE tenant_id = $1 AND id = $4)
           )::int AS count`,
          [ID.tenant, ID.submitCommand, ID.submitAccess, ID.submitTransition],
        );
        assert.equal(partial.rows[0]?.count, 0);
        await migrator.query("ROLLBACK");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });

    const grantRaceRequests = [
      {
        requestId: ID.grantRaceIssuedRequest,
        receiptId: ID.grantRaceIssuedEvidence,
        challengeNonce: crypto.randomBytes(32).toString("base64url"),
        artifactManifestHash: sha256("adapter-grant-race-issued-artifact"),
      },
      {
        requestId: ID.grantRaceDeniedRequest,
        receiptId: ID.grantRaceDeniedEvidence,
        challengeNonce: crypto.randomBytes(32).toString("base64url"),
        artifactManifestHash: sha256("adapter-grant-race-denied-artifact"),
      },
    ] as const;
    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          ID.tenant,
        ]);
        for (const request of grantRaceRequests) {
          await migrator.query(
            `INSERT INTO public.change_set_evidence_requests (
              id, tenant_id, change_set_id, target_state, kind,
              requested_by_principal_id, requested_by_membership_id,
              subject_hash, policy_version_id, tool_id, tool_version,
              challenge_nonce_hash, state, expires_at, created_at
            ) VALUES ($1, $2, $3, 'IN_REVIEW', 'TEST_ARTIFACT', $4, $5,
              $6, $7, $8, $9, $10, 'OPEN', to_timestamp($11 / 1000.0),
              to_timestamp($12 / 1000.0))`,
            [
              request.requestId,
              ID.tenant,
              ID.changeSet,
              ID.humanPrincipal,
              ID.humanMembership,
              sha256(proposedConfig),
              ID.policy,
              evidenceToolId,
              evidenceToolVersion,
              sha256(request.challengeNonce),
              NOW + 10 * 60_000,
              NOW - 1_000,
            ],
          );
        }
        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });
    const grantRaceEnvelopes = await Promise.all(
      grantRaceRequests.map((request) =>
        issueChangeSetEvidenceEnvelope(
          {
            receiptId: request.receiptId,
            evidenceRequestId: request.requestId,
            challengeNonce: request.challengeNonce,
            issuerTenantGrantId: ID.testArtifactGrant,
            tenantId: ID.tenant,
            changeSetId: ID.changeSet,
            targetState: "IN_REVIEW",
            kind: "TEST_ARTIFACT",
            requestedByPrincipalId: ID.humanPrincipal,
            requestedByMembershipId: ID.humanMembership,
            subjectHash: sha256(proposedConfig),
            policyVersionId: ID.policy,
            toolId: evidenceToolId,
            toolVersion: evidenceToolVersion,
            outcome: "PASSED",
            artifactCount: 1,
            artifactManifestHash: request.artifactManifestHash,
            ttlMs: 5 * 60_000,
          },
          evidenceSigner(),
          NOW,
        ),
      ),
    );

    const grantContextReady = deferred<void>();
    const releaseGrantContext = deferred<void>();
    const grantRaceIssuer = new PostgresChangeSetEvidenceIssuer({
      pool: pauseAfterEvidenceVerificationContextLoad({
        pool: issuerPool,
        ready: () => grantContextReady.resolve(),
        release: releaseGrantContext.promise,
      }),
      expectedRole: ROLE.evidenceIssuer,
      expectedEnvironmentId: "test-ci",
      expectedCellId: "cell-a",
      now: () => NOW,
    });
    const issuedDuringGrantRace = grantRaceIssuer.persistVerifiedEnvelope({
      expectedTenantId: ID.tenant,
      token: grantRaceEnvelopes[0].token,
    });
    const issuedDuringGrantRaceOutcome = issuedDuringGrantRace.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await within(
      Promise.race([
        grantContextReady.promise,
        issuedDuringGrantRaceOutcome.then((outcome): never => {
          if (outcome.kind === "rejected") throw outcome.error;
          throw new Error("evidence_issuance_finished_before_grant_lock_gate");
        }),
      ]),
      10_000,
    );

    const grantRevoker = new Client({
      connectionString: migratorUrl,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 15_000,
    });
    await grantRevoker.connect();
    let grantRevokerTransactionOpen = false;
    try {
      await grantRevoker.query("BEGIN");
      grantRevokerTransactionOpen = true;
      await grantRevoker.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        ID.tenant,
      ]);
      const backend = await grantRevoker.query<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      const grantRevokerPid = Number(backend.rows[0]?.pid);
      assert.ok(Number.isSafeInteger(grantRevokerPid) && grantRevokerPid > 0);
      const grantRevokeQuery = grantRevoker.query(
        `UPDATE public.change_set_evidence_issuer_tenant_grants
         SET state = 'REVOKED'
         WHERE tenant_id = $1 AND id = $2`,
        [ID.tenant, ID.testArtifactGrant],
      );
      const grantRevokeOutcome = grantRevokeQuery.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await within(
        Promise.race([
          waitForBackendLock(grantRevokerPid),
          grantRevokeOutcome.then((outcome): never => {
            if (outcome.kind === "rejected") throw outcome.error;
            throw new Error("grant_revocation_did_not_wait_for_issuance_lock");
          }),
        ]),
        10_000,
      );

      releaseGrantContext.resolve();
      const issued = await issuedDuringGrantRaceOutcome;
      assert.equal(issued.kind, "resolved");
      if (issued.kind === "resolved") {
        assert.deepEqual(issued.value, {
          receiptId: ID.grantRaceIssuedEvidence,
        });
      }
      const revoked = await grantRevokeOutcome;
      assert.equal(revoked.kind, "resolved");
      if (revoked.kind === "resolved") assert.equal(revoked.value.rowCount, 1);
      await grantRevoker.query("COMMIT");
      grantRevokerTransactionOpen = false;
    } finally {
      releaseGrantContext.resolve();
      if (grantRevokerTransactionOpen) await grantRevoker.query("ROLLBACK");
      await grantRevoker.end();
    }

    await mustFail(
      () =>
        issuer.persistVerifiedEnvelope({
          expectedTenantId: ID.tenant,
          token: grantRaceEnvelopes[1].token,
        }),
      /change_set_evidence_verification_failed:tenant_grant_inactive/,
    );
    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          ID.tenant,
        ]);
        const requests = await migrator.query(
          `SELECT id, state, issued_receipt_id
           FROM public.change_set_evidence_requests
           WHERE tenant_id = $1 AND id = ANY($2::uuid[])
           ORDER BY id`,
          [
            ID.tenant,
            [ID.grantRaceIssuedRequest, ID.grantRaceDeniedRequest],
          ],
        );
        assert.deepEqual(requests.rows, [
          {
            id: ID.grantRaceIssuedRequest,
            state: "ISSUED",
            issued_receipt_id: ID.grantRaceIssuedEvidence,
          },
          {
            id: ID.grantRaceDeniedRequest,
            state: "OPEN",
            issued_receipt_id: null,
          },
        ]);
        const receipts = await migrator.query<{ id: string }>(
          `SELECT id FROM public.change_set_evidence_receipts
           WHERE tenant_id = $1 AND id = ANY($2::uuid[])
           ORDER BY id`,
          [
            ID.tenant,
            [ID.grantRaceIssuedEvidence, ID.grantRaceDeniedEvidence],
          ],
        );
        assert.deepEqual(receipts.rows, [{ id: ID.grantRaceIssuedEvidence }]);
        await migrator.query("ROLLBACK");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });

    const issuerRaceRequests = [
      {
        requestId: ID.issuerRaceIssuedRequest,
        receiptId: ID.issuerRaceIssuedEvidence,
        challengeNonce: crypto.randomBytes(32).toString("base64url"),
      },
      {
        requestId: ID.issuerRaceDeniedRequest,
        receiptId: ID.issuerRaceDeniedEvidence,
        challengeNonce: crypto.randomBytes(32).toString("base64url"),
      },
    ] as const;
    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          ID.tenant,
        ]);
        for (const request of issuerRaceRequests) {
          await migrator.query(
            `INSERT INTO public.change_set_evidence_requests (
              id, tenant_id, change_set_id, target_state, kind,
              requested_by_principal_id, requested_by_membership_id,
              subject_hash, policy_version_id, tool_id, tool_version,
              challenge_nonce_hash, state, expires_at, created_at
            ) VALUES ($1, $2, $3, 'IN_REVIEW', 'ROLLBACK_PLAN', $4, $5,
              $6, $7, $8, $9, $10, 'OPEN', to_timestamp($11 / 1000.0),
              to_timestamp($12 / 1000.0))`,
            [
              request.requestId,
              ID.tenant,
              ID.changeSet,
              ID.humanPrincipal,
              ID.humanMembership,
              sha256(proposedConfig),
              ID.policy,
              evidenceToolId,
              evidenceToolVersion,
              sha256(request.challengeNonce),
              NOW + 10 * 60_000,
              NOW - 1_000,
            ],
          );
        }
        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });
    const issuerRaceEnvelopes = await Promise.all(
      issuerRaceRequests.map((request) =>
        issueChangeSetEvidenceEnvelope(
          {
            receiptId: request.receiptId,
            evidenceRequestId: request.requestId,
            challengeNonce: request.challengeNonce,
            issuerTenantGrantId: ID.rollbackPlanGrant,
            tenantId: ID.tenant,
            changeSetId: ID.changeSet,
            targetState: "IN_REVIEW",
            kind: "ROLLBACK_PLAN",
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
        ),
      ),
    );

    const issuerContextReady = deferred<void>();
    const releaseIssuerContext = deferred<void>();
    const issuerRaceAdapter = new PostgresChangeSetEvidenceIssuer({
      pool: pauseAfterEvidenceVerificationContextLoad({
        pool: issuerPool,
        ready: () => issuerContextReady.resolve(),
        release: releaseIssuerContext.promise,
      }),
      expectedRole: ROLE.evidenceIssuer,
      expectedEnvironmentId: "test-ci",
      expectedCellId: "cell-a",
      now: () => NOW,
    });
    const issuedDuringIssuerRace = issuerRaceAdapter.persistVerifiedEnvelope({
      expectedTenantId: ID.tenant,
      token: issuerRaceEnvelopes[0].token,
    });
    const issuedDuringIssuerRaceOutcome = issuedDuringIssuerRace.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await within(
      Promise.race([
        issuerContextReady.promise,
        issuedDuringIssuerRaceOutcome.then((outcome): never => {
          if (outcome.kind === "rejected") throw outcome.error;
          throw new Error("evidence_issuance_finished_before_issuer_lock_gate");
        }),
      ]),
      10_000,
    );

    const issuerRevoker = new Client({
      connectionString: migratorUrl,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 15_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 15_000,
    });
    await issuerRevoker.connect();
    let issuerRevokerTransactionOpen = false;
    try {
      await issuerRevoker.query("BEGIN");
      issuerRevokerTransactionOpen = true;
      await issuerRevoker.query(`SELECT set_config('app.tenant_id', $1, true)`, [
        ID.tenant,
      ]);
      const backend = await issuerRevoker.query<{ pid: number }>(
        "SELECT pg_backend_pid()::int AS pid",
      );
      const issuerRevokerPid = Number(backend.rows[0]?.pid);
      assert.ok(Number.isSafeInteger(issuerRevokerPid) && issuerRevokerPid > 0);
      const issuerRevokeQuery = issuerRevoker.query(
        `UPDATE public.change_set_evidence_issuers
         SET state = 'REVOKED'
         WHERE id = $1`,
        [evidenceIssuerId],
      );
      const issuerRevokeOutcome = issuerRevokeQuery.then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await within(
        Promise.race([
          waitForBackendLock(issuerRevokerPid),
          issuerRevokeOutcome.then((outcome): never => {
            if (outcome.kind === "rejected") throw outcome.error;
            throw new Error("issuer_revocation_did_not_wait_for_issuance_lock");
          }),
        ]),
        10_000,
      );

      releaseIssuerContext.resolve();
      const issued = await issuedDuringIssuerRaceOutcome;
      assert.equal(issued.kind, "resolved");
      if (issued.kind === "resolved") {
        assert.deepEqual(issued.value, {
          receiptId: ID.issuerRaceIssuedEvidence,
        });
      }
      const revoked = await issuerRevokeOutcome;
      assert.equal(revoked.kind, "resolved");
      if (revoked.kind === "resolved") assert.equal(revoked.value.rowCount, 1);
      await issuerRevoker.query("COMMIT");
      issuerRevokerTransactionOpen = false;
    } finally {
      releaseIssuerContext.resolve();
      if (issuerRevokerTransactionOpen) await issuerRevoker.query("ROLLBACK");
      await issuerRevoker.end();
    }

    await mustFail(
      () =>
        issuer.persistVerifiedEnvelope({
          expectedTenantId: ID.tenant,
          token: issuerRaceEnvelopes[1].token,
        }),
      /change_set_evidence_verification_failed:key_inactive/,
    );
    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query(`SELECT set_config('app.tenant_id', $1, true)`, [
          ID.tenant,
        ]);
        const requests = await migrator.query(
          `SELECT id, state, issued_receipt_id
           FROM public.change_set_evidence_requests
           WHERE tenant_id = $1 AND id = ANY($2::uuid[])
           ORDER BY id`,
          [
            ID.tenant,
            [ID.issuerRaceIssuedRequest, ID.issuerRaceDeniedRequest],
          ],
        );
        assert.deepEqual(requests.rows, [
          {
            id: ID.issuerRaceIssuedRequest,
            state: "ISSUED",
            issued_receipt_id: ID.issuerRaceIssuedEvidence,
          },
          {
            id: ID.issuerRaceDeniedRequest,
            state: "OPEN",
            issued_receipt_id: null,
          },
        ]);
        const receipts = await migrator.query<{ id: string }>(
          `SELECT id FROM public.change_set_evidence_receipts
           WHERE tenant_id = $1 AND id = ANY($2::uuid[])
           ORDER BY id`,
          [
            ID.tenant,
            [ID.issuerRaceIssuedEvidence, ID.issuerRaceDeniedEvidence],
          ],
        );
        assert.deepEqual(receipts.rows, [{ id: ID.issuerRaceIssuedEvidence }]);
        await migrator.query("ROLLBACK");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });

    await store.transaction(context, async () => {
      throw new Error("adapter_rollback_probe");
    }).then(
      () => assert.fail("rollback probe must fail"),
      (error: unknown) => assert.match(String(error), /adapter_rollback_probe/),
    );
    storeNow = context.expiresAt + 1;
    await mustFail(
      () => store.transaction(context, async () => undefined),
      /transaction_context_unverified/,
    );
    storeNow = NOW;

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
          `SELECT id, consumed_by_command_receipt_id,
                  consumed_at IS NOT NULL AS consumed
           FROM public.change_set_evidence_receipts
           WHERE tenant_id = $1 AND id = ANY($2::uuid[])
           ORDER BY id`,
          [
            ID.tenant,
            [
              ID.evidenceReceipt,
              ID.simulationEvidence,
              ID.testArtifactEvidence,
              ID.rollbackPlanEvidence,
              ID.canaryPlanEvidence,
              ID.grantRaceIssuedEvidence,
              ID.grantRaceDeniedEvidence,
              ID.issuerRaceIssuedEvidence,
              ID.issuerRaceDeniedEvidence,
            ],
          ],
        );
        assert.deepEqual(evidence.rows, [
          {
            id: ID.evidenceReceipt,
            consumed_by_command_receipt_id: ID.transitionCommand,
            consumed: true,
          },
          {
            id: ID.simulationEvidence,
            consumed_by_command_receipt_id: ID.simulationCommand,
            consumed: true,
          },
          {
            id: ID.testArtifactEvidence,
            consumed_by_command_receipt_id: null,
            consumed: false,
          },
          {
            id: ID.rollbackPlanEvidence,
            consumed_by_command_receipt_id: null,
            consumed: false,
          },
          {
            id: ID.canaryPlanEvidence,
            consumed_by_command_receipt_id: null,
            consumed: false,
          },
          {
            id: ID.grantRaceIssuedEvidence,
            consumed_by_command_receipt_id: null,
            consumed: false,
          },
          {
            id: ID.issuerRaceIssuedEvidence,
            consumed_by_command_receipt_id: null,
            consumed: false,
          },
        ]);
        const grantState = await migrator.query(
          `SELECT state, revoked_at IS NOT NULL AS revoked
           FROM public.change_set_evidence_issuer_tenant_grants
           WHERE tenant_id = $1 AND id = $2`,
          [ID.tenant, ID.testArtifactGrant],
        );
        assert.deepEqual(grantState.rows, [{ state: "REVOKED", revoked: true }]);
        const issuerState = await migrator.query(
          `SELECT state, revoked_at IS NOT NULL AS revoked
           FROM public.change_set_evidence_issuers
           WHERE id = $1`,
          [evidenceIssuerId],
        );
        assert.deepEqual(issuerState.rows, [{ state: "REVOKED", revoked: true }]);
        const state = await migrator.query(
          `SELECT status, version::int FROM public.change_sets
           WHERE tenant_id = $1 AND id = $2`,
          [ID.tenant, ID.changeSet],
        );
        assert.deepEqual(state.rows, [{ status: "SIMULATED", version: 3 }]);
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
    "[postgres-adapter-gate] PASS: EXECUTE-only roles, real command store, ambiguous-commit replay, SQLSTATE 57014 cancellation rollback, membership/policy/key/grant/issuer revoke serialization, signed evidence, and pool cleanup",
  );
}

await main();
