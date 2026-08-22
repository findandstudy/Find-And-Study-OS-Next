import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

import {
  fingerprintActiveContextPublicKey,
  verifyVersionedActiveTenantContext,
  type ActiveContextExternalSigner,
  type ActiveContextVerificationKey,
} from "../src/lib/activeTenantContext.js";
import {
  issueAuthoritativeActiveTenantContext,
  type AuthoritativeActiveContextIssuanceOptions,
  type AuthoritativeActiveContextRepository,
  type AuthoritativeActiveContextState,
} from "../src/lib/authoritativeActiveContextIssuance.js";

const NOW = 2_000_000_000_000;
const ID = {
  context: "018fb000-0000-7000-8000-000000000001",
  tenant: "018fb000-0000-7000-8000-000000000002",
  otherTenant: "018fb000-0000-7000-8000-000000000003",
  organization: "018fb000-0000-7000-8000-000000000004",
  principal: "018fb000-0000-7000-8000-000000000005",
  membership: "018fb000-0000-7000-8000-000000000006",
  assignment: "018fb000-0000-7000-8000-000000000007",
  policy: "018fb000-0000-7000-8000-000000000008",
  issuer: "018fb000-0000-7000-8000-000000000009",
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
    authenticatedPrincipalId: ID.principal,
    tenantId: ID.tenant,
    organizationId: ID.organization,
    legacyBranchId: 41,
    ...overrides,
  };
}

function state(
  overrides: {
    tenant?: Partial<AuthoritativeActiveContextState["tenant"]>;
    principal?: Partial<AuthoritativeActiveContextState["principal"]>;
    membership?: Partial<AuthoritativeActiveContextState["membership"]>;
    policy?: Partial<AuthoritativeActiveContextState["policy"]>;
    assignment?: Partial<AuthoritativeActiveContextState["assignments"][number]>;
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
      ...overrides.policy,
    },
    assignments: [
      {
        id: ID.assignment,
        tenantId: ID.tenant,
        membershipId: ID.membership,
        status: "ACTIVE",
        validFrom: NOW - 60_000,
        validUntil: NOW + 60_000,
        ...overrides.assignment,
      },
    ],
  };
}

class FakeRepository implements AuthoritativeActiveContextRepository {
  calls = 0;
  constructor(public currentState: AuthoritativeActiveContextState) {}

  async withLockedCurrentState(
    _input: Parameters<
      AuthoritativeActiveContextRepository["withLockedCurrentState"]
    >[0],
    operation: Parameters<
      AuthoritativeActiveContextRepository["withLockedCurrentState"]
    >[1],
  ) {
    this.calls += 1;
    return operation(structuredClone(this.currentState));
  }
}

function signer(counter = { calls: 0 }): ActiveContextExternalSigner {
  return {
    async sign(input) {
      counter.calls += 1;
      assert.equal(input.keyReference, KEY_REFERENCE);
      return crypto.sign(null, input.signingInput, pair.privateKey);
    },
  };
}

function options(
  repository: AuthoritativeActiveContextRepository,
  overrides: Partial<AuthoritativeActiveContextIssuanceOptions> = {},
): AuthoritativeActiveContextIssuanceOptions {
  return {
    request: request(),
    repository,
    audience: AUDIENCE,
    environmentId: ENVIRONMENT,
    cellId: CELL,
    issuerId: ID.issuer,
    keyId: KEY_ID,
    keyReference: KEY_REFERENCE,
    keyRing: [verificationKey()],
    signer: signer(),
    nextUuidV7: () => ID.context,
    now: () => NOW,
    ttlMs: 60_000,
    ...overrides,
  };
}

test("authoritative state alone supplies membership, assignments, policy, context ID, and timestamps", async () => {
  const repository = new FakeRepository(state());
  const result = await issueAuthoritativeActiveTenantContext(options(repository));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(repository.calls, 1);
  assert.equal(result.contextId, ID.context);
  assert.equal(result.issuedAt, NOW);
  assert.equal(result.expiresAt, NOW + 60_000);
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
    now: NOW,
  });
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.context.membershipId, ID.membership);
  assert.deepEqual(verified.context.assignmentIds, [ID.assignment]);
  assert.equal(verified.context.policyVersionId, ID.policy);
  assert.equal(verified.context.policyVersion, 3);
});

test("client field injection and invalid branded scope fail before repository access", async () => {
  for (const candidate of [
    request({ membershipId: ID.membership }),
    request({ assignmentIds: [ID.assignment] }),
    request({ policyVersionId: ID.policy }),
    request({ issuedAt: NOW }),
    request({ organizationId: null }),
    request({ tenantId: "not-a-uuid" }),
  ]) {
    const repository = new FakeRepository(state());
    assert.deepEqual(
      await issueAuthoritativeActiveTenantContext(
        options(repository, { request: candidate }),
      ),
      { ok: false, reason: "request_invalid" },
    );
    assert.equal(repository.calls, 0);
  }
});

test("inactive, mismatched, expired, and malformed current state never reaches signer", async () => {
  const cases: Array<{
    name: string;
    current: unknown;
    reason: string;
  }> = [
    { name: "tenant", current: state({ tenant: { status: "SUSPENDED" } }), reason: "tenant_inactive" },
    { name: "principal", current: state({ principal: { status: "REVOKED" } }), reason: "principal_inactive" },
    { name: "risk", current: state({ principal: { riskState: "LOCKED" } }), reason: "principal_risk_blocked" },
    { name: "membership", current: state({ membership: { status: "REVOKED" } }), reason: "membership_inactive" },
    { name: "membership expiry", current: state({ membership: { validUntil: NOW } }), reason: "membership_expired" },
    { name: "scope", current: state({ membership: { tenantId: ID.otherTenant } }), reason: "scope_mismatch" },
    { name: "policy", current: state({ policy: { state: "REVOKED" } }), reason: "policy_inactive" },
    { name: "policy version", current: state({ tenant: { policyVersion: 4 } }), reason: "policy_mismatch" },
    { name: "assignment", current: state({ assignment: { status: "REVOKED" } }), reason: "assignment_inactive" },
    { name: "assignment expiry", current: state({ assignment: { validUntil: NOW } }), reason: "assignment_expired" },
    { name: "assignment owner", current: state({ assignment: { tenantId: ID.otherTenant } }), reason: "assignment_set_invalid" },
    { name: "shape", current: { ...state(), injected: true }, reason: "authoritative_state_invalid" },
  ];
  for (const item of cases) {
    const signCounter = { calls: 0 };
    const repository: AuthoritativeActiveContextRepository = {
      withLockedCurrentState: async (_input, operation) => operation(item.current),
    };
    const result = await issueAuthoritativeActiveTenantContext(
      options(repository, { signer: signer(signCounter) }),
    );
    assert.deepEqual(result, { ok: false, reason: item.reason }, item.name);
    assert.equal(signCounter.calls, 0, item.name);
  }
});

test("resolver/signing timeout and repository contract violations discard every token", async () => {
  const beforeSign = [NOW, NOW + 5_001];
  const early = await issueAuthoritativeActiveTenantContext(
    options(new FakeRepository(state()), {
      now: () => beforeSign.shift() ?? NOW + 5_001,
    }),
  );
  assert.deepEqual(early, { ok: false, reason: "resolution_timeout" });

  const afterSign = [NOW, NOW, NOW + 5_001];
  const late = await issueAuthoritativeActiveTenantContext(
    options(new FakeRepository(state()), {
      now: () => afterSign.shift() ?? NOW + 5_001,
    }),
  );
  assert.deepEqual(late, { ok: false, reason: "resolution_timeout" });

  const skipped: AuthoritativeActiveContextRepository = {
    withLockedCurrentState: async () => "adapter-forged-token",
  };
  assert.deepEqual(
    await issueAuthoritativeActiveTenantContext(options(skipped)),
    { ok: false, reason: "repository_contract_invalid" },
  );

  const repeated: AuthoritativeActiveContextRepository = {
    withLockedCurrentState: async (_input, operation) => {
      await operation(state());
      return operation(state());
    },
  };
  assert.deepEqual(
    await issueAuthoritativeActiveTenantContext(options(repeated)),
    { ok: false, reason: "repository_contract_invalid" },
  );

  assert.deepEqual(
    await issueAuthoritativeActiveTenantContext(
      options(new FakeRepository(state()), { nextUuidV7: () => "bad-id" }),
    ),
    { ok: false, reason: "repository_contract_invalid" },
  );
});

test("locked issuance wins before revoke; revoke-first blocks the next token", async () => {
  let locked = false;
  let releaseSigner!: () => void;
  let signerEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    signerEntered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseSigner = resolve;
  });
  let current = state();
  const repository: AuthoritativeActiveContextRepository = {
    async withLockedCurrentState(input, operation) {
      assert.equal(input.tenantId, ID.tenant);
      locked = true;
      try {
        return await operation(structuredClone(current));
      } finally {
        locked = false;
      }
    },
  };
  const blockingSigner: ActiveContextExternalSigner = {
    async sign(input) {
      signerEntered();
      await release;
      return crypto.sign(null, input.signingInput, pair.privateKey);
    },
  };

  const issuing = issueAuthoritativeActiveTenantContext(
    options(repository, { signer: blockingSigner }),
  );
  await entered;
  assert.equal(locked, true);
  let revokeCompleted = false;
  const revoke = (async () => {
    while (locked) await new Promise<void>((resolve) => setImmediate(resolve));
    current = state({ membership: { status: "REVOKED" } });
    revokeCompleted = true;
  })();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(revokeCompleted, false);
  releaseSigner();
  const first = await issuing;
  assert.equal(first.ok, true);
  await revoke;
  assert.equal(revokeCompleted, true);

  const secondCounter = { calls: 0 };
  const second = await issueAuthoritativeActiveTenantContext(
    options(repository, { signer: signer(secondCounter) }),
  );
  assert.deepEqual(second, { ok: false, reason: "membership_inactive" });
  assert.equal(secondCounter.calls, 0);
});
