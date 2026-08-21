import {
  conversationsTable,
  db,
  externalContactsTable,
  messagesTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import {
  getAiAgentConfig,
  isExternalAutoReplyEmergencyStopped,
} from "./aiAgentConfig";
import { isAiAgentWithinWorkingHours } from "./botSchedule";
import { resolveReengagementTemplate, sendBotTemplate } from "./botAutoReply";
import { inboxBus } from "./eventBus";
import { resolveZernioAccount, sendZernioTemplate } from "./zernioSend";
import { resolveApprovedZernioTemplate } from "./zernioTemplates";

const POLL_MS = 5 * 60 * 1000;
const WINDOW_START_HOURS = 22.75;
const WINDOW_END_HOURS = 23.75;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function dormBookingFollowupEnabled(): boolean {
  return process.env.DORMBOOKING_23H_FOLLOWUP_ENABLED === "true";
}

export async function runDormBookingFollowupSweep(now = new Date()): Promise<{ sent: number; failed: number }> {
  if (!dormBookingFollowupEnabled() || isExternalAutoReplyEmergencyStopped()) {
    return { sent: 0, failed: 0 };
  }
  const minAge = new Date(now.getTime() - WINDOW_END_HOURS * 60 * 60 * 1000);
  const maxAge = new Date(now.getTime() - WINDOW_START_HOURS * 60 * 60 * 1000);
  const candidates = await db
    .select({ conversation: conversationsTable, contact: externalContactsTable })
    .from(conversationsTable)
    .leftJoin(externalContactsTable, eq(externalContactsTable.id, conversationsTable.externalContactId))
    .where(and(
      eq(conversationsTable.channel, "whatsapp"),
      eq(conversationsTable.status, "open"),
      eq(conversationsTable.botEnabled, true),
      sql`${conversationsTable.lastInboundAt} >= ${minAge}`,
      sql`${conversationsTable.lastInboundAt} <= ${maxAge}`,
      sql`${conversationsTable.aiBotId} IS NOT NULL`,
    ))
    .limit(200);

  const template = await resolveReengagementTemplate();
  if (!template) return { sent: 0, failed: 0 };
  let sent = 0;
  let failed = 0;

  for (const row of candidates) {
    const conv = row.conversation;
    const contact = row.contact;
    const phone = contact?.phoneE164 || contact?.phone;
    if (!conv.aiBotId || !conv.lastInboundAt || !phone || contact?.isBlocked) continue;
    const config = await getAiAgentConfig(conv.aiBotId);
    if (
      !config.enabled ||
      !config.externalAutoReplyEnabled ||
      isExternalAutoReplyEmergencyStopped() ||
      !isAiAgentWithinWorkingHours(config)
    ) continue;
    if (!/\bDorm\s*Booking\b|accommodation assistant/i.test(config.knowledgeBase)) continue;

    const inboundKey = conv.lastInboundAt.toISOString();
    const claimed = await db.update(conversationsTable).set({
      metadata: sql`coalesce(${conversationsTable.metadata}, '{}'::jsonb) || jsonb_build_object('bot23hFollowupClaimedAt', ${now.toISOString()}, 'bot23hFollowupInboundAt', ${inboundKey})`,
    }).where(and(
      eq(conversationsTable.id, conv.id),
      sql`coalesce(${conversationsTable.metadata}->>'bot23hFollowupInboundAt', '') <> ${inboundKey}`,
    )).returning({ id: conversationsTable.id });
    if (!claimed.length) continue;

    let outcome: { ok: boolean; error?: string; externalMessageId?: string };
    const zernio = await resolveZernioAccount(conv.channelAccountId);
    if (zernio) {
      const approved = await resolveApprovedZernioTemplate({
        externalAccountId: zernio.externalAccountId,
        templateName: template.externalTemplateName,
        preferredLanguage: template.language,
      });
      outcome = approved.ok
        ? await sendZernioTemplate({
            externalAccountId: zernio.externalAccountId,
            templateName: template.externalTemplateName,
            language: approved.template.language,
            toPhoneE164: phone,
            recipientLabel: contact?.displayName || phone,
          })
        : { ok: false, error: approved.error || approved.reason };
    } else {
      outcome = await sendBotTemplate({
        channel: "whatsapp",
        toPhoneE164: phone,
        templateName: template.externalTemplateName,
        language: template.language,
        externalDeliveryApproved: config.externalAutoReplyEnabled,
        channelAccountId: conv.channelAccountId,
        communicationPipelineId: conv.communicationPipelineId,
      });
    }

    if (!outcome.ok) {
      failed += 1;
      await db.update(conversationsTable).set({
        metadata: sql`coalesce(${conversationsTable.metadata}, '{}'::jsonb) - 'bot23hFollowupClaimedAt' - 'bot23hFollowupInboundAt'`,
      }).where(eq(conversationsTable.id, conv.id));
      console.error(`[dormbooking-followup] send failed (conversation=${conv.id}): ${outcome.error || "unknown"}`);
      continue;
    }

    const [message] = await db.insert(messagesTable).values({
      conversationId: conv.id,
      senderId: null,
      content: template.content,
      channel: "whatsapp",
      direction: "outbound",
      status: "sent",
      externalMessageId: outcome.externalMessageId || null,
      sentAt: now,
      metadata: {
        botSent: true,
        botTemplate: true,
        bot23hFollowup: true,
        templateName: template.externalTemplateName,
        inboundAt: inboundKey,
      },
    }).returning({ id: messagesTable.id });
    await db.update(conversationsTable).set({
      lastMessageAt: now,
      lastMessagePreview: template.content.slice(0, 200),
      metadata: sql`coalesce(${conversationsTable.metadata}, '{}'::jsonb) || jsonb_build_object('bot23hFollowupMessageId', ${message.id}, 'bot23hFollowupSentAt', ${now.toISOString()})`,
    }).where(eq(conversationsTable.id, conv.id));
    inboxBus.publish({
      type: "message",
      conversationId: conv.id,
      channel: conv.channel,
      assignedToId: conv.assignedToId ?? null,
      unmatched: conv.unmatched,
      direction: "outbound",
    });
    sent += 1;
  }
  return { sent, failed };
}

export function startDormBookingFollowupWorker(): () => Promise<void> {
  if (timer || !dormBookingFollowupEnabled()) return stopDormBookingFollowupWorker;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runDormBookingFollowupSweep();
      if (result.sent || result.failed) console.log(`[dormbooking-followup] sent=${result.sent}, failed=${result.failed}`);
    } catch (error) {
      console.error("[dormbooking-followup] sweep failed:", error);
    } finally {
      running = false;
    }
  };
  void tick();
  timer = setInterval(() => void tick(), POLL_MS);
  timer.unref?.();
  console.log("[dormbooking-followup] 23-hour worker started");
  return stopDormBookingFollowupWorker;
}

export async function stopDormBookingFollowupWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
}
