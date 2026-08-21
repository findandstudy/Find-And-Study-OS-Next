import crypto from "node:crypto";
import { canonicalJson } from "./jsonCanonical.js";

export const CHANGE_SET_EVIDENCE_AUDIENCE = "fas.change-set.transition";
export const CHANGE_SET_EVIDENCE_DOMAIN = "FAS_CHANGESET_EVIDENCE\0v1\0";
export const CHANGE_SET_EVIDENCE_DEFAULT_TTL_MS = 15 * 60 * 1000;
export const CHANGE_SET_EVIDENCE_MAX_TTL_MS = 60 * 60 * 1000;
export const CHANGE_SET_EVIDENCE_CLOCK_SKEW_MS = 30 * 1000;
export const CHANGE_SET_EVIDENCE_MAX_TOKEN_BYTES = 8 * 1024;

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const IDENTIFIER_RE = /^[a-z][a-z0-9._:-]{2,95}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/;
const EXPECTED_CLAIM_KEYS = [
  "algorithm",
  "artifactCount",
  "artifactManifestHash",
  "audience",
  "cellId",
  "challengeNonce",
  "changeSetId",
  "environmentId",
  "evidenceRequestId",
  "expiresAt",
  "issuedAt",
  "issuerId",
  "issuerTenantGrantId",
  "issuerPrincipalId",
  "keyId",
  "kind",
  "outcome",
  "outcomeHash",
  "policyVersionId",
  "receiptId",
  "requestedByMembershipId",
  "requestedByPrincipalId",
  "schemaVersion",
  "subjectHash",
  "targetState",
  "tenantId",
  "toolId",
  "toolVersion",
] as const;

export type ChangeSetEvidenceKind =
  | "VALIDATION"
  | "SIMULATION"
  | "TEST_ARTIFACT"
  | "ROLLBACK_PLAN"
  | "CANARY_PLAN";

export type ChangeSetEvidenceTargetState =
  | "VALIDATED"
  | "SIMULATED"
  | "IN_REVIEW";

export type ChangeSetEvidenceClaims = {
  schemaVersion: 1;
  audience: typeof CHANGE_SET_EVIDENCE_AUDIENCE;
  environmentId: string;
  cellId: string;
  receiptId: string;
  evidenceRequestId: string;
  challengeNonce: string;
  issuerId: string;
  issuerTenantGrantId: string;
  issuerPrincipalId: string;
  keyId: string;
  algorithm: "Ed25519";
  tenantId: string;
  changeSetId: string;
  targetState: ChangeSetEvidenceTargetState;
  kind: ChangeSetEvidenceKind;
  requestedByPrincipalId: string;
  requestedByMembershipId: string;
  subjectHash: string;
  policyVersionId: string;
  toolId: string;
  toolVersion: string;
  outcome: "PASSED" | "FAILED";
  artifactCount: number | null;
  artifactManifestHash: string | null;
  outcomeHash: string;
  issuedAt: number;
  expiresAt: number;
};

export type ChangeSetEvidenceIssueInput = Omit<
  ChangeSetEvidenceClaims,
  | "schemaVersion"
  | "audience"
  | "environmentId"
  | "cellId"
  | "issuerId"
  | "issuerPrincipalId"
  | "keyId"
  | "algorithm"
  | "outcomeHash"
  | "issuedAt"
  | "expiresAt"
> & { ttlMs?: number };

export type ChangeSetEvidenceSigner = {
  issuerId: string;
  issuerPrincipalId: string;
  keyId: string;
  algorithm: "Ed25519";
  environmentId: string;
  cellId: string;
  state: "ACTIVE";
  validFrom: number;
  signUntil: number;
  sign: (canonicalPayload: Uint8Array) => Promise<Uint8Array>;
};

export type ChangeSetEvidenceTenantGrant = {
  id: string;
  tenantId: string;
  kind: ChangeSetEvidenceKind;
  toolId: string;
  toolVersion: string;
  state: "ACTIVE" | "REVOKED";
  validFrom: number;
  validUntil: number | null;
};

export type ChangeSetEvidenceVerificationKey = {
  issuerId: string;
  issuerPrincipalId: string;
  keyId: string;
  algorithm: "Ed25519";
  environmentId: string;
  cellId: string;
  issuerState: "ACTIVE" | "REVOKED";
  state: "ACTIVE" | "VERIFY_ONLY" | "REVOKED" | "COMPROMISED";
  validFrom: number;
  signUntil: number;
  verifyUntil: number;
  publicKey: crypto.KeyLike;
  publicKeyFingerprintSha256: string;
  tenantGrants: readonly ChangeSetEvidenceTenantGrant[];
};

export type ChangeSetEvidenceVerificationFailure =
  | "missing_token"
  | "malformed_token"
  | "invalid_claims"
  | "unknown_key"
  | "environment_mismatch"
  | "invalid_key_record"
  | "key_inactive"
  | "key_window_invalid"
  | "key_fingerprint_mismatch"
  | "tenant_grant_inactive"
  | "invalid_signature"
  | "not_yet_valid"
  | "expired";

export type ChangeSetEvidenceVerificationResult =
  | { ok: true; claims: Readonly<ChangeSetEvidenceClaims> }
  | { ok: false; reason: ChangeSetEvidenceVerificationFailure };

export type ChangeSetEvidenceVerificationContext = {
  now: number;
  expectedEnvironmentId: string;
  expectedCellId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_RE.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_RE.test(value);
}

function expectedTargetState(
  kind: ChangeSetEvidenceKind,
): ChangeSetEvidenceTargetState {
  if (kind === "VALIDATION") return "VALIDATED";
  if (kind === "SIMULATION") return "SIMULATED";
  return "IN_REVIEW";
}

function validArtifactBinding(value: {
  kind: ChangeSetEvidenceKind;
  artifactCount: number | null;
  artifactManifestHash: string | null;
}): boolean {
  if (value.kind === "TEST_ARTIFACT") {
    return (
      Number.isSafeInteger(value.artifactCount) &&
      Number(value.artifactCount) >= 1 &&
      isSha256(value.artifactManifestHash)
    );
  }
  return value.artifactCount === null && value.artifactManifestHash === null;
}

function outcomeHash(value: {
  kind: ChangeSetEvidenceKind;
  outcome: "PASSED" | "FAILED";
  artifactCount: number | null;
  artifactManifestHash: string | null;
}): string {
  const outcomeBinding = {
    kind: value.kind,
    outcome: value.outcome,
    artifactCount: value.artifactCount,
    artifactManifestHash: value.artifactManifestHash,
  };
  return crypto
    .createHash("sha256")
    .update(canonicalJson(outcomeBinding), "utf8")
    .digest("hex");
}

function canonicalSigningPayload(claims: ChangeSetEvidenceClaims): Buffer {
  return Buffer.concat([
    Buffer.from(CHANGE_SET_EVIDENCE_DOMAIN, "utf8"),
    Buffer.from(canonicalJson(claims), "utf8"),
  ]);
}

function exactClaimKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...EXPECTED_CLAIM_KEYS].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function parseClaims(value: unknown): ChangeSetEvidenceClaims | null {
  if (!isRecord(value) || !exactClaimKeys(value)) return null;
  const claims = value as Partial<ChangeSetEvidenceClaims>;
  if (
    claims.schemaVersion !== 1 ||
    claims.audience !== CHANGE_SET_EVIDENCE_AUDIENCE ||
    claims.algorithm !== "Ed25519" ||
    !isIdentifier(claims.environmentId) ||
    !isIdentifier(claims.cellId) ||
    !isUuidV7(claims.receiptId) ||
    !isUuidV7(claims.evidenceRequestId) ||
    typeof claims.challengeNonce !== "string" ||
    !NONCE_RE.test(claims.challengeNonce) ||
    !isIdentifier(claims.issuerId) ||
    !isUuidV7(claims.issuerTenantGrantId) ||
    !isUuidV7(claims.issuerPrincipalId) ||
    !isIdentifier(claims.keyId) ||
    !isUuidV7(claims.tenantId) ||
    !isUuidV7(claims.changeSetId) ||
    !["VALIDATED", "SIMULATED", "IN_REVIEW"].includes(
      claims.targetState as string,
    ) ||
    ![
      "VALIDATION",
      "SIMULATION",
      "TEST_ARTIFACT",
      "ROLLBACK_PLAN",
      "CANARY_PLAN",
    ].includes(claims.kind as string) ||
    !isUuidV7(claims.requestedByPrincipalId) ||
    !isUuidV7(claims.requestedByMembershipId) ||
    !isSha256(claims.subjectHash) ||
    !isUuidV7(claims.policyVersionId) ||
    !isIdentifier(claims.toolId) ||
    !isIdentifier(claims.toolVersion) ||
    !["PASSED", "FAILED"].includes(claims.outcome as string) ||
    !isSha256(claims.outcomeHash) ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt)
  ) {
    return null;
  }

  const normalized = {
    ...(claims as ChangeSetEvidenceClaims),
    receiptId: claims.receiptId.toLowerCase(),
    evidenceRequestId: claims.evidenceRequestId.toLowerCase(),
    issuerTenantGrantId: claims.issuerTenantGrantId.toLowerCase(),
    issuerPrincipalId: claims.issuerPrincipalId.toLowerCase(),
    tenantId: claims.tenantId.toLowerCase(),
    changeSetId: claims.changeSetId.toLowerCase(),
    requestedByPrincipalId: claims.requestedByPrincipalId.toLowerCase(),
    requestedByMembershipId: claims.requestedByMembershipId.toLowerCase(),
    subjectHash: claims.subjectHash.toLowerCase(),
    policyVersionId: claims.policyVersionId.toLowerCase(),
    artifactManifestHash: claims.artifactManifestHash?.toLowerCase() ?? null,
    outcomeHash: claims.outcomeHash.toLowerCase(),
  } satisfies ChangeSetEvidenceClaims;

  if (
    normalized.targetState !== expectedTargetState(normalized.kind) ||
    !validArtifactBinding(normalized) ||
    normalized.outcomeHash !== outcomeHash(normalized) ||
    normalized.expiresAt <= normalized.issuedAt ||
    normalized.expiresAt - normalized.issuedAt > CHANGE_SET_EVIDENCE_MAX_TTL_MS
  ) {
    return null;
  }
  return normalized;
}

function publicKeyFingerprint(publicKey: crypto.KeyLike): string | null {
  try {
    const key =
      publicKey instanceof crypto.KeyObject
        ? publicKey
        : crypto.createPublicKey(publicKey);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      return null;
    }
    const der = key.export({ type: "spki", format: "der" });
    return crypto.createHash("sha256").update(der).digest("hex");
  } catch {
    return null;
  }
}

function validSigner(signer: ChangeSetEvidenceSigner, now: number): boolean {
  return (
    signer.state === "ACTIVE" &&
    signer.algorithm === "Ed25519" &&
    isIdentifier(signer.issuerId) &&
    isUuidV7(signer.issuerPrincipalId) &&
    isIdentifier(signer.keyId) &&
    isIdentifier(signer.environmentId) &&
    isIdentifier(signer.cellId) &&
    Number.isSafeInteger(signer.validFrom) &&
    Number.isSafeInteger(signer.signUntil) &&
    signer.validFrom <= now &&
    now <= signer.signUntil &&
    typeof signer.sign === "function"
  );
}

export async function issueChangeSetEvidenceEnvelope(
  input: ChangeSetEvidenceIssueInput,
  signer: ChangeSetEvidenceSigner,
  now = Date.now(),
): Promise<{ token: string; claims: Readonly<ChangeSetEvidenceClaims> }> {
  const ttlMs = input.ttlMs ?? CHANGE_SET_EVIDENCE_DEFAULT_TTL_MS;
  const { ttlMs: _ttlMs, ...claimsInput } = input;
  void _ttlMs;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > CHANGE_SET_EVIDENCE_MAX_TTL_MS ||
    !validSigner(signer, now)
  ) {
    throw new Error("invalid_change_set_evidence_issuer");
  }

  const claims = parseClaims({
    ...claimsInput,
    schemaVersion: 1,
    audience: CHANGE_SET_EVIDENCE_AUDIENCE,
    environmentId: signer.environmentId,
    cellId: signer.cellId,
    issuerId: signer.issuerId,
    issuerPrincipalId: signer.issuerPrincipalId,
    keyId: signer.keyId,
    algorithm: signer.algorithm,
    outcomeHash: outcomeHash(input),
    issuedAt: now,
    expiresAt: now + ttlMs,
  });
  if (!claims) throw new Error("invalid_change_set_evidence_claims");

  const canonicalClaims = canonicalJson(claims);
  const signature = Buffer.from(
    await signer.sign(canonicalSigningPayload(claims)),
  );
  if (signature.length !== 64) {
    throw new Error("invalid_change_set_evidence_signature");
  }
  const token = `${Buffer.from(canonicalClaims, "utf8").toString(
    "base64url",
  )}.${signature.toString("base64url")}`;
  if (Buffer.byteLength(token, "utf8") > CHANGE_SET_EVIDENCE_MAX_TOKEN_BYTES) {
    throw new Error("change_set_evidence_token_too_large");
  }
  return { token, claims: Object.freeze(claims) };
}

export function verifyChangeSetEvidenceEnvelope(
  token: string | null | undefined,
  keys: readonly ChangeSetEvidenceVerificationKey[],
  context: ChangeSetEvidenceVerificationContext,
): ChangeSetEvidenceVerificationResult {
  if (!token) return { ok: false, reason: "missing_token" };
  if (!isRecord(context) || !Array.isArray(keys)) {
    return { ok: false, reason: "malformed_token" };
  }
  const { now, expectedEnvironmentId, expectedCellId } = context;
  if (
    typeof token !== "string" ||
    Buffer.byteLength(token, "utf8") > CHANGE_SET_EVIDENCE_MAX_TOKEN_BYTES ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !isIdentifier(expectedEnvironmentId) ||
    !isIdentifier(expectedCellId)
  ) {
    return { ok: false, reason: "malformed_token" };
  }
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "malformed_token" };
  }

  let claims: ChangeSetEvidenceClaims | null = null;
  let signature: Buffer;
  try {
    const payload = Buffer.from(parts[0], "base64url");
    signature = Buffer.from(parts[1], "base64url");
    if (
      payload.toString("base64url") !== parts[0] ||
      signature.toString("base64url") !== parts[1] ||
      signature.length !== 64
    ) {
      return { ok: false, reason: "malformed_token" };
    }
    const parsed = JSON.parse(payload.toString("utf8")) as unknown;
    claims = parseClaims(parsed);
    if (!claims || canonicalJson(claims) !== payload.toString("utf8")) {
      return { ok: false, reason: "invalid_claims" };
    }
  } catch {
    return { ok: false, reason: "malformed_token" };
  }

  if (
    claims.environmentId !== expectedEnvironmentId ||
    claims.cellId !== expectedCellId
  ) {
    return { ok: false, reason: "environment_mismatch" };
  }

  const key = keys.find(
    (candidate: ChangeSetEvidenceVerificationKey) =>
      isRecord(candidate) &&
      candidate.issuerId === claims.issuerId &&
      candidate.keyId === claims.keyId,
  );
  if (!key) return { ok: false, reason: "unknown_key" };
  if (
    !isIdentifier(key.issuerId) ||
    !isUuidV7(key.issuerPrincipalId) ||
    !isIdentifier(key.keyId) ||
    key.algorithm !== "Ed25519" ||
    !isIdentifier(key.environmentId) ||
    !isIdentifier(key.cellId) ||
    !["ACTIVE", "REVOKED"].includes(key.issuerState) ||
    !["ACTIVE", "VERIFY_ONLY", "REVOKED", "COMPROMISED"].includes(key.state) ||
    !Array.isArray(key.tenantGrants)
  ) {
    return { ok: false, reason: "invalid_key_record" };
  }
  if (
    key.environmentId !== claims.environmentId ||
    key.cellId !== claims.cellId
  ) {
    return { ok: false, reason: "environment_mismatch" };
  }
  if (
    key.issuerState !== "ACTIVE" ||
    key.state === "REVOKED" ||
    key.state === "COMPROMISED"
  ) {
    return { ok: false, reason: "key_inactive" };
  }
  if (
    key.issuerPrincipalId.toLowerCase() !== claims.issuerPrincipalId ||
    !Number.isSafeInteger(key.validFrom) ||
    !Number.isSafeInteger(key.signUntil) ||
    !Number.isSafeInteger(key.verifyUntil) ||
    claims.issuedAt < key.validFrom ||
    claims.issuedAt > key.signUntil ||
    now > key.verifyUntil
  ) {
    return { ok: false, reason: "key_window_invalid" };
  }
  const fingerprint = publicKeyFingerprint(key.publicKey);
  if (
    !fingerprint ||
    !isSha256(key.publicKeyFingerprintSha256) ||
    fingerprint !== key.publicKeyFingerprintSha256.toLowerCase()
  ) {
    return { ok: false, reason: "key_fingerprint_mismatch" };
  }
  const grant = key.tenantGrants.find(
    (candidate: ChangeSetEvidenceTenantGrant) => {
      if (
        !isRecord(candidate) ||
        !isUuidV7(candidate.id) ||
        !isUuidV7(candidate.tenantId) ||
        typeof candidate.kind !== "string" ||
        ![
          "VALIDATION",
          "SIMULATION",
          "TEST_ARTIFACT",
          "ROLLBACK_PLAN",
          "CANARY_PLAN",
        ].includes(candidate.kind as ChangeSetEvidenceKind) ||
        !isIdentifier(candidate.toolId) ||
        !isIdentifier(candidate.toolVersion) ||
        typeof candidate.state !== "string" ||
        !["ACTIVE", "REVOKED"].includes(candidate.state) ||
        !Number.isSafeInteger(candidate.validFrom) ||
        (candidate.validUntil !== null &&
          !Number.isSafeInteger(candidate.validUntil))
      ) {
        return false;
      }
      return (
        candidate.id.toLowerCase() === claims.issuerTenantGrantId &&
        candidate.tenantId.toLowerCase() === claims.tenantId &&
        candidate.kind === claims.kind &&
        candidate.toolId === claims.toolId &&
        candidate.toolVersion === claims.toolVersion
      );
    },
  );
  if (
    !grant ||
    grant.state !== "ACTIVE" ||
    !Number.isSafeInteger(grant.validFrom) ||
    grant.validFrom > claims.issuedAt ||
    (grant.validUntil !== null &&
      (!Number.isSafeInteger(grant.validUntil) ||
        claims.issuedAt >= grant.validUntil ||
        now >= grant.validUntil))
  ) {
    return { ok: false, reason: "tenant_grant_inactive" };
  }
  let validSignature = false;
  try {
    validSignature = crypto.verify(
      null,
      canonicalSigningPayload(claims),
      key.publicKey,
      signature,
    );
  } catch {
    validSignature = false;
  }
  if (!validSignature) return { ok: false, reason: "invalid_signature" };
  if (claims.issuedAt > now + CHANGE_SET_EVIDENCE_CLOCK_SKEW_MS) {
    return { ok: false, reason: "not_yet_valid" };
  }
  if (claims.expiresAt <= now) return { ok: false, reason: "expired" };
  return { ok: true, claims: Object.freeze(claims) };
}

export function fingerprintChangeSetEvidencePublicKey(
  publicKey: crypto.KeyLike,
): string {
  const fingerprint = publicKeyFingerprint(publicKey);
  if (!fingerprint) throw new Error("invalid_ed25519_public_key");
  return fingerprint;
}
