# Authorization Corridor Foundation

## Delivery status

This change is an additive, default-unwired foundation. It does not migrate an
existing route, does not remove any item from the legacy role-gate or tenant
writer quarantine, and does not make the product external-tenant ready.
Migration `0054_authorization_corridor_foundation.sql` has not been applied to
local, staging, or production databases as part of this work.

## What the foundation establishes

- New canonical IDs are caller-generated UUIDv7 values. The database rejects a
  different UUID version for canonical authorization records.
- Tenant is the isolation boundary. Organization and the temporary
  `legacy_branch_id` bridge are authorization scopes, not substitutes for a
  tenant.
- A global principal is separate from a human tenant membership.
- A membership is not an authorization grant. Access comes only from an active,
  effective `access_assignment` linked to an active versioned role package and
  capability definition.
- Capability membership is normalized in
  `role_package_capabilities`; permissions are not stored in a role JSON blob.
- `ALLOW` and `DENY` are explicit. The evaluator applies `DENY` after matching
  active assignments and before returning an allow.
- Grant/change and access-decision evidence have append-only receipt tables.
  Update/delete is blocked by both absent RLS policies and immutable triggers.
- Tenant-owned authorization tables have forced RLS. Without a transaction-local
  `app.tenant_id`, their policies expose and accept no rows.

## Signed active context

`activeTenantContext.ts` creates a short-lived HMAC-SHA256 envelope containing
only server-selected UUIDv7 tenant, principal, membership, assignment and policy
identifiers plus organization/legacy-branch scope. Requirements:

1. `ACTIVE_CONTEXT_SIGNING_SECRET` must be independently managed and contain at
   least 32 UTF-8 bytes. There is deliberately no `SESSION_SECRET` fallback.
2. The envelope lifetime cannot exceed 15 minutes; assignment IDs are unique and
   bounded to 32.
3. A valid signature is not an authorization decision. Every request must reload
   current tenant, principal, membership, assignment, package, capability and
   policy state from the server-side store.
4. Tenant, organization or branch values from request body, query string or an
   untrusted header must never select either the envelope or `app.tenant_id`.
5. `SET LOCAL app.tenant_id = ...` may happen only inside a database transaction
   after signature verification and server-side membership resolution. The
   connection must not return to the pool with a session-level tenant setting.
6. Expiry, revoke, suspension, policy-version drift, assignment-set drift,
   principal-type mismatch and unevaluated constraints fail closed.
7. A resource in another tenant or active branch returns the generic
   `resource_not_found` decision to avoid an identifier oracle.

## Deliberate limits

- The first corridor supports only `HUMAN` principals with internal membership.
  Agent companies, sub-agents, universities, colleges, accommodation providers,
  guardians, sponsors, delegates, integration identities and AI identities must
  use a later typed `relationship_grant` or service-principal path. They must not
  be represented as internal staff membership to bypass this boundary.
- Non-empty assignment constraints are denied until the typed ABAC evaluator is
  implemented and tested.
- Step-up and approval-marked capabilities are denied unless a future verified
  receipt is explicitly provided. Boolean call-site claims are not sufficient
  for route migration.
- Platform-global principal, capability and role-package administration remains
  unwired. It requires the Super Admin ChangeSet maker-checker control plane,
  separate platform scope and audited JIT/step-up access.
- Existing integer `users`, `branches` and domain IDs are not rewritten. The
  bridge is additive and must follow expand/backfill/verify/enforce/contract.
- Production RLS ownership, application DB role, provisioning role and pool
  transaction semantics still require an isolated database integration test.

## Route promotion gate

An existing route can leave `legacy_quarantine` only when all of the following
are evidenced:

1. the active context is issued from a server-resolved membership, not request
   tenant input;
2. the database transaction sets and clears the tenant RLS context safely;
3. the route uses only versioned assignment/package/capability/policy state;
4. every allow and privileged deny writes a decision receipt without PII or
   secrets;
5. two-tenant and two-branch same-visible-ID negative tests pass at HTTP and DB
   levels;
6. revoke, expiry, stale policy, explicit deny, step-up and impersonation unsafe
   action tests pass;
7. the corresponding tenant writer is removed from quarantine only through a
   reviewed registry change.

Until that gate passes, the external-tenant decision remains **NO-GO**.
