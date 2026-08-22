import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  ACTIVE_CONTEXT_V2_ALGORITHM,
  fingerprintActiveContextPublicKey,
  issueVersionedActiveTenantContext,
  signActiveTenantContext,
  verifyVersionedActiveTenantContext,
  type ActiveContextExternalSigner,
  type ActiveContextVerificationKey,
  type ActiveContextVersionedSubject,
} from "../src/lib/activeTenantContext.js";
import { bindChangeSetRequestContext } from "../src/lib/changeSetRequestContext.js";

const NOW = 2_000_000_000_000;
const ID = {
  context: "018fa000-0000-7000-8000-000000000001",
  tenant: "018fa000-0000-7000-8000-000000000002",
  otherTenant: "018fa000-0000-7000-8000-000000000003",
  organization: "018fa000-0000-7000-8000-000000000004",
  principal: "018fa000-0000-7000-8000-000000000005",
  membership: "018fa000-0000-7000-8000-000000000006",
  assignment: "018fa000-0000-7000-8000-000000000007",
  policy: "018fa000-0000-7000-8000-000000000008",
  issuer: "018fa000-0000-7000-8000-000000000009",
  otherIssuer: "018fa000-0000-7000-8000-00000000000a",
};
const AUDIENCE = "fas.change-set.request";
const ENVIRONMENT = "test";
const CELL = "cell-a";
const KEY_ID = "active-context-2026-08-a";
const KEY_REFERENCE = "test-memory://active-context/key-a";
const LEGACY_SECRET = "legacy-active-context-secret-at-least-thirty-two-bytes";

const pair = crypto.generateKeyPairSync("ed25519");
const publicKeyPem = pair.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();

const signer: ActiveContextExternalSigner = {
  async sign(input) {
    assert.equal(input.keyReference, KEY_REFERENCE);
    assert.equal(input.algorithm, ACTIVE_CONTEXT_V2_ALGORITHM);
    return crypto.sign(null, input.signingInput, pair.privateKey);
  },
};

function subject(
  overrides: Partial<ActiveContextVersionedSubject> = {},
): ActiveContextVersionedSubject {
  return {
    contextId: ID.context,
    tenantId: ID.tenant,
    organizationId: ID.organization,
    legacyBranchId: 41,
    principalId: ID.principal,
    membershipId: ID.membership,
    assignmentIds: [ID.assignment],
    policyVersionId: ID.policy,
    policyVersion: 3,
    ...overrides,
  };
}

function key(
  overrides: Partial<ActiveContextVerificationKey> = {},
): ActiveContextVerificationKey {
  return {
    keyId: KEY_ID,
    algorithm: ACTIVE_CONTEXT_V2_ALGORITHM,
    state: "ACTIVE",
    issuerId: ID.issuer,
    environmentId: ENVIRONMENT,
    cellId: CELL,
    publicKeyPem,
    publicKeyFingerprint: fingerprintActiveContextPublicKey(publicKeyPem),
    signFrom: NOW - 60_000,
    signUntil: NOW + 60_000,
    verifyUntil: NOW + 120_000,
    ...overrides,
  };
}

function expected(overrides: Record<string, unknown> = {}) {
  return {
    audience: AUDIENCE,
    environmentId: ENVIRONMENT,
    cellId: CELL,
    issuerId: ID.issuer,
    tenantId: ID.tenant,
    ...overrides,
  };
}

async function issue(overrides: {
  now?: number;
  ttlMs?: number;
  subject?: ActiveContextVersionedSubject;
  keyRing?: readonly ActiveContextVerificationKey[];
  signer?: ActiveContextExternalSigner;
  keyReference?: string;
} = {}) {
  return issueVersionedActiveTenantContext({
    subject: overrides.subject ?? subject(),
    audience: AUDIENCE,
    environmentId: ENVIRONMENT,
    cellId: CELL,
    issuerId: ID.issuer,
    keyId: KEY_ID,
    keyReference: overrides.keyReference ?? KEY_REFERENCE,
    keyRing: overrides.keyRing ?? [key()],
    signer: overrides.signer ?? signer,
    ttlMs: overrides.ttlMs ?? 60_000,
    now: overrides.now ?? NOW,
  });
}

function resign(
  token: string,
  mutateHeader: (header: Record<string, unknown>) => void = () => undefined,
  mutatePayload: (payload: Record<string, unknown>) => void = () => undefined,
) {
  const [headerPart, payloadPart] = token.split(".");
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  mutateHeader(header);
  mutatePayload(payload);
  const nextHeader = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const nextPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signingInput = Buffer.from(
    `fas-active-context-v2\0${nextHeader}.${nextPayload}`,
    "utf8",
  );
  return `${nextHeader}.${nextPayload}.${crypto
    .sign(null, signingInput, pair.privateKey)
    .toString("base64url")}`;
}

test("versioned issuance binds key, audience, deployment, issuer, tenant, and context", async () => {
  const token = await issue();
  assert.equal(token.split(".").length, 3);
  assert.equal(token.includes(KEY_REFERENCE), false);
  const result = verifyVersionedActiveTenantContext({
    token,
    keyRing: [key()],
    expected: expected(),
    now: NOW,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.context.tenantId, ID.tenant);
  assert.equal(result.context.principalId, ID.principal);
  assert.equal(result.envelope.keyId, KEY_ID);
  assert.equal(result.envelope.audience, AUDIENCE);
  assert.equal(result.envelope.environmentId, ENVIRONMENT);
  assert.equal(result.envelope.cellId, CELL);
  assert.equal(result.envelope.issuerId, ID.issuer);
});

test("VERIFY_ONLY supports bounded rotation while revoked and compromised keys deny", async () => {
  const token = await issue();
  for (const state of ["ACTIVE", "VERIFY_ONLY"] as const) {
    assert.equal(
      verifyVersionedActiveTenantContext({
        token,
        keyRing: [key({ state })],
        expected: expected(),
        now: NOW + 1,
      }).ok,
      true,
      state,
    );
  }
  for (const state of ["REVOKED", "COMPROMISED"] as const) {
    assert.deepEqual(
      verifyVersionedActiveTenantContext({
        token,
        keyRing: [key({ state })],
        expected: expected(),
        now: NOW + 1,
      }),
      { ok: false, reason: "key_inactive" },
      state,
    );
  }
  assert.deepEqual(
    verifyVersionedActiveTenantContext({
      token,
      keyRing: [key()],
      expected: expected(),
      now: NOW + 120_000,
    }),
    { ok: false, reason: "key_window_invalid" },
  );
});

test("tamper, unknown key, algorithm downgrade, extra claims, and legacy downgrade fail closed", async () => {
  const token = await issue();
  const [header, payload, signature] = token.split(".");
  assert.deepEqual(
    verifyVersionedActiveTenantContext({
      token: `${header}.${payload}.${signature.slice(0, -1)}A`,
      keyRing: [key()],
      expected: expected(),
      now: NOW,
    }),
    { ok: false, reason: "invalid_signature" },
  );
  assert.deepEqual(
    verifyVersionedActiveTenantContext({
      token: resign(token, (value) => {
        value.keyId = "active-context-unknown-key";
      }),
      keyRing: [key()],
      expected: expected(),
      now: NOW,
    }),
    { ok: false, reason: "unknown_key" },
  );
  assert.deepEqual(
    verifyVersionedActiveTenantContext({
      token: resign(token, (value) => {
        value.algorithm = "HS256";
      }),
      keyRing: [key()],
      expected: expected(),
      now: NOW,
    }),
    { ok: false, reason: "algorithm_mismatch" },
  );
  assert.deepEqual(
    verifyVersionedActiveTenantContext({
      token: resign(token, () => undefined, (value) => {
        value.injectedTenant = ID.otherTenant;
      }),
      keyRing: [key()],
      expected: expected(),
      now: NOW,
    }),
    { ok: false, reason: "invalid_claims" },
  );
  const legacy = signActiveTenantContext(
    { ...subject(), tokenVersion: 1, issuedAt: NOW, expiresAt: NOW + 60_000 },
    LEGACY_SECRET,
  );
  assert.deepEqual(
    verifyVersionedActiveTenantContext({
      token: legacy,
      keyRing: [key()],
      expected: expected(),
      now: NOW,
    }),
    { ok: false, reason: "malformed_token" },
  );
});

test("audience, environment, cell, issuer, and tenant drift are distinct denials", async () => {
  const token = await issue();
  for (const item of [
    { field: "audience", value: "fas.other.request", reason: "audience_mismatch" },
    { field: "environmentId", value: "staging", reason: "environment_mismatch" },
    { field: "cellId", value: "cell-b", reason: "cell_mismatch" },
    { field: "issuerId", value: ID.otherIssuer, reason: "issuer_mismatch" },
    { field: "tenantId", value: ID.otherTenant, reason: "tenant_mismatch" },
  ]) {
    assert.deepEqual(
      verifyVersionedActiveTenantContext({
        token,
        keyRing: [key()],
        expected: expected({ [item.field]: item.value }) as never,
        now: NOW,
      }),
      { ok: false, reason: item.reason },
      item.field,
    );
  }
});

test("issuance refuses non-active keys, invalid windows, raw references, duplicate rings, and bad signer output", async () => {
  await assert.rejects(
    () => issue({ keyRing: [key({ state: "VERIFY_ONLY" })] }),
    /active_context_signing_key_unavailable/,
  );
  await assert.rejects(
    () => issue({ keyRing: [key({ signUntil: NOW })] }),
    /active_context_signing_key_unavailable/,
  );
  await assert.rejects(
    () => issue({ keyReference: "plain-text-private-key" }),
    /active_context_issuance_configuration_invalid/,
  );
  const privateKeyPem = pair.privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  assert.throws(
    () => fingerprintActiveContextPublicKey(privateKeyPem),
    /active_context_public_key_material_invalid/,
  );
  await assert.rejects(
    () => issue({ keyRing: [key(), key()] }),
    /active_context_issuance_configuration_invalid/,
  );
  await assert.rejects(
    () =>
      issue({
        signer: { sign: async () => Buffer.alloc(64) },
      }),
    /active_context_signer_result_invalid/,
  );
  await assert.rejects(
    () => issue({ subject: { ...subject(), injected: true } as never }),
    /active_context_issuance_configuration_invalid/,
  );
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await assert.rejects(
      () => issue(),
      /active_context_issuance_configuration_invalid/,
    );
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("not-before and expiry boundaries are fail closed", async () => {
  const future = await issue({
    now: NOW + 60_000,
    keyRing: [
      key({ signUntil: NOW + 120_000, verifyUntil: NOW + 180_000 }),
    ],
  });
  assert.deepEqual(
    verifyVersionedActiveTenantContext({
      token: future,
      keyRing: [
        key({ signUntil: NOW + 120_000, verifyUntil: NOW + 180_000 }),
      ],
      expected: expected(),
      now: NOW,
    }),
    { ok: false, reason: "not_yet_valid" },
  );
  const short = await issue({ ttlMs: 1_000 });
  assert.deepEqual(
    verifyVersionedActiveTenantContext({
      token: short,
      keyRing: [key()],
      expected: expected(),
      now: NOW + 1_000,
    }),
    { ok: false, reason: "expired" },
  );
});

test("request binder uses the versioned verifier without legacy fallback", async () => {
  const token = await issue();
  let stores = 0;
  let audits = 0;
  const binding = bindChangeSetRequestContext({
    activeContextToken: token,
    activeContextSigningSecret: undefined,
    versionedActiveContext: {
      audience: AUDIENCE,
      environmentId: ENVIRONMENT,
      cellId: CELL,
      issuerId: ID.issuer,
      keyRing: [key()],
    },
    requestIdentity: {
      authenticatedPrincipalId: ID.principal,
      tenantId: ID.tenant,
      organizationId: ID.organization,
      legacyBranchId: 41,
    },
    createStore: () => {
      stores += 1;
      return { transaction: async () => ({ ok: false, error: "not_used" }) as never };
    },
    createAuditWriter: () => {
      audits += 1;
      return { startAttempt: async () => ({}) as never };
    },
    nextUuidV7: () => "018fa000-0000-7000-8000-00000000000b",
    now: () => NOW,
  });
  assert.equal(binding.ok, true);
  assert.equal(stores, 1);
  assert.equal(audits, 1);

  const legacy = signActiveTenantContext(
    { ...subject(), tokenVersion: 1, issuedAt: NOW, expiresAt: NOW + 60_000 },
    LEGACY_SECRET,
  );
  const denied = bindChangeSetRequestContext({
    activeContextToken: legacy,
    activeContextSigningSecret: undefined,
    versionedActiveContext: {
      audience: AUDIENCE,
      environmentId: ENVIRONMENT,
      cellId: CELL,
      issuerId: ID.issuer,
      keyRing: [key()],
    },
    requestIdentity: {
      authenticatedPrincipalId: ID.principal,
      tenantId: ID.tenant,
      organizationId: ID.organization,
      legacyBranchId: 41,
    },
    createStore: () => {
      stores += 1;
      return { transaction: async () => ({ ok: false }) as never };
    },
    createAuditWriter: () => {
      audits += 1;
      return { startAttempt: async () => ({}) as never };
    },
    nextUuidV7: () => "018fa000-0000-7000-8000-00000000000c",
    now: () => NOW,
  });
  assert.deepEqual(denied, {
    ok: false,
    error: { reason: "active_context_rejected", detail: "malformed_token" },
  });
  assert.equal(stores, 1);
  assert.equal(audits, 1);

  assert.throws(
    () =>
      bindChangeSetRequestContext({
        activeContextToken: token,
        activeContextSigningSecret: LEGACY_SECRET,
        versionedActiveContext: {
          audience: AUDIENCE,
          environmentId: ENVIRONMENT,
          cellId: CELL,
          issuerId: ID.issuer,
          keyRing: [key()],
        },
        requestIdentity: {
          authenticatedPrincipalId: ID.principal,
          tenantId: ID.tenant,
          organizationId: ID.organization,
          legacyBranchId: 41,
        },
        createStore: () => ({ transaction: async () => ({}) as never }),
        createAuditWriter: () => ({ startAttempt: async () => ({}) as never }),
        nextUuidV7: () => "018fa000-0000-7000-8000-00000000000d",
        now: () => NOW,
      }),
    /change_set_request_binding_configuration_invalid/,
  );
});
