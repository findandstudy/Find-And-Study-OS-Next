import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const rateLimitsTable = pgTable("pg_rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});
