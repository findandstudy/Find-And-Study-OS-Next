# Legacy User Management Boundary

Status: interim G30 hardening; the generic `users.role` projection is not the
target authorization model and external-tenant activation remains denied.

## Why this boundary exists

The legacy `/api/users` surface previously listed all non-deleted accounts and
allowed manager-class roles to read, update, delete, reset passwords, or assign
roles without consistently proving that the target belonged to the actor's
branch. A manager could also submit administrative fields while editing their
own account. These paths were incompatible with a multi-tenant control plane.

The central policy in
`artifacts/api-server/src/lib/legacyUserManagementPolicy.ts` now makes those
routes fail closed while the signed active-context and versioned grant engine
is built.

## Enforced interim rules

### Generic directory

- Super Admin may see the platform-wide legacy directory.
- Every other staff actor sees only users whose direct `users.branch_id` is in
  the actor's server-resolved branch set.
- Branchless identities are not globally visible.
- Students and agent-family identities are excluded from the non-super generic
  directory; their relationship-aware routes are authoritative.
- An actor with no visible branch receives an empty directory.

### Detail and mutation

- A non-super actor must have a non-empty branch scope.
- Every target branch must be inside that scope. For a linked student identity,
  all active student-record branches are evaluated; one out-of-scope link
  denies the operation.
- Agent, sub-agent, and agent-staff targets require the dedicated agent
  workflow for non-super actors.
- Deleted targets fail closed.
- A non-super actor cannot update, delete, or reset the password of a peer or a
  more privileged account. An admin can manage a lower-ranked manager; a
  manager cannot manage another manager.
- Self-service PATCH is restricted to profile fields. Self-delete and
  administrator-driven self-password reset remain denied; the authenticated
  current-password flow must be used instead.

### Role and privilege changes

- Only Super Admin may assign `super_admin`, `admin`, agent/student lifecycle
  roles, or dynamic/custom roles through the generic user route.
- Admin may assign only lower branch-staff roles; manager may assign only
  lower branch-staff roles.
- A non-super actor cannot set `permissionOverrides`.
- Non-super-created accounts require an active branch inside the actor's
  server-resolved scope.
- Every denied management decision writes `user_management.denied` with the
  attempted action and policy reason.

## Verification

Run from the repository root:

```text
pnpm --filter @workspace/api-server run test:user-management-policy
pnpm --filter @workspace/api-server run test:security-regressions
pnpm --filter @workspace/api-server run build
pnpm run typecheck
pnpm audit:tenant-writers
```

The policy test is database-independent. Full route/integration tests still
require an explicitly isolated local test database; they must never target a
production or shared database.

## Deliberate limitations

This interim policy does not promote `routes/users.ts` from quarantine and does
not claim external-tenant readiness. The target control plane still requires:

1. signed active tenant/organization/branch context;
2. versioned role, grant, and capability records with effective dates;
3. maker-checker approval for privileged changes;
4. MFA/step-up and JIT access for Super Admin support actions;
5. immutable change receipts, reason, expiry, revoke, diff, and rollback;
6. database-enforced tenant isolation and two-tenant negative integration tests.

Until those controls pass the roadmap gates, `users.ts` remains
`externalPilot=quarantine` in the tenant writer registry.
