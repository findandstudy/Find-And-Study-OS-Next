import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { catalogOptionsTable } from "./catalog";

export const degreeDocumentRequirementsTable = pgTable("degree_document_requirements", {
  id: serial("id").primaryKey(),
  catalogOptionId: integer("catalog_option_id").notNull().references(() => catalogOptionsTable.id, { onDelete: "cascade" }),
  documentType: text("document_type").notNull(),
  mandatory: boolean("mandatory").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("degree_doc_req_option_doctype_uniq").on(table.catalogOptionId, table.documentType),
  index("degree_doc_req_option_id_idx").on(table.catalogOptionId),
]);

export type DegreeDocumentRequirement = typeof degreeDocumentRequirementsTable.$inferSelect;
export type InsertDegreeDocumentRequirement = typeof degreeDocumentRequirementsTable.$inferInsert;
