import crypto from "node:crypto";

export const ACTIVE_CONTEXT_TTL_MS = 15 * 60 * 1000;
export const ACTIVE_CONTEXT_CLOCK_SKEW_MS = 30 * 1000;
export const ACTIVE_CONTEXT_MAX_ASSIGNMENTS = 32;

const VERIFIED_CONTEXT = Symbol("verified-active-tenant-context");
const VERIFIED_CONTEXTS = new WeakSet<object>();
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,2}$/;

export type ActiveTenantContextClaims = {
  tokenVersion: 1;
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
  return {
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
  };
}

function parseClaims(value: unknown): ActiveTenantContextClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const claims = value as Partial<ActiveTenantContextClaims>;
  if (
    claims.tokenVersion !== 1 ||
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
    const context: VerifiedActiveTenantContext = {
      ...claims,
      assignmentIds: [...claims.assignmentIds],
      [VERIFIED_CONTEXT]: true,
    };
    Object.freeze(context.assignmentIds);
    Object.freeze(context);
    VERIFIED_CONTEXTS.add(context);
    return { ok: true, context };
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
  const candidate = value as Partial<VerifiedActiveTenantContext>;
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
    candidate.expiresAt === normalized.expiresAt
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
