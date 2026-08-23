---
name: edcons shared contract-perm backfill scope
description: The boot-DDL contract-permissions backfill is shared across several perm groups; adding a role to its WHERE silently grants that role ALL of them.
---

The api-server boot DDL has a single backfill loop that merges a `newPerms`
array (contract_templates.*, contracts.*, self_fill_links.*, company_contracts.*)
into roles selected by `WHERE name IN (...)`. Keep that WHERE scoped to
`admin`/`super_admin` only.

**Why:** Adding another role (e.g. `manager`) to the shared WHERE silently
grants that role the ENTIRE perm set, not just the one feature you were adding.
This retroactively re-grants perms to roles an admin may have deliberately
customized. A code review rejected exactly this over-expansion.

**How to apply:** To grant a NEW feature's perms to an extra role, add a
SEPARATE targeted backfill loop for just that feature's perms. As of the
"KALAN 2 İŞ" ticket the intended contract-menu default access is
ADMIN(+super_admin) full set, MANAGER full view+manage, ACCOUNTANT view-only —
implemented as three separate loops in index.ts. Note manager's
DEFAULT_ROLE_PERMISSIONS (lib/db/src/schema/roles.ts) is
`getAllPermissions().filter(...)` = everything except finance.commissions/offset,
users.manage_roles, settings.branding — so manager already has most perms by
default; the DB backfill only matters for stored/customized role rows.
