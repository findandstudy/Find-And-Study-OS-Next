# ChangeSet PostgreSQL Integration Gate

Status: **66-MIGRATION FOUNDATION CANDIDATE, DEFAULT-UNWIRED CONTEXT-BOUND
COMMAND/EVIDENCE, QUERY-CANCELLATION ROLLBACK, MEMBERSHIP/POLICY REVOCATION
SERIALIZATION, EVIDENCE-KEY COMPROMISE SERIALIZATION, AMBIGUOUS-COMMIT
AND SCHEDULED RECEIPT-ONLY RECONCILIATION, DURABLE-AUDIT ADAPTER CI GREEN,
AND DEFAULT-UNWIRED SESSION/RATE-LIMIT ADAPTER CI GREEN; SELECTION-LIFECYCLE
CANDIDATE AWAITS POSTGRESQL CI; NO-GO for runtime wiring**.

This gate is not a delivery estimate and is not proof that migrations `0055`
through `0065` have run in a long-lived environment. The approved local
PostgreSQL endpoint `127.0.0.1:5433/fasos_apply_local` was unavailable. GitHub
run `32547890515` applied the prior 63 reviewed migrations twice to an isolated
disposable PostgreSQL 16 database and passed the direct-SQL foundation matrix.
Run `32547890517` passed the real default-unwired command-store,
evidence-issuer, query-cancellation rollback and ambiguous-commit replay
candidate; run `32547890514` passed the separate durable-audit,
cancellation-terminal, reconciliation-chain and scheduled repair adapter. Run
`32547890509` passed the Linux and Windows G0 jobs. No
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
and apply the real migration runner from `0000` through `0061` using only the
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
`fas_app` logins. The current candidate targets all 66 migrations twice. It
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
tenant-context cleanup and direct-role denials. It also simulates a PostgreSQL
`COMMIT` that succeeds while its acknowledgement is lost, destroys that
uncertain pool client and proves that one same-identity retry returns the
canonical replay. A separate `pg_cancel_backend` case proves SQLSTATE `57014`
rolls back before the command claim, leaves no partial command/access/ChangeSet
rows, clears the transaction-local tenant setting, and safely reuses the same
pool-of-one backend. Real adapter races additionally pause after current
membership and policy rows are locked. A concurrent revoke must wait for the
authorized replay transaction; after that revoke commits, the same signed
context and command fail closed before a new command claim. Both membership and
policy lock orders are exercised without a test-only production hook. The
command validator
independently binds artifact count and manifest hash into the signed outcome
hash.

A separate real-transition race persists policy-valid `SIMULATION` and
`IN_REVIEW` evidence under an ephemeral Ed25519 test key. The SIMULATED command
pauses after the evidence RPC has taken issuer/key/grant/request locks; a
concurrent key compromise must wait until that transition commits. Once the
compromise commits, IN_REVIEW fails closed, its command/access/transition rows
roll back, and its three evidence receipts remain unconsumed.

The evidence-issuer adapter also exercises both tenant-grant revocation lock
orders without a production hook. When issuance owns the issuer/key/grant
verification locks first, the grant revoker waits until the signed receipt and
its single-use request commit atomically. After the revocation commits, a
second signed envelope tied to the same exact grant fails closed: its request
stays `OPEN` and no evidence receipt is inserted.

The global issuer lifecycle is exercised last because revocation is terminal.
When issuance owns the issuer verification lock first, the issuer revoker must
wait until receipt/request commit. After global revoke commits, another validly
signed envelope from that issuer is rejected as inactive before persistence;
the denied request stays open and no partial receipt is left behind.

The CREATE adapter path injects a deterministic failure immediately after each
business write boundary: command claim, ALLOW access receipt, ChangeSet insert,
and command completion. Every case must roll back command, access, and ChangeSet
rows together. The following normal CREATE command must then create one
canonical DRAFT, proving that the failed attempts left no hidden claim or
active proposal.

`.github/workflows/postgres-control-plane-audit-gate.yml` and
`test-postgres-change-set-audit.ts` add the durable outer-attempt candidate.
They prove a separately committed start event, terminal success and rejection
after business commit/rollback, terminal-only ChangeSet identity binding,
domain-separated HMAC chain verification, cross-tenant and no-context denial,
direct-table denial for the audit login, transaction-local context cleanup, and
one terminal winner under a same-attempt race. Migration `0061` additionally
proves the only allowed unresolved state is
`RECONCILIATION/PENDING/COMMIT_OUTCOME_UNKNOWN`, and that it can advance to a
single `TERMINAL/SUCCESS/COMMAND_RECONCILED` event without actor, context,
request or hash drift.

The durable-audit candidate additionally cancels a policy-valid command while
its transaction is blocked in a controlled PostgreSQL query. It proves that
the business transaction has no partial row while the separately committed
attempt advances exactly once to `TERMINAL/ERROR/INTERNAL_ERROR`.

Migration `0062` adds a separate tenant-scoped repair queue and
`fas_repair_v1` RPC facade. The repair credential has no table DML and cannot
append audit events. It claims due work with `SKIP LOCKED`, reads a command
receipt only through the facade, and never replays a business command. The
audit writer atomically pairs `COMMIT_OUTCOME_UNKNOWN` with one repair job; a
valid completed receipt resumes the existing HMAC chain as
`COMMAND_RECONCILED`. Missing/claimed receipts back off and exhaust into a
terminal error plus explicit operational escalation. Invalid identity or
result hashes fail closed. The scheduler entrypoint remains unwired.

All checks passed on authoritative-active-context-issuance implementation head
`d0c049fd2d14ba92b773913619ee4c6c3123ffb8`: foundation run `32551335015`,
command/evidence adapter run `32551335012`, durable-audit and scheduled-repair
run `32551335113`, and G0 Linux/Windows run `32551335019`. The checks are not
yet required by a repository ruleset. Two earlier scheduled-reconciliation
candidate runs correctly failed because the foundation harness retained the
prior 62-migration denominator in its main and atomic-rollback assertions; both
guards now require the current 66/66 ledger denominator.

The production-shaped request binder verifies the signed active context once,
requires exact server-resolved principal, tenant, organization, and branch
identity, and gives the command store and durable-audit writer the same opaque
verified context object. Audit start rejects tenant, context, principal,
membership, policy, and expiry drift. The PostgreSQL adapter path now exercises
membership/policy revocation through that gateway; the durable-audit path uses
it for canonical replay, rejection, SQLSTATE `57014` cancellation, and existing
pool-cleanup evidence. It remains default-unwired and exposes no HTTP route.

The v2 active-context envelope uses an exact Ed25519 header/payload/signature
contract and a public verification key ring. It binds key ID, audience,
environment, cell, issuer, tenant, not-before, TTL, and the existing context
identity; supports bounded `ACTIVE`/`VERIFY_ONLY` verification; and rejects
revoked, compromised, unknown, downgraded, cross-deployment, malformed, or
tampered tokens. The request binder selects v2 explicitly and cannot silently
fall back to the legacy HMAC verifier. Private signing material is not present
in the key ring or token; only an opaque signer reference crosses the issuance
boundary, and the process-memory test signer is denied in production mode.

The authoritative issuance orchestrator narrows its request to authenticated
principal and server-branded tenant/organization/branch. Membership,
assignment set, policy version, context ID, and timestamps are generated from
the locked repository callback, UUID source, and clock. Exact runtime state,
callback exactly-once, returned-token identity, resolver/signing budget,
client-field injection, inactive/revoked state, and issuance-first/revoke-first
ordering are covered without an HTTP route.

Migration `0063` and `PostgresAuthoritativeActiveContextRepository` add the
default-unwired PostgreSQL resolver candidate. A dedicated login receives only
schema usage and exact function execution; its separate NOLOGIN owner holds the
minimum table privileges required for `FOR SHARE`, and neither role is inherited
by the other. The adapter requires a clean connection, a transaction-local
tenant GUC, and `SERIALIZABLE` isolation. The fixed-search-path function locks
tenant, principal, exact membership, current policy, applicable assignment,
package, role-definition, and capability rows in a documented order while the
external signer runs. It never projects a global principal without one exact
tenant membership. Direct table reads, missing tenant context, cross-tenant
calls, query cancellation, pool reuse, issuance-first membership revoke, and
revoke-first membership/policy paths are disposable-PostgreSQL gate cases. The
scope matrix also proves that an organization assignment remains applicable in
an exact branch context while its membership, organization, branch, assignment,
and policy identities remain bound in the signed token.

The `0063` implementation passed on GitHub head
`cde1ef1bedf07eefb96bcf2ccdc933b79d632adb` (local equivalent
`26f5dc1d12bf8a21b7557c5e829e47d6aa7a43ce`, shared tree
`f502f2bb812210e2ac1e088f206621558cbc9ff7`): foundation run `32554158137`,
adapter/evidence run `32554158158`, durable-audit run `32554158114`, and G0
Linux/Windows run `32554158141` all succeeded. These successful runs are
evidence for the exact implementation tree, not proof that repository rules
make the checks required.

The PostgreSQL adapter candidate itself still does not cover HTTP authentication/session
extraction, direct resolver-credential compromise detection, scheduled repair
activation and alert delivery, production KMS/HSM key custody/rotation, or
decision/step-up paths. Those gaps keep runtime wiring at NO-GO.

The next default-off layer, `activeContextSessionGateway.ts`, now defines the
HTTP/session-to-authoritative-issuance contract without registering a route.
It rejects API-token/bearer issuance, untrusted or conflicting Origin/Referer,
invalid double-submit CSRF, missing/malformed/inactive/rotated/expired or
impersonated sessions, session-cookie fingerprint mismatch, malformed/expired
rate-limit permits, rate-limit dependency failure, and gateway deadline
overrun. Client body/query scope fields are ignored; the locked session
repository alone supplies principal, tenant, organization, and branch. Its
rate-limit permit and session lock remain current through resolver and signer
completion, and token TTL cannot exceed idle or absolute session expiry.

At the PR #24 gateway tree this was still a pure gateway candidate without a
PostgreSQL session/context-selection repository or durable rate-limit adapter.
It also had no HTTP response route, browser token storage decision, or
production credential.

Migration `0064` and the two narrow PostgreSQL adapters now provide that
default-unwired repository candidate. `fas_session_v1` resolves only a hashed,
server-held session to the latest explicit server-side context selection and
locks the session, fresh account, HUMAN principal, membership, and selection
through callback completion. `fas_rate_limit_v1` accepts no raw session ID,
recomputes the exact domain-separated subject hash, revalidates the current
selection, atomically limits the one-minute window, and writes one UUIDv7
permit receipt for an allowed request. The session resolver and rate limiter
use different LOGIN/NOLOGIN owner pairs and exact EXECUTE-only grants; neither
login receives table DML.

The candidate PostgreSQL matrix additionally requires: direct table denial;
missing session/selection and fingerprint mismatch; current account and HUMAN
membership binding; issuance-first rotation serialization;
inactive/rotated/revoked selection; client scope fields
ignored by the end-to-end gateway; invalid limiter subject; concurrent count
never exceeding five persisted permits per window; SQLSTATE `57014` rollback;
and clean `app.tenant_id` on pool reuse. The exact implementation tree
`8dcad10ba085b4b2b5109843332b7dcebfd0858b` passed PostgreSQL foundation run
`32557659145`, adapter/evidence/session run `32557659147`, durable-audit run
`32557659177`, and G0 Linux/Windows run `32557659146` on GitHub head
`2c216128a60a634a1ee56a2967a2a7ad7be84495`. The prior red runs
`32557456825` and `32557546603` found and caused correction of test fixture
typing and NOLOGIN-owner row-lock privileges; neither is evidence. Independent
review and required repository checks remain necessary before any route or
production credential is wired.

Migration `0065` adds a separate EXECUTE-only self-session selection lifecycle
candidate. Its new login has no table DML and its NOLOGIN owner can only lock
the authoritative session/account/principal/membership rows, transition the
current selection, and append a typed command receipt. The RPC accepts only
`SELECT` and `REVOKE`, recomputes the raw session fingerprint, requires exact
current selection id/generation, denies cross-tenant switching, and derives the
actor and target membership from locked server state. It cannot create an
authorization grant or mutate a role package. The adapter HMAC-fingerprints the
idempotency key with a separate secret and reconciles an ambiguous COMMIT only
by replaying the same canonical request.

`0065` is an empty-foundation migration, not an in-place adoption migration. It
locks the `0064` selection/rate/permit tables and aborts if any contains a row;
a non-empty environment requires a separately reviewed provenance-preserving
adoption plan. The adoption test must seed a pre-`0065` row under the same
FORCE-RLS posture and prove the migration aborts while FORCE RLS is restored.
The test matrix must also inject one and two lost COMMIT
acknowledgements, prove exactly one receipt, expose the unresolved case as a
typed non-PII unknown outcome, and reconcile only by the same request.

The PostgreSQL candidate matrix must prove: exact login/owner attributes and
cross-RPC/table denial; SERIALIZABLE NULL command/environment/cell rejection;
initial selection creation with same-key exactly-once replay and changed-request
conflict; issuance-first rotation serialization; different-key same-generation
single winner; stale and cross-tenant denial; no skipped generation; terminal
resurrection, identity mutation, receipt mutation, and deletion denial; raw
session and idempotency-key absence; SQLSTATE `57014` rollback; and clean pool
tenant GUC. The receipt tenant policy is SELECT-only for observers; lifecycle
receipt insertion remains confined to the lifecycle owner path.
This candidate has no positive CI claim until an exact PostgreSQL 16 final-head
run passes.

Selection lifecycle CI does not authorize runtime wiring. The current active-
context token is not yet cryptographically bound to `selectionId` plus
`sessionGeneration`, so a token issued before rotation/revocation remains a
hard route/browser NO-GO until every privileged consumption revalidates the
current ACTIVE selection.

The exact gateway implementation tree
`dcf62cb5d5fef588dc9b6c5e599fe1144f542dbb` passed foundation run
`32555803426`, adapter/evidence run `32555803404`, durable-audit run
`32555803435`, and G0 Linux/Windows run `32555803400` on GitHub head
`d957791b0ef6307d55e997e691d981100f1e59ba`. Earlier G0 run `32555647367`
failed only the new static registration audit because it assumed repository-root
cwd; the corrected test passes under the actual filtered-package cwd and the
local repository-root cwd. No failed run is treated as evidence.

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
