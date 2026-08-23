import { pgTable, serial, text, integer, timestamp, uniqueIndex, boolean, jsonb } from "drizzle-orm/pg-core";

// Task #167 — admin-configurable stage action buttons (max 2 per stage).
// Each action defines a button that appears on the application list rows;
// completing the action moves the application into `targetStageKey`.
export type StageActionType = "upload" | "download" | "missing_docs";
export interface StageAction {
  type: StageActionType;
  // Button label (display text). Falls back to type-default when empty.
  label?: string | null;
  // Document Name — for upload/download actions only. On upload this is
  // used as the stored filename (extension preserved); on download it is
  // used to select the matching stage document. Independent of `label`.
  documentName?: string | null;
  color?: string | null;
  // Empty / null = "Don't change" — action runs without transitioning.
  targetStageKey?: string | null;
  // For missing_docs (required) and upload/download (informational).
  requiredDocTypes?: string[];
}

export const pipelineStagesTable = pgTable("pipeline_stages", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  variant: text("variant"),
  icon: text("icon"),
  color: text("color"),
  isNotesMandatory: boolean("is_notes_mandatory").notNull().default(false),
  canAttachFile: boolean("can_attach_file").notNull().default(false),
  maxFiles: integer("max_files").notNull().default(1),
  isFileUploadMandatory: boolean("is_file_upload_mandatory").notNull().default(false),
  canGoBack: boolean("can_go_back").notNull().default(true),
  isCaseClose: boolean("is_case_close").notNull().default(false),
  countries: text("countries"),
  mappedStudentStageKey: text("mapped_student_stage_key"),
  // Task #134 — fully dynamic stage behaviors:
  // 'none' | 'admin_only' | 'staff_only' | 'staff_and_agent' | 'everyone' —
  // who can upload stage documents. 'admin_only' = admin/manager only
  // (preserves legacy admin-gated offer-stage behavior); 'staff_only' = all
  // staff roles; 'everyone' = staff + agents + students.
  uploadPermissionLevel: text("upload_permission_level").notNull().default("none"),
  // Whether documents at this stage support a `valid_until` date
  // (offer-letter expiry tracking + deadlines list + expiry notifier).
  tracksOfferExpiry: boolean("tracks_offer_expiry").notNull().default(false),
  // Whether `valid_until` is mandatory on upload (subset of tracksOfferExpiry).
  requiresValidUntil: boolean("requires_valid_until").notNull().default(false),
  // Explicit overrides for finance impact. NULL = derive from `variant`.
  // Allowed values: 'potential' | 'confirmed' | 'excluded'.
  commissionFinanceStatus: text("commission_finance_status"),
  serviceFeeFinanceStatus: text("service_fee_finance_status"),
  // When transitioning into this stage, automatically cancel sibling
  // applications for the same student.
  autoCancelSiblingsOnWon: boolean("auto_cancel_siblings_on_won").notNull().default(false),
  // Task #167 — up to 2 admin-defined action buttons per stage (application only).
  actions: jsonb("actions").$type<StageAction[]>().notNull().default([]),
  // Task #187 — when all catalog-based missing-doc requests on an
  // application have been fulfilled, the application is automatically
  // moved to this stage. NULL = no auto-advance configured.
  // Stored as a foreign-key id (not a key) to survive renames of the
  // target stage; resolved to a key at advance-time.
  missingDocsFulfilledTargetStageId: integer("missing_docs_fulfilled_target_stage_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("pipeline_stages_entity_key_uniq").on(table.entityType, table.key),
]);

export type PipelineStage = typeof pipelineStagesTable.$inferSelect;
export type InsertPipelineStage = typeof pipelineStagesTable.$inferInsert;
