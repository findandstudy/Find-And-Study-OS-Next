import { pgTable, text, serial, timestamp, integer, real, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  changeType: text("change_type").notNull().default("discount"),
  changePercent: real("change_percent").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  universityIds: jsonb("university_ids").$type<number[]>().notNull().default([]),
  agentCountries: jsonb("agent_countries").$type<string[]>().notNull().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("campaigns_active_dates_idx").on(table.isActive, table.startDate, table.endDate),
  index("campaigns_archived_idx").on(table.archivedAt),
]);

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
});
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;
