import {
  bigint,
  integer,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// Runtime metadata tables that predate the reviewed Drizzle migration chain.
// They remain canonical because live code still reads and writes them through raw SQL.
export const legacyRateLimitsTable = pgTable("rate_limits", {
  key: varchar("key", { length: 255 }).primaryKey(),
  points: integer("points").notNull().default(0),
  expire: bigint("expire", { mode: "number" }),
});

export const systemKvTable = pgTable("system_kv", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const pipelineMigrationsTable = pgTable("pipeline_migrations", {
  name: text("name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const objectOwnersBackfillTable = pgTable("object_owners_backfill", {
  id: integer("id").primaryKey().notNull().default(1),
  completedAt: timestamp("completed_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
