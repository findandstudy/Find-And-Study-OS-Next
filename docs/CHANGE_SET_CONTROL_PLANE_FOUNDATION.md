# ChangeSet Control Plane Foundation

Status: additive, default-unwired foundation. This document is a security and
delivery contract, not evidence that the feature is enabled. Migrations `0055`
and `0056` have not been applied to any database. There is no PostgreSQL command
adapter, Super Admin route, publisher, worker, or UI wired to these tables yet.

## Outcome

This slice establishes the first bounded control-plane path for long-lived
tenant configuration. A Super Admin is not a universal bypass user. A proposed
change must be represented as a versioned ChangeSet, evaluated against a
verified active-tenant context, independently reviewed, published through a
bounded canary, observed, and either made effective or rolled back with durable
evidence.

The foundation deliberately admits only reversible, single-tenant, R1 changes:

- `BRAND`
- `LOCALE`
- `NOTIFICATION_TEMPLATE`
- `FEATURE_FLAG`
- `MAINTENANCE_BANNER`

Only `PUBLIC` and `INTERNAL` data classes are allowed. Code, database schema,
infrastructure, arbitrary scripts, raw SQL, credentials, secrets, private keys,
and cross-tenant changes are outside this path and fail closed.

## Default-off command orchestrator

`artifacts/api-server/src/lib/changeSetCommand.ts` provides a storage-agnostic
create/transition orchestrator. It does not accept tenant IDs, actor IDs,
capability strings, policy versions, step-up receipts, owner IDs, or approval
receipt IDs from the command body. It also does not accept client-selected data
classification or transition evidence. Those values are derived from a verified
active-tenant context, current server-resolved authorization state, server-side
session assurance, and a server UUIDv7 factory. Create commands also cannot
provide the base configuration or version: the future adapter must lock and
read the authoritative materialized configuration, then derive the next version
on the server.

The orchestrator always establishes transaction-local tenant context before
state resolution or repository access. It authorizes the exact loaded scope,
rejects impersonation, claims a hashed idempotency key, and commits the domain
mutation and result projection in one transaction. A policy rejection after a
claim throws an internal rollback signal, so a failed command cannot leave a
stuck claim. Access-decision receipts are written only after the idempotency
claim result is known and correlate to the persisted command receipt for a new
command or replay. Conflict and in-progress attempts fail without incorrectly
attaching a new access decision to the old command; a future attempt-receipt
model must represent those attempts separately.

Migration `0056_change_set_command_idempotency.sql` stores only the SHA-256 hash
of an idempotency key. A tenant/key pair can move only from a clean `CLAIMED`
record to a complete evidence-bearing `COMPLETED` record. Claim identity is
immutable, delete is unavailable, and RLS is enabled and forced. A replay must
match both request hash and actor and must contain the exact PII-free result
projection. The stored result hash is recomputed and compared before replay;
changed requests, altered results, corrupt projections, and in-progress claims
fail closed.

Create can only produce `DRAFT`; the current transition target allowlist is only
`VALIDATED`, `SIMULATED`, and `IN_REVIEW`. Return-to-draft, approval, return,
rejection, scheduling, canary, publication, observation, effectiveness, failure,
rollback, and revocation remain default-off. In particular, no decision target
is enabled until a server-side step-up receipt verifier binds a single-use
receipt to the principal, context, action, audience, and expiry.

A verified context is immutable, process-local branded, and rechecked against
its issued/expiry window at every command and capability evaluation. A copied,
mutated, not-yet-valid, or expired context fails before transaction access.

## Security boundary

The runtime policy in `artifacts/api-server/src/lib/changeSetPolicy.ts` is a
pure decision layer. Its actor capabilities are an internal input contract,
not trusted request data. A future route must derive the actor, tenant,
membership, policy version, capability set, and step-up state from a verified
`activeTenantContext`; it must never accept capability strings, tenant IDs, or
impersonation state from a browser payload.

The future route must execute this trust order:

1. verify the signed active-tenant context before opening the mutation path;
2. start one database transaction and set `SET LOCAL app.tenant_id` from that
   verified context;
3. under RLS, revalidate tenant, principal, membership, assignment, policy, and
   impersonation state;
4. bind the request scope to the verified tenant and organization/branch;
5. evaluate the typed ChangeSet policy with the server-derived actor;
6. use optimistic concurrency against the current ChangeSet version.

RLS is enabled and forced on all three tables. There are no delete policies.
Approval and transition receipts are immutable. Missing tenant context returns
no tenant-owned rows.

`LEGACY_BRANCH` remains a compatibility scope, but the command orchestrator now
rejects it. It may be enabled only after a tenant-owned binding proves the exact
tenant, organization, and legacy branch tuple through composite constraints;
the raw branch ID by itself is never authority.

## State and review contract

The state machine is:

```text
DRAFT -> VALIDATED -> SIMULATED -> IN_REVIEW
                                      |  |  |
                                      |  |  +-> REJECTED
                                      |  +----> RETURNED -> DRAFT
                                      +-------> APPROVED -> SCHEDULED -> CANARY
                                                                 -> PUBLISHED
                                                                 -> OBSERVING
                                                                 -> EFFECTIVE
```

Defined operational states can also move to `FAILED`, `ROLLED_BACK`, or
`REVOKED` only along explicitly permitted edges. State skipping fails closed.
Every update increments the ChangeSet version exactly once.

Each entry into `IN_REVIEW` increments `review_round`. An approval, return, or
rejection is valid only for the current review round and current approval policy
version. A single immutable decision is allowed per review round. Returning a
ChangeSet to its maker and submitting it again therefore invalidates the old
decision without mutating history.

The maker cannot act as checker. Approval and all high-impact transitions need
a UUIDv7 step-up receipt. Impersonated sessions cannot mutate a ChangeSet.

## Receipt and transaction order

A transition receipt is a tenant-bound append-only hash chain. Its sequence
must be the current ChangeSet version plus one, its source state must match the
current database state, its policy version must match the ChangeSet, and its
`previous_hash` must equal the latest receipt hash. The first transition receipt
has no previous hash.

The command orchestrator requires its future PostgreSQL adapter to perform each
flow in one database transaction. Both flows first establish transaction-local
tenant context and resolve current authorization. Create then claims the
idempotency key, records the correlated access decision, locks and reads the
authoritative configuration, derives the next version, inserts the draft, and
completes the command with a canonical result hash. Transition locks and
re-reads the ChangeSet, authorizes its stored scope, claims the idempotency key,
records the correlated access decision, reads the latest receipt hash, writes
the receipt, updates state/version, and completes the command. A future enabled
decision target must insert the current-round approval before its transition
receipt.

The authoritative configuration lock must also return any active proposal for
the same tenant/scope/type while holding that lock. A competing active proposal
causes the new command transaction to roll back. Before any future approval or
publish action, the materialized base version/hash must be revalidated again.

Any error must roll back the entire transaction. A route must never insert a
receipt and commit it separately from the associated state mutation.

The database serializes competing decisions by locking the ChangeSet while
validating an approval or receipt. Unique sequence and review-round constraints
provide a second line of defense against concurrent double execution.

## Typed configuration contract

Every R1 type has an exact key allowlist and field constraints. Base and
proposed configurations are canonicalized and SHA-256 hashed. A semantic diff
and restore-base-version rollback strategy are derived by the server. No-op
changes are rejected.

The command foundation admits only feature flags in the explicit
`R1_FEATURE_FLAG_REGISTRY`. Its initial non-production entry is `journey.beta`,
owned by `student-journey`, with a maximum ten-percent cohort and the dedicated
`control_plane.flag.create` capability. Other R1 types also use type-specific
create capabilities. Arbitrary flag names, flag-key switching, generic create
authority, and larger cohorts fail closed. The data class is derived by the
server from the admitted R1 type. Registry membership does not enable or
materialize a flag; that requires a separately reviewed adapter and rollout
gate.

`VALIDATED`, `SIMULATED`, and `IN_REVIEW` do not trust command-body booleans or
counts. The future store must load immutable server-issued evidence receipts
under the same transaction. Each typed receipt binds its UUIDv7 ID, kind,
issuer, tool version, tenant, ChangeSet, target state, requesting principal,
proposed hash, policy version, issued/expiry window, and unconsumed state.
Review submission requires distinct `TEST_ARTIFACT`, `ROLLBACK_PLAN`, and
`CANARY_PLAN` receipts. Missing, duplicate, expired, consumed, cross-ChangeSet,
wrong-kind, or mismatched evidence rolls back the claim and state change.

Notification template variables must be declared whether referenced in the
subject or body. Template variables that suggest passwords, secrets, tokens,
passports, national IDs, or SSNs are not admitted. Plain-text fields reject
obvious script/event-handler/javascript payloads.

Sensitive material is rejected recursively from configuration and transition
evidence. This is a guardrail, not a secret scanner guarantee; secrets belong in
a dedicated secret manager and are referenced by opaque, non-sensitive handles
through a separately designed higher-risk workflow.

## Rollout and rollback contract

Submission for review requires validation, simulation, at least one test
evidence item, a prepared canary, and a ready rollback. Scheduling cannot be in
the past. Canary and publish steps require mutation receipts. Publication cannot
skip a successful canary.

An R1 change must observe frozen guardrails for at least one hour. It can become
`EFFECTIVE` only with zero SLO violations and passed guardrails. Rollback,
failure, and revocation transitions require their own durable execution
receipts. Failed, rejected, rolled-back, and revoked states are closed.

## Deliberately not delivered

This foundation does not yet deliver:

- a Super Admin ChangeSet inbox or editor;
- a PostgreSQL adapter or API route for the default-off command orchestrator;
- a publisher/worker or actual configuration materialization;
- verified step-up issuance;
- authoritative materialized-configuration repository;
- immutable validation/simulation/test/rollback/canary evidence repository;
- tenant/organization/legacy-branch composite binding;
- separated migrator and runtime application database roles;
- a notification preview sandbox;
- database-backed integration tests;
- a production or local database migration;
- R2/R3/R4 changes, multi-tenant changes, code, schema, infrastructure, or
  secret rotation;
- external-tenant readiness.

The system remains NO-GO for an external tenant. Existing legacy route and
writer quarantines remain authoritative.

## Next safe slice

The next implementation slice is the disposable PostgreSQL integration harness
and database-role boundary described in
`CHANGE_SET_POSTGRES_INTEGRATION_GATE.md`. The adapter must implement the exact
transaction interface and statement order without a bypass path. No API route
or Super Admin UI is connected until those tests pass. The publisher and
configuration materialization adapters stay separate until that command path
passes the relevant gate.
