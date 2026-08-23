import {
  db,
  usersTable,
  rolesTable,
  DEFAULT_ROLE_PERMISSIONS,
  getAllPermissions,
} from "@workspace/db";
import { eq } from "drizzle-orm";

type PermUser = {
  id: number;
  role: string;
  effectivePermissions?: string[];
};

// Only the platform Super Admin bypasses the configured role package. Every
// other role, including admin, must use the same stored/fallback permission
// source as the UI and route guards.
const ALL_PERMISSION_ROLES = new Set(["super_admin"]);

export function applyPermissionOverrides(
  base: Iterable<string>,
  overrides: Record<string, boolean> | null | undefined,
): Set<string> {
  const set = new Set(base);
  for (const [key, granted] of Object.entries(overrides ?? {})) {
    if (granted) set.add(key);
    else set.delete(key);
  }
  return set;
}

/**
 * Resolve the effective permission set for a user.
 *
 * Order of resolution:
 *   1. super_admin → all permissions.
 *   2. The stored role row (`roles.permissions`) is authoritative; falls back
 *      to the static DEFAULT_ROLE_PERMISSIONS only when no row exists.
 *   3. Per-user overrides (`users.permission_overrides`, a `{ key: boolean }`
 *      map) are applied last: `true` grants the key, `false` revokes it. This
 *      is a tri-state on top of the role default — keys absent from the map
 *      simply inherit the role.
 */
export async function getEffectivePermissionSet(user: PermUser): Promise<Set<string>> {
  if (ALL_PERMISSION_ROLES.has(user.role)) {
    return new Set(getAllPermissions());
  }

  // authMiddleware resolves this from the same fresh users row it already
  // loads for every authenticated request. Reusing it removes two repeated DB
  // round-trips per permission check while preserving per-request revocation
  // semantics. Non-request callers safely fall back to the canonical DB path.
  if (Array.isArray(user.effectivePermissions)) {
    return new Set(user.effectivePermissions);
  }

  const [roleRow] = await db
    .select({ permissions: rolesTable.permissions })
    .from(rolesTable)
    .where(eq(rolesTable.name, user.role));

  const base = roleRow
    ? ((roleRow.permissions as string[] | null) ?? [])
    : ((DEFAULT_ROLE_PERMISSIONS as Record<string, string[]>)[user.role] || []);

  const [u] = await db
    .select({ overrides: usersTable.permissionOverrides })
    .from(usersTable)
    .where(eq(usersTable.id, user.id));

  return applyPermissionOverrides(
    base,
    u?.overrides as Record<string, boolean> | null,
  );
}

export async function userHasPermission(user: PermUser, key: string): Promise<boolean> {
  if (ALL_PERMISSION_ROLES.has(user.role)) return true;
  const set = await getEffectivePermissionSet(user);
  return set.has(key);
}

export type AssignmentVisibility =
  | "own"
  | "own_or_unassigned"
  | "assigned"
  | "all";

/**
 * Translate the independent records.view_others and records.view_unassigned
 * grants into a list-query visibility mode. Keeping this decision centralized
 * prevents a query optimization from accidentally treating one grant as the
 * other.
 */
export function getAssignmentVisibility(perms: ReadonlySet<string>): AssignmentVisibility {
  const viewOthers = perms.has("records.view_others");
  const viewUnassigned = perms.has("records.view_unassigned");
  if (viewOthers) return viewUnassigned ? "all" : "assigned";
  return viewUnassigned ? "own_or_unassigned" : "own";
}

/**
 * Decide whether a non-admin staff user may access a record based on its
 * assignment and the user's record-visibility permissions. Admin-tier roles
 * bypass this entirely (handled by callers via ADMIN_ROLES).
 *
 *   - Own records: always accessible.
 *   - Unassigned records: require `records.view_unassigned`.
 *   - Records assigned to someone else: require `records.view_others`.
 */
export function canAccessAssignedRecord(
  perms: Set<string>,
  assignedToId: number | null,
  userId: number,
): boolean {
  if (assignedToId === userId) return true;
  if (assignedToId === null) return perms.has("records.view_unassigned");
  return perms.has("records.view_others");
}
