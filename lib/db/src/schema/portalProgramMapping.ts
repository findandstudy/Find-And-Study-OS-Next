import {
  pgTable,
  serial,
  text,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { universitiesTable } from "./universities";

/**
 * Reserved sentinel `university_key` for the GENERAL (all-universities default)
 * tier of Program Mappings + Synonyms. A single row with this key + NULL member
 * holds defaults that apply to every school; a per-university row overrides/
 * extends it (University > General > fuzzy). No real portal university may use
 * this key — the create/rename endpoints reject it.
 */
export const GENERAL_MAPPING_KEY = "__general__";

// ---------------------------------------------------------------------------
// Table — per-university program name translation dictionary
// Stores a { "portal label" → "CRM program name" } override map.
// ---------------------------------------------------------------------------

export const portalProgramMappingTable = pgTable(
  "portal_program_mapping",
  {
    id: serial("id").primaryKey(),
    universityKey: text("university_key").notNull(),
    /**
     * Multi-portal member dimension (Phase 3). NULL = 1:1 university (Topkapı —
     * today's behaviour). When set, this row holds the program overrides for the
     * member catalog university (universities.id) of the multi-portal account
     * identified by `universityKey` (the company's portal key).
     */
    memberUniversityId: integer("member_university_id").references(
      () => universitiesTable.id,
      { onDelete: "cascade" },
    ),
    /** { "portal label": "CRM program name" } — legacy human dictionary (panel). */
    mappings: jsonb("mappings")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /**
     * Manual program overrides consumed by the matcher: CRM programId → portal
     * <option> value (or option text). Bypasses fuzzy matching (conf 1.0).
     * Merged OVER the adapter's built-in defaults (DB wins).
     */
    programOverrides: jsonb("program_overrides")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    /**
     * EN↔TR synonym equivalence groups (folded single tokens) used to EXTEND
     * the matcher's built-in synonym dictionary. Never removes built-in groups.
     */
    synonyms: jsonb("synonyms")
      .$type<string[][]>()
      .notNull()
      .default([]),
    /**
     * Country name/adjective (lowercased) → portal dropdown label. Merged OVER
     * the adapter's built-in country maps (DB wins).
     */
    countryOverrides: jsonb("country_overrides")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // 1:1 universities (Topkapı): one mapping row per universityKey when there
    // is no member dimension.
    uniqueIndex("portal_prog_map_key_nomem_uniq")
      .on(table.universityKey)
      .where(sql`member_university_id IS NULL`),
    // Multi-portal members: one mapping row per (company portal key, member).
    uniqueIndex("portal_prog_map_key_mem_uniq")
      .on(table.universityKey, table.memberUniversityId)
      .where(sql`member_university_id IS NOT NULL`),
  ],
);

export type PortalProgramMapping =
  typeof portalProgramMappingTable.$inferSelect;
export type InsertPortalProgramMapping =
  typeof portalProgramMappingTable.$inferInsert;
