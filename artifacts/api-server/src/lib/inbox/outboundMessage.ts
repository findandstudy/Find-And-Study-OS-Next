import {
  db,
  conversationsTable,
  conversationParticipantsTable,
  messagesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  sendViaZernio,
  getZernioApiKey,
  type ZernioAttachment,
} from "./zernioSend";
import { inboxBus } from "./eventBus";
import { dispatchNotification } from "../notificationDispatcher";

/**
 * Single source of truth for delivering an outbound message on a
 * Zernio-hosted conversation. Used by BOTH the inbox reply route
 * (routes/inbox.ts) and the quick-contact endpoint (routes/messages.ts):
 * pending row → sendViaZernio → status update → conversation preview →
 * live event → auto-subscribe. Never returns a silent "queued" state.
 */

export interface ZernioConversationSendParams {
  conv: {
    id: number;
    channel: string;
    externalThreadId: string | null;
    assignedToId: number | null;
    unmatched: boolean;
  };
  /** channel_accounts.external_account_id of the Zernio-hosted account. */
  externalAccountId: string;
  senderId: number;
  content?: string;
  attachments?: ZernioAttachment[];
}

export interface ZernioConversationSendResult {
  ok: boolean;
  /** Set for precondition failures that happen BEFORE a message row exists. */
  precondition?: "zernio_api_key_not_configured" | "zernio_no_external_thread";
  message?: typeof messagesTable.$inferSelect;
  error?: string;
}

export async function sendZernioConversationMessage(
  params: ZernioConversationSendParams,
): Promise<ZernioConversationSendResult> {
  const { conv, externalAccountId, senderId, content, attachments } = params;
  const hasContent = Boolean(content && content.trim());
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  const zernioApiKey = await getZernioApiKey();
  if (!zernioApiKey) {
    return { ok: false, precondition: "zernio_api_key_not_configured", error: "Zernio API key not configured" };
  }
  if (!conv.externalThreadId) {
    return { ok: false, precondition: "zernio_no_external_thread", error: "Conversation has no external thread ID" };
  }

  const msgContent = content?.trim() || (hasAttachments ? "[attachment]" : "");
  const [pending] = await db
    .insert(messagesTable)
    .values({
      conversationId: conv.id,
      senderId,
      content: msgContent,
      channel: conv.channel,
      direction: "outbound",
      status: "pending",
      metadata: hasAttachments ? { attachments } : {},
    })
    .returning();

  const outcome = await sendViaZernio({
    externalThreadId: conv.externalThreadId,
    externalAccountId,
    text: hasContent ? content : undefined,
    attachments: hasAttachments ? attachments : undefined,
  });
  const sendOk = outcome.ok;
  const sendError = outcome.error;

  const [msg] = await db
    .update(messagesTable)
    .set({
      status: sendOk ? "sent" : "failed",
      externalMessageId: outcome.externalMessageId || null,
      failedReason: sendOk ? null : sendError || "send_failed",
      sentAt: sendOk ? new Date() : null,
      metadata: sendOk
        ? (hasAttachments ? { attachments } : {})
        : { error: sendError },
    })
    .where(eq(messagesTable.id, pending.id))
    .returning();

  if (sendOk) {
    await db
      .update(conversationsTable)
      .set({ lastMessageAt: new Date(), lastMessagePreview: msgContent.slice(0, 200) })
      .where(eq(conversationsTable.id, conv.id));
    inboxBus.publish({
      type: "message",
      conversationId: conv.id,
      channel: conv.channel,
      assignedToId: conv.assignedToId ?? null,
      unmatched: conv.unmatched,
      direction: "outbound",
    });
    // Auto-subscribe the sender so the conversation shows up under "Subscribed".
    await db.insert(conversationParticipantsTable)
      .values({ conversationId: conv.id, userId: senderId, isStarred: false })
      .onConflictDoNothing();
  } else {
    try {
      await dispatchNotification({
        event: "inbox.send_failed",
        title: `Zernio send failed for conversation #${conv.id}`,
        body: sendError || "Send failed",
        actionUrl: `/staff/messages?conversation=${conv.id}`,
        icon: "alert",
        data: { conversationId: conv.id, channel: conv.channel, error: sendError },
      });
    } catch (notifErr) {
      console.error("[INBOX] zernio send_failed dispatch error:", notifErr);
    }
  }

  return { ok: sendOk, message: msg, error: sendError };
}
