import { pgTable, text, serial, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const TARGET_AUDIENCES = ["all_users", "all_agents", "specific_agents"] as const;
export type TargetAudience = (typeof TARGET_AUDIENCES)[number];

export const POPUP_FREQUENCIES = ["every_session", "every_login", "once_per_user"] as const;
export type PopupFrequency = (typeof POPUP_FREQUENCIES)[number];

export const POPUP_STATUSES = ["active", "inactive"] as const;
export type PopupStatus = (typeof POPUP_STATUSES)[number];

export const popupsTable = pgTable("popups", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  imageUrl: text("image_url"),
  linkUrl: text("link_url"),
  linkText: text("link_text"),
  targetAudience: text("target_audience").notNull().default("all_agents"),
  targetAgentIds: integer("target_agent_ids").array().notNull().default([]),
  frequency: text("frequency").notNull().default("every_session"),
  status: text("status").notNull().default("active"),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("popups_status_idx").on(table.status),
  index("popups_target_idx").on(table.targetAudience),
]);

export const popupDismissalsTable = pgTable("popup_dismissals", {
  id: serial("id").primaryKey(),
  popupId: integer("popup_id").notNull().references(() => popupsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  permanent: boolean("permanent").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("popup_dismissals_popup_user_idx").on(table.popupId, table.userId),
]);

export const insertPopupSchema = createInsertSchema(popupsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  targetAgentIds: z.array(z.number().int().positive()).default([]),
});

export const insertPopupDismissalSchema = createInsertSchema(popupDismissalsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertPopup = z.infer<typeof insertPopupSchema>;
export type Popup = typeof popupsTable.$inferSelect;
export type PopupDismissal = typeof popupDismissalsTable.$inferSelect;
