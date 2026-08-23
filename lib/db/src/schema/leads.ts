import { pgTable, text, serial, timestamp, integer, numeric, boolean, index, jsonb } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { agentsTable } from "./agents";
import { studentsTable } from "./students";

export const leadsTable = pgTable("leads", {
  id: serial("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  phoneE164: text("phone_e164"),
  nationality: text("nationality"),
  country: text("country"),
  source: text("source"),
  contactType: text("contact_type").notNull().default("student"),
  status: text("status").notNull().default("new"),
  season: text("season").notNull().default("2026"),
  agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  interestedProgram: text("interested_program"),
  interestedUniversity: text("interested_university"),
  interestedCountry: text("interested_country"),
  interestedLevel: text("interested_level"),
  preferredLanguage: text("preferred_language"),
  motherName: text("mother_name"),
  fatherName: text("father_name"),
  notes: text("notes"),
  estimatedValue: numeric("estimated_value", { precision: 12, scale: 2 }),
  convertedStudentId: integer("converted_student_id").references(() => studentsTable.id, { onDelete: "set null" }),
  originType: text("origin_type").notNull().default("direct"),
  originEntityType: text("origin_entity_type"),
  originEntityId: integer("origin_entity_id"),
  originDisplayName: text("origin_display_name"),
  originLocked: boolean("origin_locked").notNull().default(false),
  educationData: jsonb("education_data"),
  branchId: integer("branch_id"),
  sourcePageUrl: text("source_page_url"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmTerm: text("utm_term"),
  utmContent: text("utm_content"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: integer("deleted_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("leads_agent_id_idx").on(table.agentId),
  index("leads_assigned_to_id_idx").on(table.assignedToId),
  index("leads_status_idx").on(table.status),
  index("leads_season_idx").on(table.season),
  index("leads_origin_type_idx").on(table.originType),
  index("leads_contact_type_idx").on(table.contactType),
  index("leads_phone_e164_idx").on(table.phoneE164),
  index("leads_staff_scope_idx")
    .on(table.branchId, table.assignedToId, table.createdAt)
    .where(sql`${table.deletedAt} IS NULL`),
  // NOTE: Partial unique indexes for public-lead dedup are managed by
  // `artifacts/api-server/scripts/cleanup-{embed,public-lead}-duplicates.ts`
  // (run from post-merge.sh) because drizzle-kit cannot express the
  // `WHERE source ILIKE 'embed:%'` etc. predicates portably. The
  // installed indexes are:
  //   - leads_embed_email_source_uniq        (lower(email), source) WHERE source ILIKE 'embed:%'
  //   - leads_website_email_source_uniq      (lower(email), source) WHERE source = 'website'
  //   - leads_webform_email_agent_uniq       (lower(email), agent_id) WHERE source='web_form' AND agent_id IS NOT NULL
  //   - leads_webform_email_uniq             (lower(email))         WHERE source='web_form' AND agent_id IS NULL
  //   - leads_websiteform_email_source_uniq  (lower(email), source) WHERE source LIKE 'website-form:%'
]);

export const followUpsTable = pgTable("follow_ups", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id").references(() => leadsTable.id, { onDelete: "set null" }),
  studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
  resourceType: text("resource_type").notNull().default("lead"),
  title: text("title").notNull(),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  notes: text("notes"),
  notifiedAt: timestamp("notified_at", { withTimezone: true }),
  createdById: integer("created_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  updatedById: integer("updated_by_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("follow_ups_lead_id_idx").on(table.leadId),
  index("follow_ups_student_id_idx").on(table.studentId),
  index("follow_ups_assigned_to_id_idx").on(table.assignedToId),
  index("follow_ups_created_by_id_idx").on(table.createdById),
  index("follow_ups_updated_by_id_idx").on(table.updatedById),
]);

export const insertLeadSchema = createInsertSchema(leadsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertLead = z.infer<typeof insertLeadSchema>;
export type Lead = typeof leadsTable.$inferSelect;

export const insertFollowUpSchema = createInsertSchema(followUpsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFollowUp = z.infer<typeof insertFollowUpSchema>;
export type FollowUp = typeof followUpsTable.$inferSelect;
