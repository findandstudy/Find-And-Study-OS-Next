import {
  isVerifiedActiveTenantContext,
  verifyActiveTenantContext,
  type ActiveContextVerificationFailure,
  type VerifiedActiveTenantContext,
} from "./activeTenantContext";
import {
  executeCreateR1ChangeSetCommand,
  executeTransitionR1ChangeSetCommand,
  type ChangeSetCommandAuditAttempt,
  type ChangeSetCommandAuditStart,
  type ChangeSetCommandAuditWriter,
  type ChangeSetCommandDependencies,
  type ChangeSetCommandResult,
  type ChangeSetCommandStore,
  type CreateR1ChangeSetCommand,
  type TransitionR1ChangeSetCommand,
} from "./changeSetCommand";

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ServerResolvedChangeSetRequestIdentity = {
  authenticatedPrincipalId: string;
  tenantId: string;
  organizationId: string | null;
  legacyBranchId: number | null;
};

export type ChangeSetRequestBindingFailure =
  | { reason: "request_identity_invalid" }
  | { reason: "clock_invalid" }
  | { reason: "active_context_rejected"; detail: ActiveContextVerificationFailure }
  | { reason: "authenticated_principal_mismatch" }
  | { reason: "branded_tenant_mismatch" }
  | { reason: "branded_organization_mismatch" }
  | { reason: "branded_branch_mismatch" };

export type ChangeSetRequestContextBinderOptions = {
  activeContextToken: string | undefined;
  activeContextSigningSecret: string | undefined;
  requestIdentity: unknown;
  createStore: (context: VerifiedActiveTenantContext) => ChangeSetCommandStore;
  createAuditWriter: (
    context: VerifiedActiveTenantContext,
  ) => ChangeSetCommandAuditWriter;
  nextUuidV7: () => string;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRequestIdentity(
  value: unknown,
): ServerResolvedChangeSetRequestIdentity | null {
  if (!isRecord(value)) return null;
  const exactKeys = [
    "authenticatedPrincipalId",
    "legacyBranchId",
    "organizationId",
    "tenantId",
  ].sort();
  if (Object.keys(value).sort().join("\0") !== exactKeys.join("\0")) return null;
  if (
    typeof value.authenticatedPrincipalId !== "string" ||
    !UUID_V7_RE.test(value.authenticatedPrincipalId) ||
    typeof value.tenantId !== "string" ||
    !UUID_V7_RE.test(value.tenantId) ||
    !(
      value.organizationId === null ||
      (typeof value.organizationId === "string" &&
        UUID_V7_RE.test(value.organizationId))
    ) ||
    !(
      value.legacyBranchId === null ||
      (Number.isSafeInteger(value.legacyBranchId) &&
        Number(value.legacyBranchId) > 0)
    ) ||
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

function validStore(value: unknown): value is ChangeSetCommandStore {
  return isRecord(value) && typeof value.transaction === "function";
}

function validAuditWriter(value: unknown): value is ChangeSetCommandAuditWriter {
  return isRecord(value) && typeof value.startAttempt === "function";
}

function sameAuditIdentity(
  context: VerifiedActiveTenantContext,
  input: ChangeSetCommandAuditStart,
): boolean {
  return (
    isRecord(input) &&
    typeof input.tenantId === "string" &&
    typeof input.contextId === "string" &&
    typeof input.actorPrincipalId === "string" &&
    typeof input.actorMembershipId === "string" &&
    typeof input.policyVersionId === "string" &&
    input.tenantId.toLowerCase() === context.tenantId &&
    input.contextId.toLowerCase() === context.contextId &&
    input.actorPrincipalId.toLowerCase() === context.principalId &&
    input.actorMembershipId.toLowerCase() === context.membershipId &&
    input.policyVersionId.toLowerCase() === context.policyVersionId
  );
}

export class ContextBoundChangeSetCommandAuditWriter
  implements ChangeSetCommandAuditWriter
{
  constructor(
    private readonly context: VerifiedActiveTenantContext,
    private readonly delegate: ChangeSetCommandAuditWriter,
    private readonly now: () => number = Date.now,
  ) {
    const current = this.now();
    if (
      !validAuditWriter(delegate) ||
      !Number.isSafeInteger(current) ||
      current < 0 ||
      !isVerifiedActiveTenantContext(context, current)
    ) {
      throw new Error("change_set_request_audit_binding_invalid");
    }
  }

  async startAttempt(
    input: ChangeSetCommandAuditStart,
  ): Promise<ChangeSetCommandAuditAttempt> {
    const current = this.now();
    if (
      !Number.isSafeInteger(current) ||
      current < 0 ||
      !isVerifiedActiveTenantContext(this.context, current)
    ) {
      throw new Error("change_set_request_context_expired");
    }
    if (!sameAuditIdentity(this.context, input)) {
      throw new Error("change_set_request_audit_context_mismatch");
    }
    return this.delegate.startAttempt(input);
  }
}

export interface BoundChangeSetRequestCommandGateway {
  executeCreate(command: CreateR1ChangeSetCommand): Promise<ChangeSetCommandResult>;
  executeTransition(
    command: TransitionR1ChangeSetCommand,
  ): Promise<ChangeSetCommandResult>;
}

class DefaultBoundChangeSetRequestCommandGateway
  implements BoundChangeSetRequestCommandGateway
{
  constructor(
    private readonly context: VerifiedActiveTenantContext,
    private readonly dependencies: ChangeSetCommandDependencies,
  ) {}

  executeCreate(
    command: CreateR1ChangeSetCommand,
  ): Promise<ChangeSetCommandResult> {
    return executeCreateR1ChangeSetCommand({
      context: this.context,
      command,
      dependencies: this.dependencies,
    });
  }

  executeTransition(
    command: TransitionR1ChangeSetCommand,
  ): Promise<ChangeSetCommandResult> {
    return executeTransitionR1ChangeSetCommand({
      context: this.context,
      command,
      dependencies: this.dependencies,
    });
  }
}

export function bindChangeSetRequestContext(
  options: ChangeSetRequestContextBinderOptions,
):
  | { ok: true; gateway: BoundChangeSetRequestCommandGateway }
  | { ok: false; error: ChangeSetRequestBindingFailure } {
  if (
    !options ||
    typeof options.createStore !== "function" ||
    typeof options.createAuditWriter !== "function" ||
    typeof options.nextUuidV7 !== "function" ||
    (options.now !== undefined && typeof options.now !== "function")
  ) {
    throw new Error("change_set_request_binding_configuration_invalid");
  }
  const identity = parseRequestIdentity(options.requestIdentity);
  if (!identity) return { ok: false, error: { reason: "request_identity_invalid" } };
  const now = options.now ?? Date.now;
  const current = now();
  if (!Number.isSafeInteger(current) || current < 0) {
    return { ok: false, error: { reason: "clock_invalid" } };
  }
  const verification = verifyActiveTenantContext(
    options.activeContextToken,
    options.activeContextSigningSecret,
    current,
  );
  if (!verification.ok) {
    return {
      ok: false,
      error: { reason: "active_context_rejected", detail: verification.reason },
    };
  }
  const context = verification.context;
  if (identity.authenticatedPrincipalId !== context.principalId) {
    return { ok: false, error: { reason: "authenticated_principal_mismatch" } };
  }
  if (identity.tenantId !== context.tenantId) {
    return { ok: false, error: { reason: "branded_tenant_mismatch" } };
  }
  if (identity.organizationId !== context.organizationId) {
    return { ok: false, error: { reason: "branded_organization_mismatch" } };
  }
  if (identity.legacyBranchId !== context.legacyBranchId) {
    return { ok: false, error: { reason: "branded_branch_mismatch" } };
  }

  const store = options.createStore(context);
  const auditDelegate = options.createAuditWriter(context);
  if (!validStore(store) || !validAuditWriter(auditDelegate)) {
    throw new Error("change_set_request_binding_dependency_invalid");
  }
  const auditWriter = new ContextBoundChangeSetCommandAuditWriter(
    context,
    auditDelegate,
    now,
  );
  return {
    ok: true,
    gateway: new DefaultBoundChangeSetRequestCommandGateway(context, {
      store,
      auditWriter,
      nextUuidV7: options.nextUuidV7,
      now,
    }),
  };
}
