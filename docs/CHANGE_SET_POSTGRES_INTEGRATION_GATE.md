# ChangeSet PostgreSQL Integration Gate

Status: **BLOCKED / NO-GO for runtime wiring**.

This gate is not a delivery estimate and is not proof that migrations `0055`
or `0056` have run. The approved local PostgreSQL endpoint
`127.0.0.1:5433/fasos_apply_local` was unavailable during this slice, and the
workspace had no Docker or `psql` executable. No database was mutated.

## Required database authority split

The harness must prove two distinct login roles and secrets:

- `fas_migrator` owns the application schema and tables and is the only role
  allowed to apply reviewed migrations;
- `fas_app` is `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, and
  `NOBYPASSRLS`, owns no tenant table, has no DDL privilege, and cannot
  `SET ROLE` to the migrator.

The API, workers, schedulers, webhooks, exports, AI tools, and future ChangeSet
adapter must use only the runtime application credential. A passing test under
the table owner is not evidence that forced RLS protects the runtime path.

## Disposable harness contract

The test environment must use a disposable PostgreSQL instance matching the
production major version and pinned by immutable image digest. It must create a
random `fas_it_*` database, set statement, lock, and idle-transaction timeouts,
and apply the real migration runner from `0000` through `0056` using only the
migrator role.

The harness is opt-in and must fail closed unless all of these are true:

- the target host is explicitly local and non-production;
- `ALLOW_LIVE_INTEGRATIONS=false`;
- the database name matches the disposable `fas_it_*` pattern;
- migration and runtime URLs are distinct;
- no production or staging hostname, secret, or tunnel is present.

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
7. verified-context tenant different from the transaction GUC tenant;
   principal/membership tenant different from the GUC tenant; and commands
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
    tenant, ChangeSet, target state, requesting principal, proposed hash,
    policy/tool version, issued/expiry window, and consumption state;
12. hardened `search_path` and temporary-object behavior for both roles.

## Runtime-wiring gate

An API route, Super Admin editor, PostgreSQL command adapter, approval action,
publisher, worker, or configuration materializer remains forbidden until:

- this full matrix passes in required CI;
- the tenant/principal/organization/branch composite model is applied by a
  reviewed migration and its `fas_app` direct-SQL negative cases pass;
- the step-up receipt issuer/verifier is bound to principal, context, action,
  audience, expiry, and single use;
- branch protection makes the database integration check required;
- an independent reviewer approves the migration, grants, adapter, and failure
  evidence.

Until then, the current code is a default-unwired policy and command foundation,
not a production control plane.
