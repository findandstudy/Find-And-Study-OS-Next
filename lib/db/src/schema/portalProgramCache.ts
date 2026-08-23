import {
  pgTable,
  serial,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Table — cached LIVE portal program option lists (value + text)
//
// Populated by fetching the portal's real program dropdown via the adapter's
// listPrograms() method. The admin "Program Eşleme" editor reads from here so
// it never has to log into the portal on every page load. Entries are stale
// after CACHE_TTL (24h); the API refetches on demand (refresh=1 or stale).
//
// NOTE: `level` is NOT NULL with a "" default (instead of nullable). A nullable
// level would break both the unique constraint and ON CONFLICT upsert in
// PostgreSQL (NULLs are distinct), so the "all levels / unspecified" case is
// encoded as the empty string. (1)(university_key, "") is a stable cache key.
// ---------------------------------------------------------------------------

/** A single portal program option: option value + visible text. */
export interface PortalProgramOption {
  v: string;
  t: string;
}

export const portalProgramCacheTable = pgTable(
  "portal_program_cache",
  {
    id: serial("id").primaryKey(),
    universityKey: text("university_key").notNull(),
    /** Education level filter (e.g. "Bachelor"); "" = unspecified / all. */
    level: text("level").notNull().default(""),
    /** Portal program options: [{ v: "<option value>", t: "<label>" }]. */
    options: jsonb("options")
      .$type<PortalProgramOption[]>()
      .notNull()
      .default([]),
    /** When the options were last fetched from the live portal (TTL anchor). */
    fetchedAt: timestamp("fetched_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("portal_prog_cache_key_level_uniq").on(
      table.universityKey,
      table.level,
    ),
  ],
);

export type PortalProgramCache = typeof portalProgramCacheTable.$inferSelect;
export type InsertPortalProgramCache =
  typeof portalProgramCacheTable.$inferInsert;
