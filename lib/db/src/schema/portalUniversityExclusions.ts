import { sql } from "drizzle-orm";
import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * portal_university_exclusions — university-based nationality exclusions
 * ("exclusive region" rules).
 *
 * When a student's nationality appears here for a given portal university, the
 * application must go through a specific agency instead of the portal. The
 * worker therefore SKIPS the portal entirely (no login/submit) and marks the
 * submission status='exclusive_region'. The skip is permanent — no retry.
 *
 * Soft-deletable with a PARTIAL unique index on (university_key, nationality)
 * WHERE deleted_at IS NULL, so a soft-deleted rule can be recreated (mirrors
 * portal_program_fallbacks).
 */
export const portalUniversityExclusionsTable = pgTable(
  "portal_university_exclusions",
  {
    id: serial("id").primaryKey(),
    universityKey: text("university_key").notNull(),
    nationality: text("nationality").notNull(),
    /** The agency the application must go through, when known. */
    agencyName: text("agency_name"),
    note: text("note"),
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
    uniqueIndex("portal_uni_exclusion_key_nat_uniq")
      .on(table.universityKey, table.nationality)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const insertPortalUniversityExclusionSchema = createInsertSchema(
  portalUniversityExclusionsTable,
  {
    universityKey: z.string().min(1),
    nationality: z.string().min(1),
  },
);

export type PortalUniversityExclusion =
  typeof portalUniversityExclusionsTable.$inferSelect;
export type NewPortalUniversityExclusion =
  typeof portalUniversityExclusionsTable.$inferInsert;
