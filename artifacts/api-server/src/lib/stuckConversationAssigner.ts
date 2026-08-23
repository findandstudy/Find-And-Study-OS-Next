import { db, pool, conversationsTable, usersTable, settingsTable, staffWorkSchedulesTable, externalContactsTable, leadsTable } from "@workspace/db";
import { and, eq, isNull, lte, ne, inArray } from "drizzle-orm";
import { STAFF_ROLES } from "@workspace/roles";
import { logAudit } from "./auth";
import { dispatchNotification } from "./notificationDispatcher";
import { getStaffCountriesForUsers } from "./staffCountries";

// Faz 2 (staff auto-assign): assigns inbox conversations that are marked
// needsHuman=true and unassigned to an eligible staff member. Priority:
// working-hours match -> country match (Faz 1 staff_countries) -> round-robin.
// Triggered two ways:
//   1. Immediately via assignStuckConversationById(), called right after the
//      bot escalation hook sets needsHuman=true (botAutoReply.ts).
//   2. As a periodic catch-up sweep (runStuckConversationSweep) for anything
//      that slipped through (manual needsHuman flips, transient failures).
// Gated by settings.autoAssignStuckConversationsEnabled (default off).

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 45 * 1000;
const STUCK_THRESHOLD_MS = 10 * 60 * 1000;
const ROUND_ROBIN_KV_KEY = "stuck_conversation_rr_last_user_id";

type OffHoursBehavior = "assign_anyway" | "leave_unassigned";

interface AssignSettings {
  enabled: boolean;
  considerWorkingHours: boolean;
  considerCountryMatch: boolean;
  offHoursBehavior: OffHoursBehavior;
}

interface StuckConversation {
  id: number;
  channel: string;
  externalContactId: number | null;
  lastMessagePreview: string | null;
}

function tzOffsetMinutes(date: Date, tz: string): number {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = dtf.formatToParts(date);
    const m: Record<string, string> = {};
    for (const p of parts) m[p.type] = p.value;
    const asUTC = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
    return Math.round((asUTC - date.getTime()) / 60000);
  } catch { return 0; }
}

function tzWeekday(date: Date, tz: string): number {
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? 0;
  } catch { return date.getDay(); }
}

function tzMinutesOfDay(date: Date, tz: string): number {
  const offMin = tzOffsetMinutes(date, tz);
  const localMs = date.getTime() + offMin * 60000;
  const local = new Date(localMs);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

async function getAssignSettings(): Promise<AssignSettings> {
  const [row] = await db.select({
    enabled: settingsTable.autoAssignStuckConversationsEnabled,
    considerWorkingHours: settingsTable.stuckAssignConsiderWorkingHours,
    considerCountryMatch: settingsTable.stuckAssignConsiderCountryMatch,
    offHoursBehavior: settingsTable.stuckAssignOffHoursBehavior,
  }).from(settingsTable).limit(1);
  return {
    enabled: row?.enabled ?? false,
    considerWorkingHours: row?.considerWorkingHours ?? true,
    considerCountryMatch: row?.considerCountryMatch ?? true,
    offHoursBehavior: (row?.offHoursBehavior === "leave_unassigned" ? "leave_unassigned" : "assign_anyway"),
  };
}

export async function findStuckConversations(): Promise<StuckConversation[]> {
  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);
  const rows = await db.select({
    id: conversationsTable.id,
    channel: conversationsTable.channel,
    externalContactId: conversationsTable.externalContactId,
    lastMessagePreview: conversationsTable.lastMessagePreview,
  })
    .from(conversationsTable)
    .where(and(
      eq(conversationsTable.needsHuman, true),
      isNull(conversationsTable.assignedToId),
      inArray(conversationsTable.status, ["open", "needs_human"]),
      ne(conversationsTable.channel, "internal"),
      lte(conversationsTable.updatedAt, cutoff)
    ));
  return rows;
}

async function getEligibleStaffPool(): Promise<number[]> {
  const rows = await db.select({ id: usersTable.id })
    .from(usersTable)
    .where(and(inArray(usersTable.role, STAFF_ROLES), eq(usersTable.isActive, true)));
  return rows.map(r => r.id);
}

async function narrowByWorkingHours(userIds: number[]): Promise<number[]> {
  if (userIds.length === 0) return [];
  const users = await db.select({ id: usersTable.id, timezone: usersTable.timezone })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds));
  const schedules = await db.select().from(staffWorkSchedulesTable)
    .where(inArray(staffWorkSchedulesTable.userId, userIds));
  const schedulesByUser = new Map<number, Array<{ weekday: number; startMinutes: number; endMinutes: number }>>();
  for (const s of schedules) {
    const list = schedulesByUser.get(s.userId) || [];
    list.push({ weekday: s.weekday, startMinutes: s.startMinutes, endMinutes: s.endMinutes });
    schedulesByUser.set(s.userId, list);
  }
  const now = new Date();
  const matches: number[] = [];
  for (const u of users) {
    const tz = u.timezone || "UTC";
    const schedule = schedulesByUser.get(u.id);
    if (!schedule || schedule.length === 0) continue;
    const wd = tzWeekday(now, tz);
    const minutes = tzMinutesOfDay(now, tz);
    const inWindow = schedule.some(s => s.weekday === wd && minutes >= s.startMinutes && minutes < s.endMinutes);
    if (inWindow) matches.push(u.id);
  }
  return matches;
}

async function resolveConversationCountry(conv: StuckConversation): Promise<string | null> {
  if (!conv.externalContactId) return null;
  const [contact] = await db.select({ leadId: externalContactsTable.leadId })
    .from(externalContactsTable)
    .where(eq(externalContactsTable.id, conv.externalContactId));
  if (!contact?.leadId) return null;
  const [lead] = await db.select({ country: leadsTable.country, interestedCountry: leadsTable.interestedCountry })
    .from(leadsTable)
    .where(eq(leadsTable.id, contact.leadId));
  if (!lead) return null;
  return lead.interestedCountry || lead.country || null;
}

async function narrowByCountry(userIds: number[], country: string | null): Promise<number[]> {
  if (!country || userIds.length === 0) return [];
  const countriesByUser = await getStaffCountriesForUsers(userIds);
  const normalized = country.trim().toLowerCase();
  const matches: number[] = [];
  for (const [userId, countries] of countriesByUser.entries()) {
    if (countries.some(c => c.trim().toLowerCase() === normalized)) matches.push(userId);
  }
  return matches;
}

async function getLastRoundRobinUserId(): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ value: string }>(`SELECT value FROM system_kv WHERE key = $1`, [ROUND_ROBIN_KV_KEY]);
    if (rows.length > 0) return parseInt(rows[0].value, 10) || null;
  } catch { /* first run — no key yet */ }
  return null;
}

async function saveLastRoundRobinUserId(userId: number): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO system_kv (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [ROUND_ROBIN_KV_KEY, String(userId)]
    );
  } catch (err: any) {
    console.error("[stuckConversationAssigner] failed to save round-robin pointer:", err?.message || err);
  }
}

async function pickRoundRobin(userIds: number[]): Promise<number> {
  const sorted = [...userIds].sort((a, b) => a - b);
  const lastId = await getLastRoundRobinUserId();
  if (lastId === null) return sorted[0];
  const idx = sorted.findIndex(id => id > lastId);
  return idx === -1 ? sorted[0] : sorted[idx];
}

// Returns null when off-hours behavior is "leave_unassigned" and nobody is
// currently in working hours — caller must treat that as "skip, stay queued".
async function pickAssignee(conv: StuckConversation, pool0: number[], settings: AssignSettings): Promise<number | null> {
  let tierPool = pool0;
  if (settings.considerWorkingHours) {
    const workingHoursPool = await narrowByWorkingHours(pool0);
    if (workingHoursPool.length > 0) {
      tierPool = workingHoursPool;
    } else if (settings.offHoursBehavior === "leave_unassigned") {
      return null;
    }
    // else "assign_anyway": keep tierPool = pool0 (already set)
  }

  let finalPool = tierPool;
  if (settings.considerCountryMatch) {
    const country = await resolveConversationCountry(conv);
    const countryPool = await narrowByCountry(tierPool, country);
    finalPool = countryPool.length > 0 ? countryPool : tierPool;
  }

  return pickRoundRobin(finalPool);
}

// Core single-conversation assignment used by both the immediate handoff hook
// and the periodic sweep. Returns the assigned userId, or null if no
// assignment was made (already assigned, feature disabled, or queued for
// off-hours per settings).
export async function assignStuckConversation(conv: StuckConversation, staffPool: number[], settings?: AssignSettings): Promise<number | null> {
  if (staffPool.length === 0) return null;
  const resolvedSettings = settings ?? await getAssignSettings();
  const assigneeId = await pickAssignee(conv, staffPool, resolvedSettings);
  if (assigneeId === null) return null;

  const [updated] = await db.update(conversationsTable)
    .set({ assignedToId: assigneeId })
    .where(and(eq(conversationsTable.id, conv.id), isNull(conversationsTable.assignedToId)))
    .returning({ id: conversationsTable.id });
  if (!updated) return null; // lost the race — someone else already assigned it

  await saveLastRoundRobinUserId(assigneeId);

  logAudit(null, "conversation.stuck_assigned", "conversation", conv.id, {
    assignedToId: assigneeId,
    channel: conv.channel,
  });

  await dispatchNotification({
    event: "conversation.stuck_assigned",
    title: "Konuşma Otomatik Atandı",
    body: `Size bir sohbet otomatik olarak atandı — inceleme gerek: ${conv.lastMessagePreview || "(mesaj yok)"}`,
    actionUrl: `/inbox?conversation=${conv.id}`,
    icon: "🤝",
    recipientUserIds: [assigneeId],
    data: { conversationId: conv.id, channel: conv.channel },
  });

  return assigneeId;
}

// Immediate handoff entry point: call this right after a conversation is
// flipped to needsHuman=true (bot escalation). No-op if disabled, already
// assigned, or no eligible staff — the periodic sweep will retry later in
// the "leave_unassigned"/no-pool cases.
export async function assignStuckConversationById(conversationId: number): Promise<{ assignedTo: number | null; reason: string }> {
  try {
    const settings = await getAssignSettings();
    if (!settings.enabled) return { assignedTo: null, reason: "disabled" };

    const [conv] = await db.select({
      id: conversationsTable.id,
      channel: conversationsTable.channel,
      externalContactId: conversationsTable.externalContactId,
      lastMessagePreview: conversationsTable.lastMessagePreview,
      assignedToId: conversationsTable.assignedToId,
      needsHuman: conversationsTable.needsHuman,
      status: conversationsTable.status,
    }).from(conversationsTable).where(eq(conversationsTable.id, conversationId));

    if (!conv) return { assignedTo: null, reason: "not_found" };
    if (conv.assignedToId) return { assignedTo: null, reason: "already_assigned" };
    if (!conv.needsHuman) return { assignedTo: null, reason: "not_needs_human" };
    if (conv.channel === "internal") return { assignedTo: null, reason: "internal_channel" };

    const staffPool = await getEligibleStaffPool();
    if (staffPool.length === 0) return { assignedTo: null, reason: "no_eligible_staff" };

    const assigneeId = await assignStuckConversation(conv, staffPool, settings);
    if (assigneeId) {
      console.log(`[stuckConversationAssigner] Immediately assigned conversation #${conv.id} to user #${assigneeId}`);
      return { assignedTo: assigneeId, reason: "assigned" };
    }
    return { assignedTo: null, reason: "queued_off_hours" };
  } catch (err: any) {
    console.error(`[stuckConversationAssigner] Immediate assignment failed for conversation #${conversationId}:`, err?.message || err);
    return { assignedTo: null, reason: "error" };
  }
}

export async function runStuckConversationSweep(): Promise<void> {
  try {
    const settings = await getAssignSettings();
    if (!settings.enabled) return;

    const stuck = await findStuckConversations();
    if (stuck.length === 0) return;

    const staffPool = await getEligibleStaffPool();
    if (staffPool.length === 0) {
      console.warn("[stuckConversationAssigner] No eligible staff found; skipping sweep.");
      return;
    }

    for (const conv of stuck) {
      try {
        const assigneeId = await assignStuckConversation(conv, staffPool, settings);
        if (assigneeId) {
          console.log(`[stuckConversationAssigner] Assigned conversation #${conv.id} to user #${assigneeId}`);
        }
      } catch (err: any) {
        console.error(`[stuckConversationAssigner] Failed to assign conversation #${conv.id}:`, err?.message || err);
      }
    }
  } catch (err: any) {
    console.error("[stuckConversationAssigner] sweep error:", err?.message || err);
  }
}

let initialSweepTimer: ReturnType<typeof setTimeout> | null = null;
let sweepInterval: ReturnType<typeof setInterval> | null = null;

export function startStuckConversationSweep(): () => void {
  if (initialSweepTimer || sweepInterval) return stopStuckConversationSweep;
  initialSweepTimer = setTimeout(() => {
    initialSweepTimer = null;
    void runStuckConversationSweep();
    sweepInterval = setInterval(runStuckConversationSweep, SWEEP_INTERVAL_MS);
  }, INITIAL_DELAY_MS);
  return stopStuckConversationSweep;
}

export function stopStuckConversationSweep(): void {
  if (initialSweepTimer) clearTimeout(initialSweepTimer);
  if (sweepInterval) clearInterval(sweepInterval);
  initialSweepTimer = null;
  sweepInterval = null;
}
