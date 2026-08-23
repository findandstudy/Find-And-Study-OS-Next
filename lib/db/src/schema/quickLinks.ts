import { pgTable, serial, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";

export const quickLinksTable = pgTable("quick_links", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  url: text("url").notNull(),
  icon: text("icon"),
  logoUrl: text("logo_url"),
  color: text("color"),
  target: text("target").notNull().default("agent"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type QuickLink = typeof quickLinksTable.$inferSelect;
export type InsertQuickLink = typeof quickLinksTable.$inferInsert;
