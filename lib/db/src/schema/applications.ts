import { pgTable, text, serial, timestamp, integer, real, boolean, index, type AnyPgColumn } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import { studentsTable } from "./students";
import { programsTable, universitiesTable } from "./universities";
import { agentsTable } from "./agents";
import { usersTable } from "./users";
import { leadsTable } from "./leads";

export const applicationsTable = pgTable("applications", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
  leadId: integer("lead_id").references(() => leadsTable.id, { onDelete: "set null" }),
  programId: integer("program_id").references(() => programsTable.id, { onDelete: "set null" }),
  universityId: integer("university_id").references(() => universitiesTable.id, { onDelete: "set null" }),
  agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  season: text("season").notNull().default("2026"),
  stage: text("stage").notNull().default("inquiry"),
  intake: text("intake"),
  level: text("level"),
  instructionLanguage: text("instruction_language"),
  deadline: text("deadline"),
  programName: text("program_name"),
  universityName: text("university_name"),
  // Canonical portal-assigned application identifier. Per-run evidence remains
  // in portal_submissions.external_ref; this value is the current staff-facing
  // identifier and can be corrected without rewriting submission history.
  universityApplicationId: text("university_application_id"),
  country: text("country"),
  tuitionFee: real("tuition_fee"),
  discountedFee: real("discounted_fee"),
  scholarship: real("scholarship"),
  commissionRate: real("commission_rate"),
  serviceFeeAmount: real("service_fee_amount"),
  applicationFee: real("application_fee"),
  depositFee: real("deposit_fee"),
  advancedFee: real("advanced_fee"),
  languageFee: real("language_fee"),
  currency: text("currency").default("USD"),
  notes: text("notes"),
  campaignId: integer("campaign_id"),
  campaignName: text("campaign_name"),
  campaignType: text("campaign_type"),
  campaignPercent: real("campaign_percent"),
  originType: text("origin_type").notNull().default("direct"),
  originEntityType: text("origin_entity_type"),
  originEntityId: integer("origin_entity_id"),
  originDisplayName: text("origin_display_name"),
  originLocked: boolean("origin_locked").notNull().default(false),
  originStudentId: integer("origin_student_id"),
  branchId: integer("branch_id"),
  // WHO created this application, for the 3-group split on the student profile
  // (student self-service / staff-admin panel / portal-automation fan-out).
  // Distinct from originType (acquisition channel: direct/agent/sub_agent).
  // Nullable; null is treated as "student" (safe default) by the UI.
  createdSource: text("created_source"),
  // Automatic backup-programme (supersession) links. When a full programme is
  // superseded by an auto-created fallback application, the original points to
  // the new one (superseded_by) and the new one points back (superseded_from).
  supersededByApplicationId: integer("superseded_by_application_id").references(
    (): AnyPgColumn => applicationsTable.id,
    { onDelete: "set null" },
  ),
  supersededFromApplicationId: integer(
    "superseded_from_application_id",
  ).references((): AnyPgColumn => applicationsTable.id, {
    onDelete: "set null",
  }),
  supersedeReason: text("supersede_reason"),
  // Root/main application of an automatic fallback chain. Set on portal-automation
  // fan-out children AND supersession children so any hop can recover the
  // originally-applied programme + language + level and detect same-uni (X) vs
  // different-uni (Y). Nullable; null means THIS row is (or is treated as) the
  // main application (legacy chains fall back to walking superseded_from).
  mainApplicationId: integer("main_application_id").references(
    (): AnyPgColumn => applicationsTable.id,
    { onDelete: "set null" },
  ),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: integer("deleted_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("applications_student_id_idx").on(table.studentId),
  index("applications_lead_id_idx").on(table.leadId),
  index("applications_program_id_idx").on(table.programId),
  index("applications_university_id_idx").on(table.universityId),
  index("applications_agent_id_idx").on(table.agentId),
  index("applications_assigned_to_id_idx").on(table.assignedToId),
  index("applications_stage_idx").on(table.stage),
  index("applications_season_idx").on(table.season),
  index("applications_origin_type_idx").on(table.originType),
  index("applications_main_application_id_idx").on(table.mainApplicationId),
  index("applications_staff_scope_idx")
    .on(table.branchId, table.assignedToId, table.createdAt)
    .where(sql`${table.deletedAt} IS NULL`),
]);

export const insertApplicationSchema = createInsertSchema(applicationsTable).omit({ id: true, createdAt: true, updatedAt: true, deletedAt: true });
export type InsertApplication = z.infer<typeof insertApplicationSchema>;
export type Application = typeof applicationsTable.$inferSelect;
