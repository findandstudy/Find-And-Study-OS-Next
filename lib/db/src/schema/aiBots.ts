import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { channelAccountsTable } from "./inbox";

/**
 * Runtime AI agents used by public widgets and inbox conversations.
 *
 * This is intentionally separate from `ai_personas`: personas model internal
 * automation roles, while an AI bot owns a complete, isolated copy of the
 * public/inbox agent configuration for one brand or project.
 */
export const aiBotsTable = pgTable("ai_bots", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  /** Encrypted JSON using the same encryption helper as integration config. */
  configEncrypted: text("config_encrypted"),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("ai_bots_slug_unique").on(table.slug),
  uniqueIndex("ai_bots_one_default_unique")
    .on(table.isDefault)
    .where(sql`${table.isDefault} = true`),
  index("ai_bots_active_idx").on(table.isActive),
  index("ai_bots_default_idx").on(table.isDefault),
]);

/** A project/use-case pipeline that pins one bot and its messaging routes. */
export const communicationPipelinesTable = pgTable("communication_pipelines", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  description: text("description"),
  aiBotId: integer("ai_bot_id").notNull().references(() => aiBotsTable.id, { onDelete: "restrict" }),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("communication_pipelines_slug_unique").on(table.slug),
  uniqueIndex("communication_pipelines_one_default_unique")
    .on(table.isDefault)
    .where(sql`${table.isDefault} = true`),
  index("communication_pipelines_ai_bot_idx").on(table.aiBotId),
  index("communication_pipelines_active_idx").on(table.isActive),
  index("communication_pipelines_default_idx").on(table.isDefault),
]);

/**
 * WhatsApp (and future channel) accounts attached to a pipeline.
 * `priority` is only meaningful for outbound accounts: 1=primary, 2=secondary.
 */
export const communicationPipelineAccountsTable = pgTable("communication_pipeline_accounts", {
  id: serial("id").primaryKey(),
  pipelineId: integer("pipeline_id").notNull().references(() => communicationPipelinesTable.id, { onDelete: "cascade" }),
  channelAccountId: integer("channel_account_id").notNull().references(() => channelAccountsTable.id, { onDelete: "cascade" }),
  canSend: boolean("can_send").notNull().default(true),
  canReceive: boolean("can_receive").notNull().default(true),
  priority: integer("priority"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  check(
    "communication_pipeline_accounts_priority_check",
    sql`${table.priority} IS NULL OR ${table.priority} IN (1, 2)`,
  ),
  uniqueIndex("communication_pipeline_accounts_unique").on(table.pipelineId, table.channelAccountId),
  uniqueIndex("communication_pipeline_accounts_send_priority_unique")
    .on(table.pipelineId, table.priority)
    .where(sql`${table.canSend} = true AND ${table.priority} IS NOT NULL`),
  uniqueIndex("communication_pipeline_accounts_receive_owner_unique")
    .on(table.channelAccountId)
    .where(sql`${table.canReceive} = true`),
  index("communication_pipeline_accounts_pipeline_idx").on(table.pipelineId),
  index("communication_pipeline_accounts_account_idx").on(table.channelAccountId),
]);

export type AiBot = typeof aiBotsTable.$inferSelect;
export type CommunicationPipeline = typeof communicationPipelinesTable.$inferSelect;
export type CommunicationPipelineAccount = typeof communicationPipelineAccountsTable.$inferSelect;
