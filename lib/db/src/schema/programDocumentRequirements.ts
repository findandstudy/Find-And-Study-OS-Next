import { pgTable, serial, integer, text, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { programsTable } from "./universities";

export const programDocumentRequirementsTable = pgTable("program_document_requirements", {
  id: serial("id").primaryKey(),
  programId: integer("program_id").notNull().references(() => programsTable.id, { onDelete: "cascade" }),
  documentType: text("document_type").notNull(),
  mandatory: boolean("mandatory").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("program_doc_req_program_doctype_uniq").on(table.programId, table.documentType),
  index("program_doc_req_program_id_idx").on(table.programId),
]);

export type ProgramDocumentRequirement = typeof programDocumentRequirementsTable.$inferSelect;
export type InsertProgramDocumentRequirement = typeof programDocumentRequirementsTable.$inferInsert;
