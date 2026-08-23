import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Table — automatic backup-programme (supersession) rules.
//
// When a portal programme is full ("Kontenjan Dolu") the worker can fall back
// to an ordered list of alternative CRM programmes instead of failing. Each row
// maps a SOURCE programme (the full/target one) to an ordered list of fallback
// CRM program ids, scoped to a portal university.
//
// `university_key` aligns with portal_universities.university_key.
// `source_program_id` / `fallback_program_ids` are CRM programs.id values — kept
// as plain ints (not FKs) to mirror the jsonb id-list semantics and avoid
// coupling to the catalog programme lifecycle.
// ---------------------------------------------------------------------------
export const portalProgramFallbacksTable = pgTable(
  "portal_program_fallbacks",
  {
    id: serial("id").primaryKey(),

    universityKey: text("university_key").notNull(),

    /** CRM programs.id of the full / source programme this rule fires for. */
    sourceProgramId: integer("source_program_id").notNull(),

    /** Ordered CRM programs.id list to try in turn, e.g. [13609, 8327]. */
    fallbackProgramIds: jsonb("fallback_program_ids")
      .$type<number[]>()
      .notNull()
      .default([]),

    /** When true the worker auto-submits to the chosen fallback programme. */
    autoSubmit: boolean("auto_submit").notNull().default(true),

    /** Master on/off switch for this rule. */
    enabled: boolean("enabled").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),

    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // One ACTIVE fallback rule per (portal university, source programme).
    // Partial (deleted_at IS NULL) so a soft-deleted rule can be recreated.
    uniqueIndex("portal_prog_fallback_key_source_uniq")
      .on(table.universityKey, table.sourceProgramId)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

// ---------------------------------------------------------------------------
// Zod schemas & TS types
// ---------------------------------------------------------------------------
export const insertPortalProgramFallbackSchema = createInsertSchema(
  portalProgramFallbacksTable,
  {
    universityKey: z.string().min(1),
    fallbackProgramIds: z.array(z.number().int()),
  },
);

export type PortalProgramFallback =
  typeof portalProgramFallbacksTable.$inferSelect;
export type NewPortalProgramFallback =
  typeof portalProgramFallbacksTable.$inferInsert;
