# Interim Super Admin Configuration Boundary

Status: G30 containment. This is an authorization and audit stopgap, not the
final versioned ChangeSet control plane.

## Protected configuration

The following long-lived platform changes now require `super_admin` at the API
boundary:

- create, edit, and delete dynamic roles and their permissions;
- create, edit, archive, and unarchive branches;
- patch global settings, automation toggles, branding/SEO configuration,
  scripts, integrations, operational thresholds, and feature flags;
- run the global null-assignment backfill.

Non-super UI no longer presents the Roles & Permissions editor. API checks are
authoritative; hiding the tab is only a usability measure.

## Audit behavior

- Role mutations continue to write create/update/delete audit records; role
  creation now records the accepted permission set.
- Branch mutations write `platform_config.branch.*` receipts.
- Global setting changes write `platform_config.settings.update` with the
  changed field names. Secret values are deliberately not copied into audit.
- Reading an absent settings row no longer creates platform configuration as a
  side effect. The first explicit Super Admin PATCH owns creation and receipt.
- `smtpPassword`, `whatsappToken`, and secret-bearing `n8nWebhookUrl` are not
  returned by the settings API.
- For permission-backed decisions, a stored role row is authoritative for
  every non-super role, including `admin`; static defaults apply only when no
  stored role exists. The canonical backend permission guard and frontend
  visibility now share that rule. Only `super_admin` bypasses the configured
  permission package. Legacy routes that still use fixed `requireRole(...)`
  checks remain separately inventoried and quarantined.

## Bootstrap ownership

API module import no longer seeds a missing role table. Default roles remain in
the explicit release seed artifact (`artifacts/api-server/src/seed.sql`), so a
read or process start cannot silently mutate platform authorization. The
release seed path still needs deployment receipt and migration-authority
evidence before external-tenant certification.

## What is still missing

Super Admin-only is necessary but insufficient. Before external tenants, the
target control plane must add:

1. draft ChangeSet with typed target and schema validation;
2. before/after diff and impact preview;
3. maker-checker approval for high-risk changes;
4. MFA/step-up, purpose, expiry, and JIT support access;
5. immutable application receipt with config version;
6. idempotent apply, rollback/compensation, and conflict detection;
7. tenant-scoped override inheritance without code forks;
8. two-tenant negative tests and emergency kill-switch behavior.

Until those controls exist, the affected writer files remain quarantined in
the tenant writer registry.

## Session boundary added alongside the control plane

Privileged control-plane work must not rely on indefinitely sliding sessions.
Sessions now carry a server-issued timestamp and expire after at most 24 hours,
even if the 8-hour idle window keeps sliding. Pre-existing sessions receive a
one-time issued timestamp on their first authenticated observation, and the
browser cookie is capped to the remaining hard lifetime. This is not MFA,
step-up, JIT, or maker-checker evidence; those remain required before high-risk
ChangeSet approval or publish.
