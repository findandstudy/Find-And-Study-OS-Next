import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const systemFlagsTable = pgTable("system_flags", {
  key: text("key").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});
