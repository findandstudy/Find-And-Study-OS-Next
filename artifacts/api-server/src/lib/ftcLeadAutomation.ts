import { db, followUpsTable, leadsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { sendEmail } from "./email";
import { dispatchNotification } from "./notificationDispatcher";
import { isFtcEmbedSource } from "./ga4LeadTracking";
import { getFtcAutomationForSource } from "./ftcLeadAutomationConfig";
import { buildFtcLeadAcknowledgementEmail } from "./ftcLeadEmail";

/** Runs only for a newly inserted FTC embed lead; never sends retroactive mail. */
export async function runFtcNewLeadAutomation(leadId: number): Promise<void> {
  const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId));
  if (!lead) return;
  if (!isFtcEmbedSource(lead.source)) return;
  const config = getFtcAutomationForSource(lead.source);
  if (!config) return;

  if (lead.assignedToId) {
    try {
      await db.insert(followUpsTable).values({
        leadId: lead.id,
        resourceType: "lead",
        title: config.taskTitle,
        scheduledAt: new Date(Date.now() + 15 * 60_000),
        assignedToId: lead.assignedToId,
        createdById: lead.assignedToId,
        notes: "Automatically created for a new Free Turkish Course enquiry. Contact within 15 minutes when business hours allow.",
      });
    } catch (error) {
      console.error("[FTC-AUTOMATION] follow-up task failed:", error);
    }
  }

  try {
    await dispatchNotification({
      event: "lead.created",
      title: `New Free Turkish Course ${config.label} lead`,
      body: `${lead.firstName} ${lead.lastName} submitted a ${config.label} enquiry.`,
      actionUrl: `/staff/leads/${lead.id}`,
      icon: "UserPlus",
      recipientUserIds: lead.assignedToId ? [lead.assignedToId] : undefined,
      templateVars: {
        firstName: lead.firstName,
        lastName: lead.lastName,
        email: lead.email || "",
        phone: lead.phone || "",
      },
    });
  } catch (error) {
    console.error("[FTC-AUTOMATION] staff notification failed:", error);
  }

  if (!lead.email) return;
  try {
    const email = buildFtcLeadAcknowledgementEmail(lead.firstName, config);
    await sendEmail(lead.email, email);
  } catch (error) {
    console.error("[FTC-AUTOMATION] acknowledgement email failed:", error);
  }
}
