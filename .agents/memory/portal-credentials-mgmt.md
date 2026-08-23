---
name: Portal credentials management
description: How encrypted portal credentials are stored, resolved, and injected into adapters without changing the adapter interface.
---

## Architecture

**Storage key**: `portal_credentials.portal_key` = `portal_universities.university_key` (NOT adapter key).

**Encryption**: AES-256-GCM via `api-server/src/lib/encryption.ts` (prefix `enc::v1::`). Key from `ENCRYPTION_KEY || SESSION_SECRET` (sha256-hashed to 32 bytes). Same scheme inline-copied to `portal-automation-worker/src/credResolver.ts`.

**Resolution order** (both api-server and worker):
1. Active, non-deleted DB row for `portalKey`
2. env vars: `${portalKey.toUpperCase()}_EMAIL/_USER + _PASSWORD`
3. env vars: `${adapterKey.toUpperCase()}_EMAIL/_USER + _PASSWORD`
4. Throw with clear message

## Adapter injection

`lib/portal-adapters/src/portalCreds.ts` has a module-level `_overrides = new Map<string, ResolvedCreds>()`. Before calling `adapter.login()`, inject resolved creds via `setCredsOverride(adapter.key, { user, password })` then clear in `finally` with `clearCredsOverride(adapter.key)`. This avoids mutating `process.env` and doesn't change the adapter interface.

## List endpoint efficiency

`batchPortalCredentialKeys()` in `api-server/src/lib/portalCreds.ts` returns a `Set<string>` of all active portal keys in ONE query. Use it before mapping university rows to avoid N+1 DB calls. env check per row is still O(1) (process.env lookup).

**Why**: Portal universities list can have many rows; per-row DB query would be slow and noisy.

## Role gate

PUT/DELETE `/university-portals/:portalKey/credentials` → `ADMIN_ROLES` only (admin, super_admin). Not STAFF_ROLES. Response NEVER includes plaintext credentials — only `{ ok: true }`.

## Soft-delete convention

DELETE endpoint sets `deletedAt = NOW()`, never hard-deletes. PUT uses manual check-then-update/insert (NOT `onConflictDoUpdate`) because the unique index is composite `(organizationId, portalKey)` and PostgreSQL does NOT raise a conflict when any part of a composite unique key is NULL.

**Why**: `onConflictDoUpdate({ target: portalCredentialsTable.portalKey })` was the old code and silently broke after schema change. The fix is in `api-server/src/lib/portalCredentials.ts`: `setPortalCredentials(orgId, key, {username, password, extra})`.

## adapterMetadata() field name

`adapterMetadata()` (from `@workspace/portal-adapters`) returns `{ key, label, family: AdapterFamily, allowlist? }` — the field is `family` NOT `kind`. Destructuring `kind` silently gives `undefined`.

## GET /university-portals behavior

Only returns portals WITH active credentials (intent: Submit dropdown). After DELETE, portal disappears from list entirely — it does NOT appear with `hasCredentials: false`. Tests should assert absence not `hasCredentials=false`.

## Test location

`artifacts/api-server/scripts/test-portal-api.ts` — TPA1–TPA7, 9 tests: enqueue dry, real-without-confirm 422, agent RBAC 403, credentials PUT/GET/DELETE round-trip. Run with `pnpm --filter @workspace/api-server test:portal`.
