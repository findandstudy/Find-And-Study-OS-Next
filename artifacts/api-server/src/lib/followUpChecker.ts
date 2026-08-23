import { db, followUpsTable } from "@workspace/db";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { dispatchNotification } from "./notificationDispatcher";

const CHECK_INTERVAL = 60 * 1000;

let running = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;

export async function checkFollowUpsDue(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const due = await db
      .select({
        id: followUpsTable.id,
        title: followUpsTable.title,
        assignedToId: followUpsTable.assignedToId,
        leadId: followUpsTable.leadId,
        studentId: followUpsTable.studentId,
        resourceType: followUpsTable.resourceType,
      })
      .from(followUpsTable)
      .where(
        and(
          eq(followUpsTable.completed, false),
          isNull(followUpsTable.notifiedAt),
          lte(followUpsTable.scheduledAt, now),
          // Skip follow-ups whose linked parents have ALL been soft-deleted —
          // they must not generate notifications for records that no longer exist.
          // Dual-linked rows (leadId + studentId) stay visible while at least one
          // parent is alive; unattached rows (both NULL) are unaffected.
          sql`(
            (${followUpsTable.leadId} IS NULL AND ${followUpsTable.studentId} IS NULL)
            OR (${followUpsTable.leadId} IS NOT NULL AND EXISTS (SELECT 1 FROM leads l WHERE l.id = ${followUpsTable.leadId} AND l.deleted_at IS NULL))
            OR (${followUpsTable.studentId} IS NOT NULL AND EXISTS (SELECT 1 FROM students s WHERE s.id = ${followUpsTable.studentId} AND s.deleted_at IS NULL))
          )`,
        ),
      );

    if (due.length === 0) return;

    for (const task of due) {
      try {
        const recipientIds: number[] = [];
        if (task.assignedToId) recipientIds.push(task.assignedToId);

        await dispatchNotification({
          event: "lead.follow_up_due",
          title: "Follow-up Due",
          body: task.title,
          actionUrl: task.leadId
            ? `/staff/leads/${task.leadId}`
            : task.studentId
            ? `/staff/students/${task.studentId}`
            : `/staff/leads`,
          icon: "CalendarClock",
          recipientUserIds: recipientIds.length > 0 ? recipientIds : undefined,
          templateVars: { title: task.title },
          data: {
            followUpId: task.id,
            leadId: task.leadId ?? null,
            studentId: task.studentId ?? null,
          },
        });

        await db
          .update(followUpsTable)
          .set({ notifiedAt: now })
          .where(eq(followUpsTable.id, task.id));
      } catch (err) {
        console.error(`[FOLLOW-UP] dispatch error for task ${task.id}:`, err);
      }
    }
  } catch (err) {
    console.error("[FOLLOW-UP] checker error:", err);
  } finally {
    running = false;
  }
}

export function startFollowUpChecker(): () => Promise<void> {
  if (intervalHandle) return stopFollowUpChecker;
  console.log("[FOLLOW-UP] Checker started, running every 60 seconds");
  checkFollowUpsDue();
  intervalHandle = setInterval(() => {
    checkFollowUpsDue();
  }, CHECK_INTERVAL);
  return stopFollowUpChecker;
}

export async function stopFollowUpChecker(): Promise<void> {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
  const deadline = Date.now() + 10_000;
  while (running && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
