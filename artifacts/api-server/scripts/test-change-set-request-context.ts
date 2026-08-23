import assert from "node:assert/strict";
import test from "node:test";

import {
  signActiveTenantContext,
  verifyActiveTenantContext,
  type ActiveTenantContextClaims,
  type VerifiedActiveTenantContext,
} from "../src/lib/activeTenantContext.js";
import {
  type ChangeSetCommandAuditAttempt,
  type ChangeSetCommandAuditStart,
  type ChangeSetCommandAuditWriter,
  type ChangeSetCommandStore,
  type ChangeSetCommandTransaction,
} from "../src/lib/changeSetCommand.js";
import {
  bindChangeSetRequestContext,
  ContextBoundChangeSetCommandAuditWriter,
} from "../src/lib/changeSetRequestContext.js";

const NOW = 2_000_000_000_000;
const SECRET = "change-set-request-context-secret-32-bytes-minimum";
const ID = {
  context: "018f8000-0000-7000-8000-000000000001",
  tenant: "018f8000-0000-7000-8000-000000000002",
  otherTenant: "018f8000-0000-7000-8000-000000000003",
  organization: "018f8000-0000-7000-8000-000000000004",
  otherOrganization: "018f8000-0000-7000-8000-000000000005",
  principal: "018f8000-0000-7000-8000-000000000006",
  otherPrincipal: "018f8000-0000-7000-8000-000000000007",
  membership: "018f8000-0000-7000-8000-000000000008",
  assignment: "018f8000-0000-7000-8000-000000000009",
  policy: "018f8000-0000-7000-8000-00000000000a",
};

function claims(
  overrides: Partial<ActiveTenantContextClaims> = {},
): ActiveTenantContextClaims {
  return {
    tokenVersion: 1,
    contextId: ID.context,
    tenantId: ID.tenant,
    organizationId: ID.organization,
    legacyBranchId: 41,
    principalId: ID.principal,
    membershipId: ID.membership,
    assignmentIds: [ID.assignment],
    policyVersionId: ID.policy,
    policyVersion: 1,
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    ...overrides,
  };
}

function token(overrides: Partial<ActiveTenantContextClaims> = {}) {
  return signActiveTenantContext(claims(overrides), SECRET);
}

function verifiedContext(): VerifiedActiveTenantContext {
  const result = verifyActiveTenantContext(token(), SECRET, NOW);
  if (!result.ok) throw new Error(result.reason);
  return result.context;
}

function identity(overrides: Record<string, unknown> = {}) {
  return {
    authenticatedPrincipalId: ID.principal,
    tenantId: ID.tenant,
    organizationId: ID.organization,
    legacyBranchId: 41,
    ...overrides,
  };
}

class RecordingAuditWriter implements ChangeSetCommandAuditWriter {
  starts: ChangeSetCommandAuditStart[] = [];
  unexpectedErrors = 0;

  async startAttempt(
    input: ChangeSetCommandAuditStart,
  ): Promise<ChangeSetCommandAuditAttempt> {
    this.starts.push(structuredClone(input));
    return {
      attemptId: "018f8000-0000-7000-8000-00000000000b",
      recordResult: async () => undefined,
      recordReconciledResult: async () => undefined,
      recordCommitOutcomeUnknown: async () => undefined,
      recordUnexpectedError: async () => {
        this.unexpectedErrors += 1;
      },
    };
  }
}

class FailingStore implements ChangeSetCommandStore {
  contexts: VerifiedActiveTenantContext[] = [];

  async transaction<T>(
    context: VerifiedActiveTenantContext,
    _operation: (transaction: ChangeSetCommandTransaction) => Promise<T>,
  ): Promise<T> {
    this.contexts.push(context);
    throw new Error("request_context_store_sentinel");
  }
}

function validAuditStart(): ChangeSetCommandAuditStart {
  return {
    tenantId: ID.tenant,
    contextId: ID.context,
    actorPrincipalId: ID.principal,
    actorMembershipId: ID.membership,
    policyVersionId: ID.policy,
    commandType: "CREATE",
    targetState: null,
    capability: "control_plane.change.create",
    idempotencyKey: "request-context-create-0001",
    requestHash: "a".repeat(64),
  };
}

test("one verified context object binds store and separate audit writer", async () => {
  const store = new FailingStore();
  const audit = new RecordingAuditWriter();
  const factoryContexts: VerifiedActiveTenantContext[] = [];
  const binding = bindChangeSetRequestContext({
    activeContextToken: token(),
    activeContextSigningSecret: SECRET,
    requestIdentity: identity(),
    createStore: (context) => {
      factoryContexts.push(context);
      return store;
    },
    createAuditWriter: (context) => {
      factoryContexts.push(context);
      return audit;
    },
    nextUuidV7: () => "018f8000-0000-7000-8000-00000000000c",
    now: () => NOW,
  });
  assert.equal(binding.ok, true);
  if (!binding.ok) return;
  assert.equal(factoryContexts.length, 2);
  assert.equal(factoryContexts[0], factoryContexts[1]);

  await assert.rejects(
    () =>
      binding.gateway.executeCreate({
        idempotencyKey: "request-context-create-0001",
        changeType: "FEATURE_FLAG",
        title: "Bound request context",
        purpose: "Prove one server context reaches both persistence lanes.",
        targetScope: {
          type: "ORGANIZATION",
          organizationId: ID.organization,
          legacyBranchId: null,
        },
        proposedConfig: {
          flagKey: "journey.beta",
          enabled: true,
          cohortPercent: 5,
          reason: "Bound context test.",
        },
      }),
    /request_context_store_sentinel/,
  );
  assert.equal(store.contexts.length, 1);
  assert.equal(store.contexts[0], factoryContexts[0]);
  assert.equal(audit.starts.length, 1);
  assert.deepEqual(
    {
      tenantId: audit.starts[0]?.tenantId,
      contextId: audit.starts[0]?.contextId,
      principalId: audit.starts[0]?.actorPrincipalId,
      membershipId: audit.starts[0]?.actorMembershipId,
      policyVersionId: audit.starts[0]?.policyVersionId,
    },
    {
      tenantId: ID.tenant,
      contextId: ID.context,
      principalId: ID.principal,
      membershipId: ID.membership,
      policyVersionId: ID.policy,
    },
  );
  assert.equal(audit.unexpectedErrors, 1);
});

test("token rejection and server identity drift fail before dependency creation", () => {
  const cases: Array<{
    name: string;
    activeContextToken?: string;
    requestIdentity: unknown;
    now?: number;
    expected: unknown;
  }> = [
    {
      name: "missing token",
      requestIdentity: identity(),
      expected: {
        reason: "active_context_rejected",
        detail: "missing_token",
      },
    },
    {
      name: "expired token",
      activeContextToken: token({ expiresAt: NOW }),
      requestIdentity: identity(),
      expected: { reason: "active_context_rejected", detail: "expired" },
    },
    {
      name: "principal mismatch",
      activeContextToken: token(),
      requestIdentity: identity({ authenticatedPrincipalId: ID.otherPrincipal }),
      expected: { reason: "authenticated_principal_mismatch" },
    },
    {
      name: "tenant mismatch",
      activeContextToken: token(),
      requestIdentity: identity({ tenantId: ID.otherTenant }),
      expected: { reason: "branded_tenant_mismatch" },
    },
    {
      name: "organization mismatch",
      activeContextToken: token(),
      requestIdentity: identity({ organizationId: ID.otherOrganization }),
      expected: { reason: "branded_organization_mismatch" },
    },
    {
      name: "branch mismatch",
      activeContextToken: token(),
      requestIdentity: identity({ legacyBranchId: 42 }),
      expected: { reason: "branded_branch_mismatch" },
    },
    {
      name: "invalid request shape",
      activeContextToken: token(),
      requestIdentity: { ...identity(), injectedTenant: ID.otherTenant },
      expected: { reason: "request_identity_invalid" },
    },
    {
      name: "branch without organization",
      activeContextToken: token(),
      requestIdentity: identity({ organizationId: null }),
      expected: { reason: "request_identity_invalid" },
    },
    {
      name: "invalid clock",
      activeContextToken: token(),
      requestIdentity: identity(),
      now: -1,
      expected: { reason: "clock_invalid" },
    },
  ];

  for (const item of cases) {
    let dependencyCalls = 0;
    const result = bindChangeSetRequestContext({
      activeContextToken: item.activeContextToken,
      activeContextSigningSecret: SECRET,
      requestIdentity: item.requestIdentity,
      createStore: () => {
        dependencyCalls += 1;
        return new FailingStore();
      },
      createAuditWriter: () => {
        dependencyCalls += 1;
        return new RecordingAuditWriter();
      },
      nextUuidV7: () => "018f8000-0000-7000-8000-00000000000d",
      now: () => item.now ?? NOW,
    });
    assert.deepEqual(result, { ok: false, error: item.expected }, item.name);
    assert.equal(dependencyCalls, 0, item.name);
  }
});

test("context-bound audit writer rejects every identity drift and later expiry", async () => {
  let current = NOW;
  const context = verifiedContext();
  const delegate = new RecordingAuditWriter();
  const writer = new ContextBoundChangeSetCommandAuditWriter(
    context,
    delegate,
    () => current,
  );
  const start = validAuditStart();
  for (const drift of [
    { tenantId: ID.otherTenant },
    { contextId: "018f8000-0000-7000-8000-00000000000e" },
    { actorPrincipalId: ID.otherPrincipal },
    { actorMembershipId: "018f8000-0000-7000-8000-00000000000f" },
    { policyVersionId: "018f8000-0000-7000-8000-000000000010" },
  ]) {
    await assert.rejects(
      () => writer.startAttempt({ ...start, ...drift }),
      /change_set_request_audit_context_mismatch/,
    );
  }
  assert.equal(delegate.starts.length, 0);
  await writer.startAttempt(start);
  assert.equal(delegate.starts.length, 1);

  current = context.expiresAt;
  await assert.rejects(
    () => writer.startAttempt(start),
    /change_set_request_context_expired/,
  );
  assert.equal(delegate.starts.length, 1);
});

test("a copied verified-context shape cannot initialize an audit binding", () => {
  const copied = { ...verifiedContext() } as VerifiedActiveTenantContext;
  assert.throws(
    () =>
      new ContextBoundChangeSetCommandAuditWriter(
        copied,
        new RecordingAuditWriter(),
        () => NOW,
      ),
    /change_set_request_audit_binding_invalid/,
  );
});
