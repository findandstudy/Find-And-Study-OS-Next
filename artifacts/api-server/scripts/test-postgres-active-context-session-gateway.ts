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
const contextResolverUrl = requiredUrl("PG_GATE_CONTEXT_RESOLVER_URL");
const databaseName = new URL(adminUrl).pathname.slice(1);

assert.match(databaseName, /^fas_it_[a-z0-9_]+$/);
for (const value of [
  adminUrl,
  migratorUrl,
  sessionResolverUrl,
  rateLimitUrl,
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
} as const;

const ID = {
  tenant: "018f5000-0000-7000-8000-000000000001",
  principal: "018f5000-0000-7000-8000-000000000002",
  membership: "018f5000-0000-7000-8000-000000000003",
  context: "018fc000-0000-7000-8000-000000000001",
  selection: "018fc000-0000-7000-8000-000000000002",
  otherSelection: "018fc000-0000-7000-8000-000000000003",
  issuer: "018fc000-0000-7000-8000-000000000004",
} as const;

const USER_ID = 910_001;
const SID = "a".repeat(64);
const OTHER_SID = "b".repeat(64);
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
        ${ROLE.sessionResolver}, ${ROLE.rateExecutor};
      GRANT USAGE ON SCHEMA public, fas_session_v1 TO ${ROLE.sessionOwner};
      GRANT USAGE ON SCHEMA public, fas_rate_limit_v1 TO ${ROLE.rateOwner};
      GRANT USAGE ON SCHEMA fas_session_v1 TO ${ROLE.sessionResolver};
      GRANT USAGE ON SCHEMA fas_rate_limit_v1 TO ${ROLE.rateExecutor};

      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM
        ${ROLE.sessionOwner}, ${ROLE.sessionResolver},
        ${ROLE.rateOwner}, ${ROLE.rateExecutor};
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM
        ${ROLE.sessionOwner}, ${ROLE.sessionResolver},
        ${ROLE.rateOwner}, ${ROLE.rateExecutor};

      GRANT SELECT ON TABLE
        public.sessions, public.users, public.principals, public.memberships,
        public.active_session_context_selections
      TO ${ROLE.sessionOwner};
      GRANT SELECT ON TABLE public.active_session_context_selections
      TO ${ROLE.rateOwner};
      GRANT SELECT, INSERT, UPDATE ON TABLE
        public.active_context_issuance_rate_limits
      TO ${ROLE.rateOwner};
      GRANT SELECT, INSERT ON TABLE public.active_context_issuance_permits
      TO ${ROLE.rateOwner};

      ALTER FUNCTION fas_session_v1.resolve_session_for_active_context(text, text, bigint)
        OWNER TO ${ROLE.sessionOwner};
      ALTER FUNCTION fas_rate_limit_v1.consume_active_context_issuance(
        uuid, text, text, bigint, uuid, bigint, uuid
      ) OWNER TO ${ROLE.rateOwner};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_session_v1
        FROM PUBLIC, ${ROLE.sessionResolver};
      REVOKE ALL ON ALL FUNCTIONS IN SCHEMA fas_rate_limit_v1
        FROM PUBLIC, ${ROLE.rateExecutor};
      GRANT EXECUTE ON FUNCTION
        fas_session_v1.resolve_session_for_active_context(text, text, bigint)
      TO ${ROLE.sessionResolver};
      GRANT EXECUTE ON FUNCTION
        fas_rate_limit_v1.consume_active_context_issuance(
          uuid, text, text, bigint, uuid, bigint, uuid
        )
      TO ${ROLE.rateExecutor};
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
      ]],
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
        role.rolname === ROLE.sessionResolver || role.rolname === ROLE.rateExecutor,
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
        `INSERT INTO public.sessions (sid, sess, expire, user_id)
         VALUES (
           $1,
           jsonb_build_object(
             'user', jsonb_build_object('id', $2, 'role', 'staff'),
             'access_token', 'synthetic-test-only',
             'issued_at', $3::bigint
           ),
           to_timestamp($4::bigint / 1000.0) AT TIME ZONE 'UTC',
           $2
         )`,
        [SID, USER_ID, SESSION_ISSUED_AT, SESSION_IDLE_EXPIRES_AT],
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

async function main() {
  await bootstrapAuthority();
  await seed();

  const sessionPool = new Pool({ connectionString: sessionResolverUrl, max: 1 });
  const ratePool = new Pool({ connectionString: rateLimitUrl, max: 8 });
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
    assert.equal(result.ok, true);
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

    let releaseSessionLock: () => void = () => undefined;
    let markSessionLocked: () => void = () => undefined;
    const sessionLocked = new Promise<void>((resolve) => { markSessionLocked = resolve; });
    const releaseSession = new Promise<void>((resolve) => { releaseSessionLock = resolve; });
    const heldSession = sessionRepository.withLockedCurrentSession(
      { sessionId: SID, sessionFingerprint: fingerprint(SID), observedAt: NOW },
      async (state) => {
        assert.equal((state as { status?: unknown }).status, "ACTIVE");
        markSessionLocked();
        await releaseSession;
        return "session-lock-held";
      },
    );
    await within(sessionLocked, 10_000);
    let rotationSettled = false;
    const rotation = withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenant]);
        await migrator.query(
          `UPDATE public.active_session_context_selections
           SET status = 'ROTATED', revoked_at = statement_timestamp(),
               updated_at = statement_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ID.tenant, ID.selection],
        );
        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    }).finally(() => { rotationSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(rotationSettled, false, "selection rotation must wait for issuance lock");
    releaseSessionLock();
    assert.equal(await heldSession, "session-lock-held");
    await rotation;
    const rotated = await sessionRepository.withLockedCurrentSession(
      { sessionId: SID, sessionFingerprint: fingerprint(SID), observedAt: NOW },
      async (state) => JSON.stringify(state),
    );
    assert.equal(JSON.parse(rotated).status, "ROTATED");
    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenant]);
        await migrator.query(
          `UPDATE public.active_session_context_selections
           SET status = 'ACTIVE', revoked_at = NULL, updated_at = statement_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ID.tenant, ID.selection],
        );
        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });

    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenant]);
        await migrator.query(
          `UPDATE public.active_session_context_selections
           SET status = 'REVOKED', revoked_at = statement_timestamp(),
               updated_at = statement_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ID.tenant, ID.selection],
        );
        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });
    const revoked = await sessionRepository.withLockedCurrentSession(
      { sessionId: SID, sessionFingerprint: fingerprint(SID), observedAt: NOW },
      async (state) => JSON.stringify(state),
    );
    assert.equal(JSON.parse(revoked).status, "REVOKED");
    await withClient(migratorUrl, async (migrator) => {
      await migrator.query("BEGIN");
      try {
        await migrator.query("SELECT set_config('app.tenant_id', $1, true)", [ID.tenant]);
        await migrator.query(
          `UPDATE public.active_session_context_selections
           SET status = 'ACTIVE', revoked_at = NULL, updated_at = statement_timestamp()
           WHERE tenant_id = $1 AND id = $2`,
          [ID.tenant, ID.selection],
        );
        await migrator.query("COMMIT");
      } catch (error) {
        await migrator.query("ROLLBACK");
        throw error;
      }
    });

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
  } finally {
    await Promise.all([sessionPool.end(), ratePool.end(), contextPool.end()]);
  }
  console.log(
    "[postgres-session-gateway] PASS: EXECUTE-only server session selection, current account and HUMAN membership binding, durable rate permits, concurrency bounds, SQLSTATE 57014 rollback and pool cleanup",
  );
}

await main();
