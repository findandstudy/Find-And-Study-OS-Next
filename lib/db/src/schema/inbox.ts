import { pgTable, serial, text, timestamp, integer, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { leadsTable } from "./leads";
import { studentsTable } from "./students";
import { agentsTable } from "./agents";

export const channelAccountsTable = pgTable("channel_accounts", {
  id: serial("id").primaryKey(),
  channel: text("channel").notNull(),
  displayName: text("display_name").notNull(),
  externalAccountId: text("external_account_id"),
  configEncrypted: text("config_encrypted"),
  webhookSecret: text("webhook_secret"),
  provider: text("provider").notNull().default("direct"),
  status: text("status").notNull().default("active"),
  isActive: boolean("is_active").notNull().default(true),
  isDefault: boolean("is_default").notNull().default(false),
  metadata: jsonb("metadata").default({}),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("channel_accounts_channel_idx").on(table.channel),
  index("channel_accounts_status_idx").on(table.status),
]);

export const externalContactsTable = pgTable("external_contacts", {
  id: serial("id").primaryKey(),
  channel: text("channel").notNull(),
  externalId: text("external_id").notNull(),
  displayName: text("display_name"),
  phone: text("phone"),
  phoneE164: text("phone_e164"),
  email: text("email"),
  contactType: text("contact_type").notNull().default("student"),
  leadId: integer("lead_id").references(() => leadsTable.id, { onDelete: "set null" }),
  studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
  agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  isBlocked: boolean("is_blocked").notNull().default(false),
  blockedAt: timestamp("blocked_at", { withTimezone: true }),
  metadata: jsonb("metadata").default({}),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("external_contacts_channel_external_idx").on(table.channel, table.externalId),
  index("external_contacts_phone_e164_idx").on(table.phoneE164),
  index("external_contacts_email_idx").on(table.email),
  index("external_contacts_contact_type_idx").on(table.contactType),
  index("external_contacts_lead_id_idx").on(table.leadId),
  index("external_contacts_student_id_idx").on(table.studentId),
  index("external_contacts_agent_id_idx").on(table.agentId),
]);

export type ChannelAccount = typeof channelAccountsTable.$inferSelect;
export type ExternalContact = typeof externalContactsTable.$inferSelect;
