import crypto from "node:crypto";

export const ACTIVE_CONTEXT_TTL_MS = 15 * 60 * 1000;
export const ACTIVE_CONTEXT_CLOCK_SKEW_MS = 30 * 1000;
export const ACTIVE_CONTEXT_MAX_ASSIGNMENTS = 32;
export const ACTIVE_CONTEXT_V2_TYPE = "FAS_ACTIVE_CONTEXT";
export const ACTIVE_CONTEXT_V2_ALGORITHM = "Ed25519";

const VERIFIED_CONTEXT = Symbol("verified-active-tenant-context");
const VERIFIED_CONTEXTS = new WeakSet<object>();
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const DEPLOYMENT_ID_RE = /^[a-z][a-z0-9-]{1,62}$/;
const AUDIENCE_RE = /^[a-z][a-z0-9.-]{2,127}$/;
const OPAQUE_SIGNER_REF_RE = /^(kms|hsm|test-memory):\/\/[A-Za-z0-9][A-Za-z0-9._:/-]{5,255}$/;

type ActiveContextBaseClaims = {
  contextId: string;
  tenantId: string;
  organizationId: string | null;
  legacyBranchId: number | null;
  principalId: string;
  membershipId: string;
  assignmentIds: string[];
  policyVersionId: string;
  policyVersion: number;
  issuedAt: number;
  expiresAt: number;
};

export type ActiveTenantContextClaims =
  | (ActiveContextBaseClaims & { tokenVersion: 1 })
  | (ActiveContextBaseClaims & {
      tokenVersion: 2;
      selectionId: string;
      sessionGeneration: number;
    });

export type ActiveContextSelectionBinding = {
  selectionId: string;
  sessionGeneration: number;
};

export type VerifiedActiveTenantContext = ActiveTenantContextClaims & {
  readonly [VERIFIED_CONTEXT]: true;
};

export type ActiveContextVerificationFailure =
  | "missing_token"
  | "signing_secret_unavailable"
  | "malformed_token"
  | "invalid_signature"
  | "invalid_claims"
  | "not_yet_valid"
  | "expired";

export type ActiveContextVerificationResult =
  | { ok: true; context: VerifiedActiveTenantContext }
  | { ok: false; reason: ActiveContextVerificationFailure };

export type ActiveContextKeyState =
  | "ACTIVE"
  | "VERIFY_ONLY"
  | "REVOKED"
  | "COMPROMISED";

export type ActiveContextVerificationKey = {
  keyId: string;
  algorithm: typeof ACTIVE_CONTEXT_V2_ALGORITHM;
  state: ActiveContextKeyState;
  issuerId: string;
  environmentId: string;
  cellId: string;
  publicKeyPem: string;
  publicKeyFingerprint: string;
  signFrom: number;
  signUntil: number;
  verifyUntil: number;
};

export type ActiveContextVersionedTokenExpected = {
  audience: string;
  environmentId: string;
  cellId: string;
  issuerId: string;
  tenantId: string;
};

export type ActiveContextVersionedSubject = Omit<
  ActiveTenantContextClaims,
  "tokenVersion" | "issuedAt" | "expiresAt"
>;

export type ActiveContextExternalSigner = {
  sign(input: {
    keyReference: string;
    algorithm: typeof ACTIVE_CONTEXT_V2_ALGORITHM;
    signingInput: Buffer;
  }): Promise<Buffer>;
};

export type ActiveContextVersionedIssuanceOptions = {
  subject: ActiveContextVersionedSubject;
  audience: string;
  environmentId: string;
  cellId: string;
  issuerId: string;
  keyId: string;
  keyReference: string;
  keyRing: readonly ActiveContextVerificationKey[];
  signer: ActiveContextExternalSigner;
  ttlMs?: number;
  now?: number;
};

export type ActiveContextVersionedVerificationFailure =
  | "missing_token"
  | "clock_invalid"
  | "expected_context_invalid"
  | "key_ring_invalid"
  | "malformed_token"
  | "unknown_key"
  | "algorithm_mismatch"
  | "key_inactive"
  | "key_window_invalid"
  | "invalid_signature"
  | "invalid_claims"
  | "audience_mismatch"
  | "environment_mismatch"
  | "cell_mismatch"
  | "issuer_mismatch"
  | "tenant_mismatch"
  | "selection_binding_missing"
  | "selection_binding_mismatch"
  | "not_yet_valid"
  | "expired";

export type ActiveContextVersionedVerificationResult =
  | {
      ok: true;
      context: VerifiedActiveTenantContext;
      envelope: {
        envelopeVersion: 2;
        algorithm: typeof ACTIVE_CONTEXT_V2_ALGORITHM;
        keyId: string;
        audience: string;
        environmentId: string;
        cellId: string;
        issuerId: string;
        notBefore: number;
      };
    }
  | { ok: false; reason: ActiveContextVersionedVerificationFailure };

export type PrincipalType = "HUMAN" | "SERVICE" | "INTEGRATION" | "AI";
export type AssignmentScopeType = "TENANT" | "ORGANIZATION" | "LEGACY_BRANCH";

export type ResolvedCapability = {
  key: string;
  effect: "ALLOW" | "DENY";
  status: "ACTIVE" | "DEPRECATED" | "REVOKED";
  stepUpRequired: boolean;
  approvalRequired: boolean;
};

export type ResolvedAccessAssignment = {
  id: string;
  tenantId: string;
  membershipId: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED";
  validFrom: number;
  validUntil: number | null;
  scopeType: AssignmentScopeType;
  organizationId: string | null;
  legacyBranchId: number | null;
  constraintDocument: Record<string, unknown>;
  rolePackageVersionId: string;
  rolePackageStatus: "DRAFT" | "ACTIVE" | "DEPRECATED" | "REVOKED";
  rolePackagePrincipalType: PrincipalType;
  rolePackageEffectiveAt: number | null;
  rolePackageDeprecatedAt: number | null;
  capabilities: ResolvedCapability[];
};

export type ResolvedActiveContextState = {
  tenant: {
    id: string;
    status: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "OFFBOARDING" | "CLOSED";
    policyVersion: number;
  };
  principal: {
    id: string;
    principalType: PrincipalType;
    status: "ACTIVE" | "SUSPENDED" | "REVOKED";
    riskState: "NORMAL" | "STEP_UP_REQUIRED" | "LOCKED";
  };
  membership: {
    id: string;
    tenantId: string;
    organizationId: string | null;
    legacyBranchId: number | null;
    principalId: string;
    status: "PENDING" | "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED";
    validFrom: number;
    validUntil: number | null;
  };
  policy: {
    id: string;
    tenantId: string;
    version: number;
    state: "DRAFT" | "ACTIVE" | "REVOKED";
    effectiveAt: number | null;
    revokedAt: number | null;
  };
  assignments: ResolvedAccessAssignment[];
};

export type ActiveContextResource = {
  type: string;
  id: string;
  tenantId: string;
  organizationId?: string | null;
  legacyBranchId?: number | null;
};

export type ActiveContextDecisionReason =
  | "allowed"
  | "resource_not_found"
  | "context_not_current"
  | "tenant_inactive"
  | "context_tenant_mismatch"
  | "principal_mismatch"
  | "principal_inactive"
  | "principal_risk_blocked"
  | "membership_mismatch"
  | "membership_inactive"
  | "membership_expired"
  | "context_scope_mismatch"
  | "policy_mismatch"
  | "policy_inactive"
  | "assignment_set_mismatch"
  | "assignment_inactive"
  | "assignment_expired"
  | "assignment_scope_mismatch"
  | "role_package_inactive"
  | "principal_type_mismatch"
  | "unsupported_constraint"
  | "capability_missing"
  | "capability_metadata_invalid"
  | "resolved_state_invalid"
  | "capability_inactive"
  | "explicit_deny"
  | "step_up_required"
  | "approval_required";

export type ActiveContextDecision = {
  allowed: boolean;
  reason: ActiveContextDecisionReason;
  receipt: {
    tenantId: string;
    contextId: string;
    actorPrincipalId: string;
    membershipId: string;
    assignmentIds: string[];
    rolePackageVersionIds: string[];
    capabilityKey: string;
    resourceType: string;
    resourceId: string;
    decision: "ALLOW" | "DENY";
    reasonCode: ActiveContextDecisionReason;
    policyVersionId: string;
  };
};

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_RE.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return (
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function hasStrongSecret(secret: unknown): secret is string {
  return typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= 32;
}

function isNullableUuidV7(value: unknown): value is string | null {
  return value === null || isUuidV7(value);
}

function isNullableBranchId(value: unknown): value is number | null {
  return value === null || (Number.isInteger(value) && Number(value) > 0);
}

function normalizeClaims(
  claims: ActiveTenantContextClaims,
): ActiveTenantContextClaims {
  const normalizedBase = {
    tokenVersion: 1,
    contextId: claims.contextId.toLowerCase(),
    tenantId: claims.tenantId.toLowerCase(),
    organizationId: claims.organizationId?.toLowerCase() ?? null,
    legacyBranchId: claims.legacyBranchId,
    principalId: claims.principalId.toLowerCase(),
    membershipId: claims.membershipId.toLowerCase(),
    assignmentIds: [...claims.assignmentIds]
      .map((id) => id.toLowerCase())
      .sort(),
    policyVersionId: claims.policyVersionId.toLowerCase(),
    policyVersion: claims.policyVersion,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  } as const;
  if (claims.tokenVersion === 2) {
    return {
      ...normalizedBase,
      tokenVersion: 2,
      selectionId: claims.selectionId.toLowerCase(),
      sessionGeneration: claims.sessionGeneration,
    };
  }
  return normalizedBase;
}

function parseClaims(value: unknown): ActiveTenantContextClaims | null {
  if (!isPlainRecord(value)) return null;
  const baseFields = [
    "assignmentIds",
    "contextId",
    "expiresAt",
    "issuedAt",
    "legacyBranchId",
    "membershipId",
    "organizationId",
    "policyVersion",
    "policyVersionId",
    "principalId",
    "tenantId",
    "tokenVersion",
  ] as const;
  const selectionBoundFields = [
    ...baseFields,
    "selectionId",
    "sessionGeneration",
  ] as const;
  const selectionBound = hasExactKeys(value, selectionBoundFields);
  if (!selectionBound && !hasExactKeys(value, baseFields)) {
    return null;
  }
  const claims = value as Partial<ActiveTenantContextClaims> & {
    selectionId?: unknown;
    sessionGeneration?: unknown;
  };
  if (
    claims.tokenVersion !== (selectionBound ? 2 : 1) ||
    !isUuidV7(claims.contextId) ||
    !isUuidV7(claims.tenantId) ||
    !isNullableUuidV7(claims.organizationId) ||
    !isNullableBranchId(claims.legacyBranchId) ||
    !isUuidV7(claims.principalId) ||
    !isUuidV7(claims.membershipId) ||
    !isUuidV7(claims.policyVersionId) ||
    !Number.isSafeInteger(claims.policyVersion) ||
    Number(claims.policyVersion) < 1 ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    !Array.isArray(claims.assignmentIds) ||
    claims.assignmentIds.length < 1 ||
    claims.assignmentIds.length > ACTIVE_CONTEXT_MAX_ASSIGNMENTS ||
    !claims.assignmentIds.every(isUuidV7)
  )
    return null;

  if (
    selectionBound &&
    (!isUuidV7(claims.selectionId) ||
      !Number.isSafeInteger(claims.sessionGeneration) ||
      Number(claims.sessionGeneration) < 1)
  ) {
    return null;
  }

  const normalized = normalizeClaims(claims as ActiveTenantContextClaims);
  if (
    new Set(normalized.assignmentIds).size !== normalized.assignmentIds.length
  )
    return null;
  if (normalized.expiresAt <= normalized.issuedAt) return null;
  if (normalized.expiresAt - normalized.issuedAt > ACTIVE_CONTEXT_TTL_MS)
    return null;
  return normalized;
}

function brandVerifiedContext(
  claims: ActiveTenantContextClaims,
): VerifiedActiveTenantContext {
  const context: VerifiedActiveTenantContext = {
    ...claims,
    assignmentIds: [...claims.assignmentIds],
    [VERIFIED_CONTEXT]: true,
  };
  Object.freeze(context.assignmentIds);
  Object.freeze(context);
  VERIFIED_CONTEXTS.add(context);
  return context;
}

export function signActiveTenantContext(
  claims: ActiveTenantContextClaims,
  secret: string,
): string {
  if (!hasStrongSecret(secret)) {
    throw new Error(
      "ACTIVE_CONTEXT_SIGNING_SECRET must contain at least 32 UTF-8 bytes",
    );
  }
  const normalized = parseClaims(claims);
  if (!normalized) throw new Error("Active tenant context claims are invalid");
  const payload = Buffer.from(JSON.stringify(normalized), "utf8").toString(
    "base64url",
  );
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`fas-active-context-v1:${payload}`)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyActiveTenantContext(
  token: string | undefined,
  secret: string | undefined,
  now = Date.now(),
): ActiveContextVerificationResult {
  if (!token) return { ok: false, reason: "missing_token" };
  if (!hasStrongSecret(secret)) {
    return { ok: false, reason: "signing_secret_unavailable" };
  }
  if (token.length > 8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, reason: "malformed_token" };
  }
  try {
    const [payload, signature] = token.split(".");
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`fas-active-context-v1:${payload}`)
      .digest("base64url");
    const actualBuffer = Buffer.from(signature, "base64url");
    const expectedBuffer = Buffer.from(expected, "base64url");
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(actualBuffer, expectedBuffer)
    )
      return { ok: false, reason: "invalid_signature" };

    const decoded = Buffer.from(payload, "base64url").toString("utf8");
    const claims = parseClaims(JSON.parse(decoded));
    if (!claims) return { ok: false, reason: "invalid_claims" };
    if (claims.issuedAt > now + ACTIVE_CONTEXT_CLOCK_SKEW_MS) {
      return { ok: false, reason: "not_yet_valid" };
    }
    if (now >= claims.expiresAt) return { ok: false, reason: "expired" };
    return { ok: true, context: brandVerifiedContext(claims) };
  } catch {
    return { ok: false, reason: "malformed_token" };
  }
}

type ActiveContextVersionedHeader = {
  type: typeof ACTIVE_CONTEXT_V2_TYPE;
  envelopeVersion: 2;
  algorithm: typeof ACTIVE_CONTEXT_V2_ALGORITHM;
  keyId: string;
};

type ActiveContextVersionedPayload = ActiveTenantContextClaims & {
  audience: string;
  environmentId: string;
  cellId: string;
  issuerId: string;
  keyId: string;
  notBefore: number;
};

const ACTIVE_CONTEXT_V2_DOMAIN = "fas-active-context-v2";
const ACTIVE_CONTEXT_KEY_FIELDS = [
  "algorithm",
  "cellId",
  "environmentId",
  "issuerId",
  "keyId",
  "publicKeyFingerprint",
  "publicKeyPem",
  "signFrom",
  "signUntil",
  "state",
  "verifyUntil",
] as const;
const ACTIVE_CONTEXT_EXPECTED_FIELDS = [
  "audience",
  "cellId",
  "environmentId",
  "issuerId",
  "tenantId",
] as const;
const ACTIVE_CONTEXT_SUBJECT_FIELDS = [
  "assignmentIds",
  "contextId",
  "legacyBranchId",
  "membershipId",
  "organizationId",
  "policyVersion",
  "policyVersionId",
  "principalId",
  "tenantId",
] as const;
const ACTIVE_CONTEXT_SELECTION_SUBJECT_FIELDS = [
  ...ACTIVE_CONTEXT_SUBJECT_FIELDS,
  "selectionId",
  "sessionGeneration",
] as const;
const ACTIVE_CONTEXT_V2_PAYLOAD_FIELDS = [
  ...ACTIVE_CONTEXT_SUBJECT_FIELDS,
  "audience",
  "cellId",
  "environmentId",
  "expiresAt",
  "issuedAt",
  "issuerId",
  "keyId",
  "notBefore",
  "tokenVersion",
] as const;
const ACTIVE_CONTEXT_SELECTION_V2_PAYLOAD_FIELDS = [
  ...ACTIVE_CONTEXT_SELECTION_SUBJECT_FIELDS,
  "audience",
  "cellId",
  "environmentId",
  "expiresAt",
  "issuedAt",
  "issuerId",
  "keyId",
  "notBefore",
  "tokenVersion",
] as const;

export function fingerprintActiveContextPublicKey(publicKeyPem: string): string {
  if (
    typeof publicKeyPem !== "string" ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(publicKeyPem)
  ) {
    throw new Error("active_context_public_key_material_invalid");
  }
  const key = crypto.createPublicKey(publicKeyPem);
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("active_context_public_key_algorithm_invalid");
  }
  const der = key.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

function parseVersionedKeyRing(
  value: unknown,
): ActiveContextVerificationKey[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const parsed: ActiveContextVerificationKey[] = [];
  const keyIds = new Set<string>();
  for (const candidate of value) {
    if (!isPlainRecord(candidate) || !hasExactKeys(candidate, ACTIVE_CONTEXT_KEY_FIELDS)) {
      return null;
    }
    if (
      typeof candidate.keyId !== "string" ||
      !KEY_ID_RE.test(candidate.keyId) ||
      candidate.algorithm !== ACTIVE_CONTEXT_V2_ALGORITHM ||
      !["ACTIVE", "VERIFY_ONLY", "REVOKED", "COMPROMISED"].includes(
        String(candidate.state),
      ) ||
      !isUuidV7(candidate.issuerId) ||
      typeof candidate.environmentId !== "string" ||
      !DEPLOYMENT_ID_RE.test(candidate.environmentId) ||
      typeof candidate.cellId !== "string" ||
      !DEPLOYMENT_ID_RE.test(candidate.cellId) ||
      typeof candidate.publicKeyPem !== "string" ||
      Buffer.byteLength(candidate.publicKeyPem, "utf8") > 8192 ||
      typeof candidate.publicKeyFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(candidate.publicKeyFingerprint) ||
      !Number.isSafeInteger(candidate.signFrom) ||
      !Number.isSafeInteger(candidate.signUntil) ||
      !Number.isSafeInteger(candidate.verifyUntil) ||
      Number(candidate.signFrom) < 0 ||
      Number(candidate.signUntil) <= Number(candidate.signFrom) ||
      Number(candidate.verifyUntil) < Number(candidate.signUntil)
    ) {
      return null;
    }
    let fingerprint: string;
    try {
      fingerprint = fingerprintActiveContextPublicKey(candidate.publicKeyPem);
    } catch {
      return null;
    }
    if (fingerprint !== candidate.publicKeyFingerprint || keyIds.has(candidate.keyId)) {
      return null;
    }
    keyIds.add(candidate.keyId);
    parsed.push({
      keyId: candidate.keyId,
      algorithm: ACTIVE_CONTEXT_V2_ALGORITHM,
      state: candidate.state as ActiveContextKeyState,
      issuerId: candidate.issuerId.toLowerCase(),
      environmentId: candidate.environmentId,
      cellId: candidate.cellId,
      publicKeyPem: candidate.publicKeyPem,
      publicKeyFingerprint: candidate.publicKeyFingerprint,
      signFrom: Number(candidate.signFrom),
      signUntil: Number(candidate.signUntil),
      verifyUntil: Number(candidate.verifyUntil),
    });
  }
  return parsed;
}

function parseVersionedExpected(
  value: unknown,
): ActiveContextVersionedTokenExpected | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, ACTIVE_CONTEXT_EXPECTED_FIELDS)) {
    return null;
  }
  if (
    typeof value.audience !== "string" ||
    !AUDIENCE_RE.test(value.audience) ||
    typeof value.environmentId !== "string" ||
    !DEPLOYMENT_ID_RE.test(value.environmentId) ||
    typeof value.cellId !== "string" ||
    !DEPLOYMENT_ID_RE.test(value.cellId) ||
    !isUuidV7(value.issuerId) ||
    !isUuidV7(value.tenantId)
  ) {
    return null;
  }
  return {
    audience: value.audience,
    environmentId: value.environmentId,
    cellId: value.cellId,
    issuerId: value.issuerId.toLowerCase(),
    tenantId: value.tenantId.toLowerCase(),
  };
}

function parseVersionedHeader(value: unknown): ActiveContextVersionedHeader | null {
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ["algorithm", "envelopeVersion", "keyId", "type"]) ||
    value.type !== ACTIVE_CONTEXT_V2_TYPE ||
    value.envelopeVersion !== 2 ||
    typeof value.keyId !== "string" ||
    !KEY_ID_RE.test(value.keyId)
  ) {
    return null;
  }
  if (value.algorithm !== ACTIVE_CONTEXT_V2_ALGORITHM) return null;
  return {
    type: ACTIVE_CONTEXT_V2_TYPE,
    envelopeVersion: 2,
    algorithm: ACTIVE_CONTEXT_V2_ALGORITHM,
    keyId: value.keyId,
  };
}

function parseVersionedPayload(value: unknown): ActiveContextVersionedPayload | null {
  if (
    !isPlainRecord(value) ||
    (!hasExactKeys(value, ACTIVE_CONTEXT_V2_PAYLOAD_FIELDS) &&
      !hasExactKeys(value, ACTIVE_CONTEXT_SELECTION_V2_PAYLOAD_FIELDS)) ||
    typeof value.audience !== "string" ||
    !AUDIENCE_RE.test(value.audience) ||
    typeof value.environmentId !== "string" ||
    !DEPLOYMENT_ID_RE.test(value.environmentId) ||
    typeof value.cellId !== "string" ||
    !DEPLOYMENT_ID_RE.test(value.cellId) ||
    !isUuidV7(value.issuerId) ||
    typeof value.keyId !== "string" ||
    !KEY_ID_RE.test(value.keyId) ||
    !Number.isSafeInteger(value.notBefore)
  ) {
    return null;
  }
  const claims = parseClaims({
    tokenVersion: value.tokenVersion,
    contextId: value.contextId,
    tenantId: value.tenantId,
    organizationId: value.organizationId,
    legacyBranchId: value.legacyBranchId,
    principalId: value.principalId,
    membershipId: value.membershipId,
    assignmentIds: value.assignmentIds,
    policyVersionId: value.policyVersionId,
    policyVersion: value.policyVersion,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
    ...(Object.hasOwn(value, "selectionId")
      ? {
          selectionId: value.selectionId,
          sessionGeneration: value.sessionGeneration,
        }
      : {}),
  });
  if (
    !claims ||
    Number(value.notBefore) < claims.issuedAt ||
    Number(value.notBefore) >= claims.expiresAt
  ) {
    return null;
  }
  return {
    ...claims,
    audience: value.audience,
    environmentId: value.environmentId,
    cellId: value.cellId,
    issuerId: value.issuerId.toLowerCase(),
    keyId: value.keyId,
    notBefore: Number(value.notBefore),
  };
}

function decodeVersionedJson(segment: string): unknown {
  const bytes = Buffer.from(segment, "base64url");
  if (bytes.toString("base64url") !== segment) {
    throw new Error("non_canonical_base64url");
  }
  return JSON.parse(bytes.toString("utf8"));
}

function versionedSigningInput(header: string, payload: string) {
  return Buffer.from(`${ACTIVE_CONTEXT_V2_DOMAIN}\0${header}.${payload}`, "utf8");
}

export async function issueVersionedActiveTenantContext(
  options: ActiveContextVersionedIssuanceOptions,
): Promise<string> {
  const now = options?.now ?? Date.now();
  const ttlMs = options?.ttlMs ?? ACTIVE_CONTEXT_TTL_MS;
  if (
    !options ||
    !isPlainRecord(options.subject) ||
    (!hasExactKeys(options.subject, ACTIVE_CONTEXT_SUBJECT_FIELDS) &&
      !hasExactKeys(options.subject, ACTIVE_CONTEXT_SELECTION_SUBJECT_FIELDS)) ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > ACTIVE_CONTEXT_TTL_MS ||
    typeof options.keyReference !== "string" ||
    !OPAQUE_SIGNER_REF_RE.test(options.keyReference) ||
    (options.keyReference.startsWith("test-memory://") &&
      (options.environmentId !== "test" || process.env.NODE_ENV === "production")) ||
    !isPlainRecord(options.signer) ||
    typeof options.signer.sign !== "function"
  ) {
    throw new Error("active_context_issuance_configuration_invalid");
  }
  const expected = parseVersionedExpected({
    audience: options.audience,
    environmentId: options.environmentId,
    cellId: options.cellId,
    issuerId: options.issuerId,
    tenantId: options.subject.tenantId,
  });
  const keyRing = parseVersionedKeyRing(options.keyRing);
  if (!expected || !keyRing) {
    throw new Error("active_context_issuance_configuration_invalid");
  }
  const key = keyRing.find((candidate) => candidate.keyId === options.keyId);
  if (!key) throw new Error("active_context_signing_key_unknown");
  if (
    key.state !== "ACTIVE" ||
    key.algorithm !== ACTIVE_CONTEXT_V2_ALGORITHM ||
    key.issuerId !== expected.issuerId ||
    key.environmentId !== expected.environmentId ||
    key.cellId !== expected.cellId ||
    now < key.signFrom ||
    now >= key.signUntil ||
    now + ttlMs > key.verifyUntil
  ) {
    throw new Error("active_context_signing_key_unavailable");
  }
  const selectionBound =
    isPlainRecord(options.subject) &&
    Object.hasOwn(options.subject, "selectionId") &&
    Object.hasOwn(options.subject, "sessionGeneration");
  const claims = parseClaims({
    ...options.subject,
    tokenVersion: selectionBound ? 2 : 1,
    issuedAt: now,
    expiresAt: now + ttlMs,
  });
  if (!claims || claims.tenantId !== expected.tenantId) {
    throw new Error("active_context_issuance_subject_invalid");
  }
  const header: ActiveContextVersionedHeader = {
    type: ACTIVE_CONTEXT_V2_TYPE,
    envelopeVersion: 2,
    algorithm: ACTIVE_CONTEXT_V2_ALGORITHM,
    keyId: key.keyId,
  };
  const payload: ActiveContextVersionedPayload = {
    ...claims,
    audience: expected.audience,
    environmentId: expected.environmentId,
    cellId: expected.cellId,
    issuerId: expected.issuerId,
    keyId: key.keyId,
    notBefore: now,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  const signingInput = versionedSigningInput(encodedHeader, encodedPayload);
  const signature = await options.signer.sign({
    keyReference: options.keyReference,
    algorithm: ACTIVE_CONTEXT_V2_ALGORITHM,
    signingInput: Buffer.from(signingInput),
  });
  if (
    !Buffer.isBuffer(signature) ||
    signature.length !== 64 ||
    !crypto.verify(null, signingInput, key.publicKeyPem, signature)
  ) {
    throw new Error("active_context_signer_result_invalid");
  }
  return `${encodedHeader}.${encodedPayload}.${signature.toString("base64url")}`;
}

export function verifyVersionedActiveTenantContext(input: {
  token: string | undefined;
  keyRing: readonly ActiveContextVerificationKey[];
  expected: ActiveContextVersionedTokenExpected;
  expectedSelectionBinding?: ActiveContextSelectionBinding;
  now?: number;
}): ActiveContextVersionedVerificationResult {
  if (!input?.token) return { ok: false, reason: "missing_token" };
  const now = input.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, reason: "clock_invalid" };
  }
  const expected = parseVersionedExpected(input.expected);
  if (!expected) return { ok: false, reason: "expected_context_invalid" };
  const keyRing = parseVersionedKeyRing(input.keyRing);
  if (!keyRing) return { ok: false, reason: "key_ring_invalid" };
  if (
    input.token.length > 16384 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input.token)
  ) {
    return { ok: false, reason: "malformed_token" };
  }
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = input.token.split(".");
    const rawHeader = decodeVersionedJson(encodedHeader);
    if (
      isPlainRecord(rawHeader) &&
      rawHeader.algorithm !== ACTIVE_CONTEXT_V2_ALGORITHM
    ) {
      return { ok: false, reason: "algorithm_mismatch" };
    }
    const header = parseVersionedHeader(rawHeader);
    if (!header) return { ok: false, reason: "malformed_token" };
    const key = keyRing.find((candidate) => candidate.keyId === header.keyId);
    if (!key) return { ok: false, reason: "unknown_key" };
    if (key.algorithm !== header.algorithm) {
      return { ok: false, reason: "algorithm_mismatch" };
    }
    if (key.state === "REVOKED" || key.state === "COMPROMISED") {
      return { ok: false, reason: "key_inactive" };
    }
    if (now >= key.verifyUntil) {
      return { ok: false, reason: "key_window_invalid" };
    }
    const signature = Buffer.from(encodedSignature, "base64url");
    if (
      signature.toString("base64url") !== encodedSignature ||
      signature.length !== 64 ||
      !crypto.verify(
        null,
        versionedSigningInput(encodedHeader, encodedPayload),
        key.publicKeyPem,
        signature,
      )
    ) {
      return { ok: false, reason: "invalid_signature" };
    }
    const payload = parseVersionedPayload(decodeVersionedJson(encodedPayload));
    if (!payload) return { ok: false, reason: "invalid_claims" };
    if (payload.keyId !== key.keyId) {
      return { ok: false, reason: "unknown_key" };
    }
    if (payload.audience !== expected.audience) {
      return { ok: false, reason: "audience_mismatch" };
    }
    if (
      payload.environmentId !== expected.environmentId ||
      key.environmentId !== expected.environmentId
    ) {
      return { ok: false, reason: "environment_mismatch" };
    }
    if (payload.cellId !== expected.cellId || key.cellId !== expected.cellId) {
      return { ok: false, reason: "cell_mismatch" };
    }
    if (payload.issuerId !== expected.issuerId || key.issuerId !== expected.issuerId) {
      return { ok: false, reason: "issuer_mismatch" };
    }
    if (payload.tenantId !== expected.tenantId) {
      return { ok: false, reason: "tenant_mismatch" };
    }
    if (input.expectedSelectionBinding !== undefined) {
      const expectedBinding = input.expectedSelectionBinding;
      if (
        !isUuidV7(expectedBinding.selectionId) ||
        !Number.isSafeInteger(expectedBinding.sessionGeneration) ||
        expectedBinding.sessionGeneration < 1
      ) {
        return { ok: false, reason: "selection_binding_mismatch" };
      }
      if (payload.tokenVersion !== 2) {
        return { ok: false, reason: "selection_binding_missing" };
      }
      if (
        payload.selectionId !== expectedBinding.selectionId.toLowerCase() ||
        payload.sessionGeneration !== expectedBinding.sessionGeneration
      ) {
        return { ok: false, reason: "selection_binding_mismatch" };
      }
    }
    if (
      payload.issuedAt < key.signFrom ||
      payload.issuedAt >= key.signUntil ||
      payload.expiresAt > key.verifyUntil
    ) {
      return { ok: false, reason: "key_window_invalid" };
    }
    if (payload.notBefore > now + ACTIVE_CONTEXT_CLOCK_SKEW_MS) {
      return { ok: false, reason: "not_yet_valid" };
    }
    if (now >= payload.expiresAt) return { ok: false, reason: "expired" };
    const contextClaims = parseClaims({
      tokenVersion: payload.tokenVersion,
      contextId: payload.contextId,
      tenantId: payload.tenantId,
      organizationId: payload.organizationId,
      legacyBranchId: payload.legacyBranchId,
      principalId: payload.principalId,
      membershipId: payload.membershipId,
      assignmentIds: payload.assignmentIds,
      policyVersionId: payload.policyVersionId,
      policyVersion: payload.policyVersion,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      ...(payload.tokenVersion === 2
        ? {
            selectionId: payload.selectionId,
            sessionGeneration: payload.sessionGeneration,
          }
        : {}),
    });
    if (!contextClaims) return { ok: false, reason: "invalid_claims" };
    return {
      ok: true,
      context: brandVerifiedContext(contextClaims),
      envelope: {
        envelopeVersion: 2,
        algorithm: ACTIVE_CONTEXT_V2_ALGORITHM,
        keyId: key.keyId,
        audience: payload.audience,
        environmentId: payload.environmentId,
        cellId: payload.cellId,
        issuerId: payload.issuerId,
        notBefore: payload.notBefore,
      },
    };
  } catch {
    return { ok: false, reason: "malformed_token" };
  }
}

export function isVerifiedActiveTenantContext(
  value: unknown,
  now = Date.now(),
): value is VerifiedActiveTenantContext {
  if (!Number.isSafeInteger(now) || now < 0) return false;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<VerifiedActiveTenantContext> & {
    selectionId?: unknown;
    sessionGeneration?: unknown;
  };
  if (candidate[VERIFIED_CONTEXT] !== true || !VERIFIED_CONTEXTS.has(value)) {
    return false;
  }
  const normalized = parseClaims(value);
  if (!normalized) return false;
  if (
    normalized.issuedAt > now + ACTIVE_CONTEXT_CLOCK_SKEW_MS ||
    now >= normalized.expiresAt
  ) {
    return false;
  }
  return (
    candidate.tokenVersion === normalized.tokenVersion &&
    candidate.contextId === normalized.contextId &&
    candidate.tenantId === normalized.tenantId &&
    candidate.organizationId === normalized.organizationId &&
    candidate.legacyBranchId === normalized.legacyBranchId &&
    candidate.principalId === normalized.principalId &&
    candidate.membershipId === normalized.membershipId &&
    Array.isArray(candidate.assignmentIds) &&
    candidate.assignmentIds.length === normalized.assignmentIds.length &&
    candidate.assignmentIds.every(
      (assignmentId, index) => assignmentId === normalized.assignmentIds[index],
    ) &&
    candidate.policyVersionId === normalized.policyVersionId &&
    candidate.policyVersion === normalized.policyVersion &&
    candidate.issuedAt === normalized.issuedAt &&
    candidate.expiresAt === normalized.expiresAt &&
    (normalized.tokenVersion === 1
      ? !Object.hasOwn(candidate, "selectionId") &&
        !Object.hasOwn(candidate, "sessionGeneration")
      : candidate.selectionId === normalized.selectionId &&
        candidate.sessionGeneration === normalized.sessionGeneration)
  );
}

export function isSelectionBoundActiveTenantContext(
  value: unknown,
  now = Date.now(),
): value is VerifiedActiveTenantContext & {
  tokenVersion: 2;
  selectionId: string;
  sessionGeneration: number;
} {
  const candidate = value as Partial<VerifiedActiveTenantContext> & {
    selectionId?: unknown;
    sessionGeneration?: unknown;
  };
  return (
    isVerifiedActiveTenantContext(value, now) &&
    candidate.tokenVersion === 2 &&
    isUuidV7(candidate.selectionId) &&
    Number.isSafeInteger(candidate.sessionGeneration) &&
    Number(candidate.sessionGeneration) > 0
  );
}

function isCurrentWindow(
  from: number,
  until: number | null,
  now: number,
): boolean {
  return from <= now && (until === null || now < until);
}

function sameIds(expected: string[], actual: string[]): boolean {
  if (expected.length !== actual.length) return false;
  const left = [...expected].map((id) => id.toLowerCase()).sort();
  const right = [...actual].map((id) => id.toLowerCase()).sort();
  return left.every((id, index) => id === right[index]);
}

function assignmentMatchesContext(
  assignment: ResolvedAccessAssignment,
  context: VerifiedActiveTenantContext,
): boolean {
  if (assignment.scopeType === "TENANT") return true;
  if (assignment.scopeType === "ORGANIZATION") {
    return assignment.organizationId === context.organizationId;
  }
  if (assignment.scopeType !== "LEGACY_BRANCH") return false;
  return (
    assignment.organizationId === context.organizationId &&
    assignment.legacyBranchId === context.legacyBranchId
  );
}

function assignmentMatchesResource(
  assignment: ResolvedAccessAssignment,
  resource: ActiveContextResource,
): boolean {
  if (assignment.scopeType === "TENANT") return true;
  if (assignment.scopeType === "ORGANIZATION") {
    return assignment.organizationId === (resource.organizationId ?? null);
  }
  if (assignment.scopeType !== "LEGACY_BRANCH") return false;
  return (
    assignment.organizationId === (resource.organizationId ?? null) &&
    assignment.legacyBranchId === (resource.legacyBranchId ?? null)
  );
}

function hasValidResolvedCapabilities(
  value: unknown,
): value is ResolvedCapability[] {
  return (
    Array.isArray(value) &&
    value.every(
      (capability) =>
        capability !== null &&
        typeof capability === "object" &&
        !Array.isArray(capability) &&
        typeof capability.key === "string" &&
        CAPABILITY_RE.test(capability.key) &&
        (capability.effect === "ALLOW" || capability.effect === "DENY") &&
        ["ACTIVE", "DEPRECATED", "REVOKED"].includes(
          String(capability.status),
        ) &&
        typeof capability.stepUpRequired === "boolean" &&
        typeof capability.approvalRequired === "boolean",
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableSafeTimestamp(value: unknown): value is number | null {
  return value === null || isSafeTimestamp(value);
}

function hasValidResolvedStateShape(
  value: unknown,
): value is ResolvedActiveContextState {
  if (!isRecord(value)) return false;
  const { tenant, principal, membership, policy, assignments } = value;
  if (
    !isRecord(tenant) ||
    !isUuidV7(tenant.id) ||
    !["PROVISIONING", "ACTIVE", "SUSPENDED", "OFFBOARDING", "CLOSED"].includes(
      String(tenant.status),
    ) ||
    !Number.isSafeInteger(tenant.policyVersion) ||
    Number(tenant.policyVersion) < 1 ||
    !isRecord(principal) ||
    !isUuidV7(principal.id) ||
    !["HUMAN", "SERVICE", "INTEGRATION", "AI"].includes(
      String(principal.principalType),
    ) ||
    !["ACTIVE", "SUSPENDED", "REVOKED"].includes(String(principal.status)) ||
    !["NORMAL", "STEP_UP_REQUIRED", "LOCKED"].includes(
      String(principal.riskState),
    ) ||
    !isRecord(membership) ||
    !isUuidV7(membership.id) ||
    !isUuidV7(membership.tenantId) ||
    !isNullableUuidV7(membership.organizationId) ||
    !isNullableBranchId(membership.legacyBranchId) ||
    (membership.legacyBranchId !== null && membership.organizationId === null) ||
    !isUuidV7(membership.principalId) ||
    !["PENDING", "ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"].includes(
      String(membership.status),
    ) ||
    !isSafeTimestamp(membership.validFrom) ||
    !isNullableSafeTimestamp(membership.validUntil) ||
    (membership.validUntil !== null &&
      membership.validUntil <= membership.validFrom) ||
    !isRecord(policy) ||
    !isUuidV7(policy.id) ||
    !isUuidV7(policy.tenantId) ||
    !Number.isSafeInteger(policy.version) ||
    Number(policy.version) < 1 ||
    !["DRAFT", "ACTIVE", "REVOKED"].includes(String(policy.state)) ||
    !isNullableSafeTimestamp(policy.effectiveAt) ||
    !isNullableSafeTimestamp(policy.revokedAt) ||
    !Array.isArray(assignments) ||
    assignments.length > ACTIVE_CONTEXT_MAX_ASSIGNMENTS
  ) {
    return false;
  }

  return assignments.every((assignment) => {
    if (!isRecord(assignment)) return false;
    const scopeType = assignment.scopeType;
    const scopeIsValid =
      (scopeType === "TENANT" &&
        assignment.organizationId === null &&
        assignment.legacyBranchId === null) ||
      (scopeType === "ORGANIZATION" &&
        isUuidV7(assignment.organizationId) &&
        assignment.legacyBranchId === null) ||
      (scopeType === "LEGACY_BRANCH" &&
        isUuidV7(assignment.organizationId) &&
        isNullableBranchId(assignment.legacyBranchId) &&
        assignment.legacyBranchId !== null);
    return (
      isUuidV7(assignment.id) &&
      isUuidV7(assignment.tenantId) &&
      isUuidV7(assignment.membershipId) &&
      ["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"].includes(
        String(assignment.status),
      ) &&
      isSafeTimestamp(assignment.validFrom) &&
      isNullableSafeTimestamp(assignment.validUntil) &&
      (assignment.validUntil === null ||
        assignment.validUntil > assignment.validFrom) &&
      scopeIsValid &&
      isRecord(assignment.constraintDocument) &&
      isUuidV7(assignment.rolePackageVersionId) &&
      ["DRAFT", "ACTIVE", "DEPRECATED", "REVOKED"].includes(
        String(assignment.rolePackageStatus),
      ) &&
      ["HUMAN", "SERVICE", "INTEGRATION", "AI"].includes(
        String(assignment.rolePackagePrincipalType),
      ) &&
      isNullableSafeTimestamp(assignment.rolePackageEffectiveAt) &&
      isNullableSafeTimestamp(assignment.rolePackageDeprecatedAt) &&
      hasValidResolvedCapabilities(assignment.capabilities)
    );
  });
}

export function evaluateActiveTenantCapability(input: {
  context: VerifiedActiveTenantContext;
  state: ResolvedActiveContextState;
  capabilityKey: string;
  resource: ActiveContextResource;
  stepUpSatisfied?: boolean;
  approvalSatisfied?: boolean;
  now?: number;
}): ActiveContextDecision {
  const { context, state, resource } = input;
  const now = input.now ?? Date.now();
  const safeAssignments = Array.isArray(state?.assignments)
    ? state.assignments.filter(isRecord)
    : [];
  const assignmentIds = safeAssignments
    .map((assignment) => assignment.id)
    .filter((id): id is string => typeof id === "string");
  const packageIds = [
    ...new Set(
      safeAssignments
        .map((assignment) => assignment.rolePackageVersionId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ].sort();
  const decide = (
    allowed: boolean,
    reason: ActiveContextDecisionReason,
  ): ActiveContextDecision => ({
    allowed,
    reason,
    receipt: {
      tenantId: context.tenantId,
      contextId: context.contextId,
      actorPrincipalId: context.principalId,
      membershipId: context.membershipId,
      assignmentIds: [...context.assignmentIds],
      rolePackageVersionIds: packageIds,
      capabilityKey: input.capabilityKey,
      resourceType: resource.type,
      resourceId: resource.id,
      decision: allowed ? "ALLOW" : "DENY",
      reasonCode: reason,
      policyVersionId: context.policyVersionId,
    },
  });

  if (!isVerifiedActiveTenantContext(context, now)) {
    return decide(false, "context_not_current");
  }
  if (!hasValidResolvedStateShape(state)) {
    return decide(false, "resolved_state_invalid");
  }
  if (!CAPABILITY_RE.test(input.capabilityKey))
    return decide(false, "capability_missing");
  if (resource.tenantId !== context.tenantId)
    return decide(false, "resource_not_found");
  if (
    (context.organizationId !== null &&
      (resource.organizationId ?? null) !== context.organizationId) ||
    (context.legacyBranchId !== null &&
      (resource.legacyBranchId ?? null) !== context.legacyBranchId)
  )
    return decide(false, "resource_not_found");
  if (state.tenant.id !== context.tenantId)
    return decide(false, "context_tenant_mismatch");
  if (state.tenant.status !== "ACTIVE") return decide(false, "tenant_inactive");
  if (state.principal.id !== context.principalId)
    return decide(false, "principal_mismatch");
  if (state.principal.status !== "ACTIVE")
    return decide(false, "principal_inactive");
  if (state.principal.riskState !== "NORMAL")
    return decide(false, "principal_risk_blocked");
  if (
    state.membership.id !== context.membershipId ||
    state.membership.tenantId !== context.tenantId ||
    state.membership.principalId !== context.principalId
  )
    return decide(false, "membership_mismatch");
  if (state.principal.principalType !== "HUMAN") {
    return decide(false, "principal_type_mismatch");
  }
  if (state.membership.status !== "ACTIVE")
    return decide(false, "membership_inactive");
  if (
    !isCurrentWindow(
      state.membership.validFrom,
      state.membership.validUntil,
      now,
    )
  ) {
    return decide(false, "membership_expired");
  }
  if (
    state.membership.organizationId !== context.organizationId ||
    state.membership.legacyBranchId !== context.legacyBranchId
  )
    return decide(false, "context_scope_mismatch");
  if (
    state.policy.id !== context.policyVersionId ||
    state.policy.tenantId !== context.tenantId ||
    state.policy.version !== context.policyVersion ||
    state.tenant.policyVersion !== context.policyVersion
  )
    return decide(false, "policy_mismatch");
  if (
    state.policy.state !== "ACTIVE" ||
    state.policy.effectiveAt === null ||
    state.policy.effectiveAt > now ||
    state.policy.revokedAt !== null
  )
    return decide(false, "policy_inactive");
  if (!sameIds(context.assignmentIds, assignmentIds)) {
    return decide(false, "assignment_set_mismatch");
  }

  for (const assignment of state.assignments) {
    if (
      assignment.tenantId !== context.tenantId ||
      assignment.membershipId !== context.membershipId
    )
      return decide(false, "assignment_set_mismatch");
    if (assignment.status !== "ACTIVE")
      return decide(false, "assignment_inactive");
    if (!isCurrentWindow(assignment.validFrom, assignment.validUntil, now)) {
      return decide(false, "assignment_expired");
    }
    if (!assignmentMatchesContext(assignment, context)) {
      return decide(false, "assignment_scope_mismatch");
    }
    if (
      assignment.rolePackageStatus !== "ACTIVE" ||
      assignment.rolePackageEffectiveAt === null ||
      assignment.rolePackageEffectiveAt > now ||
      (assignment.rolePackageDeprecatedAt !== null &&
        now >= assignment.rolePackageDeprecatedAt)
    )
      return decide(false, "role_package_inactive");
    if (assignment.rolePackagePrincipalType !== state.principal.principalType) {
      return decide(false, "principal_type_mismatch");
    }
    if (
      assignment.constraintDocument === null ||
      typeof assignment.constraintDocument !== "object" ||
      Array.isArray(assignment.constraintDocument) ||
      Object.keys(assignment.constraintDocument).length > 0
    ) {
      return decide(false, "unsupported_constraint");
    }
    if (!hasValidResolvedCapabilities(assignment.capabilities)) {
      return decide(false, "capability_metadata_invalid");
    }
  }

  const scopedCapabilities = state.assignments
    .filter((assignment) => assignmentMatchesResource(assignment, resource))
    .flatMap((assignment) => assignment.capabilities)
    .filter((capability) => capability.key === input.capabilityKey);
  if (scopedCapabilities.length === 0)
    return decide(false, "capability_missing");
  if (scopedCapabilities.some((capability) => capability.effect === "DENY")) {
    return decide(false, "explicit_deny");
  }
  const allows = scopedCapabilities.filter(
    (capability) => capability.effect === "ALLOW",
  );
  if (allows.length === 0) return decide(false, "capability_missing");
  if (allows.some((capability) => capability.status !== "ACTIVE")) {
    return decide(false, "capability_inactive");
  }
  if (
    allows.some((capability) => capability.stepUpRequired) &&
    input.stepUpSatisfied !== true
  ) {
    return decide(false, "step_up_required");
  }
  if (
    allows.some((capability) => capability.approvalRequired) &&
    input.approvalSatisfied !== true
  ) {
    return decide(false, "approval_required");
  }
  return decide(true, "allowed");
}
