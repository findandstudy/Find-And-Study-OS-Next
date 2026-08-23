import { Router, type IRouter } from "express";
import {
  db,
  messageCampaignsTable,
  messageCampaignRecipientsTable,
  messageTemplatesTable,
  channelAccountsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { logAudit, requireAuth, requireRole } from "../lib/auth";
import { ADMIN_ROLES, STAFF_ROLES } from "../lib/roles";
import {
  loadWhatsAppEntitySnapshot,
  WhatsAppTemplateSendError,
} from "../lib/inbox/startWhatsAppTemplate";
import type { MessageTemplateEntityType } from "../lib/inbox/templateVariableContext";
import { resolveApprovedZernioTemplate } from "../lib/inbox/zernioTemplates";

const router: IRouter = Router();

const createCampaignSchema = z.object({
  name: z.string().trim().min(1).max(180).optional(),
  entityType: z.enum(["lead", "student", "application"]),
  entityIds: z.array(z.coerce.number().int().positive()).min(1).max(500),
  templateId: z.coerce.number().int().positive(),
  channelAccountId: z.coerce.number().int().positive(),
  scheduledAt: z.coerce.date().optional(),
});

// These errors are known to occur before any provider send request. Only
// recipients with one of these codes can be bulk-retried safely. Ambiguous
// provider/network results must stay blocked to prevent duplicate WhatsApp
// messages.
const SAFE_BULK_RETRY_ERROR_CODES = [
  "recipient_phone_changed",
  "no_zernio_account",
  "template_not_available",
  "template_not_approved_for_whatsapp_account",
  "template_availability_check_failed",
  "template_variables_missing",
  "template_variables_unmapped",
  "template_variable_count_mismatch",
] as const;

function canViewAllCampaigns(role: string): boolean {
  return (ADMIN_ROLES as readonly string[]).includes(role);
}

router.post(
  "/message-campaigns",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const parsed = createCampaignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_campaign", details: parsed.error.flatten() });
      return;
    }

    const { entityType, templateId, channelAccountId } = parsed.data;
    const entityIds = [...new Set(parsed.data.entityIds)];
    const [template] = await db
      .select()
      .from(messageTemplatesTable)
      .where(and(
        eq(messageTemplatesTable.id, templateId),
        eq(messageTemplatesTable.isActive, true),
      ))
      .limit(1);
    if (
      !template?.externalTemplateName
      || !["whatsapp", "all"].includes(template.channel)
      || String(template.approvalStatus || "").toLowerCase() !== "approved"
    ) {
      res.status(400).json({ error: "template_not_available" });
      return;
    }
    const [account] = await db.select({
      id: channelAccountsTable.id,
      displayName: channelAccountsTable.displayName,
      externalAccountId: channelAccountsTable.externalAccountId,
      metadata: channelAccountsTable.metadata,
    }).from(channelAccountsTable).where(and(
      eq(channelAccountsTable.id, channelAccountId),
      eq(channelAccountsTable.channel, "whatsapp"),
      eq(channelAccountsTable.provider, "zernio"),
      eq(channelAccountsTable.isActive, true),
    )).limit(1);
    if (!account?.externalAccountId) {
      res.status(400).json({ error: "whatsapp_account_not_available" });
      return;
    }
    const availability = await resolveApprovedZernioTemplate({
      externalAccountId: account.externalAccountId,
      templateName: template.externalTemplateName,
      preferredLanguage: template.language,
    });
    if (!availability.ok) {
      res.status(availability.reason === "provider_unavailable" ? 502 : 409).json({
        error: availability.reason === "provider_unavailable"
          ? "template_availability_check_failed"
          : "template_not_approved_for_whatsapp_account",
      });
      return;
    }

    const recipients: Array<{
      entityType: MessageTemplateEntityType;
      entityId: number;
      recipientKey: string;
      leadId: number | null;
      studentId: number | null;
      applicationId: number | null;
      displayName: string | null;
      phoneE164: string | null;
      status: "queued" | "skipped";
      errorCode: string | null;
      errorDetail: string | null;
      sourceSnapshot: Record<string, unknown>;
    }> = [];
    const seenPhones = new Set<string>();

    for (const entityId of entityIds) {
      try {
        const snapshot = await loadWhatsAppEntitySnapshot(req.user!, entityType, entityId);
        const duplicate = seenPhones.has(snapshot.phoneE164);
        seenPhones.add(snapshot.phoneE164);
        recipients.push({
          entityType,
          entityId,
          recipientKey: `${entityType}:${entityId}`,
          leadId: entityType === "lead" ? entityId : null,
          studentId: entityType === "student" ? entityId : snapshot.resolvedStudentId,
          applicationId: entityType === "application" ? entityId : null,
          displayName: snapshot.displayName || null,
          phoneE164: snapshot.phoneE164,
          status: duplicate ? "skipped" : "queued",
          errorCode: duplicate ? "duplicate_recipient" : null,
          errorDetail: duplicate ? "Another selected record resolves to the same phone number." : null,
          sourceSnapshot: {
            entityType,
            entityId,
            displayName: snapshot.displayName,
            phoneE164: snapshot.phoneE164,
          },
        });
      } catch (error) {
        if (error instanceof WhatsAppTemplateSendError && error.code === "no_phone") {
          recipients.push({
            entityType,
            entityId,
            recipientKey: `${entityType}:${entityId}`,
            leadId: entityType === "lead" ? entityId : null,
            studentId: entityType === "student" ? entityId : null,
            applicationId: entityType === "application" ? entityId : null,
            displayName: null,
            phoneE164: null,
            status: "skipped",
            errorCode: "no_phone",
            errorDetail: error.detail || "No valid WhatsApp phone number.",
            sourceSnapshot: { entityType, entityId },
          });
          continue;
        }
        if (error instanceof WhatsAppTemplateSendError) {
          res.status(error.status).json({ error: error.code, detail: error.detail });
          return;
        }
        throw error;
      }
    }

    const queuedCount = recipients.filter((row) => row.status === "queued").length;
    const skippedCount = recipients.length - queuedCount;
    const scheduledAt = parsed.data.scheduledAt || new Date();
    const [campaign] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(messageCampaignsTable)
        .values({
          name: parsed.data.name || `${template.name} · ${recipients.length} recipients`,
          channel: "whatsapp",
          sourceEntityType: entityType,
          templateId,
          status: queuedCount > 0 ? "queued" : "completed",
          createdById: req.user!.id,
          scheduledAt,
          completedAt: queuedCount > 0 ? null : new Date(),
          totalCount: recipients.length,
          queuedCount,
          skippedCount,
          metadata: {
            templateName: template.externalTemplateName,
            channelAccountId: account.id,
            senderLine: {
              displayName: account.displayName,
              brandLabel: (account.metadata as any)?.brandLabel || account.displayName,
              brandColor: (account.metadata as any)?.brandColor || null,
            },
          },
        })
        .returning();
      if (recipients.length > 0) {
        await tx.insert(messageCampaignRecipientsTable).values(
          recipients.map((recipient) => ({ ...recipient, campaignId: created.id, channelAccountId: account.id })),
        );
      }
      return [created];
    });

    logAudit(
      req.user!.id,
      "message_campaign.create",
      "message_campaign",
      campaign.id,
      {
        entityType,
        templateId,
        totalCount: recipients.length,
        queuedCount,
        skippedCount,
        scheduledAt: scheduledAt.toISOString(),
        channelAccountId: account.id,
      },
      req.ip,
    );

    res.status(201).json({
      data: campaign,
      summary: { total: recipients.length, queued: queuedCount, skipped: skippedCount },
    });
  },
);

router.get(
  "/message-campaigns",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const rows = await db
      .select({
        campaign: messageCampaignsTable,
        templateName: messageTemplatesTable.name,
        externalTemplateName: messageTemplatesTable.externalTemplateName,
      })
      .from(messageCampaignsTable)
      .innerJoin(messageTemplatesTable, eq(messageCampaignsTable.templateId, messageTemplatesTable.id))
      .where(canViewAllCampaigns(req.user!.role)
        ? undefined
        : eq(messageCampaignsTable.createdById, req.user!.id))
      .orderBy(desc(messageCampaignsTable.createdAt))
      .limit(100);
    res.json({ data: rows.map((row) => ({ ...row.campaign, templateName: row.templateName, externalTemplateName: row.externalTemplateName })) });
  },
);

router.get(
  "/message-campaigns/:id",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      res.status(400).json({ error: "invalid_campaign_id" });
      return;
    }
    const [campaign] = await db
      .select()
      .from(messageCampaignsTable)
      .where(and(
        eq(messageCampaignsTable.id, campaignId),
        ...(canViewAllCampaigns(req.user!.role) ? [] : [eq(messageCampaignsTable.createdById, req.user!.id)]),
      ))
      .limit(1);
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }
    const recipients = await db
      .select()
      .from(messageCampaignRecipientsTable)
      .where(eq(messageCampaignRecipientsTable.campaignId, campaignId))
      .orderBy(messageCampaignRecipientsTable.id);
    res.json({ data: { ...campaign, recipients } });
  },
);

router.post(
  "/message-campaigns/:id/retry-failed",
  requireAuth,
  requireRole(...STAFF_ROLES, ...ADMIN_ROLES),
  async (req, res): Promise<void> => {
    const campaignId = Number(req.params.id);
    if (!Number.isInteger(campaignId) || campaignId <= 0) {
      res.status(400).json({ error: "invalid_campaign_id" });
      return;
    }
    const [campaign] = await db
      .select()
      .from(messageCampaignsTable)
      .where(and(
        eq(messageCampaignsTable.id, campaignId),
        ...(canViewAllCampaigns(req.user!.role) ? [] : [eq(messageCampaignsTable.createdById, req.user!.id)]),
      ))
      .limit(1);
    if (!campaign) {
      res.status(404).json({ error: "campaign_not_found" });
      return;
    }
    const retried = await db
      .update(messageCampaignRecipientsTable)
      .set({
        status: "queued",
        attempts: 0,
        nextAttemptAt: new Date(),
        errorCode: null,
        errorDetail: null,
      })
      .where(and(
        eq(messageCampaignRecipientsTable.campaignId, campaignId),
        inArray(messageCampaignRecipientsTable.status, ["failed", "retrying"]),
        inArray(messageCampaignRecipientsTable.errorCode, [...SAFE_BULK_RETRY_ERROR_CODES]),
      ))
      .returning({ id: messageCampaignRecipientsTable.id });
    await db
      .update(messageCampaignsTable)
      .set(retried.length > 0 ? {
        status: "queued",
        completedAt: null,
        queuedCount: sql`${messageCampaignsTable.queuedCount} + ${retried.length}`,
        failedCount: sql`GREATEST(${messageCampaignsTable.failedCount} - ${retried.length}, 0)`,
      } : {
        status: campaign.status,
        completedAt: campaign.completedAt,
      })
      .where(eq(messageCampaignsTable.id, campaignId));
    logAudit(
      req.user!.id,
      "message_campaign.retry_safe_failures",
      "message_campaign",
      campaignId,
      { retriedCount: retried.length },
      req.ip,
    );
    res.json({ retried: retried.length });
  },
);

export default router;
