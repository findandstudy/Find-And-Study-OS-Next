import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { universitiesTable } from "./universities";

// ---------------------------------------------------------------------------
// Table — multi-portal account membership (Phase 3)
//
// Junction mapping a multi-portal company (portal_universities.university_key)
// to the FAS-OS catalog universities (universities.id) it submits applications
// for. A catalog university belongs to AT MOST ONE portal account
// (UNIQUE(catalog_university_id)). Routing resolution joins a submission's
// catalog university (via portal_universities.crm_university_id) to this table.
// ---------------------------------------------------------------------------

export const portalAccountUniversitiesTable = pgTable(
  "portal_account_universities",
  {
    id: serial("id").primaryKey(),
    /** The multi-portal company's portal_universities.university_key. */
    portalKey: text("portal_key").notNull(),
    /** FAS-OS catalog university id (universities.id) this membership covers. */
    catalogUniversityId: integer("catalog_university_id")
      .notNull()
      .references(() => universitiesTable.id, { onDelete: "cascade" }),
    /** When false the membership exists but routing is suspended. */
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    // A catalog university can be a member of at most one portal account.
    uniqueIndex("portal_acct_uni_catalog_uniq").on(table.catalogUniversityId),
    index("portal_acct_uni_portal_key_idx").on(table.portalKey),
  ],
);

export type PortalAccountUniversity =
  typeof portalAccountUniversitiesTable.$inferSelect;
export type InsertPortalAccountUniversity =
  typeof portalAccountUniversitiesTable.$inferInsert;
