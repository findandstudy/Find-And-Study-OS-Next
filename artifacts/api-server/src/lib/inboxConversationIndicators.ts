import { sql } from "drizzle-orm";

// Drizzle can render a column interpolated inside a correlated raw SQL
// subquery as just "id". Inside `messages m` / `conversation_participants cp`
// that unqualified identifier binds to the inner table instead of the outer
// conversations row. Keep the correlation target explicitly qualified.
export const inboxOuterConversationIdSql = sql.raw(
  '"conversations"."id"',
);

/**
 * Effective inbox owner, matching assignmentSync.getChainOwner():
 * student owner wins, then lead owner, then the conversation's own owner.
 *
 * Some historical conversations have a null conversations.assigned_to_id
 * even though their linked CRM record is assigned. Inbox filtering must use
 * this expression as well as displaying it, otherwise an assigned thread can
 * appear under the Unassigned tab until its detail page happens to reconcile
 * the stale conversation row.
 */
export function inboxEffectiveAssignedToSql() {
  return sql<number | null>`COALESCE(
    (
      SELECT s.assigned_to_id
      FROM external_contacts ec
      JOIN students s
        ON s.id = ec.student_id
       AND s.deleted_at IS NULL
      WHERE ec.id = "conversations"."external_contact_id"
        AND s.assigned_to_id IS NOT NULL
      LIMIT 1
    ),
    (
      SELECT l.assigned_to_id
      FROM external_contacts ec
      JOIN leads l
        ON l.id = ec.lead_id
       AND l.deleted_at IS NULL
      WHERE ec.id = "conversations"."external_contact_id"
        AND l.assigned_to_id IS NOT NULL
      LIMIT 1
    ),
    "conversations"."assigned_to_id"
  )`;
}

export function inboxIsStarredSql(userId: number) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM conversation_participants cp
    WHERE cp.conversation_id = ${inboxOuterConversationIdSql}
    AND cp.user_id = ${userId} AND cp.is_starred = true
  )`.as("is_starred");
}

export function inboxIsSubscribedSql(userId: number) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM conversation_participants cp
    WHERE cp.conversation_id = ${inboxOuterConversationIdSql}
    AND cp.user_id = ${userId}
  )`.as("is_subscribed");
}

export function inboxUnreadCountSql(userId: number) {
  return sql<number>`(
    SELECT COUNT(*)::int FROM messages m
    WHERE m.conversation_id = ${inboxOuterConversationIdSql}
    AND m.direction = 'inbound'
    AND m.created_at > COALESCE((
      SELECT cp.last_read_at FROM conversation_participants cp
      WHERE cp.conversation_id = ${inboxOuterConversationIdSql}
      AND cp.user_id = ${userId}
    ), 'epoch'::timestamptz)
  )`.as("unread_count");
}

export function inboxAwaitingReplySql() {
  return sql<boolean>`(
    COALESCE((
      SELECT m.direction FROM messages m
      WHERE m.conversation_id = ${inboxOuterConversationIdSql}
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1
    ), '') = 'inbound'
  )`.as("awaiting_reply");
}

/**
 * Moves a participant read cursor immediately before the newest inbound
 * message. This makes exactly the latest inbound message unread in the common
 * case instead of resetting the cursor to epoch and marking the entire thread
 * unread.
 */
export function manualUnreadLastReadAt(
  latestInboundAt: Date | string,
): Date {
  const parsed = latestInboundAt instanceof Date
    ? latestInboundAt
    : new Date(latestInboundAt);
  const timestamp = parsed.getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error("Invalid latest inbound timestamp");
  }
  return new Date(timestamp - 1);
}
