import { pgTable, serial, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";

export const integrationsTable = pgTable("integrations", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(false),
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Integration = typeof integrationsTable.$inferSelect;
