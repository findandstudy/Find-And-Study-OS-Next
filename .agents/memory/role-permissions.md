---
name: Role permission resolution
description: How EduConsult role permissions resolve into the auth payload and how to add new default grants safely.
---

# Role permission resolution (EduConsult OS)

Roles live in the `roles` DB table (`permissions` jsonb array). The Roles & Permissions
editor (admin Users page) writes the FULL selected permission set to that row. The catalog
of available keys is `PERMISSION_CATEGORIES` in `lib/db/src/schema/roles.ts`; the editor
renders directly from it, so a new key auto-appears once added there under the right category.

`/auth/me` returns an effective `permissions` array via `getEffectivePermissions(role)` in
`artifacts/api-server/src/routes/auth.ts`. The frontend `hasPermission(key)` in
`artifacts/edcons/src/hooks/use-auth.ts` checks that array, with super_admin/admin always true.

## Rule: resolution is DB-authoritative; grant defaults via one-shot backfill, never a runtime union
`getEffectivePermissions` returns the stored role row's permissions verbatim when the row
exists (falling back to `DEFAULT_ROLE_PERMISSIONS` only when no row exists).

**Why:** An earlier attempt unioned DB perms with `DEFAULT_ROLE_PERMISSIONS` as a floor so new
keys would apply without touching existing rows. But that floor makes it impossible to turn a
default-granted permission OFF in the editor — the union silently re-adds it every request,
defeating the whole point of per-role toggles.

**How to apply:** When you add a new permission key that should be granted to existing roles by
default, add it to `DEFAULT_ROLE_PERMISSIONS` + `seed.sql` (for fresh installs) AND write a
one-shot startup backfill in `artifacts/api-server/src/index.ts`, gated by a `system_flags`
marker row (e.g. `INSERT INTO system_flags (key) VALUES ('...') ON CONFLICT DO NOTHING RETURNING key`).
The marker ensures it runs exactly once so a later admin removal isn't re-added on the next boot.
Backfill jsonb arrays with `jsonb_agg(DISTINCT elem)` over `jsonb_array_elements_text(permissions || '[...]'::jsonb)`.

## Note: UI gating only, not API field-stripping
The commission-visibility permissions (`leads/applications/students.view_commission`) gate UI
display only. The leads/applications API responses still include `estimatedValue`/`commissionAmount`,
so a user without the permission can still read them from network responses. Server-side stripping
was deliberately left out of scope (it risks breaking sorting and response shapes).
