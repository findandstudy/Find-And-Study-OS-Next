import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  fingerprintActiveContextPublicKey,
  verifyVersionedActiveTenantContext,
  type ActiveContextExternalSigner,
  type ActiveContextVerificationKey,
} from "../src/lib/activeTenantContext.js";
import {
  ACTIVE_CONTEXT_SESSION_GATEWAY_PATH,
  issueActiveContextForHttpSession,
  type ActiveContextIssuanceRateLimiter,
  type ActiveContextRateLimitInput,
  type ActiveContextSessionGatewayOptions,
  type ActiveContextSessionRepository,
  type ActiveContextSessionState,
} from "../src/lib/activeContextSessionGateway.js";
import type {
  AuthoritativeActiveContextRepository,
  AuthoritativeActiveContextState,
} from "../src/lib/authoritativeActiveContextIssuance.js";
import { ABSOLUTE_SESSION_TTL } from "../src/lib/sessionLifetime.js";

const NOW = 2_000_000_000_000;
const SID = "a".repeat(64);
const OTHER_SID = "b".repeat(64);
const CSRF = "c".repeat(64);
const TRUSTED_ORIGIN = "https://apply.findandstudy.test";
const ID = {
  context: "018fb000-0000-7000-8000-000000000001",
  tenant: "018fb000-0000-7000-8000-000000000002",
  otherTenant: "018fb000-0000-7000-8000-000000000003",
  organization: "018fb000-0000-7000-8000-000000000004",
  principal: "018fb000-0000-7000-8000-000000000005",
  otherPrincipal: "018fb000-0000-7000-8000-000000000006",
  membership: "018fb000-0000-7000-8000-000000000007",
  selection: "018fb000-0000-7000-8000-00000000000c",
  assignment: "018fb000-0000-7000-8000-000000000008",
  policy: "018fb000-0000-7000-8000-000000000009",
  issuer: "018fb000-0000-7000-8000-00000000000a",
  permit: "018fb000-0000-7000-8000-00000000000b",
};
const AUDIENCE = "fas.change-set.request";
const ENVIRONMENT = "test";
const CELL = "cell-a";
const KEY_ID = "active-context-authority-a";
const KEY_REFERENCE = "test-memory://active-context/authority-a";
const pair = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = pair.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

function fingerprint(sid = SID) {
  return crypto.createHash("sha256").update(sid, "ascii").digest("hex");
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
    signUntil: NOW + 60_000,
    verifyUntil: NOW + 120_000,
  };
}

function request(overrides: Record<string, unknown> = {}) {
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
      authenticatedPrincipalId: ID.otherPrincipal,
      tenantId: ID.otherTenant,
      organizationId: null,
      legacyBranchId: null,
    },
    query: { tenantId: ID.otherTenant },
    ...overrides,
  };
}

function sessionState(
  overrides: Partial<ActiveContextSessionState> = {},
): ActiveContextSessionState {
  const issuedAt = NOW - 60_000;
  return {
    selectionId: ID.selection,
    sessionFingerprint: fingerprint(),
    sessionGeneration: 4,
    status: "ACTIVE",
    accountStatus: "ACTIVE",
    authenticatedPrincipalId: ID.principal,
    tenantId: ID.tenant,
    organizationId: ID.organization,
    legacyBranchId: 41,
    issuedAt,
    idleExpiresAt: NOW + 30_000,
    absoluteExpiresAt: issuedAt + ABSOLUTE_SESSION_TTL,
    impersonatorPrincipalId: null,
    originalSessionFingerprint: null,
    ...overrides,
  };
}

function authoritativeState(
  overrides: {
    tenant?: Partial<AuthoritativeActiveContextState["tenant"]>;
    principal?: Partial<AuthoritativeActiveContextState["principal"]>;
    membership?: Partial<AuthoritativeActiveContextState["membership"]>;
  } = {},
): AuthoritativeActiveContextState {
  return {
    tenant: {
      id: ID.tenant,
      status: "ACTIVE",
      policyVersion: 3,
      ...overrides.tenant,
    },
    principal: {
      id: ID.principal,
      principalType: "HUMAN",
      status: "ACTIVE",
      riskState: "NORMAL",
      ...overrides.principal,
    },
    membership: {
      id: ID.membership,
      tenantId: ID.tenant,
      organizationId: ID.organization,
      legacyBranchId: 41,
      principalId: ID.principal,
      status: "ACTIVE",
      validFrom: NOW - 60_000,
      validUntil: NOW + 60_000,
      ...overrides.membership,
    },
    policy: {
      id: ID.policy,
      tenantId: ID.tenant,
      version: 3,
      state: "ACTIVE",
      effectiveAt: NOW - 60_000,
      revokedAt: null,
    },
    assignments: [
      {
        id: ID.assignment,
        tenantId: ID.tenant,
        membershipId: ID.membership,
        status: "ACTIVE",
        validFrom: NOW - 60_000,
        validUntil: NOW + 60_000,
      },
    ],
  };
}

class FakeSessionRepository implements ActiveContextSessionRepository {
  calls = 0;
  locked = false;

  constructor(public currentState: unknown = sessionState()) {}

  async withLockedCurrentSession(
    input: Parameters<ActiveContextSessionRepository["withLockedCurrentSession"]>[0],
    operation: Parameters<ActiveContextSessionRepository["withLockedCurrentSession"]>[1],
  ) {
    this.calls += 1;
    assert.equal(input.sessionId, SID);
    assert.equal(input.sessionFingerprint, fingerprint());
    assert.equal(input.observedAt, NOW);
    this.locked = true;
    try {
      return await operation(structuredClone(this.currentState));
    } finally {
      this.locked = false;
    }
  }
}

class FakeRateLimiter implements ActiveContextIssuanceRateLimiter {
  calls: ActiveContextRateLimitInput[] = [];
  constructor(
    readonly responder: (input: ActiveContextRateLimitInput) => unknown =
      (input) => ({
        allowed: true,
        permitId: ID.permit,
        subjectHash: input.subjectHash,
        issuedAt: input.observedAt,
        expiresAt: input.observedAt + 10_000,
      }),
  ) {}

  async consume(input: ActiveContextRateLimitInput) {
    this.calls.push(structuredClone(input));
    return this.responder(input);
  }
}

function signer(
  counter = { calls: 0 },
  beforeSign: (() => void | Promise<void>) | undefined = undefined,
): ActiveContextExternalSigner {
  return {
    async sign(input) {
      counter.calls += 1;
      assert.equal(input.keyReference, KEY_REFERENCE);
      await beforeSign?.();
      return crypto.sign(null, input.signingInput, pair.privateKey);
    },
  };
}

function options(
  sessionRepository: ActiveContextSessionRepository,
  rateLimiter: ActiveContextIssuanceRateLimiter,
  overrides: Partial<ActiveContextSessionGatewayOptions> = {},
): ActiveContextSessionGatewayOptions {
  const current = authoritativeState();
  const authoritativeRepository: AuthoritativeActiveContextRepository = {
    async withLockedCurrentState(input, operation) {
      assert.equal(input.authenticatedPrincipalId, ID.principal);
      assert.equal(input.tenantId, ID.tenant);
      assert.equal(input.organizationId, ID.organization);
      assert.equal(input.legacyBranchId, 41);
      return operation(structuredClone(current));
    },
  };
  return {
    request: request(),
    trustedOrigins: [TRUSTED_ORIGIN],
    sessionRepository,
    rateLimiter,
    issuance: {
      repository: authoritativeRepository,
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
    tokenTtlMs: 60_000,
    now: () => NOW,
    ...overrides,
  };
}

test("HTTP gateway ignores client scope fields and binds the token to locked server session state", async () => {
  const sessions = new FakeSessionRepository();
  const limiter = new FakeRateLimiter();
  const result = await issueActiveContextForHttpSession(
    options(sessions, limiter),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(sessions.calls, 1);
  assert.equal(limiter.calls.length, 1);
  assert.equal(limiter.calls[0].authenticatedPrincipalId, ID.principal);
  assert.equal(limiter.calls[0].tenantId, ID.tenant);
  assert.equal(limiter.calls[0].sessionGeneration, 4);
  assert.equal(result.expiresAt, NOW + 30_000);
  assert.equal(result.rateLimitPermitId, ID.permit);

  const verified = verifyVersionedActiveTenantContext({
    token: result.token,
    keyRing: [verificationKey()],
    expected: {
      audience: AUDIENCE,
      environmentId: ENVIRONMENT,
      cellId: CELL,
      issuerId: ID.issuer,
      tenantId: ID.tenant,
    },
    expectedSelectionBinding: {
      selectionId: ID.selection,
      sessionGeneration: 4,
    },
    now: NOW,
  });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.context.principalId, ID.principal);
  assert.equal(verified.context.organizationId, ID.organization);
  assert.equal(verified.context.legacyBranchId, 41);
  assert.equal(verified.context.tokenVersion, 2);
  assert.equal(verified.context.selectionId, ID.selection);
  assert.equal(verified.context.sessionGeneration, 4);
});

test("method, path, bearer auth, origin, referer, cookie, and CSRF violations fail before session access", async () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["method", { method: "GET" }, "http_request_invalid"],
    ["path", { path: "/api/active-context/issue" }, "http_request_invalid"],
    ["api token", { apiTokenAuth: true }, "http_request_invalid"],
    [
      "authorization",
      {
        headers: {
          origin: TRUSTED_ORIGIN,
          "x-csrf-token": CSRF,
          authorization: "Bearer external-token",
        },
      },
      "authorization_header_forbidden",
    ],
    [
      "origin",
      { headers: { origin: "https://evil.example", "x-csrf-token": CSRF } },
      "origin_untrusted",
    ],
    [
      "origin referer mismatch",
      {
        headers: {
          origin: TRUSTED_ORIGIN,
          referer: "https://evil.example/x",
          "x-csrf-token": CSRF,
        },
      },
      "origin_untrusted",
    ],
    [
      "missing origin",
      { headers: { "x-csrf-token": CSRF } },
      "origin_untrusted",
    ],
    ["missing sid", { cookies: { csrf_token: CSRF } }, "http_request_invalid"],
    [
      "duplicate sid",
      {
        headers: {
          origin: TRUSTED_ORIGIN,
          "x-csrf-token": CSRF,
          cookie: `sid=${SID}; sid=${OTHER_SID}; csrf_token=${CSRF}`,
        },
      },
      "http_request_invalid",
    ],
    [
      "csrf mismatch",
      { cookies: { sid: SID, csrf_token: "d".repeat(64) } },
      "csrf_invalid",
    ],
  ];
  for (const [name, override, reason] of cases) {
    const sessions = new FakeSessionRepository();
    const limiter = new FakeRateLimiter();
    const result = await issueActiveContextForHttpSession(
      options(sessions, limiter, { request: request(override) }),
    );
    assert.deepEqual(result, { ok: false, reason }, name);
    assert.equal(sessions.calls, 0, name);
    assert.equal(limiter.calls.length, 0, name);
  }
});

test("missing, malformed, inactive, expired, rotated, cross-session, and impersonated sessions fail closed", async () => {
  const malformed = { ...sessionState(), injected: true };
  const cases: Array<[string, unknown, string]> = [
    ["missing", null, "session_missing"],
    ["malformed", malformed, "session_state_invalid"],
    ["revoked", sessionState({ status: "REVOKED" }), "session_inactive"],
    ["rotated", sessionState({ status: "ROTATED" }), "session_inactive"],
    ["account", sessionState({ accountStatus: "INACTIVE" }), "account_inactive"],
    ["idle expiry", sessionState({ idleExpiresAt: NOW }), "session_expired"],
    [
      "absolute shape",
      sessionState({ absoluteExpiresAt: NOW + ABSOLUTE_SESSION_TTL }),
      "session_state_invalid",
    ],
    [
      "cookie binding",
      sessionState({ sessionFingerprint: fingerprint(OTHER_SID) }),
      "session_scope_invalid",
    ],
    [
      "impersonation",
      sessionState({
        impersonatorPrincipalId: ID.otherPrincipal,
        originalSessionFingerprint: fingerprint(OTHER_SID),
      }),
      "impersonation_forbidden",
    ],
  ];
  for (const [name, current, reason] of cases) {
    const sessions = new FakeSessionRepository(current);
    const limiter = new FakeRateLimiter();
    const signCounter = { calls: 0 };
    const base = options(sessions, limiter);
    const result = await issueActiveContextForHttpSession({
      ...base,
      issuance: { ...base.issuance, signer: signer(signCounter) },
    });
    assert.deepEqual(result, { ok: false, reason }, name);
    assert.equal(limiter.calls.length, 0, name);
    assert.equal(signCounter.calls, 0, name);
  }
});

test("rate-limit denial, outage, malformed permits, and expired permits cannot reach a caller", async () => {
  const denied = await issueActiveContextForHttpSession(
    options(
      new FakeSessionRepository(),
      new FakeRateLimiter(() => ({ allowed: false, retryAfterMs: 2_000 })),
    ),
  );
  assert.deepEqual(denied, {
    ok: false,
    reason: "rate_limited",
    retryAfterMs: 2_000,
  });

  const unavailable: ActiveContextIssuanceRateLimiter = {
    async consume() {
      throw new Error("redis unavailable");
    },
  };
  assert.deepEqual(
    await issueActiveContextForHttpSession(
      options(new FakeSessionRepository(), unavailable),
    ),
    { ok: false, reason: "rate_limiter_unavailable" },
  );

  assert.deepEqual(
    await issueActiveContextForHttpSession(
      options(
        new FakeSessionRepository(),
        new FakeRateLimiter((input) => ({
          allowed: true,
          permitId: ID.permit,
          subjectHash: `${input.subjectHash.slice(0, -1)}${
            input.subjectHash.endsWith("0") ? "1" : "0"
          }`,
          issuedAt: input.observedAt,
          expiresAt: input.observedAt + 10_000,
        })),
      ),
    ),
    { ok: false, reason: "rate_limiter_contract_invalid" },
  );

  let current = NOW;
  const expiringLimiter = new FakeRateLimiter((input) => ({
    allowed: true,
    permitId: ID.permit,
    subjectHash: input.subjectHash,
    issuedAt: input.observedAt,
    expiresAt: input.observedAt + 50,
  }));
  const sessions = new FakeSessionRepository();
  const base = options(sessions, expiringLimiter, { now: () => current });
  const result = await issueActiveContextForHttpSession({
    ...base,
    issuance: {
      ...base.issuance,
      signer: signer(undefined, () => {
        current += 50;
      }),
    },
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "rate_limit_permit_expired",
  });
});

test("authoritative membership denial is preserved without leaking a token", async () => {
  const signCounter = { calls: 0 };
  const authoritativeRepository: AuthoritativeActiveContextRepository = {
    async withLockedCurrentState(_input, operation) {
      return operation(
        authoritativeState({ membership: { status: "REVOKED" } }),
      );
    },
  };
  const sessions = new FakeSessionRepository();
  const limiter = new FakeRateLimiter();
  const base = options(sessions, limiter);
  const result = await issueActiveContextForHttpSession({
    ...base,
    issuance: {
      ...base.issuance,
      repository: authoritativeRepository,
      signer: signer(signCounter),
    },
  });
  assert.deepEqual(result, {
    ok: false,
    reason: "authoritative_context_denied",
    authoritativeReason: "membership_inactive",
  });
  assert.equal(signCounter.calls, 0);
});

test("session lock remains held through rate-limit, resolver, and signing completion", async () => {
  const sessions = new FakeSessionRepository();
  const limiter = new FakeRateLimiter((input) => {
    assert.equal(sessions.locked, true);
    return {
      allowed: true,
      permitId: ID.permit,
      subjectHash: input.subjectHash,
      issuedAt: input.observedAt,
      expiresAt: input.observedAt + 10_000,
    };
  });
  const base = options(sessions, limiter);
  const result = await issueActiveContextForHttpSession({
    ...base,
    issuance: {
      ...base.issuance,
      signer: signer(undefined, () => assert.equal(sessions.locked, true)),
    },
  });
  assert.equal(result.ok, true);
  assert.equal(sessions.locked, false);
});

test("session repository skip, replay, return substitution, and outage fail closed", async () => {
  const limiter = new FakeRateLimiter();
  const skipped: ActiveContextSessionRepository = {
    async withLockedCurrentSession() {
      return "forged-token";
    },
  };
  assert.deepEqual(
    await issueActiveContextForHttpSession(options(skipped, limiter)),
    { ok: false, reason: "session_repository_contract_invalid" },
  );

  const repeated: ActiveContextSessionRepository = {
    async withLockedCurrentSession(_input, operation) {
      await operation(sessionState());
      return operation(sessionState());
    },
  };
  assert.deepEqual(
    await issueActiveContextForHttpSession(
      options(repeated, new FakeRateLimiter()),
    ),
    { ok: false, reason: "session_repository_contract_invalid" },
  );

  const substituted: ActiveContextSessionRepository = {
    async withLockedCurrentSession(_input, operation) {
      await operation(sessionState());
      return "substituted-token";
    },
  };
  assert.deepEqual(
    await issueActiveContextForHttpSession(
      options(substituted, new FakeRateLimiter()),
    ),
    { ok: false, reason: "session_repository_contract_invalid" },
  );

  const unavailable: ActiveContextSessionRepository = {
    async withLockedCurrentSession() {
      throw new Error("session store unavailable");
    },
  };
  assert.deepEqual(
    await issueActiveContextForHttpSession(
      options(unavailable, new FakeRateLimiter()),
    ),
    { ok: false, reason: "session_repository_unavailable" },
  );
});

test("gateway deadline failure discards the permit before resolver access", async () => {
  let current = NOW;
  const sessions = new FakeSessionRepository();
  const limiter = new FakeRateLimiter((input) => {
    current += 8_001;
    return {
      allowed: true,
      permitId: ID.permit,
      subjectHash: input.subjectHash,
      issuedAt: input.observedAt,
      expiresAt: input.observedAt + 10_000,
    };
  });
  const signCounter = { calls: 0 };
  const base = options(sessions, limiter, { now: () => current });
  const result = await issueActiveContextForHttpSession({
    ...base,
    issuance: { ...base.issuance, signer: signer(signCounter) },
  });
  assert.deepEqual(result, { ok: false, reason: "gateway_timeout" });
  assert.equal(signCounter.calls, 0);
});

test("gateway remains absent from every application and route registration module", () => {
  const sourceRoots = [
    path.resolve("src"),
    path.resolve("artifacts/api-server/src"),
  ].filter((candidate) =>
    fs.existsSync(path.join(candidate, "routes")),
  );
  assert.equal(sourceRoots.length, 1, "expected one API source root");
  const sourceRoot = sourceRoots[0];
  const candidates = [
    path.join(sourceRoot, "app.ts"),
    path.join(sourceRoot, "index.ts"),
    ...fs
      .readdirSync(path.join(sourceRoot, "routes"), {
        recursive: true,
        withFileTypes: true,
      })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => path.join(entry.parentPath, entry.name)),
  ];
  for (const candidate of candidates) {
    const source = fs.readFileSync(candidate, "utf8");
    assert.equal(
      source.includes("activeContextSessionGateway") ||
        source.includes("issueActiveContextForHttpSession") ||
        source.includes("postgresActiveContextSelectionLifecycle") ||
        source.includes("PostgresActiveContextSelectionLifecycle"),
      false,
      candidate,
    );
  }
});
