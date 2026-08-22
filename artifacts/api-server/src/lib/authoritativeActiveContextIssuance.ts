import {
  ACTIVE_CONTEXT_MAX_ASSIGNMENTS,
  ACTIVE_CONTEXT_TTL_MS,
  issueVersionedActiveTenantContext,
  type ActiveContextExternalSigner,
  type ActiveContextVerificationKey,
} from "./activeTenantContext";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ACTIVE_CONTEXT_ISSUANCE_RESOLUTION_BUDGET_MS = 5_000;

export type AuthoritativeActiveContextRequest = {
  authenticatedPrincipalId: string;
  tenantId: string;
  organizationId: string | null;
  legacyBranchId: number | null;
};

export type AuthoritativeActiveContextState = {
  tenant: {
    id: string;
    status: "PROVISIONING" | "ACTIVE" | "SUSPENDED" | "OFFBOARDING" | "CLOSED";
    policyVersion: number;
  };
  principal: {
    id: string;
    principalType: "HUMAN" | "SERVICE" | "INTEGRATION" | "AI";
    status: "ACTIVE" | "SUSPENDED" | "REVOKED";
    riskState: "NORMAL" | "STEP_UP_REQUIRED" | "LOCKED";
  };
  membership: {
    id: string;
    tenantId: string;
    organizationId: string | null;
    legacyBranchId: number | null;
    principalId: string;
    status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED";
    validFrom: number;
    validUntil: number | null;
  };
  policy: {
    id: string;
    tenantId: string;
    version: number;
    state: "ACTIVE" | "DRAFT" | "REVOKED";
    effectiveAt: number | null;
    revokedAt: number | null;
  };
  assignments: Array<{
    id: string;
    tenantId: string;
    membershipId: string;
    status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED";
    validFrom: number;
    validUntil: number | null;
  }>;
};

export interface AuthoritativeActiveContextRepository {
  withLockedCurrentState(
    input: AuthoritativeActiveContextRequest & { observedAt: number },
    operation: (state: unknown) => Promise<string>,
  ): Promise<string>;
}

export type AuthoritativeActiveContextIssuanceFailure =
  | "request_invalid"
  | "clock_invalid"
  | "repository_unavailable"
  | "repository_contract_invalid"
  | "authoritative_state_invalid"
  | "tenant_inactive"
  | "principal_inactive"
  | "principal_risk_blocked"
  | "membership_inactive"
  | "membership_expired"
  | "scope_mismatch"
  | "policy_inactive"
  | "policy_mismatch"
  | "assignment_set_invalid"
  | "assignment_inactive"
  | "assignment_expired"
  | "resolution_timeout"
  | "signing_failed";

export type AuthoritativeActiveContextIssuanceOptions = {
  request: unknown;
  repository: AuthoritativeActiveContextRepository;
  audience: string;
  environmentId: string;
  cellId: string;
  issuerId: string;
  keyId: string;
  keyReference: string;
  keyRing: readonly ActiveContextVerificationKey[];
  signer: ActiveContextExternalSigner;
  nextUuidV7: () => string;
  ttlMs?: number;
  resolutionBudgetMs?: number;
  now?: () => number;
};

export type AuthoritativeActiveContextIssuanceResult =
  | {
      ok: true;
      token: string;
      contextId: string;
      issuedAt: number;
      expiresAt: number;
    }
  | { ok: false; reason: AuthoritativeActiveContextIssuanceFailure };

class IssuanceDenied extends Error {
  constructor(readonly reason: AuthoritativeActiveContextIssuanceFailure) {
    super(reason);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]) {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_RE.test(value);
}

function isNullableUuidV7(value: unknown): value is string | null {
  return value === null || isUuidV7(value);
}

function isBranch(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isTimestamp(value);
}

function parseRequest(value: unknown): AuthoritativeActiveContextRequest | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "authenticatedPrincipalId",
      "legacyBranchId",
      "organizationId",
      "tenantId",
    ]) ||
    !isUuidV7(value.authenticatedPrincipalId) ||
    !isUuidV7(value.tenantId) ||
    !isNullableUuidV7(value.organizationId) ||
    !isBranch(value.legacyBranchId) ||
    (value.legacyBranchId !== null && value.organizationId === null)
  ) {
    return null;
  }
  return {
    authenticatedPrincipalId: value.authenticatedPrincipalId.toLowerCase(),
    tenantId: value.tenantId.toLowerCase(),
    organizationId: value.organizationId?.toLowerCase() ?? null,
    legacyBranchId:
      value.legacyBranchId === null ? null : Number(value.legacyBranchId),
  };
}

function parseState(value: unknown): AuthoritativeActiveContextState | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["assignments", "membership", "policy", "principal", "tenant"]) ||
    !isRecord(value.tenant) ||
    !exactKeys(value.tenant, ["id", "policyVersion", "status"]) ||
    !isUuidV7(value.tenant.id) ||
    !["PROVISIONING", "ACTIVE", "SUSPENDED", "OFFBOARDING", "CLOSED"].includes(
      String(value.tenant.status),
    ) ||
    !Number.isSafeInteger(value.tenant.policyVersion) ||
    Number(value.tenant.policyVersion) < 1 ||
    !isRecord(value.principal) ||
    !exactKeys(value.principal, ["id", "principalType", "riskState", "status"]) ||
    !isUuidV7(value.principal.id) ||
    !["HUMAN", "SERVICE", "INTEGRATION", "AI"].includes(
      String(value.principal.principalType),
    ) ||
    !["ACTIVE", "SUSPENDED", "REVOKED"].includes(String(value.principal.status)) ||
    !["NORMAL", "STEP_UP_REQUIRED", "LOCKED"].includes(
      String(value.principal.riskState),
    ) ||
    !isRecord(value.membership) ||
    !exactKeys(value.membership, [
      "id",
      "legacyBranchId",
      "organizationId",
      "principalId",
      "status",
      "tenantId",
      "validFrom",
      "validUntil",
    ]) ||
    !isUuidV7(value.membership.id) ||
    !isUuidV7(value.membership.tenantId) ||
    !isNullableUuidV7(value.membership.organizationId) ||
    !isBranch(value.membership.legacyBranchId) ||
    !isUuidV7(value.membership.principalId) ||
    !["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"].includes(
      String(value.membership.status),
    ) ||
    !isTimestamp(value.membership.validFrom) ||
    !isNullableTimestamp(value.membership.validUntil) ||
    (value.membership.validUntil !== null &&
      Number(value.membership.validUntil) <= Number(value.membership.validFrom)) ||
    !isRecord(value.policy) ||
    !exactKeys(value.policy, [
      "effectiveAt",
      "id",
      "revokedAt",
      "state",
      "tenantId",
      "version",
    ]) ||
    !isUuidV7(value.policy.id) ||
    !isUuidV7(value.policy.tenantId) ||
    !Number.isSafeInteger(value.policy.version) ||
    Number(value.policy.version) < 1 ||
    !["ACTIVE", "DRAFT", "REVOKED"].includes(String(value.policy.state)) ||
    !isNullableTimestamp(value.policy.effectiveAt) ||
    !isNullableTimestamp(value.policy.revokedAt) ||
    !Array.isArray(value.assignments) ||
    value.assignments.length < 1 ||
    value.assignments.length > ACTIVE_CONTEXT_MAX_ASSIGNMENTS
  ) {
    return null;
  }
  const assignments: AuthoritativeActiveContextState["assignments"] = [];
  for (const assignment of value.assignments) {
    if (
      !isRecord(assignment) ||
      !exactKeys(assignment, [
        "id",
        "membershipId",
        "status",
        "tenantId",
        "validFrom",
        "validUntil",
      ]) ||
      !isUuidV7(assignment.id) ||
      !isUuidV7(assignment.tenantId) ||
      !isUuidV7(assignment.membershipId) ||
      !["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"].includes(
        String(assignment.status),
      ) ||
      !isTimestamp(assignment.validFrom) ||
      !isNullableTimestamp(assignment.validUntil) ||
      (assignment.validUntil !== null &&
        Number(assignment.validUntil) <= Number(assignment.validFrom))
    ) {
      return null;
    }
    assignments.push({
      id: assignment.id.toLowerCase(),
      tenantId: assignment.tenantId.toLowerCase(),
      membershipId: assignment.membershipId.toLowerCase(),
      status: assignment.status as AuthoritativeActiveContextState["assignments"][number]["status"],
      validFrom: Number(assignment.validFrom),
      validUntil:
        assignment.validUntil === null ? null : Number(assignment.validUntil),
    });
  }
  return {
    tenant: {
      id: value.tenant.id.toLowerCase(),
      status: value.tenant.status as AuthoritativeActiveContextState["tenant"]["status"],
      policyVersion: Number(value.tenant.policyVersion),
    },
    principal: {
      id: value.principal.id.toLowerCase(),
      principalType:
        value.principal.principalType as AuthoritativeActiveContextState["principal"]["principalType"],
      status: value.principal.status as AuthoritativeActiveContextState["principal"]["status"],
      riskState:
        value.principal.riskState as AuthoritativeActiveContextState["principal"]["riskState"],
    },
    membership: {
      id: value.membership.id.toLowerCase(),
      tenantId: value.membership.tenantId.toLowerCase(),
      organizationId: value.membership.organizationId?.toLowerCase() ?? null,
      legacyBranchId:
        value.membership.legacyBranchId === null
          ? null
          : Number(value.membership.legacyBranchId),
      principalId: value.membership.principalId.toLowerCase(),
      status:
        value.membership.status as AuthoritativeActiveContextState["membership"]["status"],
      validFrom: Number(value.membership.validFrom),
      validUntil:
        value.membership.validUntil === null
          ? null
          : Number(value.membership.validUntil),
    },
    policy: {
      id: value.policy.id.toLowerCase(),
      tenantId: value.policy.tenantId.toLowerCase(),
      version: Number(value.policy.version),
      state: value.policy.state as AuthoritativeActiveContextState["policy"]["state"],
      effectiveAt:
        value.policy.effectiveAt === null ? null : Number(value.policy.effectiveAt),
      revokedAt:
        value.policy.revokedAt === null ? null : Number(value.policy.revokedAt),
    },
    assignments,
  };
}

function requireCurrentState(
  request: AuthoritativeActiveContextRequest,
  state: AuthoritativeActiveContextState,
  now: number,
) {
  if (state.tenant.id !== request.tenantId) throw new IssuanceDenied("scope_mismatch");
  if (state.tenant.status !== "ACTIVE") throw new IssuanceDenied("tenant_inactive");
  if (state.principal.id !== request.authenticatedPrincipalId) {
    throw new IssuanceDenied("scope_mismatch");
  }
  if (state.principal.principalType !== "HUMAN" || state.principal.status !== "ACTIVE") {
    throw new IssuanceDenied("principal_inactive");
  }
  if (state.principal.riskState !== "NORMAL") {
    throw new IssuanceDenied("principal_risk_blocked");
  }
  if (
    state.membership.tenantId !== request.tenantId ||
    state.membership.principalId !== request.authenticatedPrincipalId ||
    state.membership.organizationId !== request.organizationId ||
    state.membership.legacyBranchId !== request.legacyBranchId
  ) {
    throw new IssuanceDenied("scope_mismatch");
  }
  if (state.membership.status !== "ACTIVE") {
    throw new IssuanceDenied("membership_inactive");
  }
  if (
    state.membership.validFrom > now ||
    (state.membership.validUntil !== null && now >= state.membership.validUntil)
  ) {
    throw new IssuanceDenied("membership_expired");
  }
  if (state.policy.tenantId !== request.tenantId || state.policy.state !== "ACTIVE") {
    throw new IssuanceDenied("policy_inactive");
  }
  if (
    state.policy.effectiveAt === null ||
    state.policy.effectiveAt > now ||
    state.policy.revokedAt !== null
  ) {
    throw new IssuanceDenied("policy_inactive");
  }
  if (state.policy.version !== state.tenant.policyVersion) {
    throw new IssuanceDenied("policy_mismatch");
  }
  const ids = state.assignments.map((assignment) => assignment.id).sort();
  if (new Set(ids).size !== ids.length) {
    throw new IssuanceDenied("assignment_set_invalid");
  }
  for (const assignment of state.assignments) {
    if (
      assignment.tenantId !== request.tenantId ||
      assignment.membershipId !== state.membership.id
    ) {
      throw new IssuanceDenied("assignment_set_invalid");
    }
    if (assignment.status !== "ACTIVE") {
      throw new IssuanceDenied("assignment_inactive");
    }
    if (
      assignment.validFrom > now ||
      (assignment.validUntil !== null && now >= assignment.validUntil)
    ) {
      throw new IssuanceDenied("assignment_expired");
    }
  }
  return ids;
}

export async function issueAuthoritativeActiveTenantContext(
  options: AuthoritativeActiveContextIssuanceOptions,
): Promise<AuthoritativeActiveContextIssuanceResult> {
  if (
    !options ||
    !isRecord(options.repository) ||
    typeof options.repository.withLockedCurrentState !== "function" ||
    !isRecord(options.signer) ||
    typeof options.signer.sign !== "function" ||
    typeof options.nextUuidV7 !== "function" ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    throw new Error("authoritative_active_context_configuration_invalid");
  }
  const request = parseRequest(options.request);
  if (!request) return { ok: false, reason: "request_invalid" };
  const now = options.now ?? Date.now;
  const startedAt = now();
  const budget =
    options.resolutionBudgetMs ?? ACTIVE_CONTEXT_ISSUANCE_RESOLUTION_BUDGET_MS;
  const ttlMs = options.ttlMs ?? ACTIVE_CONTEXT_TTL_MS;
  if (!isTimestamp(startedAt)) {
    return { ok: false, reason: "clock_invalid" };
  }
  if (
    !Number.isSafeInteger(budget) ||
    budget < 1 ||
    budget > 30_000 ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > ACTIVE_CONTEXT_TTL_MS
  ) {
    throw new Error("authoritative_active_context_configuration_invalid");
  }

  let operationCalls = 0;
  let issuedToken: string | undefined;
  let issuedContextId: string | undefined;
  let issuedAt: number | undefined;
  try {
    const returned = await options.repository.withLockedCurrentState(
      { ...request, observedAt: startedAt },
      async (rawState) => {
        operationCalls += 1;
        if (operationCalls !== 1) {
          throw new IssuanceDenied("repository_contract_invalid");
        }
        const current = now();
        if (!isTimestamp(current) || current < startedAt) {
          throw new IssuanceDenied("clock_invalid");
        }
        if (current - startedAt > budget) {
          throw new IssuanceDenied("resolution_timeout");
        }
        const state = parseState(rawState);
        if (!state) throw new IssuanceDenied("authoritative_state_invalid");
        const assignmentIds = requireCurrentState(request, state, current);
        const contextId = options.nextUuidV7();
        if (!isUuidV7(contextId)) {
          throw new IssuanceDenied("repository_contract_invalid");
        }
        let token: string;
        try {
          token = await issueVersionedActiveTenantContext({
            subject: {
              contextId,
              tenantId: request.tenantId,
              organizationId: request.organizationId,
              legacyBranchId: request.legacyBranchId,
              principalId: request.authenticatedPrincipalId,
              membershipId: state.membership.id,
              assignmentIds,
              policyVersionId: state.policy.id,
              policyVersion: state.policy.version,
            },
            audience: options.audience,
            environmentId: options.environmentId,
            cellId: options.cellId,
            issuerId: options.issuerId,
            keyId: options.keyId,
            keyReference: options.keyReference,
            keyRing: options.keyRing,
            signer: options.signer,
            ttlMs,
            now: current,
          });
        } catch {
          throw new IssuanceDenied("signing_failed");
        }
        const completedAt = now();
        if (
          !isTimestamp(completedAt) ||
          completedAt < current ||
          completedAt - startedAt > budget
        ) {
          throw new IssuanceDenied("resolution_timeout");
        }
        issuedToken = token;
        issuedContextId = contextId.toLowerCase();
        issuedAt = current;
        return token;
      },
    );
    if (
      operationCalls !== 1 ||
      !issuedToken ||
      returned !== issuedToken ||
      !issuedContextId ||
      issuedAt === undefined
    ) {
      return { ok: false, reason: "repository_contract_invalid" };
    }
    return {
      ok: true,
      token: issuedToken,
      contextId: issuedContextId,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
    };
  } catch (error) {
    if (error instanceof IssuanceDenied) {
      return { ok: false, reason: error.reason };
    }
    return {
      ok: false,
      reason: operationCalls === 0
        ? "repository_unavailable"
        : "repository_contract_invalid",
    };
  }
}
