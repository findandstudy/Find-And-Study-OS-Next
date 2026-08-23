import { pgTable, text, serial, timestamp, integer, real, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { studentsTable } from "./students";
import { applicationsTable } from "./applications";
import { leadsTable } from "./leads";
import { usersTable } from "./users";

export const documentsTable = pgTable("documents", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
  applicationId: integer("application_id").references(() => applicationsTable.id, { onDelete: "set null" }),
  leadId: integer("lead_id").references(() => leadsTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  status: text("status").notNull().default("pending"),
  fileKey: text("file_key"),
  fileUrl: text("file_url"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  extractedData: text("extracted_data"),
  confidenceScore: real("confidence_score"),
  reviewedBy: integer("reviewed_by").references(() => usersTable.id, { onDelete: "set null" }),
  fileData: text("file_data"),
  notes: text("notes"),
  // When this document was created by mirroring a stage-document upload,
  // this points back to the originating application_stage_documents row so
  // we can soft-delete the mirror when the stage doc is deleted (Faz J).
  sourceStageDocumentId: integer("source_stage_document_id"),
  // Inbox "Add as Document" — tracks where the document came from.
  source: text("source"),
  sourceConversationId: integer("source_conversation_id"),
  sourceMessageId: integer("source_message_id"),
  sourceAttachmentId: text("source_attachment_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("documents_student_id_idx").on(table.studentId),
  index("documents_application_id_idx").on(table.applicationId),
  index("documents_lead_id_idx").on(table.leadId),
]);

export const insertDocumentSchema = createInsertSchema(documentsTable).omit({ id: true, createdAt: true, updatedAt: true, deletedAt: true });
export type InsertDocument = z.infer<typeof insertDocumentSchema>;
export type Document = typeof documentsTable.$inferSelect;
