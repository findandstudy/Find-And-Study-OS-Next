# ChangeSet PostgreSQL Integration Gate

Status: **61-MIGRATION FOUNDATION, DEFAULT-UNWIRED CONTEXT-BOUND
COMMAND/EVIDENCE AND DURABLE-AUDIT ADAPTER CI GREEN; NO-GO for runtime wiring**.

This gate is not a delivery estimate and is not proof that migrations `0055`
through `0060` have run in a long-lived environment. The approved local
PostgreSQL endpoint `127.0.0.1:5433/fasos_apply_local` was unavailable. GitHub
run `32537777722` applied all 61 reviewed migrations twice to an isolated
disposable PostgreSQL 16 database and passed the direct-SQL foundation matrix.
Run `32537777669` passed the real default-unwired command-store and
evidence-issuer adapter candidate; run `32537777763` passed the separate
durable-audit adapter. No
long-lived, production, staging, or production-derived database was mutated.

## Required database authority split

The foundation harness proves two distinct database authorities:

- `fas_migrator` owns the application schema and tables and is the only role
  allowed to apply reviewed migrations;
- `fas_app` is `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, and
  `NOBYPASSRLS`, owns no tenant table, has no DDL privilege, and cannot
  `SET ROLE` to the migrator.

The API, workers, schedulers, webhooks, exports, and AI tools must use only the
runtime application credential. A passing test under
the table owner is not evidence that forced RLS protects the runtime path.
The candidate grant contract gives the runtime role no direct control-plane
table access; only tenant-scoped membership reads needed by the RLS probe are
allowed. A command adapter requires a separately reviewed, narrow writer role
or procedure contract; granting generic ChangeSet DML to the shared
application role is forbidden. The adapter harness additionally creates
separate command-executor and evidence-issuer login roles plus separate
`NOLOGIN` function owners. The durable-audit harness adds a separate audit
writer login and audit function owner. Login roles receive execute on their exact RPC
façade only; they do not receive Control Plane table DML and cannot assume an
owner or migrator role. This is disposable test bootstrap, not a production
credential rollout.

## Disposable harness contract

The test environment must use a disposable PostgreSQL instance matching the
production major version and pinned by immutable image digest. It must create a
random `fas_it_*` database, set statement, lock, and idle-transaction timeouts,
and apply the real migration runner from `0000` through `0060` using only the
migrator role.

The harness is opt-in and must fail closed unless all of these are true:

- the target host is explicitly local and non-production;
- `ALLOW_LIVE_INTEGRATIONS=false`;
- the database name matches the disposable `fas_it_*` pattern;
- migration and runtime URLs are distinct;
- no production or staging hostname, secret, or tunnel is present.

The reviewed migration runner independently enforces the explicit target class
and connected database identity. Disposable `test` runs accept only
literal loopback:5432, a `fas_it_*` database, and a cluster-unprivileged
`fas_migrator` with no inherited role memberships.
`local` and `development` are also loopback-only, require the approved local
database naming contract and exact effective host/port/database/user
confirmations. URL query parameters are rejected before connection. The
effective client endpoint is pinned; the connected TCP endpoint and cluster
role attributes are
verified before the ledger preflight. This runner rejects `staging` and
`production`: long-lived
adoption requires a separate executor that proves cluster identity, verified
TLS, same-executor migration semantics and rollback. These controls authorize
neither a production rollout nor migration `0058` adoption into a non-empty
evidence table.

## Mandatory evidence matrix

The gate passes only when CI records all of the following:

1. clean full migration application and repeat-run behavior;
2. atomic rollback on an injected migration failure;
3. runtime-role inability to bypass RLS, delete immutable receipts, alter
   schema, create roles, or assume the migrator role;
4. no-context, wrong-tenant, two-tenant, owner-role, runtime-role, and forced-RLS
   read/write cases;
5. `SET LOCAL app.tenant_id` isolation on the same checked-out client after
   commit, rollback, error, cancellation, pool size one, and two concurrent
   connections;
6. composite negative cases for tenant, principal membership, organization,
   and legacy branch bindings;
7. copied, unverified, expired, or in-transaction-expired context; any
   same-tenant context/principal/membership/policy substitution; verified
   context tenant different from the transaction GUC tenant; and commands
   racing a membership/assignment revoke or policy-version rotation, all
   failing closed;
8. concurrent duplicate commands, changed-request conflicts, in-progress
   claims, canonical result-hash replay, optimistic concurrency, and injected
   failures between every receipt/state write;
9. two different idempotency keys racing to create a proposal for the same
   tenant/scope/type/base version, with only one active proposal admitted;
10. transition hash-chain, review-round uniqueness, maker/checker separation,
    and one-way command completion constraints;
11. server-issued validation/simulation/test/rollback/canary receipt bindings to
    issuer principal, Ed25519 key/fingerprint, audience, environment/cell,
    single-use request/challenge, exact issuer-tenant grant UUID, tenant,
    ChangeSet, target state, requesting principal/membership, proposed hash,
    policy version, artifact manifest, issued/expiry window, and consumption
    state;
12. hardened `search_path` and temporary-object behavior for both roles;
13. append-only, tenant-scoped audit sequence, stable actor/context/request
    identity, one terminal event, adapter-computed keyed event hashes, and
    denial of raw command/request/error/secret payload fields.

## Foundation and adapter CI harnesses

`.github/workflows/postgres-control-plane-gate.yml` and
`artifacts/api-server/scripts/test-postgres-control-plane-gate.ts` define the
foundation PostgreSQL 16 gate. It uses an immutable official
image digest, a per-run `fas_it_*` database, separate `fas_migrator` and
`fas_app` logins. The current candidate targets all 61 migrations twice. It
directly
exercises:

- authority attributes, forced RLS under owner and runtime roles, no-context and
  two-tenant isolation;
- commit, rollback, and error cleanup of transaction-local tenant context plus
  two concurrent tenant connections;
- no runtime DDL, temporary table, role creation, migrator assumption, legacy
  business-table write, control-plane write, or receipt deletion;
- tenant/organization/legacy-branch and principal/membership tuple negatives;
- active-proposal uniqueness, transition receipt/state ordering, one-way
  command completion, atomic evidence consumption/finalization, and concurrent
  evidence reuse under the migrator-owned invariant harness.
- persisted canonical signed-claim round trip through the pure Ed25519 verifier,
  trusted environment/cell binding, exact grant UUID, issuer/key/grant revoke
  serialization, and terminal audit-chain invariants.

`.github/workflows/postgres-control-plane-adapter-gate.yml` and
`test-postgres-change-set-adapter.ts` add the separate real-adapter candidate.
It uses a pool of one, the exact signed-envelope verifier, separate RPC-only
roles and fixed-search-path function owners. It proves authoritative snapshot
create, copied-context and actor-substitution denial, in-transaction context
expiry, internal-only tenant GUC binding, signed evidence admission, DRAFT to
VALIDATED, evidence consumption, canonical replay, rollback, same-client
tenant-context cleanup and direct-role denials. The command validator
independently binds artifact count and manifest hash into the signed outcome
hash.

`.github/workflows/postgres-control-plane-audit-gate.yml` and
`test-postgres-change-set-audit.ts` add the durable outer-attempt candidate.
They prove a separately committed start event, terminal success and rejection
after business commit/rollback, terminal-only ChangeSet identity binding,
domain-separated HMAC chain verification, cross-tenant and no-context denial,
direct-table denial for the audit login, transaction-local context cleanup, and
one terminal winner under a same-attempt race.

All checks passed on context-binding implementation head
`e855f0283f7cc9449da9dc0c19a20d23991cd223`: foundation run `32539460998`,
command/evidence adapter run `32539460946`, durable-audit run `32539461023`,
and G0 Linux/Windows run `32539460995`. The checks are not yet required by a
repository ruleset. The adapter candidate still does not cover HTTP
authentication-to-branded-context wiring, binding that context into the
separate audit writer, direct command-credential compromise, every
cancellation/ambiguous-commit path, both lock orders for
membership/policy/key revocation, injected failure between every write,
production KMS/HSM audit-key custody, incomplete-attempt reconciliation, or
decision/step-up paths. Those gaps keep the full matrix and runtime wiring at
NO-GO.

## Runtime-wiring gate

Activation of an API route, Super Admin editor, PostgreSQL command adapter,
approval action, publisher, worker, or configuration materializer remains
forbidden until:

- this full matrix passes in required CI;
- the tenant/principal/organization/branch composite model is applied by a
  reviewed migration and its `fas_app` direct-SQL negative cases pass;
- the step-up receipt issuer/verifier is bound to principal, context, action,
  audience, expiry, and single use;
- branch protection makes the database integration check required;
- an independent reviewer approves the migration, grants, adapter, and failure
  evidence.

Until then, the current code is a default-unwired policy, command foundation and
adapter candidate, not a production control plane.
