# ChangeSet Control Plane Foundation

Status: additive, default-unwired foundation plus tested PostgreSQL command,
evidence, and durable-audit adapter candidates. This document is a security and
delivery contract, not evidence that the feature is enabled. Migrations `0055`
through `0060` have not been applied to a long-lived database. No API route,
Super Admin UI, publisher, worker, or materializer is wired to these adapters.

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
provide the base configuration or version: the adapter must lock and
read the authoritative configuration snapshot, then derive the next version on
the server. The default-unwired PostgreSQL adapter now implements that contract
for the bounded candidate path; it is not reachable from HTTP or a worker.

The command store accepts the exact process-branded verified context rather
than a caller-selected tenant ID and establishes transaction-local tenant
context internally before state resolution or repository access. The
transaction surface has no public tenant setter. It authorizes the exact loaded scope,
rejects impersonation, claims a hashed idempotency key, and commits the domain
mutation and result projection in one transaction. A policy rejection after a
claim throws an internal rollback signal, so a failed command cannot leave a
stuck claim. Access-decision receipts are written only after the idempotency
claim result is known and correlate to the persisted command receipt for a new
command or replay. Authorization denials receive a DENY decision receipt before
any idempotency claim. Conflict and in-progress attempts do not attach a new
access decision to the old command; `0057` adds a separate immutable attempt
receipt for those outcomes.

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
its issued/expiry window before pool access, after `BEGIN`, at every command and
capability evaluation, and before every command RPC. A copied, mutated,
not-yet-valid, or expired context fails before business access. Command claims,
attempt and access receipts, drafts, approvals, evidence loads, and transition
receipts must retain the same context, principal, membership, and policy
identity where those fields apply; same-tenant identity substitution fails
before the RPC call.

## Default-unwired PostgreSQL adapter candidate

Migration `0059_change_set_postgres_command_adapter.sql` adds the tenant-owned
R1 configuration snapshot and two versioned, fixed-search-path RPC façades:
`fas_cp_v1` for command transactions and `fas_evidence_v1` for signed evidence
admission. The migration grants neither a shared application credential nor a
new login role. Public execute and direct table access remain revoked.

`postgresChangeSetCommandStore.ts` executes one command per transaction. It
requires the original verified context object, derives `app.tenant_id` only
inside the store from that object, revalidates the active principal,
membership, assignments and policy under locks, and exposes only the RPC
operations required by the storage-agnostic orchestrator. It verifies persisted
Ed25519 evidence again at consumption time and binds artifact count,
artifact-manifest hash and outcome hash to the command decision.
`postgresChangeSetEvidenceIssuer.ts` verifies the signed envelope against the
trusted issuer/key/grant state before calling the issuer-only RPC. Neither
adapter contains a private signing key.

The disposable PostgreSQL 16 harness supplies separate `NOLOGIN` function
owners and separate least-privilege command-executor and evidence-issuer login
roles. Login roles receive RPC execute only and no Control Plane table DML. The
harness proves copied-context rejection, in-transaction expiry rejection,
same-tenant actor substitution rejection, absence of a public tenant setter,
create, signed validation evidence admission, DRAFT to VALIDATED, canonical
replay, transaction rollback, pool reuse/context cleanup, role separation and
direct-access denial. These roles and grants are test bootstrap evidence, not a
production role rollout.

## Security boundary

The runtime policy in `artifacts/api-server/src/lib/changeSetPolicy.ts` is a
pure decision layer. Its actor capabilities are an internal input contract,
not trusted request data. A future route must derive the actor, tenant,
membership, policy version, capability set, and step-up state from a verified
`activeTenantContext`; it must never accept capability strings, tenant IDs, or
impersonation state from a browser payload.

The future route must execute this trust order:

1. verify the signed active-tenant context before opening the mutation path;
2. pass that exact process-branded context to the command store; the store must
   start one database transaction and set transaction-local `app.tenant_id`
   internally from that context, with no route-visible tenant setter;
3. under RLS, revalidate tenant, principal, membership, assignment, policy, and
   impersonation state;
4. bind the request scope to the verified tenant and organization/branch;
5. evaluate the typed ChangeSet policy with the server-derived actor;
6. use optimistic concurrency against the current ChangeSet version.

RLS is enabled and forced on every tenant-owned authorization and ChangeSet
foundation table. Receipt tables have no delete policy. Approval, transition,
command-attempt, access-decision, and authorization-change receipts are
immutable; verified evidence permits only an atomic, one-way unconsumed to
consumed update. Each early transition receipt is uniquely bound to its claimed
command; command completion requires the exact typed evidence set and a deferred
constraint requires receipt, state and command completion in the same commit.
Missing tenant context returns no tenant-owned rows.

`LEGACY_BRANCH` remains a compatibility scope, but the command orchestrator
still rejects it. Migration `0057` adds the tenant-owned
`tenant_organization_legacy_branches` map and composite membership, assignment,
and ChangeSet constraints. The scope remains closed until a future narrow
writer/procedure contract proves those constraints without granting generic DML
to the shared `fas_app` credential; the raw branch ID by itself is never authority.

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

The command orchestrator requires every adapter to perform each flow in one
database transaction. The default-unwired PostgreSQL candidate follows this
order. Both flows first establish transaction-local
tenant context and resolve current authorization. Create then claims the
idempotency key, locks and reads the authoritative configuration identity,
re-resolves authorization and time after the lock, records the correlated
access decision, derives the next version, inserts the draft, and completes the
command with a canonical result hash. Transition locks and re-reads the
ChangeSet, authorizes its exact stored scope, claims the idempotency key, locks
server-issued evidence, re-resolves authorization and time, records the
correlated access decision, atomically consumes evidence, writes the receipt,
updates state/version, and completes the command. A future enabled decision
target must insert the current-round approval before its transition receipt.

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
counts. The store must load immutable server-issued evidence receipts
under the same transaction. Each typed receipt binds its UUIDv7 ID, kind,
issuer and issuer principal, signing key, audience, environment/cell, single-use
request and challenge, exact issuer-tenant grant UUID, tool/version, tenant,
ChangeSet, target state, requesting
principal and membership, proposed hash, policy version, pass/fail outcome,
artifact manifest, issued/expiry window, and unconsumed state.
Review submission requires distinct `TEST_ARTIFACT`, `ROLLBACK_PLAN`, and
`CANARY_PLAN` receipts. Missing, duplicate, expired, consumed, cross-ChangeSet,
wrong-kind, failed-outcome, wrong-outcome-hash, or mismatched evidence rolls
back the claim and state change. All required receipts are consumed atomically
by the exact transition command; concurrent reuse admits at most one consumer.

Migration `0058_change_set_evidence_identity_audit_foundation.sql` adds the
default-unwired authenticity registry: issuer identity, public Ed25519 key and
fingerprint, a separately ACL-bound opaque KMS/HSM signing-key reference, exact
tenant-grant UUID, single-use evidence request, persisted canonical signed
claims, and immutable signed-envelope bindings. Private key material is neither
a column nor a configuration value. Key material,
issuer identity, grants, requests, and consumed evidence cannot be rewritten;
rotation creates a new key and moves the prior key through `VERIFY_ONLY` to a
terminal revoked state. `REVOKED` and `COMPROMISED` keys fail closed.

`changeSetEvidenceEnvelope.ts` implements the pure, KMS-compatible Ed25519
issuer/verifier contract. Its domain-separated canonical claims bind every
security-relevant identity and reject claim mutation, wrong key/fingerprint,
wrong tenant grant, expiry, future issuance, malformed artifacts, and revoked
or compromised keys. Verification requires an independently trusted expected
environment/cell and current issuer, key, and exact grant records. PostgreSQL
persists enough canonical claims to reconstruct and reverify the token, locks
issuer/key/grant rows during issue and consumption, and fails closed on revoke
races. PostgreSQL recomputes the stored canonical-claim hash and signed
challenge nonce SHA-256; it does not perform Ed25519 verification or RFC 8785
canonicalization itself. The narrow evidence adapter verifies the exact
canonical envelope before its issuer-only insert procedure can persist a
receipt; a production KMS/HSM issuer and production role bootstrap remain
absent.

The same migration adds `change_set_command_audit_events`, a tenant-scoped,
append-only attempt chain containing fixed enums and keyed fingerprints rather
than raw idempotency keys, request bodies, titles, reasons, errors, stack traces,
secrets, or PII. The database serializes each attempt, preserves actor/context/
request identity, and forbids appends after one terminal event. The `event_hash`
is still an adapter-computed keyed value; the default-unwired table does not
recompute that MAC.

Migration `0060_change_set_durable_audit_adapter.sql` and
`postgresChangeSetAuditWriter.ts` add the first optional outer-attempt writer.
It commits `ATTEMPT_STARTED` before the business transaction and commits one
terminal success/deny/reject/conflict/error event after the business transaction
returns or rolls back. CREATE and TRANSITION start unbound; only a terminal
success can bind a verified ChangeSet ID, and that identity cannot later be
cleared or changed. The writer uses domain-separated HMAC-SHA-256 fingerprints,
re-verifies the stored chain head before appending, and fails closed if the
start event cannot be persisted. The disposable harness gives it a dedicated
EXECUTE-only login and a separate `NOLOGIN` function owner. It is still
default-unwired and uses only an ephemeral CI key; production KMS/HSM custody,
HTTP-to-branded-context and audit-writer context binding, and the full
race/failure matrix remain mandatory before any runtime route can use it.

Migration `0061_change_set_commit_reconciliation.sql` and the command adapter
add the first bounded ambiguous-commit contract. An error returned by the
PostgreSQL `COMMIT` call is not labelled as a definite rollback or terminal
error. The command is retried exactly once with the same tenant, actor, request
hash and hashed idempotency identity. A successful canonical replay is closed
as `COMMAND_RECONCILED`; an unresolved retry is left non-terminal as
`RECONCILIATION/PENDING/COMMIT_OUTCOME_UNKNOWN` and exposes its audit attempt
UUID for a future repair worker. The audit fingerprint is an HMAC of the same
domain-separated SHA-256 identity stored by the command receipt, so a narrow
future reconciler can correlate them without storing the raw key. This does
not yet deliver scheduled incomplete-attempt repair or permission to wire the
adapter into a route.

The disposable PostgreSQL adapter gate also proves real SQLSTATE `57014`
query-cancellation handling. Cancellation before the claim rolls the bounded
business transaction back, leaves no command/access/ChangeSet residue, clears
the tenant-local GUC, and permits safe reuse of the same pool-of-one backend.
With the durable audit writer enabled, the separately committed start event is
closed exactly once as `TERMINAL/ERROR/INTERNAL_ERROR`; cancellation is never
misclassified as a successful command or an ambiguous `COMMIT`.

The real adapter harness also serializes membership and policy revocation in
both lock orders. When the command owns the current-state locks first, the
revoker waits until the canonical replay commits. Once the revoke transaction
commits, the next identical command is denied before it can create a new
command claim. Synthetic fixture restoration occurs only after the deny is
observed and never weakens the runtime contract.

Notification template variables must be declared whether referenced in the
subject or body. Template variables that suggest passwords, secrets, tokens,
passports, national IDs, or SSNs are not admitted. Plain-text fields reject
obvious script/event-handler/javascript payloads.

Sensitive material is rejected recursively from configuration, transition
evidence, title, purpose, and reason text. This is a guardrail, not a secret
scanner guarantee; secrets belong in a dedicated secret manager and are
referenced by opaque, non-sensitive handles
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
- an API route for the default-off command orchestrator;
- a publisher/worker or actual configuration materialization;
- verified step-up issuance;
- a production configuration materializer and reconciliation loop;
- a production evidence issuer or outcome-hash signing service;
- a KMS/HSM-backed production signer, key rotation ceremony, or issuer runtime
  credential;
- production command-executor/evidence-issuer role bootstrap and credentials;
- production audit-key custody/rotation, scheduled incomplete-attempt repair,
  HTTP-to-branded-context wiring, and signed active-context-to-audit-tenant
  binding;
- runtime adoption/backfill of the tenant/organization/legacy-branch map;
- persistent environment grants for separated migrator and runtime application
  database roles;
- a notification preview sandbox;
- a required database-backed runtime-adapter merge gate (the disposable
  foundation and adapter checks are green but repository rules do not yet make
  them required);
- a production or local database migration;
- R2/R3/R4 changes, multi-tenant changes, code, schema, infrastructure, or
  secret rotation;
- external-tenant readiness.

The system remains NO-GO for an external tenant. Existing legacy route and
writer quarantines remain authoritative.

## Next safe slice

The 62-migration PostgreSQL 16 foundation and default-unwired command, evidence,
durable-audit, context-bound transaction, ambiguous-commit, query-cancellation,
and membership/policy revocation workflows described in
`CHANGE_SET_POSTGRES_INTEGRATION_GATE.md` are green on implementation head
`360de74d305ff07a810628701c722eb19b1f3e16` (foundation run `32543303215`,
adapter run `32543303199`, audit run `32543303200`, and G0 Linux/Windows run
`32543303201`).

The next safe slice is the remaining adapter race/failure matrix: scheduled
repair of unresolved commit outcomes, evidence issuer/key/grant revocation in
both lock orders, injected failure at every write boundary, and incomplete-
attempt repair. The shared runtime role must not
receive generic Control Plane DML. No API route or Super Admin UI may be
connected before those controls, required checks, production role/bootstrap
review and independent approval exist. Publisher and configuration
materialization adapters remain separate and default-off.
