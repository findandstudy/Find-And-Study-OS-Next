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
receipt IDs from the command body. Those values are derived from a verified
active-tenant context, current server-resolved authorization state, server-side
session assurance, and a server UUIDv7 factory.

The orchestrator always establishes transaction-local tenant context before
state resolution or repository access. It authorizes the exact loaded scope,
rejects impersonation, claims a hashed idempotency key, and commits the domain
mutation and result projection in one transaction. A policy rejection after a
claim throws an internal rollback signal, so a failed command cannot leave a
stuck claim.

Migration `0056_change_set_command_idempotency.sql` stores only the SHA-256 hash
of an idempotency key. A tenant/key pair can move only from a clean `CLAIMED`
record to a complete evidence-bearing `COMPLETED` record. Claim identity is
immutable, delete is unavailable, and RLS is enabled and forced. A replay must
match both request hash and actor and must contain the exact PII-free result
projection; changed requests, corrupt projections, and in-progress claims fail
closed.

## Security boundary

The runtime policy in `artifacts/api-server/src/lib/changeSetPolicy.ts` is a
pure decision layer. Its actor capabilities are an internal input contract,
not trusted request data. A future route must derive the actor, tenant,
membership, policy version, capability set, and step-up state from a verified
`activeTenantContext`; it must never accept capability strings, tenant IDs, or
impersonation state from a browser payload.

Before any database access, the future route must:

1. verify the signed active-tenant context;
2. revalidate tenant, principal, membership, assignment, and policy state;
3. reject impersonated sessions for every mutation;
4. bind the request scope to the verified tenant and organization/branch;
5. set `SET LOCAL app.tenant_id` only inside the transaction and only after
   verification;
6. evaluate the typed ChangeSet policy with the server-derived actor;
7. use optimistic concurrency against the current ChangeSet version.

RLS is enabled and forced on all three tables. There are no delete policies.
Approval and transition receipts are immutable. Missing tenant context returns
no tenant-owned rows.

`LEGACY_BRANCH` remains a compatibility scope. It may be wired only after the
active context proves the exact tenant, organization, and legacy branch tuple;
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

The command orchestrator requires its future PostgreSQL adapter to perform this
order in one database transaction:

1. lock and re-read the ChangeSet under tenant RLS;
2. write the current-round approval decision first when the target is
   `APPROVED`, `RETURNED`, or `REJECTED`;
3. write the transition receipt;
4. update the ChangeSet state and increment its version;
5. commit all three effects together.

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
- a notification preview sandbox;
- database-backed integration tests;
- a production or local database migration;
- R2/R3/R4 changes, multi-tenant changes, code, schema, infrastructure, or
  secret rotation;
- external-tenant readiness.

The system remains NO-GO for an external tenant. Existing legacy route and
writer quarantines remain authoritative.

## Next safe slice

The next implementation slice is the PostgreSQL adapter for the default-off
command orchestrator, followed by database-backed concurrency/RLS tests on the
approved isolated local database. The adapter must implement the exact
transaction interface and statement order without a bypass path. No API route
or Super Admin UI is connected until those tests pass. The publisher and
configuration materialization adapters stay separate until that command path
passes the relevant gate.
