import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

import {
  fingerprintActiveContextPublicKey,
  type ActiveContextExternalSigner,
  type ActiveContextVerificationKey,
} from "../src/lib/activeTenantContext.js";
import {
  ACTIVE_CONTEXT_SESSION_GATEWAY_PATH,
  issueActiveContextForHttpSession,
  type ActiveContextRateLimitInput,
} from "../src/lib/activeContextSessionGateway.js";
import { PostgresActiveContextIssuanceRateLimiter } from "../src/lib/postgresActiveContextIssuanceRateLimiter.js";
import {
  ActiveContextSelectionCommitOutcomeUnknownError,
  PostgresActiveContextSelectionLifecycle,
} from "../src/lib/postgresActiveContextSelectionLifecycle.js";
import { PostgresActiveContextSessionRepository } from "../src/lib/postgresActiveContextSessionRepository.js";
import { PostgresAuthoritativeActiveContextRepository } from "../src/lib/postgresAuthoritativeActiveContextRepository.js";

const { Client, Pool } = pg;

function requiredUrl(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const adminUrl = requiredUrl("PG_GATE_ADMIN_URL");
const migratorUrl = requiredUrl("PG_GATE_MIGRATOR_URL");
const sessionResolverUrl = requiredUrl("PG_GATE_SESSION_RESOLVER_URL");
const rateLimitUrl = requiredUrl("PG_GATE_RATE_LIMIT_URL");
const lifecycleUrl = requiredUrl("PG_GATE_SESSION_LIFECYCLE_URL");
const contextResolverUrl = requiredUrl("PG_GATE_CONTEXT_RESOLVER_URL");
const databaseName = new URL(adminUrl).pathname.slice(1);

assert.match(databaseName, /^fas_it_[a-z0-9_]+$/);
for (const value of [
  adminUrl,
  migratorUrl,
  sessionResolverUrl,
  rateLimitUrl,
  lifecycleUrl,
  contextResolverUrl,
]) {
  const parsed = new URL(value);
  assert.equal(parsed.hostname, "127.0.0.1");
  assert.equal(parsed.port, "5432");
  assert.equal(parsed.pathname.slice(1), databaseName);
  assert.equal(parsed.search, "");
  assert.equal(parsed.hash, "");
}

const ROLE = {
  sessionOwner: "fas_session_owner",
  sessionResolver: "fas_session_resolver",
  rateOwner: "fas_rate_limit_owner",
  rateExecutor: "fas_rate_limit_executor",
  lifecycleOwner: "fas_session_lifecycle_owner",
  lifecycleExecutor: "fas_session_lifecycle_executor",
} as const;

const ID = {
  tenant: "018f5000-0000-7000-8000-000000000001",
  principal: "018f5000-0000-7000-8000-000000000002",
  membership: "018f5000-0000-7000-8000-000000000003",
  membershipTwo: "018f5000-0000-7000-8000-000000000005",
  context: "018fc000-0000-7000-8000-000000000001",
  selection: "018fc000-0000-7000-8000-000000000002",
  otherSelection: "018fc000-0000-7000-8000-000000000003",
  issuer: "018fc000-0000-7000-8000-000000000004",
  impersonatedSelection: "018fc000-0000-7000-8000-000000000006",
} as const;

const USER_ID = 910_001;
const SID = "a".repeat(64);
const OTHER_SID = "b".repeat(64);
const IMPERSONATED_SID = "d".repeat(64);
const CSRF = "c".repeat(64);
const TRUSTED_ORIGIN = "https://apply.findandstudy.test";
const NOW = Date.now();
const SESSION_ISSUED_AT = NOW - 60_000;
const SESSION_IDLE_EXPIRES_AT = NOW + 5 * 60_000;
const SESSION_GENERATION = 1;
const AUDIENCE = "fas.change-set.request";
const ENVIRONMENT = "test";
const CELL = "cell-a";
const KEY_ID = "active-context-session-pg-a";
const KEY_REFERENCE = "test-memory://active-context/session-pg-a";
const keys = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = keys.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

function fingerprint(sid: string): string {
  return crypto.createHash("sha256").update(sid, "ascii").digest("hex");
}

function subjectHash(input: {
  sessionFingerprint: string;
  sessionGeneration: number;
  principalId: string;
  tenantId: string;
}) {
  return crypto
    .createHash("sha256")
    .update("fas.active-context-issuance-rate-limit.v1\0", "utf8")
    .update(input.sessionFingerprint, "ascii")
    .update("\0", "ascii")
    .update(String(input.sessionGeneration), "ascii")
    .update("\0", "ascii")
    .update(input.principalId, "ascii")
    .update("\0", "ascii")
    .update(input.tenantId, "ascii")
    .digest("hex");
}

function verificationKey(): ActiveContextVerificationKey {
  return {
    keyId: KEY_ID,
    algorithm: "Ed25519",
    state: "ACTIVE",
    issuerId: ID.issuer,
    environmentId: ENVIRONMENT,
    cellId: CELL,
    publicKeyPem,
    publicKeyFingerprint: fingerprintActiveContextPublicKey(publicKeyPem),
    signFrom: NOW - 60_000,
    signUntil: NOW + 10 * 60_000,
    verifyUntil: NOW + 20 * 60_000,
  };
}

function signer(): ActiveContextExternalSigner {
  return {
    async sign({ keyReference, signingInput }) {
      assert.equal(keyReference, KEY_REFERENCE);
      return crypto.sign(null, signingInput, keys.privateKey);
    },
  };
}

function nextUuidV7Factory() {
  let counter = 0;
  return (observedAt = NOW) => {
    counter += 1;
    const bytes = Buffer.alloc(16);
    const timestamp = BigInt(observedAt);
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Number(timestamp >> BigInt((5 - index) * 8) & 0xffn);
    }
    bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80;
    crypto.randomFillSync(bytes, 9);
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
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
    const identity = await client.query(
      "SELECT current_user, current_database(), inet_server_port() AS server_port",
    );
    assert.equal(identity.rows[0]?.current_user, new URL(url).username);
    assert.equal(identity.rows[0]?.current_database, databaseName);
    assert.equal(identity.rows[0]?.server_port, 5432);
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
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("test_timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function bootstrapAuthority() {
  await withClient(adminUrl, async (admin) => {
    await admin.query(`
      GRANT CONNECT ON DATABASE ${databaseName} TO
        ${ROLE.sessionResolver}, ${ROLE.rateExecutor}, ${ROLE.lifecycleExecutor};
      GRANT USAGE ON SCHEMA public, fas_session_v1 TO ${ROLE.sessionOwner};
      GRANT USAGE ON SCHEMA public, fas_rate_limit_v1 TO ${ROLE.rateOwner};
      GRANT USAGE ON SCHEMA public, fas_session_lifecycle_v1 TO ${ROLE.lifecycleOwner};
      GRANT USAGE ON SCHEMA fas_session_v1 TO ${ROLE.sessionResolver};
      GRANT USAGE ON SCHEMA fas_rate_limit_v1 TO ${ROLE.rateExecutor};
      GRANT USAGE ON SCHEMA fas_session_lifecycle_v1 TO ${ROLE.lifecycleExecutor};

      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM
        ${ROLE.sessionOwner}, ${ROLE.sessionResolver},
        ${ROLE.rateOwner}, ${ROLE.rateExecutor},
        ${ROLE.lifecycleOwner}, ${ROLE.lifecycleExecutor};
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM
        ${ROLE.sessionOwner}, ${ROLE.sessionResolver},
        ${ROLE.rateOwner}, ${ROLE.rateExecutor},
        ${ROLE.lifecycleOwner}, ${ROLE.lifecycleExecutor};

      GRANT SELECT, UPDATE ON TABLE
        public.sessions, public.users, public.principals, public.memberships,
        public.active_session_context_selections
      TO ${ROLE.sessionOwner};
      GRANT SELECT, UPDATE ON TABLE public.active_session_context_selections
      TO ${ROLE.rateOwner};
      GRANT SELECT, INSERT, UPDATE ON TABLE
        public.active_context_issuance_rate_limits
      TO ${ROLE.rateOwner};
      GRANT SELECT, INSERT ON TABLE public.active_context_issuance_permits
      TO ${ROLE.rateOwner};
      GRANT SELECT, UPDATE ON TABLE
        public.sessions, public.users, public.principals, public.memberships,
        public.tenants, public.organizations
      TO ${ROLE.lifecycleOwner};
      GRANT SELECT ON TABLE public.tenant_organization_legacy_branches
      TO ${ROLE.lifecycleOwner};
      GRANT SELECT, INSERT, UPDATE ON TABLE
        public.active_session_context_selections
      TO ${ROLE.lifecycleOwner};
      GRANT SELECT, INSERT ON TABLE
        public.active_session_context_selection_command_receipts
      TO ${ROLE.lifecycleOwner};

      ALTER FUNCTION fas_session_v1.resolve_session_for_active_context(text, text, bigint)
        OWNER TO ${ROLE.sessionOwner};
      ALTER FUNCTION fas_rate_limit_v1.consume_active_context_issuance(
        uuid, text, text, bigint, uuid, bigint, uuid
      ) OWNER TO ${ROLE.rateOwner};
      ALTER FUNCTION fas_session_lifecycle_v1.apply_self_selection_command(
        text, text, text, uuid, uuid, uuid, bigint, text, text,
        uuid, uuid, text, text, bigint
      ) OWNER TO ${ROLE.lifecycleOwner};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_session_v1
        FROM PUBLIC, ${ROLE.sessionResolver};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_rate_limit_v1
        FROM PUBLIC, ${ROLE.rateExecutor};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_session_lifecycle_v1
        FROM PUBLIC, ${ROLE.lifecycleExecutor};
      GRANT EXECUTE ON FUNCTION
        fas_session_v1.resolve_session_for_active_context(text, text, bigint)
      TO ${ROLE.sessionResolver};
      GRANT EXECUTE ON FUNCTION
        fas_rate_limit_v1.consume_active_context_issuance(
          uuid, text, text, bigint, uuid, bigint, uuid
        )
      TO ${ROLE.rateExecutor};
      GRANT EXECUTE ON FUNCTION
        fas_session_lifecycle_v1.apply_self_selection_command(
          text, text, text, uuid, uuid, uuid, bigint, text, text,
          uuid, uuid, text, text, bigint
        )
      TO ${ROLE.lifecycleExecutor};
    `);

    const roles = await admin.query(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolinherit,
              rolreplication, rolbypassrls, rolcanlogin
       FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [[
        ROLE.sessionOwner,
        ROLE.sessionResolver,
        ROLE.rateOwner,
        ROLE.rateExecutor,
        ROLE.lifecycleOwner,
        ROLE.lifecycleExecutor,
      ]],
    );
    assert.equal(roles.rowCount, 6);
    for (const role of roles.rows) {
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolcreatedb, false);
      assert.equal(role.rolcreaterole, false);
      assert.equal(role.rolinherit, false);
      assert.equal(role.rolreplication, false);
      assert.equal(role.rolbypassrls, false);
      assert.equal(
        role.rolcanlogin,
        role.rolname === ROLE.sessionResolver ||
          role.rolname === ROLE.rateExecutor ||
          role.rolname === ROLE.lifecycleExecutor,
      );
    }
  });
}

async function seed() {
  await withClient(migratorUrl, async (migrator) => {
    await migrator.query("BEGIN");
    try {
      await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenant]);
      const foundation = await migrator.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM public.tenants tenant
         JOIN public.principals principal ON principal.id = $2
         JOIN public.memberships membership
           ON membership.tenant_id = tenant.id
          AND membership.id = $3
          AND membership.principal_id = principal.id
         JOIN public.policy_versions policy
           ON policy.tenant_id = tenant.id
          AND policy.version_number = tenant.policy_version
          AND policy.state = 'ACTIVE'
         WHERE tenant.id = $1 AND tenant.status = 'ACTIVE'
           AND principal.principal_type = 'HUMAN'
           AND principal.status = 'ACTIVE'
           AND membership.status = 'ACTIVE'
           AND EXISTS (
             SELECT 1 FROM public.access_assignments assignment
             WHERE assignment.tenant_id = tenant.id
               AND assignment.membership_id = membership.id
               AND assignment.status = 'ACTIVE'
           )`,
        [ID.tenant, ID.principal, ID.membership],
      );
      assert.equal(foundation.rows[0]?.count, 1);
      await migrator.query(
        `INSERT INTO public.users (
           id, email, first_name, last_name, role, language,
           is_active, email_verified, created_at, updated_at
         ) VALUES ($1, $2, 'Session', 'Gateway', 'staff', 'en', true, true,
                   statement_timestamp(), statement_timestamp())`,
        [USER_ID, `session-gateway-${USER_ID}@example.test`],
      );
      await migrator.query(
        `UPDATE public.principals SET legacy_user_id = $1, version = version + 1,
           updated_at = statement_timestamp() WHERE id = $2`,
        [USER_ID, ID.principal],
      );
      await migrator.query(
        `INSERT INTO public.memberships (
           id, tenant_id, organization_id, legacy_branch_id, principal_id,
           status, valid_from, valid_until, version, created_at, updated_at
         )
         SELECT $1, tenant_id, NULL, NULL, principal_id,
                status, valid_from, valid_until, 1,
                statement_timestamp(), statement_timestamp()
         FROM public.memberships
         WHERE tenant_id = $2 AND id = $3 AND principal_id = $4`,
        [ID.membershipTwo, ID.tenant, ID.membership, ID.principal],
      );
      await migrator.query(
        `INSERT INTO public.sessions (sid, sess, expire, user_id)
         VALUES (
           $1,
           jsonb_build_object(
             'user', jsonb_build_object('id', $2::integer, 'role', 'staff'),
             'access_token', 'synthetic-test-only',
             'issued_at', $3::bigint
           ),
           to_timestamp($4::bigint / 1000.0) AT TIME ZONE 'UTC',
           $2::integer
         )`,
        [SID, USER_ID, SESSION_ISSUED_AT, SESSION_IDLE_EXPIRES_AT],
      );
      await migrator.query(
        `INSERT INTO public.sessions (sid, sess, expire, user_id)
         VALUES (
           $1,
           jsonb_build_object(
             'user', jsonb_build_object('id', $2::integer, 'role', 'staff'),
             'access_token', 'synthetic-test-only',
             'issued_at', $3::bigint
           ),
           to_timestamp($4::bigint / 1000.0) AT TIME ZONE 'UTC',
           $2::integer
         )`,
        [OTHER_SID, USER_ID, SESSION_ISSUED_AT, SESSION_IDLE_EXPIRES_AT],
      );
      await migrator.query(
        `INSERT INTO public.active_session_context_selections (
           id, tenant_id, session_fingerprint, session_generation,
           legacy_user_id, principal_id, membership_id, status
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
        [
          ID.selection,
          ID.tenant,
          fingerprint(SID),
          SESSION_GENERATION,
          USER_ID,
          ID.principal,
          ID.membership,
        ],
      );
      await migrator.query(
        `INSERT INTO public.sessions (sid, sess, expire, user_id)
         VALUES (
           $1,
           jsonb_build_object(
             'user', jsonb_build_object('id', $2::integer, 'role', 'staff'),
             'access_token', 'synthetic-test-only',
             'issued_at', $3::bigint
           ),
           to_timestamp($4::bigint / 1000.0) AT TIME ZONE 'UTC',
           $2::integer
         )`,
        [IMPERSONATED_SID, USER_ID, SESSION_ISSUED_AT, SESSION_IDLE_EXPIRES_AT],
      );
      await migrator.query(
        `INSERT INTO public.active_session_context_selections (
           id, tenant_id, session_fingerprint, session_generation,
           legacy_user_id, principal_id, membership_id, status,
           impersonator_principal_id, original_session_fingerprint
         ) VALUES ($1, $2, $3, 1, $4, $5, $6, 'ACTIVE', $5, $7)`,
        [
          ID.impersonatedSelection,
          ID.tenant,
          fingerprint(IMPERSONATED_SID),
          USER_ID,
          ID.principal,
          ID.membership,
          fingerprint(SID),
        ],
      );
      await migrator.query("COMMIT");
    } catch (error) {
      await migrator.query("ROLLBACK");
      throw error;
    }
  });
}

function request() {
  return {
    method: "POST",
    path: ACTIVE_CONTEXT_SESSION_GATEWAY_PATH,
    headers: {
      origin: TRUSTED_ORIGIN,
      referer: `${TRUSTED_ORIGIN}/admin/control-plane`,
      "x-csrf-token": CSRF,
      cookie: `sid=${SID}; csrf_token=${CSRF}`,
    },
    cookies: { sid: SID, csrf_token: CSRF },
    apiTokenAuth: false,
    body: {
      tenantId: "018fc000-0000-7000-8000-000000000099",
      authenticatedPrincipalId: "018fc000-0000-7000-8000-000000000098",
    },
    query: { tenantId: "018fc000-0000-7000-8000-000000000099" },
  };
}

function cancellationPool(input: {
  pool: pg.Pool;
  ready: (pid: number) => void;
}): pg.Pool {
  let armed = true;
  return {
    connect: async () => {
      const client = await input.pool.connect();
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return async (text: string, values?: unknown[]) => {
              if (
                armed &&
                text.includes("fas_session_v1.resolve_session_for_active_context")
              ) {
                armed = false;
                const backend = await target.query<{ pid: number }>(
                  "SELECT pg_backend_pid()::int AS pid",
                );
                const pid = Number(backend.rows[0]?.pid);
                assert.ok(Number.isSafeInteger(pid) && pid > 0);
                input.ready(pid);
                await target.query("SELECT pg_sleep(30)");
              }
              return target.query(text, values as never[] | undefined);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
}

function loseCommitAcknowledgements(pool: pg.Pool, count: number): pg.Pool {
  let remaining = count;
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: unknown[]) => {
          const result = await client.query(text, values as never[] | undefined);
          if (text === "COMMIT" && remaining > 0) {
            remaining -= 1;
            throw new Error("simulated_selection_commit_acknowledgement_loss");
          }
          return result;
        },
        release: (error?: boolean | Error) => client.release(error),
      } as unknown as pg.PoolClient;
    },
  } as unknown as pg.Pool;
}

function failBeforeCommit(pool: pg.Pool): pg.Pool {
  let armed = true;
  return {
    connect: async () => {
      const client = await pool.connect();
      return {
        query: async (text: string, values?: unknown[]) => {
          if (text === "COMMIT" && armed) {
            armed = false;
            throw new Error("simulated_selection_precommit_connection_loss");
          }
          return client.query(text, values as never[] | undefined);
        },
        release: (error?: boolean | Error) => client.release(error),
      } as unknown as pg.PoolClient;
    },
  } as unknown as pg.Pool;
}

function poisonedLifecyclePool(input: {
  pool: pg.Pool;
  onRelease: (error: Error | boolean | undefined) => void;
}): pg.Pool {
  return {
    connect: async () => {
      const client = await input.pool.connect();
      await client.query("SELECT set_config('app.tenant_id', $1, false)", [ID.tenant]);
      return {
        query: (text: string, values?: unknown[]) =>
          client.query(text, values as never[] | undefined),
        release: (error?: boolean | Error) => {
          input.onRelease(error);
          client.release(error);
        },
      } as unknown as pg.PoolClient;
    },
  } as unknown as pg.Pool;
}

function lifecycleCancellationPool(input: {
  pool: pg.Pool;
  ready: (pid: number) => void;
}): pg.Pool {
  let armed = true;
  return {
    connect: async () => {
      const client = await input.pool.connect();
      return new Proxy(client, {
        get(target, property, receiver) {
          if (property === "query") {
            return async (text: string, values?: unknown[]) => {
              if (
                armed &&
                text.includes("fas_session_lifecycle_v1.apply_self_selection_command")
              ) {
                armed = false;
                const backend = await target.query<{ pid: number }>(
                  "SELECT pg_backend_pid()::int AS pid",
                );
                const pid = Number(backend.rows[0]?.pid);
                assert.ok(Number.isSafeInteger(pid) && pid > 0);
                input.ready(pid);
                await target.query("SELECT pg_sleep(30)");
              }
              return target.query(text, values as never[] | undefined);
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as pg.Pool;
}

async function main() {
  await bootstrapAuthority();
  await seed();

  const sessionPool = new Pool({ connectionString: sessionResolverUrl, max: 1 });
  const ratePool = new Pool({ connectionString: rateLimitUrl, max: 8 });
  const lifecyclePool = new Pool({ connectionString: lifecycleUrl, max: 4 });
  const contextPool = new Pool({ connectionString: contextResolverUrl, max: 1 });
  try {
    const sessionRepository = new PostgresActiveContextSessionRepository({
      pool: sessionPool,
      expectedRole: ROLE.sessionResolver,
    });
    const nextPermit = nextUuidV7Factory();
    const rateLimiter = new PostgresActiveContextIssuanceRateLimiter({
      pool: ratePool,
      expectedRole: ROLE.rateExecutor,
      nextUuidV7: nextPermit,
    });
    const contextRepository = new PostgresAuthoritativeActiveContextRepository({
      pool: contextPool,
      expectedRole: "fas_auth_context_resolver",
    });
    const lifecycle = new PostgresActiveContextSelectionLifecycle({
      pool: lifecyclePool,
      expectedRole: ROLE.lifecycleExecutor,
      environmentId: ENVIRONMENT,
      cellId: CELL,
      idempotencySecret: Buffer.alloc(32, 0x5a),
      nextUuidV7: nextUuidV7Factory(),
    });
    const issueGateway = (tokenTtlMs = 60_000) =>
      issueActiveContextForHttpSession({
        request: request(),
        trustedOrigins: [TRUSTED_ORIGIN],
        sessionRepository,
        rateLimiter,
        issuance: {
          repository: contextRepository,
          audience: AUDIENCE,
          environmentId: ENVIRONMENT,
          cellId: CELL,
          issuerId: ID.issuer,
          keyId: KEY_ID,
          keyReference: KEY_REFERENCE,
          keyRing: [verificationKey()],
          signer: signer(),
          nextUuidV7: () => ID.context,
        },
        tokenTtlMs,
        now: () => NOW,
      });
    const result = await issueGateway();
    if (!result.ok) {
      const debugState = await sessionRepository.withLockedCurrentSession(
        {
          sessionId: SID,
          sessionFingerprint: fingerprint(SID),
          observedAt: NOW,
        },
        async (state) => JSON.stringify(state),
      );
      console.error(`[gateway-debug-state] ${debugState}`);
    }
    assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result));
    if (!result.ok) throw new Error(`gateway_denied_${result.reason}`);
    assert.equal(result.rateLimitPermitId.length, 36);

    await withClient(sessionResolverUrl, async (resolver) => {
      await mustFail(
        () => resolver.query("SELECT * FROM public.sessions"),
        /permission denied/,
      );
      await mustFail(
        () => resolver.query("SELECT * FROM public.active_session_context_selections"),
        /permission denied/,
      );
      await mustFail(
        () => resolver.query(
          "SELECT fas_session_v1.resolve_session_for_active_context($1,$2,$3)",
          [SID, fingerprint(SID), NOW],
        ),
        /serializable transaction/,
      );
      await mustFail(
        () => resolver.query(
          "SELECT fas_rate_limit_v1.consume_active_context_issuance($1,$2,$3,$4,$5,$6,$7)",
          [ID.tenant, "0".repeat(64), fingerprint(SID), 1, ID.principal, NOW, ID.context],
        ),
        /permission denied/,
      );
      await mustFail(
        () => resolver.query(
          `SELECT fas_session_lifecycle_v1.apply_self_selection_command(
             $1,$2,'SELECT',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
           )`,
          [
            SID,
            fingerprint(SID),
            ID.tenant,
            ID.membership,
            ID.selection,
            1,
            "0".repeat(64),
            "1".repeat(64),
            ID.context,
            ID.otherSelection,
            ENVIRONMENT,
            CELL,
            NOW,
          ],
        ),
        /permission denied/,
      );
    });
    await withClient(rateLimitUrl, async (executor) => {
      await mustFail(
        () => executor.query("SELECT * FROM public.active_context_issuance_rate_limits"),
        /permission denied/,
      );
      await mustFail(
        () => executor.query(
          "SELECT fas_rate_limit_v1.consume_active_context_issuance($1,$2,$3,$4,$5,$6,$7)",
          [ID.tenant, "0".repeat(64), fingerprint(SID), 1, ID.principal, NOW, ID.context],
        ),
        /serializable transaction|tenant mismatch/,
      );
      await mustFail(
        () => executor.query(
          "SELECT fas_session_v1.resolve_session_for_active_context($1,$2,$3)",
          [SID, fingerprint(SID), NOW],
        ),
        /permission denied/,
      );
      await mustFail(
        () => executor.query(
          `SELECT fas_session_lifecycle_v1.apply_self_selection_command(
             $1,$2,'SELECT',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
           )`,
          [
            SID,
            fingerprint(SID),
            ID.tenant,
            ID.membership,
            ID.selection,
            1,
            "0".repeat(64),
            "1".repeat(64),
            ID.context,
            ID.otherSelection,
            ENVIRONMENT,
            CELL,
            NOW,
          ],
        ),
        /permission denied/,
      );
    });
    await withClient(lifecycleUrl, async (executor) => {
      await mustFail(
        () => executor.query(
          "SELECT * FROM public.active_session_context_selection_command_receipts",
        ),
        /permission denied/,
      );
      await mustFail(
        () => executor.query(
          "UPDATE public.active_session_context_selections SET row_version = row_version + 1",
        ),
        /permission denied/,
      );
      await mustFail(
        () => executor.query(
          `SELECT fas_session_lifecycle_v1.apply_self_selection_command(
             $1,$2,'SELECT',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13
           )`,
          [
            SID,
            fingerprint(SID),
            ID.tenant,
            ID.membership,
            ID.selection,
            1,
            "0".repeat(64),
            "1".repeat(64),
            ID.context,
            ID.otherSelection,
            ENVIRONMENT,
            CELL,
            Date.now(),
          ],
        ),
        /serializable transaction/,
      );
      await mustFail(
        () => executor.query(
          "SELECT fas_session_v1.resolve_session_for_active_context($1,$2,$3)",
          [SID, fingerprint(SID), NOW],
        ),
        /permission denied/,
      );
      await mustFail(
        () => executor.query(
          "SELECT fas_rate_limit_v1.consume_active_context_issuance($1,$2,$3,$4,$5,$6,$7)",
          [ID.tenant, "0".repeat(64), fingerprint(SID), 1, ID.principal, NOW, ID.context],
        ),
        /permission denied/,
      );
      const invalidLifecycleInputs: unknown[][] = [
        [
          SID,
          fingerprint(SID),
          null,
          ID.tenant,
          ID.membership,
          ID.selection,
          1,
          "0".repeat(64),
          "1".repeat(64),
          ID.context,
          ID.otherSelection,
          ENVIRONMENT,
          CELL,
          NOW,
        ],
        [
          SID,
          fingerprint(SID),
          "SELECT",
          ID.tenant,
          ID.membership,
          ID.selection,
          1,
          "0".repeat(64),
          "1".repeat(64),
          ID.context,
          ID.otherSelection,
          null,
          CELL,
          NOW,
        ],
        [
          SID,
          fingerprint(SID),
          "SELECT",
          ID.tenant,
          ID.membership,
          ID.selection,
          1,
          "0".repeat(64),
          "1".repeat(64),
          ID.context,
          ID.otherSelection,
          ENVIRONMENT,
          null,
          NOW,
        ],
      ];
      for (const values of invalidLifecycleInputs) {
        await executor.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        try {
          await mustFail(
            () => executor.query(
              `SELECT fas_session_lifecycle_v1.apply_self_selection_command(
                 $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14
               )`,
              values,
            ),
            /input is invalid/,
          );
        } finally {
          await executor.query("ROLLBACK");
        }
      }
    });
    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        const otherTenant = "018f3000-0000-7000-8000-000000000101";
        await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [otherTenant]);
        await mustFail(
          () => migrator.query(
            `INSERT INTO public.active_session_context_selections (
               id, tenant_id, session_fingerprint, session_generation,
               legacy_user_id, principal_id, membership_id, status
             ) VALUES ($1, $2, $3, 1, $4, $5, $6, 'ACTIVE')`,
            [
              ID.otherSelection,
              otherTenant,
              fingerprint(OTHER_SID),
              USER_ID,
              ID.principal,
              ID.membership,
            ],
          ),
          /foreign key constraint/,
        );
      } finally {
        await migrator.query("ROLLBACK");
      }
    });

    const missing = await sessionRepository.withLockedCurrentSession(
      {
        sessionId: OTHER_SID,
        sessionFingerprint: fingerprint(OTHER_SID),
        observedAt: NOW,
      },
      async (state) => JSON.stringify(state),
    );
    assert.equal(missing, "null");
    await mustFail(
      () => sessionRepository.withLockedCurrentSession(
        { sessionId: SID, sessionFingerprint: fingerprint(OTHER_SID), observedAt: NOW },
        async () => "must-not-run",
      ),
      /repository_input_invalid/,
    );

    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("UPDATE public.users SET is_active = false WHERE id = $1", [USER_ID]);
    });
    const inactive = await issueGateway();
    assert.deepEqual(inactive, { ok: false, reason: "account_inactive" });
    await withClient(migratorUrl, (migrator) =>
      migrator.query("UPDATE public.users SET is_active = true WHERE id = $1", [USER_ID]),
    );

    await withClient(migratorUrl, (migrator) =>
      migrator.query(
        "UPDATE public.sessions SET expire = to_timestamp($1::bigint / 1000.0) AT TIME ZONE 'UTC' WHERE sid = $2",
        [NOW - 1, SID],
      ),
    );
    assert.deepEqual(await issueGateway(), { ok: false, reason: "session_expired" });
    await withClient(migratorUrl, (migrator) =>
      migrator.query(
        "UPDATE public.sessions SET expire = to_timestamp($1::bigint / 1000.0) AT TIME ZONE 'UTC' WHERE sid = $2",
        [SESSION_IDLE_EXPIRES_AT, SID],
      ),
    );

    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenant]);
        await migrator.query("DELETE FROM public.active_context_issuance_permits WHERE tenant_id = $1", [ID.tenant]);
        await migrator.query("DELETE FROM public.active_context_issuance_rate_limits WHERE tenant_id = $1", [ID.tenant]);
        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });
    const input: ActiveContextRateLimitInput = {
      operation: "ACTIVE_CONTEXT_ISSUE",
      sessionFingerprint: fingerprint(SID),
      sessionGeneration: SESSION_GENERATION,
      authenticatedPrincipalId: ID.principal,
      tenantId: ID.tenant,
      subjectHash: subjectHash({
        sessionFingerprint: fingerprint(SID),
        sessionGeneration: SESSION_GENERATION,
        principalId: ID.principal,
        tenantId: ID.tenant,
      }),
      observedAt: NOW,
    };
    const concurrent = await Promise.allSettled(
      Array.from({ length: 8 }, () => rateLimiter.consume(input)),
    );
    const allowed = concurrent.filter(
      (entry) => entry.status === "fulfilled" &&
        (entry.value as { allowed?: unknown }).allowed === true,
    ).length;
    assert.ok(allowed >= 1 && allowed <= 5);
    assert.equal(concurrent.length, 8);
    const persisted = await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenant]);
        const rows = await migrator.query<{ permits: number; count: number }>(
          `SELECT
             (SELECT count(*)::int FROM public.active_context_issuance_permits
              WHERE tenant_id = $1 AND subject_hash = $2) AS permits,
             (SELECT request_count::int FROM public.active_context_issuance_rate_limits
              WHERE tenant_id = $1 AND subject_hash = $2) AS count`,
          [ID.tenant, input.subjectHash],
        );
        await migrator.query("ROLLBACK");
        return rows.rows[0];
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });
    assert.equal(persisted?.permits, allowed);
    assert.ok((persisted?.count ?? 0) >= allowed && (persisted?.count ?? 0) <= 8);

    let resolvePid: (pid: number) => void = () => undefined;
    const pidReady = new Promise<number>((resolve) => { resolvePid = resolve; });
    const cancellationRepository = new PostgresActiveContextSessionRepository({
      pool: cancellationPool({ pool: sessionPool, ready: resolvePid }),
      expectedRole: ROLE.sessionResolver,
    });
    const cancelledOperation = cancellationRepository.withLockedCurrentSession(
      { sessionId: SID, sessionFingerprint: fingerprint(SID), observedAt: NOW },
      async () => "must-not-complete",
    );
    const cancelledOutcome = cancelledOperation.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const pid = await within(pidReady, 10_000);
    await withClient(adminUrl, async (admin) => {
      const cancelled = await admin.query<{ cancelled: boolean }>(
        "SELECT pg_cancel_backend($1)::boolean AS cancelled",
        [pid],
      );
      assert.equal(cancelled.rows[0]?.cancelled, true);
    });
    const outcome = await cancelledOutcome;
    assert.equal(outcome.kind, "rejected");
    if (outcome.kind === "rejected") {
      assert.equal((outcome.error as Error & { code?: string }).code, "57014");
    }
    const reused = await sessionPool.connect();
    try {
      const clean = await reused.query<{
        pid: number;
        tenant_setting: string | null;
      }>(
        `SELECT pg_backend_pid()::int AS pid,
                nullif(current_setting('app.tenant_id', true), '') AS tenant_setting`,
      );
      assert.equal(clean.rows[0]?.pid, pid);
      assert.equal(clean.rows[0]?.tenant_setting, null);
    } finally {
      reused.release();
    }

    await mustFail(
      () => rateLimiter.consume({ ...input, subjectHash: "0".repeat(64) }),
      /subject mismatch/,
    );

    const unchangedCommand = {
      type: "SELECT" as const,
      targetTenantId: ID.tenant,
      targetMembershipId: ID.membership,
      expectedSelectionId: ID.selection,
      expectedGeneration: 1,
    };
    assert.throws(
      () => new PostgresActiveContextSelectionLifecycle({
        pool: lifecyclePool,
        expectedRole: ROLE.lifecycleExecutor,
        environmentId: ENVIRONMENT,
        cellId: CELL,
        idempotencySecret: Buffer.alloc(31, 0x5a),
      }),
      /configuration_invalid/,
    );
    let poisonedRelease: Error | boolean | undefined;
    const poisonedLifecycle = new PostgresActiveContextSelectionLifecycle({
      pool: poisonedLifecyclePool({
        pool: lifecyclePool,
        onRelease: (error) => {
          poisonedRelease = error;
        },
      }),
      expectedRole: ROLE.lifecycleExecutor,
      environmentId: ENVIRONMENT,
      cellId: CELL,
      idempotencySecret: Buffer.alloc(32, 0x5a),
      nextUuidV7: nextUuidV7Factory(),
    });
    await mustFail(
      () => poisonedLifecycle.execute({
        sessionId: SID,
        idempotencyKey: "lifecycle-poisoned-0000",
        command: unchangedCommand,
      }),
      /identity_invalid/,
    );
    assert.ok(poisonedRelease instanceof Error);
    await mustFail(
      () => lifecycle.execute({
        sessionId: SID,
        idempotencyKey: "lifecycle-invalid-top-0000",
        command: unchangedCommand,
        injectedTenantId: ID.tenant,
      } as Parameters<typeof lifecycle.execute>[0]),
      /input_invalid/,
    );
    await mustFail(
      () => lifecycle.execute({
        sessionId: SID,
        idempotencyKey: "lifecycle-invalid-command-0000",
        command: { ...unchangedCommand, actorPrincipalId: ID.principal },
      }),
      /command_invalid/,
    );
    await withClient(migratorUrl, (migrator) =>
      migrator.query(
        "UPDATE public.sessions SET sess = sess - 'issued_at' WHERE sid = $1",
        [SID],
      ),
    );
    await mustFail(
      () => lifecycle.execute({
        sessionId: SID,
        idempotencyKey: "lifecycle-invalid-session-0000",
        command: unchangedCommand,
      }),
      /session invalid|session inactive/,
    );
    await withClient(migratorUrl, (migrator) =>
      migrator.query(
        `UPDATE public.sessions
         SET sess = jsonb_set(sess, '{issued_at}', to_jsonb($1::bigint), true)
         WHERE sid = $2`,
        [SESSION_ISSUED_AT, SID],
      ),
    );
    await mustFail(
      () => lifecycle.execute({
        sessionId: IMPERSONATED_SID,
        idempotencyKey: "lifecycle-impersonation-0000",
        command: {
          type: "SELECT",
          targetTenantId: ID.tenant,
          targetMembershipId: ID.membership,
          expectedSelectionId: ID.impersonatedSelection,
          expectedGeneration: 1,
        },
      }),
      /impersonation denied/,
    );
    const createCommand = {
      type: "SELECT" as const,
      targetTenantId: ID.tenant,
      targetMembershipId: ID.membership,
      expectedSelectionId: null,
      expectedGeneration: 0,
    };
    const [createA, createB] = await Promise.all([
      lifecycle.execute({
        sessionId: OTHER_SID,
        idempotencyKey: "lifecycle-create-0001",
        command: createCommand,
      }),
      lifecycle.execute({
        sessionId: OTHER_SID,
        idempotencyKey: "lifecycle-create-0001",
        command: createCommand,
      }),
    ]);
    assert.equal(createA.outcome, "SELECTED");
    assert.equal(createB.outcome, "SELECTED");
    assert.equal(createA.selectionId, createB.selectionId);
    assert.equal(createA.sessionGeneration, 1);
    assert.equal(createB.sessionGeneration, 1);
    assert.equal([createA.replayed, createB.replayed].filter(Boolean).length, 1);
    const createdSelectionId = createA.selectionId;
    const createdRevoke = await lifecycle.execute({
      sessionId: OTHER_SID,
      idempotencyKey: "lifecycle-create-revoke-0002",
      command: {
        type: "REVOKE",
        expectedSelectionId: createdSelectionId,
        expectedGeneration: 1,
      },
    });
    assert.equal(createdRevoke.outcome, "REVOKED");
    const unchanged = await lifecycle.execute({
      sessionId: SID,
      idempotencyKey: "lifecycle-unchanged-0001",
      command: unchangedCommand,
    });
    assert.equal(unchanged.outcome, "UNCHANGED");
    assert.equal(unchanged.selectionId, ID.selection);
    assert.equal(unchanged.sessionGeneration, 1);
    assert.equal(unchanged.replayed, false);
    const unchangedReplay = await lifecycle.execute({
      sessionId: SID,
      idempotencyKey: "lifecycle-unchanged-0001",
      command: unchangedCommand,
    });
    assert.deepEqual(
      { ...unchangedReplay, replayed: false },
      unchanged,
    );
    assert.equal(unchangedReplay.replayed, true);
    const precommitRetryLifecycle = new PostgresActiveContextSelectionLifecycle({
      pool: failBeforeCommit(lifecyclePool),
      expectedRole: ROLE.lifecycleExecutor,
      environmentId: ENVIRONMENT,
      cellId: CELL,
      idempotencySecret: Buffer.alloc(32, 0x5a),
      nextUuidV7: nextUuidV7Factory(),
    });
    const precommitRetried = await precommitRetryLifecycle.execute({
      sessionId: SID,
      idempotencyKey: "lifecycle-precommit-0002",
      command: unchangedCommand,
    });
    assert.equal(precommitRetried.outcome, "UNCHANGED");
    assert.equal(precommitRetried.replayed, false);
    const acknowledgedLossLifecycle = new PostgresActiveContextSelectionLifecycle({
      pool: loseCommitAcknowledgements(lifecyclePool, 1),
      expectedRole: ROLE.lifecycleExecutor,
      environmentId: ENVIRONMENT,
      cellId: CELL,
      idempotencySecret: Buffer.alloc(32, 0x5a),
      nextUuidV7: nextUuidV7Factory(),
    });
    const acknowledgementReconciled = await acknowledgedLossLifecycle.execute({
      sessionId: SID,
      idempotencyKey: "lifecycle-ack-loss-0003",
      command: unchangedCommand,
    });
    assert.equal(acknowledgementReconciled.outcome, "UNCHANGED");
    assert.equal(acknowledgementReconciled.replayed, true);
    const ambiguousLifecycle = new PostgresActiveContextSelectionLifecycle({
      pool: loseCommitAcknowledgements(lifecyclePool, 2),
      expectedRole: ROLE.lifecycleExecutor,
      environmentId: ENVIRONMENT,
      cellId: CELL,
      idempotencySecret: Buffer.alloc(32, 0x5a),
      nextUuidV7: nextUuidV7Factory(),
    });
    let unknownOutcome: ActiveContextSelectionCommitOutcomeUnknownError | undefined;
    try {
      await ambiguousLifecycle.execute({
        sessionId: SID,
        idempotencyKey: "lifecycle-ambiguous-0004",
        command: unchangedCommand,
      });
      assert.fail("two lost commit acknowledgements must remain explicitly unknown");
    } catch (error) {
      assert.ok(error instanceof ActiveContextSelectionCommitOutcomeUnknownError);
      unknownOutcome = error;
    }
    const reconciled = await lifecycle.execute({
      sessionId: SID,
      idempotencyKey: "lifecycle-ambiguous-0004",
      command: unchangedCommand,
    });
    assert.equal(reconciled.replayed, true);
    assert.equal(reconciled.commandId, unknownOutcome?.commandId);
    assert.equal(reconciled.requestHash, unknownOutcome?.requestHash);
    let resolveLifecyclePid: (pid: number) => void = () => undefined;
    const lifecyclePidReady = new Promise<number>((resolve) => {
      resolveLifecyclePid = resolve;
    });
    const cancellableLifecycle = new PostgresActiveContextSelectionLifecycle({
      pool: lifecycleCancellationPool({
        pool: lifecyclePool,
        ready: resolveLifecyclePid,
      }),
      expectedRole: ROLE.lifecycleExecutor,
      environmentId: ENVIRONMENT,
      cellId: CELL,
      idempotencySecret: Buffer.alloc(32, 0x5a),
      nextUuidV7: nextUuidV7Factory(),
    });
    const cancelledLifecycle = cancellableLifecycle.execute({
      sessionId: SID,
      idempotencyKey: "lifecycle-cancel-0005",
      command: unchangedCommand,
    });
    const cancelledLifecycleOutcome = cancelledLifecycle.then(
      (value) => ({ kind: "resolved" as const, value }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    const lifecyclePid = await within(lifecyclePidReady, 10_000);
    await withClient(adminUrl, async (admin) => {
      const cancelled = await admin.query<{ cancelled: boolean }>(
        "SELECT pg_cancel_backend($1)::boolean AS cancelled",
        [lifecyclePid],
      );
      assert.equal(cancelled.rows[0]?.cancelled, true);
    });
    const cancelledLifecycleResult = await cancelledLifecycleOutcome;
    assert.equal(cancelledLifecycleResult.kind, "rejected");
    if (cancelledLifecycleResult.kind === "rejected") {
      assert.equal(
        (cancelledLifecycleResult.error as Error & { code?: string }).code,
        "57014",
      );
    }
    await mustFail(
      () => lifecycle.execute({
        sessionId: SID,
        idempotencyKey: "lifecycle-unchanged-0001",
        command: {
          ...unchangedCommand,
          targetMembershipId: ID.membershipTwo,
        },
      }),
      /idempotency conflict/,
    );

    let releaseSessionLock: () => void = () => undefined;
    let markSessionLocked: () => void = () => undefined;
    const sessionLocked = new Promise<void>((resolve) => { markSessionLocked = resolve; });
    const releaseSession = new Promise<void>((resolve) => { releaseSessionLock = resolve; });
    const heldSession = sessionRepository.withLockedCurrentSession(
      { sessionId: SID, sessionFingerprint: fingerprint(SID), observedAt: Date.now() },
      async (state) => {
        assert.equal((state as { status?: unknown }).status, "ACTIVE");
        markSessionLocked();
        await releaseSession;
        return "session-lock-held";
      },
    );
    await within(sessionLocked, 10_000);
    let rotationSettled = false;
    const rotation = lifecycle.execute({
      sessionId: SID,
      idempotencyKey: "lifecycle-rotate-0002",
      command: {
        type: "SELECT",
        targetTenantId: ID.tenant,
        targetMembershipId: ID.membershipTwo,
        expectedSelectionId: ID.selection,
        expectedGeneration: 1,
      },
    }).finally(() => { rotationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(rotationSettled, false, "selection rotation must wait for issuance lock");
    releaseSessionLock();
    assert.equal(await heldSession, "session-lock-held");
    const rotated = await rotation;
    assert.equal(rotated.outcome, "SELECTED");
    assert.equal(rotated.membershipId, ID.membershipTwo);
    assert.equal(rotated.sessionGeneration, 2);

    await mustFail(
      () => lifecycle.execute({
        sessionId: SID,
        idempotencyKey: "lifecycle-cross-tenant-0003",
        command: {
          type: "SELECT",
          targetTenantId: "018f3000-0000-7000-8000-000000000101",
          targetMembershipId: "018f3000-0000-7000-8000-000000000104",
          expectedSelectionId: rotated.selectionId,
          expectedGeneration: 2,
        },
      }),
      /cross tenant switch denied/,
    );
    await mustFail(
      () => lifecycle.execute({
        sessionId: SID,
        idempotencyKey: "lifecycle-stale-0004",
        command: unchangedCommand,
      }),
      /stale expectation/,
    );

    const concurrentRotation = await Promise.allSettled([
      lifecycle.execute({
        sessionId: SID,
        idempotencyKey: "lifecycle-race-a-0005",
        command: {
          type: "SELECT",
          targetTenantId: ID.tenant,
          targetMembershipId: ID.membership,
          expectedSelectionId: rotated.selectionId,
          expectedGeneration: 2,
        },
      }),
      lifecycle.execute({
        sessionId: SID,
        idempotencyKey: "lifecycle-race-b-0006",
        command: {
          type: "SELECT",
          targetTenantId: ID.tenant,
          targetMembershipId: ID.membership,
          expectedSelectionId: rotated.selectionId,
          expectedGeneration: 2,
        },
      }),
    ]);
    const rotationWinners = concurrentRotation.filter(
      (entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof lifecycle.execute>>> =>
        entry.status === "fulfilled",
    );
    const rotationLosers = concurrentRotation.filter((entry) => entry.status === "rejected");
    assert.equal(rotationWinners.length, 1);
    assert.equal(rotationLosers.length, 1);
    assert.equal(rotationWinners[0]?.value.outcome, "SELECTED");
    assert.equal(rotationWinners[0]?.value.sessionGeneration, 3);
    assert.match(String((rotationLosers[0] as PromiseRejectedResult).reason), /stale expectation/);
    const current = rotationWinners[0]!.value;

    const revoked = await lifecycle.execute({
      sessionId: SID,
      idempotencyKey: "lifecycle-revoke-0007",
      command: {
        type: "REVOKE",
        expectedSelectionId: current.selectionId,
        expectedGeneration: current.sessionGeneration,
      },
    });
    assert.equal(revoked.outcome, "REVOKED");
    assert.equal(revoked.selectionId, current.selectionId);
    assert.equal(revoked.sessionGeneration, 3);
    const revokedReplay = await lifecycle.execute({
      sessionId: SID,
      idempotencyKey: "lifecycle-revoke-0007",
      command: {
        type: "REVOKE",
        expectedSelectionId: current.selectionId,
        expectedGeneration: current.sessionGeneration,
      },
    });
    assert.equal(revokedReplay.replayed, true);
    assert.equal(revokedReplay.resultHash, revoked.resultHash);

    await withClient(migratorUrl, async (migrator) => {
      for (const statement of [
        `UPDATE public.active_session_context_selections
         SET status = 'ACTIVE', revoked_at = NULL, termination_reason = NULL,
             row_version = row_version + 1
         WHERE tenant_id = $1 AND id = $2`,
        `DELETE FROM public.active_session_context_selections
         WHERE tenant_id = $1 AND id = $2`,
      ]) {
        await migrator.query("BEGIN");
        try {
          await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenant]);
          await mustFail(
            () => migrator.query(statement, [ID.tenant, current.selectionId]),
            /terminal transition is invalid|append-only/,
          );
        } finally {
          await migrator.query("ROLLBACK");
        }
      }
      await migrator.query("BEGIN");
      try {
        await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenant]);
        await mustFail(
          () => migrator.query(
            `UPDATE public.active_session_context_selection_command_receipts
             SET result_hash = $1 WHERE tenant_id = $2`,
            ["f".repeat(64), ID.tenant],
          ),
          /receipts are immutable/,
        );
      } finally {
        await migrator.query("ROLLBACK");
      }
    });

    const lifecycleEvidence = await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenant]);
        const evidence = await migrator.query<{
          active_count: number;
          receipt_count: number;
          generations: number[];
          states: Array<{
            generation: number;
            previousSelectionId: string | null;
            rowVersion: number;
            status: string;
            terminationReason: string | null;
          }>;
          persisted: string;
        }>(
          `SELECT
             (SELECT count(*)::int FROM public.active_session_context_selections
              WHERE session_fingerprint = $1 AND status = 'ACTIVE') AS active_count,
             (SELECT count(*)::int FROM public.active_session_context_selection_command_receipts
              WHERE session_fingerprint = $1) AS receipt_count,
             (SELECT array_agg(session_generation::int ORDER BY session_generation)
              FROM public.active_session_context_selections
              WHERE session_fingerprint = $1) AS generations,
             (SELECT jsonb_agg(jsonb_build_object(
                'generation', session_generation::int,
                'previousSelectionId', previous_selection_id,
                'rowVersion', row_version::int,
                'status', status,
                'terminationReason', termination_reason
              ) ORDER BY session_generation)
              FROM public.active_session_context_selections
              WHERE session_fingerprint = $1) AS states,
             (SELECT coalesce(string_agg(row_to_json(receipt)::text, ''), '')
              FROM public.active_session_context_selection_command_receipts receipt
              WHERE session_fingerprint = $1) AS persisted`,
          [fingerprint(SID)],
        );
        await migrator.query("ROLLBACK");
        return evidence.rows[0]!;
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });
    assert.equal(lifecycleEvidence.active_count, 0);
    assert.equal(lifecycleEvidence.receipt_count, 7);
    assert.deepEqual(lifecycleEvidence.generations, [1, 2, 3]);
    assert.deepEqual(lifecycleEvidence.states, [
      {
        generation: 1,
        previousSelectionId: null,
        rowVersion: 2,
        status: "ROTATED",
        terminationReason: "SELF_SWITCH",
      },
      {
        generation: 2,
        previousSelectionId: ID.selection,
        rowVersion: 2,
        status: "ROTATED",
        terminationReason: "SELF_SWITCH",
      },
      {
        generation: 3,
        previousSelectionId: rotated.selectionId,
        rowVersion: 2,
        status: "REVOKED",
        terminationReason: "SELF_REVOKE",
      },
    ]);
    assert.equal(lifecycleEvidence.persisted.includes(SID), false);
    for (const rawKey of [
      "lifecycle-unchanged-0001",
      "lifecycle-precommit-0002",
      "lifecycle-ack-loss-0003",
      "lifecycle-ambiguous-0004",
      "lifecycle-cancel-0005",
      "lifecycle-rotate-0002",
      "lifecycle-race-a-0005",
      "lifecycle-race-b-0006",
      "lifecycle-revoke-0007",
    ]) {
      assert.equal(lifecycleEvidence.persisted.includes(rawKey), false);
    }
    const lifecycleReused = await lifecyclePool.connect();
    try {
      const clean = await lifecycleReused.query<{
        current_user: string;
        tenant_setting: string | null;
      }>(
        `SELECT current_user,
                nullif(current_setting('app.tenant_id', true), '') AS tenant_setting`,
      );
      assert.equal(clean.rows[0]?.current_user, ROLE.lifecycleExecutor);
      assert.equal(clean.rows[0]?.tenant_setting, null);
    } finally {
      lifecycleReused.release();
    }
  } finally {
    await Promise.all([
      sessionPool.end(),
      ratePool.end(),
      lifecyclePool.end(),
      contextPool.end(),
    ]);
  }
  console.log(
    "[postgres-session-gateway] PASS: EXECUTE-only server session selection, HMAC-idempotent lifecycle receipts, immutable terminal generations, durable rate permits, concurrency bounds, SQLSTATE 57014 rollback and pool cleanup",
  );
}

await main();
