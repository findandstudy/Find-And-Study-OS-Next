import { db, agencyAssignedStaffTable, agentsTable, usersTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

export interface StaffEntry { userId: number; isPrimary?: boolean }

export interface NormalizedStaff {
  userId: number;
  isPrimary: boolean;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  role: string | null;
}

export function parseStaffInput(input: unknown, fallbackPrimaryId?: number | null): StaffEntry[] {
  // Accept array of {userId,isPrimary} OR array of numbers OR single {assignedStaffId}.
  if (Array.isArray(input)) {
    const out: StaffEntry[] = [];
    for (const it of input) {
      if (it == null) continue;
      if (typeof it === "number") {
        if (!isNaN(it)) out.push({ userId: it, isPrimary: false });
      } else if (typeof it === "object") {
        const uid = (it as any).userId;
        const n = typeof uid === "number" ? uid : parseInt(String(uid), 10);
        if (!isNaN(n)) out.push({ userId: n, isPrimary: !!(it as any).isPrimary });
      }
    }
    return dedupeAndEnsurePrimary(out);
  }
  if (typeof fallbackPrimaryId === "number" && !isNaN(fallbackPrimaryId)) {
    return [{ userId: fallbackPrimaryId, isPrimary: true }];
  }
  return [];
}

function dedupeAndEnsurePrimary(list: StaffEntry[]): StaffEntry[] {
  const seen = new Map<number, StaffEntry>();
  for (const e of list) if (!seen.has(e.userId)) seen.set(e.userId, { ...e });
  const arr = Array.from(seen.values());
  if (arr.length === 0) return arr;
  const primaries = arr.filter(a => a.isPrimary);
  if (primaries.length === 0) arr[0].isPrimary = true;
  else if (primaries.length > 1) {
    let first = true;
    for (const a of arr) {
      if (a.isPrimary) {
        if (first) first = false;
        else a.isPrimary = false;
      }
    }
  }
  return arr;
}

/**
 * Replace the agency_assigned_staff rows for an agent with `staff`. Keeps
 * `agents.assigned_staff_id` synced to the primary user (back-compat for
 * notification/contract checkers). Pass empty array to clear all.
 */
export async function setAgencyStaff(agentId: number, staff: StaffEntry[]): Promise<void> {
  const normalized = dedupeAndEnsurePrimary(staff);
  const primary = normalized.find(s => s.isPrimary) || normalized[0] || null;
  await db.transaction(async (tx) => {
    await tx.delete(agencyAssignedStaffTable).where(eq(agencyAssignedStaffTable.agentId, agentId));
    if (normalized.length > 0) {
      await tx.insert(agencyAssignedStaffTable).values(
        normalized.map(s => ({ agentId, userId: s.userId, isPrimary: !!s.isPrimary })),
      );
    }
    await tx.update(agentsTable)
      .set({ assignedStaffId: primary ? primary.userId : null })
      .where(eq(agentsTable.id, agentId));
  });
}

/**
 * Read back-compat helper: if join-table list is empty, resolve the legacy
 * agents.assigned_staff_id scalar into a synthetic NormalizedStaff[]. This
 * keeps unmigrated rows rendering correctly.
 */
export async function getAgencyStaffWithLegacy(agentId: number, legacyStaffId: number | null): Promise<NormalizedStaff[]> {
  const list = await getAgencyStaff(agentId);
  if (list.length > 0 || !legacyStaffId) return list;
  const [u] = await db.select({
    id: usersTable.id,
    firstName: usersTable.firstName,
    lastName: usersTable.lastName,
    email: usersTable.email,
    phone: usersTable.phone,
    avatarUrl: usersTable.avatarUrl,
    role: usersTable.role,
  }).from(usersTable).where(eq(usersTable.id, legacyStaffId));
  if (!u) return [];
  return [{
    userId: u.id,
    isPrimary: true,
    firstName: u.firstName,
    lastName: u.lastName,
    email: u.email,
    phone: u.phone,
    avatarUrl: u.avatarUrl,
    role: u.role,
  }];
}

/** Fetch normalized staff list for one agent (joined with user names). */
export async function getAgencyStaff(agentId: number): Promise<NormalizedStaff[]> {
  const rows = await db.select({
    userId: agencyAssignedStaffTable.userId,
    isPrimary: agencyAssignedStaffTable.isPrimary,
    firstName: usersTable.firstName,
    lastName: usersTable.lastName,
    email: usersTable.email,
    phone: usersTable.phone,
    avatarUrl: usersTable.avatarUrl,
    role: usersTable.role,
  })
    .from(agencyAssignedStaffTable)
    .leftJoin(usersTable, eq(agencyAssignedStaffTable.userId, usersTable.id))
    .where(eq(agencyAssignedStaffTable.agentId, agentId));
  return rows.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

/** Bulk fetch keyed by agentId. */
export async function getAgencyStaffMap(agentIds: number[]): Promise<Map<number, NormalizedStaff[]>> {
  const map = new Map<number, NormalizedStaff[]>();
  if (agentIds.length === 0) return map;
  const rows = await db.select({
    agentId: agencyAssignedStaffTable.agentId,
    userId: agencyAssignedStaffTable.userId,
    isPrimary: agencyAssignedStaffTable.isPrimary,
    firstName: usersTable.firstName,
    lastName: usersTable.lastName,
    email: usersTable.email,
    phone: usersTable.phone,
    avatarUrl: usersTable.avatarUrl,
    role: usersTable.role,
  })
    .from(agencyAssignedStaffTable)
    .leftJoin(usersTable, eq(agencyAssignedStaffTable.userId, usersTable.id))
    .where(inArray(agencyAssignedStaffTable.agentId, agentIds));
  for (const r of rows) {
    const arr = map.get(r.agentId) || [];
    arr.push({
      userId: r.userId,
      isPrimary: r.isPrimary,
      firstName: r.firstName,
      lastName: r.lastName,
      email: r.email,
      phone: r.phone,
      avatarUrl: r.avatarUrl,
      role: r.role,
    });
    map.set(r.agentId, arr);
  }
  for (const [k, v] of map) v.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
  return map;
}

/**
 * Return the agentIds for which the given user is listed in the agency's
 * assigned-staff join table. Used to extend a non-admin staff member's
 * read-only visibility into the students/applications belonging to the
 * agencies they are assigned to (Task #128). Notification recipient
 * resolution intentionally does NOT use this — agency membership grants
 * visibility only, never notification fanout.
 */
export async function getAgencyMemberAgentIds(userId: number): Promise<number[]> {
  if (!userId || isNaN(userId)) return [];
  const rows = await db.select({ agentId: agencyAssignedStaffTable.agentId })
    .from(agencyAssignedStaffTable)
    .where(eq(agencyAssignedStaffTable.userId, userId));
  const set = new Set<number>();
  for (const r of rows) if (r.agentId != null) set.add(r.agentId);
  return Array.from(set);
}

export function staffDisplayName(s: { firstName: string | null; lastName: string | null }): string {
  return [s.firstName, s.lastName].filter(Boolean).join(" ").trim();
}
