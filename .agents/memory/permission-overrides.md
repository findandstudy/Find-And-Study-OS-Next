---
name: Per-user permission overrides
description: How EduConsult OS layers per-user permission overrides on top of role permissions, and the backfill rule for new role grants.
---

# Per-user permission overrides

`users.permission_overrides` is a jsonb map of `permissionKey -> boolean`. It is a
**tri-state on top of role permissions**: a key absent from the map means "inherit
the role default"; `true` = allow; `false` = deny. The effective permission set is
computed by a shared backend helper that starts from the user's role permissions
(DB-authoritative) and then applies the override map.

`super_admin` and `admin` are always-all in that helper — overrides do not restrict
them.

`/auth/me` resolves its `permissions` array through this same helper, so per-user
overrides surface to the frontend (which gates UI via `hasPermission`).

**Why:** A single role grant is too coarse — admins need to grant/deny individual
actions (stage change, card move, assignment) to specific users without inventing
new roles.

**How to apply:**
- When adding a NEW permission key that should be granted to existing roles by
  default, you must add a `system_flags`-gated one-shot backfill in
  `artifacts/api-server/src/index.ts` (system_flags has only `key` + `created_at`;
  presence of the row = "done"). Do NOT union defaults at runtime, or admin
  toggle-offs won't stick (see role-permissions.md).
- Per-user override editing is admin-only; the `users.ts` PATCH validates/cleans
  the map to a plain boolean map and treats `null` as "clear all overrides".
