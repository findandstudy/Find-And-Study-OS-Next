import { db, messageCampaignsTable, messageCampaignRecipientsTable, messageTemplatesTable, pool, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import type { AuthUser } from "../auth";
import { sendWhatsAppTemplateToEntity, WhatsAppTemplateSendError } from "./startWhatsAppTemplate";
import type { MessageTemplateEntityType } from "./templateVariableContext";

const POLL_MS = 1_500;
const STALE_PROCESSING_MINUTES = 15;
const STALE_RECOVERY_INTERVAL_MS = 60_000;
let started = false;
let busy = false;
let lastStaleRecoveryAt = 0;
let workerTimer: ReturnType<typeof setInterval> | null = null;

interface ClaimedRecipient {
  id: number;
  campaign_id: number;
  entity_type: MessageTemplateEntityType;
  entity_id: number;
  phone_e164: string | null;
  channel_account_id: number | null;
  attempts: number;
  template_id: number;
  created_by_id: number;
}

async function claimRecipient(): Promise<ClaimedRecipient | null> {
  const result = await pool.query<ClaimedRecipient>(`
    UPDATE message_campaign_recipients AS recipient
       SET status = 'processing',
           attempts = recipient.attempts + 1,
           last_attempt_at = now(),
           updated_at = now()
     WHERE recipient.id = (
       SELECT r.id
         FROM message_campaign_recipients r
         JOIN message_campaigns c ON c.id = r.campaign_id
        WHERE r.status IN ('queued', 'retrying')
          AND COALESCE(r.next_attempt_at, c.scheduled_at) <= now()
          AND c.status IN ('queued', 'running')
        ORDER BY COALESCE(r.next_attempt_at, c.scheduled_at), r.id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
     )
    RETURNING recipient.id,
              recipient.campaign_id,
              recipient.entity_type,
              recipient.entity_id,
              recipient.phone_e164,
              recipient.channel_account_id,
              recipient.attempts,
              (SELECT template_id FROM message_campaigns WHERE id = recipient.campaign_id) AS template_id,
              (SELECT created_by_id FROM message_campaigns WHERE id = recipient.campaign_id) AS created_by_id
  `);
  return result.rows[0] || null;
}

async function refreshCampaign(campaignId: number): Promise<void> {
  await pool.query(`
    WITH counts AS (
      SELECT
        count(*) FILTER (WHERE status IN ('queued', 'retrying', 'processing'))::int AS pending_count,
        count(*) FILTER (WHERE status = 'sent')::int AS sent_count,
        count(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        count(*) FILTER (WHERE status = 'skipped')::int AS skipped_count
      FROM message_campaign_recipients
      WHERE campaign_id = $1
    )
    UPDATE message_campaigns AS campaign
       SET queued_count = counts.pending_count,
           sent_count = counts.sent_count,
           failed_count = counts.failed_count,
           skipped_count = counts.skipped_count,
           started_at = COALESCE(campaign.started_at, now()),
           completed_at = CASE WHEN counts.pending_count = 0 THEN now() ELSE NULL END,
           status = CASE
             WHEN counts.pending_count > 0 THEN 'running'
             WHEN counts.failed_count > 0 AND counts.sent_count > 0 THEN 'partial'
             WHEN counts.failed_count > 0 THEN 'failed'
             ELSE 'completed'
           END,
           updated_at = now()
      FROM counts
     WHERE campaign.id = $1
  `, [campaignId]);
}

function retryDelay(attempt: number): Date {
  const delays = [60_000, 5 * 60_000, 20 * 60_000];
  return new Date(Date.now() + (delays[Math.max(0, attempt - 1)] || delays[delays.length - 1]));
}

function isRetryable(error: unknown): boolean {
  // Retry only a failure that is proven to have happened before the provider
  // send request. Network/provider send failures are ambiguous: the provider
  // may have accepted the message even when we did not receive its response.
  // Those require operator review instead of risking a duplicate message.
  return error instanceof WhatsAppTemplateSendError
    && error.code === "template_availability_check_failed";
}

async function processRecipient(recipient: ClaimedRecipient): Promise<void> {
  await db.update(messageCampaignsTable).set({ status: "running" }).where(eq(messageCampaignsTable.id, recipient.campaign_id));
  const [actor] = await db.select().from(usersTable).where(eq(usersTable.id, recipient.created_by_id)).limit(1);
  const [template] = await db.select({ id: messageTemplatesTable.id }).from(messageTemplatesTable).where(eq(messageTemplatesTable.id, recipient.template_id)).limit(1);
  if (!actor || !template) {
    await db.update(messageCampaignRecipientsTable).set({ status: "failed", errorCode: "campaign_source_missing", errorDetail: "Campaign owner or template no longer exists." }).where(eq(messageCampaignRecipientsTable.id, recipient.id));
    await refreshCampaign(recipient.campaign_id);
    return;
  }

  try {
    const result = await sendWhatsAppTemplateToEntity({
      actor: actor as AuthUser,
      entityType: recipient.entity_type,
      entityId: recipient.entity_id,
      templateId: recipient.template_id,
      expectedPhoneE164: recipient.phone_e164 || undefined,
      channelAccountId: recipient.channel_account_id || undefined,
    });
    await db.update(messageCampaignRecipientsTable).set({
      status: "sent",
      channelAccountId: result.channelAccountId,
      conversationId: result.conversationId,
      messageId: result.messageId,
      renderedContent: result.renderedContent,
      externalMessageId: result.externalMessageId,
      providerBroadcastId: result.providerBroadcastId,
      variablesSnapshot: result.variables,
      nextAttemptAt: null,
      errorCode: null,
      errorDetail: null,
    }).where(eq(messageCampaignRecipientsTable.id, recipient.id));
  } catch (error) {
    const structured = error instanceof WhatsAppTemplateSendError ? error : null;
    const shouldRetry = recipient.attempts < 3 && isRetryable(error);
    await db.update(messageCampaignRecipientsTable).set({
      status: shouldRetry ? "retrying" : "failed",
      nextAttemptAt: shouldRetry ? retryDelay(recipient.attempts) : null,
      conversationId: structured?.conversationId || null,
      messageId: structured?.messageId || null,
      errorCode: structured?.code || "unexpected_send_error",
      errorDetail: structured?.detail || (error instanceof Error ? error.message : "Unknown send error"),
    }).where(eq(messageCampaignRecipientsTable.id, recipient.id));
  }
  await refreshCampaign(recipient.campaign_id);
}

async function recoverStaleProcessing(): Promise<void> {
  await pool.query(`
    UPDATE message_campaign_recipients
       SET status = 'failed',
           next_attempt_at = NULL,
           error_code = 'delivery_outcome_unknown',
           error_detail = 'The worker stopped before the provider outcome was recorded. Review the conversation/provider history before retrying.',
           updated_at = now()
     WHERE status = 'processing'
       AND last_attempt_at < now() - interval '${STALE_PROCESSING_MINUTES} minutes'
  `);
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    if (now - lastStaleRecoveryAt >= STALE_RECOVERY_INTERVAL_MS) {
      lastStaleRecoveryAt = now;
      await recoverStaleProcessing();
    }
    const recipient = await claimRecipient();
    if (recipient) await processRecipient(recipient);
  } catch (error) {
    console.error("[messageCampaignWorker]", error);
  } finally {
    busy = false;
  }
}

export function startMessageCampaignWorker(): () => Promise<void> {
  if (started) return stopMessageCampaignWorker;
  started = true;
  // We cannot prove whether the provider accepted a request if this process
  // died while a row was `processing`. Retrying it could send a duplicate
  // WhatsApp message. Mark it fail-closed for provider/conversation review;
  // the bulk retry endpoint intentionally excludes this outcome.
  // Recovery runs periodically, not only once at boot: a row orphaned less
  // than 15 minutes before a restart must still be quarantined after it ages.
  workerTimer = setInterval(() => { void tick(); }, POLL_MS);
  workerTimer.unref?.();
  void tick();
  return stopMessageCampaignWorker;
}

export async function stopMessageCampaignWorker(): Promise<void> {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  started = false;
  const deadline = Date.now() + 10_000;
  while (busy && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
