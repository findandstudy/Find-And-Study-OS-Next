import { db, agentsTable, usersTable, settingsTable, signingSessionsTable } from "@workspace/db";
import { and, eq, isNotNull, isNull, inArray, lt, or, sql } from "drizzle-orm";
import { dispatchNotification } from "./notificationDispatcher";
import { formatDate } from "@workspace/i18n";

const CHECK_INTERVAL = 60 * 60 * 1000;

function parseThresholds(csv: string | null | undefined): number[] {
  const raw = (csv || "30,14,7,1").split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  return Array.from(new Set(raw)).sort((a, b) => b - a);
}

function daysBetween(future: Date, now: Date): number {
  return Math.ceil((future.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export async function checkContractExpiries(): Promise<void> {
  try {
    const [settings] = await db.select({ contractExpiryReminderDays: settingsTable.contractExpiryReminderDays, defaultLanguage: settingsTable.defaultLanguage }).from(settingsTable);
    const thresholds = parseThresholds(settings?.contractExpiryReminderDays);
    const lang = settings?.defaultLanguage || "tr";
    if (thresholds.length === 0) return;

    const agents = await db.select({
      id: agentsTable.id,
      userId: agentsTable.userId,
      parentAgentId: agentsTable.parentAgentId,
      firstName: agentsTable.firstName,
      lastName: agentsTable.lastName,
      businessName: agentsTable.businessName,
      contractEndDate: agentsTable.contractEndDate,
      contractLastNotified: agentsTable.contractLastNotified,
      assignedStaffId: agentsTable.assignedStaffId,
    })
      .from(agentsTable)
      .where(and(
        isNotNull(agentsTable.contractEndDate),
        isNull(agentsTable.deletedAt),
        eq(agentsTable.status, "active"),
      ));

    if (agents.length === 0) return;

    // Cache super_admin recipient IDs once per run (active only).
    const supers = await db.select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.role, "super_admin"), eq(usersTable.isActive, true)));
    const superIds = supers.map(s => s.id);

    const now = new Date();
    const ascending = [...thresholds].sort((a, b) => a - b);

    for (const agent of agents) {
      if (!agent.contractEndDate) continue;
      const endDate = new Date(agent.contractEndDate);
      const daysLeft = daysBetween(endDate, now);
      if (daysLeft <= 0) continue;

      // Pick the smallest threshold >= daysLeft (e.g. daysLeft=6 with [30,14,7,1] → 7).
      // This way each threshold fires exactly once as the deadline approaches.
      const matched = ascending.find(t => daysLeft <= t);
      if (!matched) continue;

      // contractLastNotified is reused as a CSV of already-notified threshold
      // values. Legacy values like "3d" / "60d" are ignored (treated as "no
      // matching threshold yet"), so the new system fires fresh reminders for
      // the configured thresholds.
      const alreadyNotified = (agent.contractLastNotified || "")
        .split(",").map(s => s.trim()).filter(Boolean);
      if (alreadyNotified.includes(String(matched))) continue;

      // Atomically claim this (agent, threshold) by appending the threshold to
      // contract_last_notified only if it is not already present. This guards
      // against concurrent workers double-firing the same reminder.
      const updated = [...alreadyNotified, String(matched)].join(",");
      const claimToken = String(matched);
      const claimRows = await db.execute(sql`
        UPDATE agents
        SET contract_last_notified = ${updated}
        WHERE id = ${agent.id}
          AND (
            contract_last_notified IS NULL
            OR (
              contract_last_notified NOT LIKE ${claimToken + ',%'}
              AND contract_last_notified NOT LIKE ${'%,' + claimToken + ',%'}
              AND contract_last_notified NOT LIKE ${'%,' + claimToken}
              AND contract_last_notified <> ${claimToken}
            )
          )
        RETURNING id
      `);
      const rows = (claimRows as any).rows ?? claimRows;
      if (!rows || (Array.isArray(rows) && rows.length === 0)) {
        // Another worker already claimed this threshold — skip silently.
        continue;
      }

      const recipientUserIds = new Set<number>(superIds);

      // Assigned staff (agency contact person inside the company).
      if (agent.assignedStaffId) recipientUserIds.add(agent.assignedStaffId);

      // Agency owner: for top-level agents this is the agent's own user; for
      // sub-agents this is the parent agent's user.
      if (agent.parentAgentId) {
        const [parent] = await db.select({ userId: agentsTable.userId })
          .from(agentsTable).where(eq(agentsTable.id, agent.parentAgentId));
        if (parent?.userId) recipientUserIds.add(parent.userId);
      } else if (agent.userId) {
        recipientUserIds.add(agent.userId);
      }

      if (recipientUserIds.size === 0) continue;

      // Filter to active users only so inactive accounts don't receive
      // in-app notifications either.
      const activeRecipients = await db.select({ id: usersTable.id })
        .from(usersTable)
        .where(and(
          inArray(usersTable.id, Array.from(recipientUserIds)),
          eq(usersTable.isActive, true),
        ));
      const activeIds = activeRecipients.map(u => u.id);
      if (activeIds.length === 0) continue;

      const agentName = `${agent.firstName} ${agent.lastName}`.trim();
      const businessName = agent.businessName || "";
      const contractEndStr = formatDate(endDate, lang, { day: "2-digit", month: "long", year: "numeric" });
      const title = `Sözleşme ${daysLeft} gün içinde sona eriyor — ${businessName || agentName}`;
      const body = `${businessName ? businessName + " (" + agentName + ")" : agentName} acentesinin sözleşmesi ${contractEndStr} tarihinde sona eriyor (${daysLeft} gün kaldı).`;

      await dispatchNotification({
        event: "agent.contract_expiring",
        title,
        body,
        actionUrl: `/staff/agents`,
        icon: "AlertTriangle",
        recipientUserIds: activeIds,
        data: {
          agentId: agent.id,
          contractEndDate: endDate.toISOString(),
          daysLeft,
          threshold: matched,
        },
        templateVars: {
          agentName,
          businessName,
          contractEndDate: contractEndStr,
          daysLeft: String(daysLeft),
          threshold: String(matched),
        },
      });

      console.log(`[CONTRACT] Notified ${activeIds.length} recipient(s) for agent ${agentName} — ${daysLeft}d left, threshold ${matched}`);
    }
  } catch (err) {
    console.error("[CONTRACT] Expiry check error:", err);
  }
}

// Sweep: transition past-due signing sessions still in non-terminal states
// to status=expired so admin lists/filters/badges reflect reality. The
// public flow also lazily expires on resolve, but this catches sessions
// nobody opens.
export async function sweepExpiredSigningSessions(): Promise<void> {
  try {
    const now = new Date();
    const updated = await db.update(signingSessionsTable)
      .set({ status: "expired" })
      .where(and(
        lt(signingSessionsTable.expiresAt, now),
        or(
          eq(signingSessionsTable.status, "intake_pending"),
          eq(signingSessionsTable.status, "review_pending"),
        )!,
      ))
      .returning({ id: signingSessionsTable.id });
    if (updated.length > 0) {
      console.log(`[CONTRACT] Swept ${updated.length} expired signing session(s)`);
    }
  } catch (err) {
    console.error("[CONTRACT] Sweep error:", err);
  }
}

let contractCheckerInterval: ReturnType<typeof setInterval> | null = null;
let contractCheckerInitialTimer: ReturnType<typeof setTimeout> | null = null;

export function startContractChecker(): () => void {
  if (contractCheckerInterval) return stopContractChecker;
  console.log(`[CONTRACT] Checker started, running every ${CHECK_INTERVAL / 60000} minute(s)`);

  contractCheckerInitialTimer = setTimeout(() => {
    contractCheckerInitialTimer = null;
    Promise.all([checkContractExpiries(), sweepExpiredSigningSessions()]).then(() => {
      console.log("[CONTRACT] Initial check completed");
    });
  }, 12000);

  contractCheckerInterval = setInterval(() => {
    checkContractExpiries();
    sweepExpiredSigningSessions();
  }, CHECK_INTERVAL);
  return stopContractChecker;
}

export function stopContractChecker(): void {
  if (contractCheckerInitialTimer) clearTimeout(contractCheckerInitialTimer);
  if (contractCheckerInterval) clearInterval(contractCheckerInterval);
  contractCheckerInitialTimer = null;
  contractCheckerInterval = null;
}
