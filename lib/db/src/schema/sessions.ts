import { index, integer, jsonb, pgTable, timestamp, varchar } from "drizzle-orm/pg-core";

export const sessionsTable = pgTable(
  "sessions",
  {
    sid: varchar("sid").primaryKey(),
    sess: jsonb("sess").notNull(),
    expire: timestamp("expire").notNull(),
    userId: integer("user_id"),
  },
  (table) => [
    index("IDX_session_expire").on(table.expire),
    index("IDX_session_user_id").on(table.userId),
  ],
);
