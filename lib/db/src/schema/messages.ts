import { pgTable, serial, text, timestamp, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";
import { aiBotsTable, communicationPipelinesTable } from "./aiBots";

// AI summary cache stored in conversations.metadata.aiSummary.
// The pgTable schema itself does not change — this is the TypeScript
// shape that inbox routes use when reading/writing that JSON slot.
export interface ConversationAiSummary {
  content: string;
  generatedAt: string;
  messageCount: number;
  model: string;
  generatedByUserId: number;
}

export const conversationsTable = pgTable("conversations", {
  id: serial("id").primaryKey(),
  type: text("type").notNull().default("direct"),
  title: text("title"),
  createdById: integer("created_by_id").references(() => usersTable.id),
  isArchived: boolean("is_archived").notNull().default(false),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
  lastMessagePreview: text("last_message_preview"),
  metadata: jsonb("metadata").default({}),
  channel: text("channel").notNull().default("internal"),
  channelAccountId: integer("channel_account_id"),
  aiBotId: integer("ai_bot_id").references(() => aiBotsTable.id, { onDelete: "set null" }),
  communicationPipelineId: integer("communication_pipeline_id").references(() => communicationPipelinesTable.id, { onDelete: "set null" }),
  externalContactId: integer("external_contact_id"),
  externalThreadId: text("external_thread_id"),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  status: text("status").notNull().default("open"),
  language: text("language"),
  unmatched: boolean("unmatched").notNull().default(false),
  lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
  readReceiptsEnabled: boolean("read_receipts_enabled").notNull().default(true),
  botEnabled: boolean("bot_enabled").notNull().default(false),
  needsHuman: boolean("needs_human").notNull().default(false),
  botLastHandledMessageId: integer("bot_last_handled_message_id"),
  botReplyCount: integer("bot_reply_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("conversations_created_by_id_idx").on(table.createdById),
  index("conversations_channel_idx").on(table.channel),
  index("conversations_assigned_to_id_idx").on(table.assignedToId),
  index("conversations_status_idx").on(table.status),
  index("conversations_unmatched_idx").on(table.unmatched),
  index("conversations_external_contact_id_idx").on(table.externalContactId),
  index("conversations_ai_bot_idx").on(table.aiBotId),
  index("conversations_communication_pipeline_idx").on(table.communicationPipelineId),
  uniqueIndex("conversations_channel_thread_idx").on(table.channelAccountId, table.externalThreadId),
]);

export const conversationParticipantsTable = pgTable("conversation_participants", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }),
  isMuted: boolean("is_muted").notNull().default(false),
  isStarred: boolean("is_starred").notNull().default(false),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  senderId: integer("sender_id").references(() => usersTable.id),
  content: text("content").notNull(),
  channel: text("channel").notNull().default("internal"),
  status: text("status").notNull().default("sent"),
  direction: text("direction").notNull().default("internal"),
  externalMessageId: text("external_message_id"),
  failedReason: text("failed_reason"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  replyToId: integer("reply_to_id"),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("messages_sender_id_idx").on(table.senderId),
  index("messages_conversation_id_idx").on(table.conversationId),
  index("messages_direction_idx").on(table.direction),
  uniqueIndex("messages_channel_external_idx").on(table.channel, table.externalMessageId),
]);

export const broadcastsTable = pgTable("broadcasts", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  channel: text("channel").notNull().default("internal"),
  targetAudience: text("target_audience").notNull().default("all"),
  targetRoles: jsonb("target_roles").default([]),
  status: text("status").notNull().default("draft"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  sentById: integer("sent_by_id").references(() => usersTable.id),
  recipientCount: integer("recipient_count").default(0),
  metadata: jsonb("metadata").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("broadcasts_sent_by_id_idx").on(table.sentById),
]);

export const messageTemplatesTable = pgTable("message_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull().default("general"),
  subject: text("subject"),
  content: text("content").notNull(),
  channel: text("channel").notNull().default("all"),
  language: text("language").notNull().default("en"),
  variables: jsonb("variables").default([]),
  externalTemplateName: text("external_template_name"),
  approvalStatus: text("approval_status"),
  isActive: boolean("is_active").notNull().default(true),
  createdById: integer("created_by_id").references(() => usersTable.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("msg_templates_created_by_id_idx").on(table.createdById),
]);

export const messageReactionsTable = pgTable("message_reactions", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull().references(() => messagesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  emoji: text("emoji").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("message_reactions_msg_user_emoji_idx").on(table.messageId, table.userId, table.emoji),
  index("message_reactions_message_id_idx").on(table.messageId),
]);

// Conversation quality scoring (Faz 1). One row per (conversation, staff user)
// scored by the nightly LLM batch. Bot messages are excluded from scoring;
// `speed` is computed from real reply-pair timing data, not by the LLM.
// rationales holds { accuracy: { rationale, evidence[] }, ... } with PII-masked
// evidence quotes. contentHash dedups re-scoring of unchanged conversations.
export const conversationQualityScoresTable = pgTable("conversation_quality_scores", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  accuracy: integer("accuracy").notNull(),
  completeness: integer("completeness").notNull(),
  speed: integer("speed").notNull(),
  tone: integer("tone").notNull(),
  outcome: integer("outcome").notNull(),
  overall: integer("overall").notNull(),
  rationales: jsonb("rationales").notNull().default({}),
  topic: text("topic"),
  language: text("language"),
  staffMessageCount: integer("staff_message_count").notNull().default(0),
  avgReplySeconds: integer("avg_reply_seconds"),
  contentHash: text("content_hash").notNull(),
  model: text("model"),
  scoredAt: timestamp("scored_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("conv_quality_conv_user_idx").on(table.conversationId, table.userId),
  index("conv_quality_user_id_idx").on(table.userId),
  index("conv_quality_scored_at_idx").on(table.scoredAt),
]);

export type ConversationQualityScore = typeof conversationQualityScoresTable.$inferSelect;

export type Conversation = typeof conversationsTable.$inferSelect;
export type Message = typeof messagesTable.$inferSelect;
export type Broadcast = typeof broadcastsTable.$inferSelect;
export type MessageTemplate = typeof messageTemplatesTable.$inferSelect;
export type MessageReaction = typeof messageReactionsTable.$inferSelect;
