# Find And Study OS — Engineering Constitution

Status: Normative
Applies to: Entire repository and every human or AI-assisted engineering task
Adopted: 2026-08-04

This constitution is the default engineering contract for Find And Study OS.
The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative. A
task-specific user instruction may authorize a narrower exception, but it does
not silently waive unrelated safety rules. System-level safety requirements
always take precedence.

Every contributor and AI agent MUST read this file before making changes. The
constitution remains in force until the user explicitly changes it.

## 1. Project Purpose

Find And Study OS manages active education-consultancy operations, including
leads, students, applications, documents, contracts, finance, messaging,
notifications, staff workflows, public application flows, and university portal
automation.

Production remains active while development continues. New student, application,
message, payment, document, audit, and portal records may be created at any time.
Protecting that live activity takes priority over deployment speed or developer
convenience.

The repository is a pnpm TypeScript monorepo whose main runtime boundaries are:

- `artifacts/edcons`: React/Vite web application;
- `artifacts/api-server`: Express API and controlled API-internal schedulers;
- `artifacts/portal-automation-worker`: dedicated browser automation worker;
- `lib/db`: PostgreSQL/Drizzle schema and reviewed migrations;
- `lib/*`: shared contracts, integrations, storage, validation, and domain tools;
- `deploy`: production build, PM2 topology, and deployment preflight controls.

## 2. Engineering Principles

1. Preserve live data before preserving convenience.
2. Prefer explicit, reversible, observable operations.
3. Make unsafe states fail closed with actionable errors.
4. Keep one authoritative path for each operational concern.
5. Prefer additive and backward-compatible evolution.
6. Prove behavior with repository evidence and tests; do not rely on assumptions.
7. Keep changes minimal, cohesive, and inside the requested scope.
8. Preserve existing architecture and user-owned work unless a change is
   explicitly required.
9. Treat production, the local production-derived database, and Git as different
   sources with different trust boundaries.
10. Never hide a blocker behind a fallback, retry loop, warning, or silent skip.

## 3. AI Agent Working Rules

The default AI-agent scope is **local repository work only**. Unless the user
explicitly authorizes the exact action for the current task, an agent MUST NOT:

- create a commit;
- push, force-push, create a branch, open a PR, merge, or write to GitHub/remote;
- connect to production or staging by SSH, SFTP, SCP, rsync, console, or API;
- access a live database;
- deploy, release, restart, rollback, or change infrastructure;
- operate real PM2, Docker, systemd, Nginx, queues, or workers;
- run a real migration, seed, backfill, cleanup, or destructive SQL operation;
- contact live external integrations or real recipients.

Additional agent rules:

- Start from repository evidence. Mark unavailable production facts as
  **Unverified** rather than inferring them.
- Inspect before editing. For diagnosis/review tasks, do not implement a fix
  unless requested.
- Preserve dirty-worktree changes. Never use destructive Git or filesystem
  commands to discard work.
- Never print `.env` values, connection strings, credentials, tokens, cookies,
  private documents, or production personal data.
- Do not upload repository contents or production-derived data to third parties.
- Use the smallest safe change and avoid unrelated refactors.
- Report commands run, tests performed, files changed, untracked files, known
  limitations, and actions deliberately not taken.
- Stop and request direction when the target, authority, data impact, rollback,
  or production state cannot be proven safely.

Explicit permission is task-specific. Permission to inspect production does not
grant permission to mutate it; permission to deploy does not automatically grant
permission to migrate, restart unrelated services, or restore data.

## 4. Local Development Policy

- Use pnpm; do not introduce npm/yarn lockfiles.
- The default local PostgreSQL target is `127.0.0.1:5433`, database
  `fasos_apply_local`, unless the user explicitly changes it.
- Before any mutating database command, resolve and verify that the host and
  database are local/disposable.
- The local database and storage are development copies, never the current
  production source of truth.
- Allowed data direction is production-to-isolated-local only. Local rows,
  dumps, `.env`, storage, uploads, or logs MUST NOT be synchronized to production.
- `backups/production-import/fasos_apply-production.unverified.dump` MUST remain
  quarantined and MUST NOT be restored.
- Keep `ALLOW_LIVE_INTEGRATIONS=false` locally.
- Keep API background jobs disabled unless a local test explicitly needs them.
- Use fixtures, mocks, or disposable databases for destructive and migration
  tests. Do not mutate the important local development database for test setup.
- Do not delete or relocate existing local `.env`, storage, uploads, logs,
  backups, or database files without explicit approval.

## 5. Git Policy

- Commit, push, branch, merge, tag, and PR actions require explicit user
  authorization.
- Never commit secrets, `.env` files, dumps, backups, runtime logs, production
  storage, uploaded documents, browser auth state, or copied personal data.
- Secret-free `.env.example` files MAY be tracked.
- Preserve unrelated local modifications and untracked files.
- Do not use `git reset --hard`, destructive checkout, broad clean commands, or
  history rewriting without explicit approval and an exact target.
- `git clean -fdx` is forbidden in project/deployment automation.
- A release MUST come from an exact reviewed commit. Critical untracked files
  are not a release artifact until intentionally included.
- Before handoff, run `git diff --check` and report `git status --short` and
  `git diff --stat` when code was changed.

## 6. Deployment Policy

- Deployment is forbidden by default and requires a task-specific user approval
  after a production preflight report.
- `deploy/deploy.sh` is the canonical repository deployment entrypoint.
  Compatibility scripts MUST delegate to it and MUST NOT implement parallel
  deployment behavior.
- The authoritative PM2 topology is `deploy/ecosystem.config.cjs`:
  - API: `fasos-apply-api`, fork mode, one instance;
  - portal worker: `findandstudy-portal-worker`, fork mode, one instance.
- Never use blind `pm2 start`, `startOrRestart`, `restart all`, or an unknown
  process name in production deployment automation.
- PM2 and persistent-data preflights MUST pass before restart.
- Deployment MUST NOT copy, replace, delete, or roll back `.env`, storage,
  uploads, backups, dumps, or other persistent runtime data.
- A release MUST have an immutable source commit, build evidence, health checks,
  smoke tests, monitoring plan, and code rollback target.
- Migration is a separate reviewed operation. Deployment MUST NOT silently
  apply schema changes or assume API boot will repair schema.
- Do not deploy while migration validation fails, production worktree changes
  are unexplained, backups are unverified, or worker topology is uncertain.
- Prefer immutable/atomic release switching over building in the live directory.
- Code rollback MUST preserve the live database and storage. Database restore is
  a separate last-resort recovery decision, not normal code rollback.

## 7. Production Safety Rules

- Treat production access as read-only until the user explicitly authorizes a
  defined mutation.
- Never restore a local database/dump into production or synchronize local rows
  back to production.
- Never replace production storage with local storage.
- Never copy a local `.env` to production.
- Verify the production commit, dirty worktree, PM2 process list, database
  target, storage path, and live service topology before an approved release.
- Immediately before a data-affecting release, create a fresh PostgreSQL
  custom-format dump with `--no-owner --no-acl`; verify exit code, SHA-256, and
  `pg_restore --list` readability.
- Verify a recoverable production storage snapshot/backup independently of Git.
- Record source commit, production commit, backup identifiers, release time,
  expected impact, and rollback boundary.
- Do not test email, WhatsApp/Meta, portal, payments, or other live integrations
  using real recipients without explicit authorization.
- If restoring an older database could remove activity created after backup,
  stop and obtain a new explicit recovery decision.

## 8. Database & Migration Rules

The single intended migration authority is:

1. Drizzle schema under `lib/db/src/schema`;
2. reviewed SQL under `lib/db/drizzle`;
3. one coherent journal at `lib/db/drizzle/meta/_journal.json`;
4. the explicit `migrate:reviewed` runner after validation.

Mandatory rules:

- API boot MUST NOT run DDL, schema synchronization, seed, cleanup, large
  backfill, or data-repair migrations.
- Route/module import MUST NOT mutate schema or data.
- `drizzle push`/schema push is forbidden for production and staging.
- Migrations MUST have unique, ordered identities and a coherent journal.
- Never rename, delete, reorder, or rewrite a migration that may have been
  applied without first reconciling the applied production history.
- Generated SQL MUST be reviewed. ORM generation is not approval.
- Prefer additive tables, nullable columns, compatible defaults, and safe index
  creation. Estimate locks, rewrites, runtime, disk growth, and request impact.
- `DROP`, `TRUNCATE`, destructive `DELETE`, populated-column rename/type change,
  and non-compatible constraint changes require a dedicated plan, verified
  backup, recovery limits, and fresh explicit approval.
- Seeds and catalog initialization are explicit operations, not boot behavior.
- Backfills MUST be separate, bounded, resumable, idempotent where possible,
  observable, and safe to pause/retry. They MUST NOT be hidden in API boot.
- A missing migration MUST cause validation/readiness failure; the API MUST NOT
  silently repair it.
- Migration scripts MUST identify the target environment and fail closed for
  production/staging unless the approved production runbook explicitly permits
  the operation.
- Dump/restore pipelines MUST use `pipefail`; a failed or partial restore MUST
  stop before migrations.

Adoption-time migration gate: the duplicate `0020` identity and SQL/journal
inconsistencies were reconciled into the contiguous reviewed history through
`0040`; repository validation records that history as coherent. Every later
migration MUST preserve that sequence and pass ledger plus database-state
validation before deployment.

## 9. Background Worker Rules

- API-internal schedules MUST be registered through `BackgroundJobCoordinator`.
- `BACKGROUND_JOBS_ENABLED` is the single master control. Missing or invalid
  production-like configuration MUST fail safe with jobs disabled while HTTP can
  still start.
- One scheduler set MUST hold the PostgreSQL advisory lock. Process-local flags,
  PID files, or PM2 instance count alone are insufficient.
- Failure to acquire the lock MUST leave HTTP running and produce an explicit
  log; it MUST NOT start a second scheduler set.
- The dedicated portal automation worker remains a separate PM2 process and
  MUST NOT be started from API boot.
- New/modified worker start functions MUST provide a stop contract, stop taking
  new work on shutdown, clear their timers, and expose/await in-flight work.
- Queue consumers MUST use atomic claims, leases, `FOR UPDATE SKIP LOCKED`,
  advisory locks, or an equivalent distributed mechanism appropriate to the
  job. Duplicate external delivery must be considered explicitly.
- Crash recovery for `processing`/claimed records MUST be bounded and reviewed;
  it MUST NOT depend on schema-migration boot code.
- Jobs contacting email, messaging, AI, or portals need idempotency/deduplication,
  retry limits, stale-claim handling, and auditable outcomes.
- Cluster/multiple API instances remain forbidden until scheduler and shutdown
  safety is demonstrated for the complete worker set.

## 10. Object Storage Rules

- `artifacts/api-server/src/lib/objectStorage.ts` and
  `ObjectStorageService.streamObjectToResponse` are the canonical object download
  path for logo, avatar, document, contract, inbox media, and generic storage
  routes.
- Normal downloads MUST use real streaming. Do not read complete large files
  into RAM or recreate a stream from a full buffer.
- Range responses MUST correctly implement inclusive byte bounds and
  `Content-Length`, `Content-Range`, `Accept-Ranges`, status `206`, and `416`.
- Stream errors MUST be handled without unhandled exceptions. Client disconnect
  MUST close/destroy the underlying stream and file descriptor.
- Paths MUST be normalized and realpath-checked. Traversal, absolute-path input,
  backslash escape, null bytes, and symlink escape outside the storage root are
  forbidden.
- Authorization MUST be enforced before private object access. Generic object
  routes MUST not trust user-writable reference fields as ownership proof.
- Persistent local storage MUST use an absolute external path such as
  `STORAGE_LOCAL_DIR`; it MUST exist outside the code release and pass
  `deploy/data-path-preflight.cjs`.
- Deploy, rollback, Git, rsync, and cleanup operations MUST NOT copy, delete, or
  overwrite runtime storage.
- Storage compatibility changes require fixtures for small/large files, ranges,
  empty/missing files, MIME types, SHA equality, disconnect, concurrency, memory,
  traversal, and production smoke coverage.

## 11. Environment & Secret Management

- Runtime secrets live outside Git. `.env`, `.env.*`, credentials, tokens,
  connection URLs, browser sessions, and provider keys MUST NOT be committed or
  printed.
- Track only secret-free examples containing variable names and safe placeholders.
- Production values MUST NOT be copied into local `.env` or documentation.
- Environment flags controlling destructive or external behavior require exact
  string matching, explicit documentation, and safe defaults.
- Local defaults MUST disable live integrations, destructive cleanup, production
  migration paths, and background jobs unless a test explicitly enables them.
- Validate required production variables before process restart without logging
  their values.
- Secret rotation, provider credential changes, and portal login changes are
  operational tasks requiring separate authorization and verification.

## 12. Logging & Monitoring

- Logs MUST identify component, operation, and relevant non-secret record ID.
- Never log passwords, tokens, cookies, full connection strings, private file
  contents, or unnecessary personal data.
- Expected fail-closed outcomes should be clear warnings; unexpected failures
  should include actionable context and preserve the original error.
- Do not swallow migration, backup, restore, or release failures as non-fatal.
- Background jobs MUST log enable/disable state, lock ownership, start failure,
  shutdown result, and bounded job outcomes.
- Deployment monitoring MUST cover API health, error rate, PM2 restarts/memory,
  database connections/locks, email queue, messaging, portal claims, storage
  errors, and failed/stale background jobs.
- Runtime logs SHOULD live outside immutable release content and have defined
  retention/rotation.

## 13. Testing Standards

- Tests MUST be proportional to risk and cover both success and failure paths.
- Use local fixtures, mocks, fake timers/locks, or disposable databases. Never
  use production/staging or important local data.
- Every changed package MUST pass its typecheck and relevant targeted tests.
- Cross-cutting changes SHOULD pass:
  - `pnpm run typecheck`;
  - `pnpm run build:prod` when build/runtime behavior is affected;
  - `git diff --check`;
  - `pnpm run test:pm2-safety` for PM2/deploy changes;
  - `pnpm run test:data-boundaries` for storage/Git/deploy path changes;
  - the API cleanup, object-storage, background-job, and migration-authority
    tests when their respective surfaces change.
- Migration-affecting changes MUST run static ledger validation. A broken
  baseline is a blocker to report, never a reason to bypass validation.
- Worker tests MUST cover disabled mode, exclusive lock ownership, ownership
  transfer, shutdown, duplicate claims, and stale recovery.
- Storage tests MUST verify downloaded bytes/SHA, ranges, MIME headers,
  disconnect cleanup, concurrency, and bounded memory growth.
- A green build does not replace production preflight, migration review, smoke
  tests, or monitoring.

## 14. Coding Standards

- Use TypeScript and existing package/module conventions.
- Keep HTTP routes thin: validate input, enforce auth, call domain/storage
  helpers, map known errors, and avoid duplicating infrastructure behavior.
- Validate untrusted boundaries with existing Zod/contracts where available.
- Use parameterized SQL/Drizzle expressions. Never interpolate untrusted values
  into SQL identifiers or statements.
- Handle asynchronous errors intentionally; no floating promises in critical
  flows and no unhandled stream/process errors.
- Preserve API contracts, status codes, headers, audit events, and authorization
  behavior unless the task explicitly changes them.
- Prefer existing shared libraries over local copies.
- Do not add speculative abstractions, broad formatting, or unrelated refactors.
- Comments explain safety invariants and reasons, not obvious syntax.
- Keep code reviewable: cohesive functions, explicit names, bounded side
  effects, and minimal diff size.

## 15. Architecture Rules

- Preserve the pnpm workspace and package boundaries.
- Frontend uses the shared API clients/contracts rather than duplicating backend
  schemas or constructing inconsistent endpoints.
- API is the HTTP/auth/domain orchestration boundary; database definitions live
  in `lib/db`; reusable logic belongs in an appropriate shared library.
- Database schema evolution belongs only to the migration authority, never
  route import or application boot.
- API schedulers use `BackgroundJobCoordinator` plus PostgreSQL advisory lock.
- Portal browser automation stays in the dedicated portal worker.
- Object access routes use the canonical object-storage helper.
- PM2 topology and process names come from one authoritative config.
- Deploy and compatibility entrypoints delegate to one guarded workflow.
- Persistent state is external to the release; code releases are replaceable.
- New architecture boundaries require an explicit rationale, dependency map,
  migration path, and tests.

## 16. Performance Rules

- Stream large files and responses; avoid file-sized buffers and unbounded JSON.
- Paginate/list-bound database reads and batch large writes/backfills.
- Avoid N+1 queries, unbounded loops, and loading whole production tables into
  memory.
- Background work needs bounded batch size, interval, concurrency, retry count,
  timeout, and memory use.
- Index changes require query/use evidence and production-safe creation review.
- External calls require timeouts and controlled retry behavior. Never retry an
  operation when provider acceptance is ambiguous and duplication is harmful.
- Measure or test memory/latency for storage, import/export, AI extraction, and
  portal automation changes likely to handle large inputs.

## 17. Security Rules

- Every private route MUST enforce authentication and the narrowest existing
  role/permission/source-scope authorization.
- Never weaken `requireAuth`, role, permission, ownership, agent scope, or signed
  token checks for convenience.
- Protect object paths against IDOR and traversal; verify ownership/ACL before
  serving private data.
- Validate upload type, size, path, and filename. Serve untrusted content with
  correct MIME, content disposition, cache policy, and `nosniff` where relevant.
- Parameterize SQL and validate IDs/enums. Treat dynamic SQL and bulk operations
  as high risk.
- Apply rate limits to public, auth, upload/download, signing, webhook, and
  integration-sensitive surfaces as appropriate.
- Verify webhook/API signatures and scopes; avoid secrets in query strings.
- Destructive admin actions require explicit authorization, audit logging,
  confirmation/flags, and fail-closed target validation.
- Sensitive state changes involving students, applications, contracts, finance,
  users, permissions, integrations, and portal submissions MUST be auditable.
- Security fixes require regression tests for the exploit/failure mode.

## 18. Definition of Done

A task is done only when:

1. The requested behavior is implemented without unrelated changes.
2. Architecture, auth, migration, worker, storage, and production boundaries are
   respected.
3. Relevant tests, typechecks, builds, and `git diff --check` pass, or each
   unrun/failed check is explicitly reported with reason.
4. No secret, dump, production storage, log, or personal data was added to Git.
5. New files and generated artifacts are identified.
6. Error, shutdown, concurrency, retry, and rollback behavior are considered in
   proportion to risk.
7. Documentation/examples are consistent with the resulting behavior.
8. The final report lists changed files, verification results, remaining risks,
   and confirms whether commit/push/PR/production/deploy actions occurred.
9. Production-affecting work has a reviewed preflight and awaits explicit
   approval; local completion is not production release approval.
10. No known P0/P1 release blocker is described as ready.

## 19. Pull Request Standards (Future Use)

When PRs are authorized in the future, each PR MUST:

- have one clear purpose and a bounded diff;
- explain user/business impact and affected modules;
- identify schema, data, worker, storage, auth, integration, and deployment
  impact;
- include test commands/results and manual smoke steps;
- include migration SQL, lock/runtime assessment, backfill plan, and rollback
  limits when applicable;
- disclose new environment variables without secret values;
- disclose generated files, untracked dependencies, and operational steps;
- preserve backward compatibility or document rollout sequencing;
- require focused review for auth/security, finance, migration, worker, portal,
  and storage changes;
- never merge with unresolved P0/P1 findings or failing required checks.

## 20. Future Maintainer Notes

- Read `AGENTS.md`, this constitution, current deployment documentation, and the
  relevant module analysis before changing cross-cutting behavior.
- Do not assume GitHub, local code, and the VPS are identical. Production may
  contain deliberate or accidental Git-external hotfixes.
- The current migration history was historically split between boot DDL,
  hand-written SQL, an incomplete Drizzle journal, and separate scripts. Do not
  normalize filenames or journal entries mechanically; reconcile against actual
  applied history first.
- The disabled legacy boot DDL and pipeline migration function are migration
  archaeology, not approved runtime behavior. Remove them only after every
  required schema/data operation has an authoritative reviewed destination.
- Background scheduler exclusivity is stronger than scheduler shutdown. Before
  enabling multi-instance API or claiming graceful drain, ensure each real
  worker exposes stop/in-flight completion behavior and queue crash recovery.
- The production `BACKGROUND_JOBS_ENABLED` decision affects email retries,
  contract/follow-up checks, scoring, messaging, and other operations; treat it
  as an operational rollout decision, not a casual environment default.
- Storage must remain independent of releases. Code rollback must never roll
  back student uploads or replace newer production files.
- Keep this constitution concise enough to use, but update it whenever an
  architectural authority, process name, migration mechanism, storage driver,
  or production safety boundary intentionally changes.
