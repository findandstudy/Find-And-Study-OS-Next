# Legacy Role-Gate Inventory

Status: G30 authorization denominator. External-tenant activation remains
denied.

## Purpose

`scripts/audit-legacy-role-gates.mjs` scans every TypeScript route file and
every Express router registration under `artifacts/api-server/src/routes`. It
freezes the following conservative review surfaces:

- route registrations;
- `requireAuth` references;
- fixed `requireRole(...)` gates;
- dynamic `requirePermission(...)` gates;
- API-token `requireScope(...)` gates;
- direct request-user role comparisons;
- authenticated routes without a role/permission/scope middleware in their
  registration prefix;
- route registrations without `requireAuth` in that prefix.

The last two categories are candidates for review, not vulnerability claims.
Handlers may intentionally be public or may call relationship/state/object
guards inside the handler. The inventory exists so those decisions cannot
remain invisible.

## Commands

```text
pnpm audit:legacy-role-gates
node scripts/audit-legacy-role-gates.mjs --json
node scripts/audit-legacy-role-gates.mjs --strict
```

Normal mode fails on an added/deleted/changed route file or metric drift until
the registry is deliberately reviewed and regenerated with `--write`. Strict
mode additionally fails while route-bearing files remain
`legacy_quarantine`; that failure is the expected external-tenant NO-GO
baseline.

## Frozen baseline

| Surface | Count |
|---|---:|
| Route files | 68 |
| Route registrations | 731 |
| `requireAuth` references | 681 |
| Fixed `requireRole(...)` gates | 460 |
| `requirePermission(...)` gates | 34 |
| `requireScope(...)` references in route files | 0 |
| Direct request-user role checks | 30 |
| Auth-only registration candidates | 128 |
| Public registration candidates | 118 |

All 68 files are classified `legacy_quarantine`; 67 contain at least one route
registration. `corridor_migrated=0` and `public_reviewed=0`. Therefore strict
mode is intentionally red.

## Interpretation

- `requireRole(...)` is legacy role projection, not the target capability
  engine.
- `requirePermission(...)` now has consistent stored-role precedence, but it
  still lacks signed tenant context, membership/relationship grant, policy
  version, step-up, and access-decision receipt.
- UI visibility is never authorization.
- A file can leave quarantine only after its reachable routes use the signed
  active context and versioned grant/capability decision path, with same-ID
  negative tests across two tenants and two branches.

This denominator complements `TENANT_WRITER_INVENTORY.md`: one freezes who can
attempt a route; the other freezes which routes/jobs can mutate data or create
external effects. Both must pass before an external tenant is enabled.
