import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { leadsTable } from "./leads";
import { studentsTable } from "./students";
import { applicationsTable } from "./applications";
import {
  conversationsTable,
  messagesTable,
  messageTemplatesTable,
} from "./messages";
import { channelAccountsTable } from "./inbox";

/**
 * Outbound CRM campaigns are deliberately separate from `broadcasts`.
 * Broadcasts are internal announcements for platform users; campaigns target
 * snapshotted CRM entities and retain one auditable delivery row per target.
 */
export const messageCampaignsTable = pgTable("message_campaigns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  channel: text("channel").notNull().default("whatsapp"),
  sourceEntityType: text("source_entity_type").notNull(),
  templateId: integer("template_id")
    .notNull()
    .references(() => messageTemplatesTable.id, { onDelete: "restrict" }),
  status: text("status").notNull().default("queued"),
  createdById: integer("created_by_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "restrict" }),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  totalCount: integer("total_count").notNull().default(0),
  queuedCount: integer("queued_count").notNull().default(0),
  sentCount: integer("sent_count").notNull().default(0),
  failedCount: integer("failed_count").notNull().default(0),
  skippedCount: integer("skipped_count").notNull().default(0),
  metadata: jsonb("metadata").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("message_campaigns_status_scheduled_idx").on(table.status, table.scheduledAt),
  index("message_campaigns_created_by_idx").on(table.createdById, table.createdAt),
]);

export const messageCampaignRecipientsTable = pgTable("message_campaign_recipients", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id")
    .notNull()
    .references(() => messageCampaignsTable.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  recipientKey: text("recipient_key").notNull(),
  leadId: integer("lead_id").references(() => leadsTable.id, { onDelete: "set null" }),
  studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
  applicationId: integer("application_id").references(() => applicationsTable.id, { onDelete: "set null" }),
  displayName: text("display_name"),
  phoneE164: text("phone_e164"),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  channelAccountId: integer("channel_account_id").references(() => channelAccountsTable.id, { onDelete: "set null" }),
  conversationId: integer("conversation_id").references(() => conversationsTable.id, { onDelete: "set null" }),
  messageId: integer("message_id").references(() => messagesTable.id, { onDelete: "set null" }),
  renderedContent: text("rendered_content"),
  externalMessageId: text("external_message_id"),
  providerBroadcastId: text("provider_broadcast_id"),
  errorCode: text("error_code"),
  errorDetail: text("error_detail"),
  variablesSnapshot: jsonb("variables_snapshot").notNull().default({}),
  sourceSnapshot: jsonb("source_snapshot").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("message_campaign_recipients_campaign_key_uidx").on(table.campaignId, table.recipientKey),
  index("message_campaign_recipients_claim_idx").on(table.status, table.nextAttemptAt, table.id),
  index("message_campaign_recipients_campaign_status_idx").on(table.campaignId, table.status),
]);

export type MessageCampaign = typeof messageCampaignsTable.$inferSelect;
export type MessageCampaignRecipient = typeof messageCampaignRecipientsTable.$inferSelect;
