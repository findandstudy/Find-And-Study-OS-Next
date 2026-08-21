import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  CHANGE_SET_EVIDENCE_CLOCK_SKEW_MS,
  CHANGE_SET_EVIDENCE_MAX_TTL_MS,
  fingerprintChangeSetEvidencePublicKey,
  issueChangeSetEvidenceEnvelope,
  verifyChangeSetEvidenceEnvelope,
  type ChangeSetEvidenceIssueInput,
  type ChangeSetEvidenceSigner,
  type ChangeSetEvidenceVerificationKey,
} from "../src/lib/changeSetEvidenceEnvelope.js";
import { canonicalJson } from "../src/lib/jsonCanonical.js";

const NOW = 2_000_000_000_000;
const ID = {
  tenant: "018f4000-0000-7000-8000-000000000001",
  changeSet: "018f4000-0000-7000-8000-000000000002",
  principal: "018f4000-0000-7000-8000-000000000003",
  membership: "018f4000-0000-7000-8000-000000000004",
  policy: "018f4000-0000-7000-8000-000000000005",
  receipt: "018f4000-0000-7000-8000-000000000006",
  request: "018f4000-0000-7000-8000-000000000007",
  issuerPrincipal: "018f4000-0000-7000-8000-000000000008",
  alternate: "018f4000-0000-7000-8000-000000000009",
};

const pair = crypto.generateKeyPairSync("ed25519");

function signer(overrides: Partial<ChangeSetEvidenceSigner> = {}) {
  return {
    issuerId: "fas-evidence-service",
    issuerPrincipalId: ID.issuerPrincipal,
    keyId: "test-key-1",
    algorithm: "Ed25519" as const,
    environmentId: "test-ci",
    cellId: "cell-a",
    state: "ACTIVE" as const,
    validFrom: NOW - 60_000,
    signUntil: NOW + 60 * 60 * 1000,
    sign: async (payload: Uint8Array) =>
      crypto.sign(null, Buffer.from(payload), pair.privateKey),
    ...overrides,
  } satisfies ChangeSetEvidenceSigner;
}

function input(
  overrides: Partial<ChangeSetEvidenceIssueInput> = {},
): ChangeSetEvidenceIssueInput {
  return {
    receiptId: ID.receipt,
    evidenceRequestId: ID.request,
    challengeNonce: "abcdefghijklmnopqrstuv",
    tenantId: ID.tenant,
    changeSetId: ID.changeSet,
    targetState: "VALIDATED",
    kind: "VALIDATION",
    requestedByPrincipalId: ID.principal,
    requestedByMembershipId: ID.membership,
    subjectHash: "a".repeat(64),
    policyVersionId: ID.policy,
    toolId: "fas-evidence-service",
    toolVersion: "test-v1",
    outcome: "PASSED",
    artifactCount: null,
    artifactManifestHash: null,
    ...overrides,
  };
}

function verificationKey(
  overrides: Partial<ChangeSetEvidenceVerificationKey> = {},
): ChangeSetEvidenceVerificationKey {
  return {
    issuerId: "fas-evidence-service",
    issuerPrincipalId: ID.issuerPrincipal,
    keyId: "test-key-1",
    algorithm: "Ed25519",
    environmentId: "test-ci",
    cellId: "cell-a",
    state: "ACTIVE",
    validFrom: NOW - 60_000,
    signUntil: NOW + 60 * 60 * 1000,
    verifyUntil: NOW + 2 * 60 * 60 * 1000,
    publicKey: pair.publicKey,
    publicKeyFingerprintSha256: fingerprintChangeSetEvidencePublicKey(
      pair.publicKey,
    ),
    tenantGrants: [
      {
        tenantId: ID.tenant,
        kind: "VALIDATION",
        toolId: "fas-evidence-service",
        toolVersion: "test-v1",
        state: "ACTIVE",
        validFrom: NOW - 60_000,
        validUntil: NOW + 60 * 60 * 1000,
      },
    ],
    ...overrides,
  };
}

function tamperClaim(token: string, key: string, value: unknown): string {
  const [payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  claims[key] = value;
  return `${Buffer.from(canonicalJson(claims), "utf8").toString(
    "base64url",
  )}.${signature}`;
}

function differentValue(value: unknown): unknown {
  if (value === null) return 1;
  if (typeof value === "number") return value + 1;
  if (typeof value !== "string") return "tampered";
  if (/^[0-9a-f]{64}$/.test(value)) return "c".repeat(64);
  if (/^[0-9a-f]{8}-/.test(value)) return ID.alternate;
  return `${value}-tampered`;
}

test("issues and verifies a tenant-bound Ed25519 evidence envelope", async () => {
  const issued = await issueChangeSetEvidenceEnvelope(input(), signer(), NOW);
  const verified = verifyChangeSetEvidenceEnvelope(
    issued.token,
    [verificationKey()],
    NOW,
  );
  if (verified.ok === false) assert.fail(verified.reason);
  assert.equal(verified.claims.tenantId, ID.tenant);
  assert.equal(verified.claims.receiptId, ID.receipt);
  assert.equal(verified.claims.audience, "fas.change-set.transition");
  assert.equal("privateKey" in verified.claims, false);
});

test("rejects mutation of every signed claim", async () => {
  const issued = await issueChangeSetEvidenceEnvelope(input(), signer(), NOW);
  for (const [key, value] of Object.entries(issued.claims)) {
    const result = verifyChangeSetEvidenceEnvelope(
      tamperClaim(issued.token, key, differentValue(value)),
      [verificationKey()],
      NOW,
    );
    assert.equal(result.ok, false, `mutated claim must fail: ${key}`);
  }
});

test("rejects signature, key, fingerprint, and tenant-grant failures", async () => {
  const issued = await issueChangeSetEvidenceEnvelope(input(), signer(), NOW);
  const [payload, signature] = issued.token.split(".");
  const signatureBytes = Buffer.from(signature, "base64url");
  signatureBytes[0] ^= 1;
  const badSignature = `${payload}.${signatureBytes.toString("base64url")}`;
  assert.deepEqual(
    verifyChangeSetEvidenceEnvelope(badSignature, [verificationKey()], NOW),
    { ok: false, reason: "invalid_signature" },
  );
  assert.deepEqual(verifyChangeSetEvidenceEnvelope(issued.token, [], NOW), {
    ok: false,
    reason: "unknown_key",
  });
  assert.deepEqual(
    verifyChangeSetEvidenceEnvelope(
      issued.token,
      [verificationKey({ publicKeyFingerprintSha256: "f".repeat(64) })],
      NOW,
    ),
    { ok: false, reason: "key_fingerprint_mismatch" },
  );
  assert.deepEqual(
    verifyChangeSetEvidenceEnvelope(
      issued.token,
      [verificationKey({ tenantGrants: [] })],
      NOW,
    ),
    { ok: false, reason: "tenant_grant_inactive" },
  );
});

test("supports planned verify-only rotation and rejects revoked keys", async () => {
  const issued = await issueChangeSetEvidenceEnvelope(input(), signer(), NOW);
  assert.equal(
    verifyChangeSetEvidenceEnvelope(
      issued.token,
      [verificationKey({ state: "VERIFY_ONLY" })],
      NOW,
    ).ok,
    true,
  );
  for (const state of ["REVOKED", "COMPROMISED"] as const) {
    assert.deepEqual(
      verifyChangeSetEvidenceEnvelope(
        issued.token,
        [verificationKey({ state })],
        NOW,
      ),
      { ok: false, reason: "key_inactive" },
    );
  }
});

test("enforces not-before, expiry boundary, and maximum TTL", async () => {
  const issued = await issueChangeSetEvidenceEnvelope(input(), signer(), NOW);
  assert.deepEqual(
    verifyChangeSetEvidenceEnvelope(
      issued.token,
      [verificationKey()],
      issued.claims.expiresAt,
    ),
    { ok: false, reason: "expired" },
  );

  const futureNow = NOW + CHANGE_SET_EVIDENCE_CLOCK_SKEW_MS + 1;
  const future = await issueChangeSetEvidenceEnvelope(
    input(),
    signer({ signUntil: futureNow + 60_000 }),
    futureNow,
  );
  assert.deepEqual(
    verifyChangeSetEvidenceEnvelope(future.token, [verificationKey()], NOW),
    { ok: false, reason: "not_yet_valid" },
  );

  await assert.rejects(
    issueChangeSetEvidenceEnvelope(
      input({ ttlMs: CHANGE_SET_EVIDENCE_MAX_TTL_MS + 1 }),
      signer(),
      NOW,
    ),
    /invalid_change_set_evidence_issuer/,
  );
});

test("binds test artifacts to an immutable manifest hash", async () => {
  const issued = await issueChangeSetEvidenceEnvelope(
    input({
      receiptId: ID.alternate,
      targetState: "IN_REVIEW",
      kind: "TEST_ARTIFACT",
      artifactCount: 2,
      artifactManifestHash: "b".repeat(64),
    }),
    signer(),
    NOW,
  );
  const key = verificationKey({
    tenantGrants: [
      {
        tenantId: ID.tenant,
        kind: "TEST_ARTIFACT",
        toolId: "fas-evidence-service",
        toolVersion: "test-v1",
        state: "ACTIVE",
        validFrom: NOW - 60_000,
        validUntil: null,
      },
    ],
  });
  assert.equal(
    verifyChangeSetEvidenceEnvelope(issued.token, [key], NOW).ok,
    true,
  );
  assert.equal(
    verifyChangeSetEvidenceEnvelope(
      tamperClaim(issued.token, "artifactManifestHash", "d".repeat(64)),
      [key],
      NOW,
    ).ok,
    false,
  );
});

test("0058 keeps keys opaque, tenant grants scoped, and audit append-only", () => {
  const migration = fs.readFileSync(
    new URL(
      "../../../lib/db/drizzle/0058_change_set_evidence_identity_audit_foundation.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(migration, /private_key/i);
  assert.match(migration, /opaque_signing_key_ref/);
  assert.match(migration, /change_set_evidence_issuer_tenant_grants/);
  assert.match(
    migration,
    /change_set_evidence_issuer_tenant_grants FORCE ROW LEVEL SECURITY/,
  );
  assert.match(
    migration,
    /signed evidence does not match its single-use request/,
  );
  assert.match(migration, /signed evidence issuer has no active tenant grant/);
  assert.match(
    migration,
    /evidence signing key material and lifecycle are immutable/,
  );
  assert.match(migration, /change_set_command_audit_events_immutable/);
  assert.match(migration, /audit chain must begin with ATTEMPT_STARTED/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(
    migration,
    /REVOKE ALL ON TABLE public\.change_set_evidence_signing_keys FROM PUBLIC/,
  );
});
