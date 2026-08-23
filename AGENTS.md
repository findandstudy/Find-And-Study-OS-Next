# Find And Study OS — Production Safety Instructions

These instructions apply to every task performed in this repository.

## Primary safety objective

Production remains active while development continues. Students, applications,
documents, messages, payments, notifications, and uploaded files may be created
or changed at any time. Preserve all production data added after the local
snapshot was taken.

The local database and local storage are disposable development copies. They
must never be treated as the current source of truth for production data.

## Hard rules

- Never restore the local database or a local dump into production.
- Never synchronize local database rows back to production.
- Never replace production storage with the local storage directory.
- Never copy a local `.env` file to production.
- Never commit or push dumps, `.env` files, credentials, tokens, logs containing
  secrets, or copied production storage.
- Never run a production migration, destructive SQL statement, deployment,
  service restart, container restart, or worker restart without explicit user
  approval for that specific production action.
- Never assume GitHub matches the code currently running on the VPS. Verify the
  production commit and production worktree before planning a deployment.
- Treat all production access as read-only unless the user has explicitly
  approved a defined deployment step.

## Allowed data direction

Production data may be copied to an isolated local environment for development:

```text
Production database/storage -> Local development copy
```

Do not reverse that direction. Production receives application code and vetted
schema migrations, not local database contents or local storage snapshots.

## Database migration requirements

Before proposing a production migration:

1. Inspect the current production schema read-only.
2. Test the migration against a recent production-derived local copy.
3. Estimate locks, runtime, disk growth, and impact on active requests/workers.
4. Prefer additive and backward-compatible changes:
   - add tables;
   - add nullable columns;
   - add indexes using a production-safe method;
   - deploy code that tolerates both old and new schema states;
   - backfill separately in bounded batches when required.
5. Do not drop, truncate, rename, rewrite, or change the type of populated
   production columns without a dedicated plan and explicit approval.
6. Do not use ORM schema push/sync commands against production.
7. Review the generated SQL rather than trusting migration generation alone.

Destructive or irreversible SQL requires a fresh backup, a rollback/data
recovery plan, and explicit user confirmation immediately before execution.

## Required production deployment gate

Do not deploy until all of the following have been reported to the user:

- exact source commit and files included in the release;
- production commit and dirty-worktree status;
- migration SQL and whether it changes or locks existing data;
- current database and storage backup plan;
- expected downtime or confirmation of a backward-compatible rollout;
- worker, queue, cron, email, messaging, and portal-automation impact;
- health checks and smoke tests to run after deployment;
- code rollback plan and database recovery limitations.

Wait for explicit approval after presenting this preflight report.

## Backup policy

Immediately before an approved production release that can affect data:

- create a fresh PostgreSQL custom-format dump with `--no-owner --no-acl`;
- verify the dump exit code, SHA-256 checksum, and `pg_restore --list` output;
- capture or verify a recoverable production storage backup/snapshot;
- record the production Git commit and deployment timestamp;
- keep backups outside Git and do not expose credentials in output.

A database restore is a last resort because restoring an older snapshot can
delete valid activity that occurred after the snapshot. Prefer rolling back code
while keeping a backward-compatible database schema whenever possible.

## Workers and external integrations

Production background jobs can change data or contact real users. Deployment
planning must explicitly cover email queues, notifications, messaging,
WhatsApp/Meta integrations, portal automation, scheduled jobs, and cron tasks.

- Avoid running two incompatible worker versions concurrently.
- Require idempotency or a single-consumer transition plan.
- Do not test live integrations using production recipients.
- Keep live integrations disabled in local development.

## Local development safeguards

- Use only the local PostgreSQL endpoint on `127.0.0.1:5433` and database
  `fasos_apply_local` unless the user explicitly changes the local setup.
- Keep `ALLOW_LIVE_INTEGRATIONS=false` locally.
- Treat local startup migrations, seeders, and background workers as capable of
  modifying the local copy.
- Confirm the resolved database host before running scripts that mutate data.
- Do not use the quarantined `fasos_apply-production.unverified.dump`.

## Stop conditions

Stop and ask the user before proceeding when:

- the target database or server cannot be proven to be local;
- a command could overwrite or delete production data or storage;
- a migration is not backward compatible;
- the production worktree contains unexplained changes;
- the backup cannot be verified;
- rollback would require restoring an old database snapshot;
- a deploy could cause external messages, payments, or portal submissions;
- required secrets, ownership, target paths, or release scope are ambiguous.

When uncertain, preserve production state and present the uncertainty rather
than making an assumption.
