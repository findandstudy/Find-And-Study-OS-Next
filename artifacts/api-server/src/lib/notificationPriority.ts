export type NotificationPriority = "critical" | "high" | "normal";

/**
 * The bell is an attention surface, not a second inbox. Keep only events that
 * require a decision, recovery action, or time-sensitive follow-up in its
 * default view. Routine activity remains available under "All" and continues
 * to feed the existing section badges.
 */
export const IMPORTANT_NOTIFICATION_TYPES = [
  "application.assigned",
  "application.offer_letter_expiring",
  "application.visa_update",
  "lead.assigned",
  "lead.follow_up_due",
  "student.assigned",
  "task.assigned",
  "task.mention",
  "message.mention",
  "inbox.assigned",
  "inbox.message_unmatched",
  "inbox.send_failed",
  "mandatory_docs_missing",
  "finance.payment_due",
  "agent.contract_expiring",
  "university_contract.expiring",
  "university_contract.expired",
  "company_contract.expiring",
  "company_contract.expired",
  "system.broadcast",
  "system.announcement",
] as const;

const IMPORTANT_TYPES = new Set<string>(IMPORTANT_NOTIFICATION_TYPES);

export function notificationPriority(type: string): NotificationPriority {
  const normalized = String(type || "").toLowerCase();
  if (
    normalized.includes("failed") ||
    normalized.includes("expired") ||
    normalized.includes("missing") ||
    normalized.includes("unmatched")
  ) return "critical";
  if (IMPORTANT_TYPES.has(normalized)) return "high";
  return "normal";
}

export function isImportantNotification(type: string): boolean {
  return notificationPriority(type) !== "normal";
}
