import { pgTable, text, serial, timestamp, integer, boolean, index } from "drizzle-orm/pg-core";
import { applicationsTable } from "./applications";
import { usersTable } from "./users";

export const applicationStageDocumentsTable = pgTable("application_stage_documents", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id").notNull().references(() => applicationsTable.id, { onDelete: "cascade" }),
  stage: text("stage").notNull(),
  fileName: text("file_name").notNull(),
  fileData: text("file_data"),
  fileUrl: text("file_url"),
  mimeType: text("mime_type"),
  sizeBytes: integer("size_bytes"),
  uploadedBy: integer("uploaded_by").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  uploadedByRole: text("uploaded_by_role").notNull(),
  uploadedByName: text("uploaded_by_name"),
  isMissingDocNote: boolean("is_missing_doc_note").default(false),
  // Task #187 — per-item note attached to a missing-doc request row,
  // separate from `fileName` so the UI can show the catalog/custom title
  // distinctly from any free-text instructions.
  note: text("note"),
  // Task #187 — false = `fileName` is a document-catalog key (auto-matched
  // against student uploads via doc-equivalence); true = free-text custom
  // title (must be fulfilled manually).
  isCustom: boolean("is_custom").default(false).notNull(),
  // Task #187 — set when the student (or equivalent uploader) provides the
  // requested document. Used to drive the missing-docs-fulfilled auto-stage
  // transition; NULL = still open.
  fulfilledAt: timestamp("fulfilled_at", { withTimezone: true }),
  // Task #187 — custom (free-text) requests can't be auto-matched, but when
  // the student uploads ANY document on the same source stage we mark them
  // as "responded / awaiting staff review" so the panel stops nagging the
  // student while staff decides whether to close it. NULL = still open and
  // no upload has happened yet.
  respondedAt: timestamp("responded_at", { withTimezone: true }),
  respondedDocumentId: integer("responded_document_id"),
  // Task #187 round-5 — snapshot of the missing-doc action's targetStageKey
  // (the "waiting" stage staff moved the application to when invoking the
  // action). The fulfillment hook gates auto-advance on this exact stage so
  // unrelated transitions can't trigger silent jumps.
  actionTargetStageKey: text("action_target_stage_key"),
  validUntil: timestamp("valid_until", { withTimezone: true }),
  expiryNotifiedThresholds: text("expiry_notified_thresholds"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("app_stage_docs_application_id_idx").on(table.applicationId),
  index("app_stage_docs_stage_idx").on(table.stage),
]);

export type ApplicationStageDocument = typeof applicationStageDocumentsTable.$inferSelect;
