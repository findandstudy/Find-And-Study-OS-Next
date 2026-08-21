# Tenant Writer and Side-Effect Inventory

Status: G30 baseline; external-tenant activation remains denied.

The executable inventory is defined by:

- `scripts/audit-tenant-writers.mjs`
- `security/tenant-writer-registry.json`
- root command `pnpm audit:tenant-writers`

The scanner covers production TypeScript under the API server and portal
automation worker. It detects database mutation/query surfaces, raw mutating
SQL, object/file writes, external side effects, event/cache writes, and
scheduled/background execution. Matching is intentionally conservative and
some source locations can appear in more than one surface class.

## Frozen baseline

The initial registry contains 144 explicitly classified files and 1,969
static surface matches:

| Ownership class | Files |
|---|---:|
| Tenant-owned | 46 |
| External integration | 22 |
| Privileged configuration | 12 |
| Public ingress | 5 |
| Platform-global | 16 |
| Mixed legacy | 43 |

All 144 files are currently `externalPilot=quarantine`. This is deliberate:
classification is not authorization, and a file does not leave quarantine
until its effective tenant boundary is proven. The strict gate currently
reports 116 critical/high files still quarantined. That failure is the honest
baseline, not a test defect.

The surface total is a review denominator, not a claim that the application
performs 1,969 unique runtime writes. Pattern overlap prevents unsafe
undercounting; promotion evidence is evaluated per registered file and its
reachable runtime paths.

## Commands

```text
pnpm audit:tenant-writers
node scripts/audit-tenant-writers.mjs --json
node scripts/audit-tenant-writers.mjs --strict
```

The normal command fails when a discovered writer file is absent from the
registry, a registry entry becomes stale, or its ownership/risk/owner fields
are invalid. `--strict` additionally fails while any critical/high file still
requires quarantine. It is intended to become a required external-pilot gate,
not to be waived.

## Promotion contract

A file may change from `quarantine_required` only when all relevant evidence
exists:

1. Tenant/platform ownership and accountable team are explicit.
2. Human, service, integration, or AI actor source is known.
3. Active tenant/organization/branch/case context is resolved from an
   authenticated membership or relationship grant, never trusted directly
   from body/query/header input.
4. Every reachable read/write has a central scope guard and a fail-closed
   runtime assertion.
5. High-risk corridor PII has DB-enforced isolation or an approved equivalent.
6. Object/file paths use owner, tenant, visibility, and authorization evidence.
7. External effects have approval mode, idempotency, provider receipt, retry,
   and compensation/rollback behavior.
8. Same-resource-ID negative tests across two tenants and two branches prove
   no read, write, export, cache, event, or job leakage.
9. An independent reviewer records the evidence and registry transition.

Only then may enforcement become `runtime_scoped`, `db_enforced`,
`receipt_guarded`, or `allowlisted_global`; only separately approved reachable
paths may receive `externalPilot=allow`.

## Authorization precedence

The migration rule is frozen in the registry:

- Current legacy routes may consult `users.role`, dynamic role permissions,
  permission overrides, and route-local checks. They remain quarantined until
  their exact decision path is evidenced.
- The corridor target is signed active tenant context plus versioned
  grant/capability, evaluated deny-by-default.
- After migration, `users.role` is a read-only compatibility projection and
  cannot grant corridor access.
- External-tenant impersonation stays disabled until real actor, target actor,
  tenant context, step-up, receipt, expiry, and unsafe-action deny tests pass.

## Change discipline

Every new production writer/side-effect file must be registered in the same
change that introduces it. A registry edit without boundary tests does not
permit external-tenant access. Raw SQL, schedulers, bots, webhooks, exports,
cache keys, search projections, and provider sends are part of the denominator;
route-only coverage is insufficient.
