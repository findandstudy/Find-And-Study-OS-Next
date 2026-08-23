import { pgTable, text, serial, timestamp, integer, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";
import { agentsTable } from "./agents";

export const studentsTable = pgTable("students", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  phoneE164: text("phone_e164"),
  dateOfBirth: text("date_of_birth"),
  gender: text("gender"),
  nationality: text("nationality"),
  passportNumber: text("passport_number"),
  passportIssueDate: text("passport_issue_date"),
  passportExpiry: text("passport_expiry"),
  motherName: text("mother_name"),
  fatherName: text("father_name"),
  address: text("address"),
  cityOfBirth: text("city_of_birth"),
  addressCity: text("address_city"),
  postalCode: text("postal_code"),
  needsVisaSupport: boolean("needs_visa_support"),
  status: text("status").notNull().default("active"),
  agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  assignedToId: integer("assigned_to_id").references(() => usersTable.id, { onDelete: "set null" }),
  branchId: integer("branch_id"),
  highSchool: text("high_school"),
  universityBachelor: text("university_bachelor"),
  universityMaster: text("university_master"),
  graduationYear: integer("graduation_year"),
  gpa: text("gpa"),
  languageScore: text("language_score"),
  season: text("season").notNull().default("2026"),
  photoUrl: text("photo_url"),
  hasPhoto: boolean("has_photo").notNull().default(false),
  interestedLevel: text("interested_level"),
  // SIT "Student Information" toggles (asked at Review & Submit; stored on profile)
  transferStudent: boolean("transfer_student").notNull().default(false),
  hasTcId: boolean("has_tc_id").notNull().default(false),
  hasBlueCard: boolean("has_blue_card").notNull().default(false),
  notes: text("notes"),
  nextFollowup: timestamp("next_followup", { withTimezone: true }),
  originType: text("origin_type").notNull().default("direct"),
  originEntityType: text("origin_entity_type"),
  originEntityId: integer("origin_entity_id"),
  originDisplayName: text("origin_display_name"),
  originLocked: boolean("origin_locked").notNull().default(false),
  originLeadId: integer("origin_lead_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: integer("deleted_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("students_email_idx").on(table.email),
  index("students_agent_id_idx").on(table.agentId),
  index("students_assigned_to_id_idx").on(table.assignedToId),
  index("students_status_idx").on(table.status),
  index("students_season_idx").on(table.season),
  index("students_user_id_idx").on(table.userId),
  index("students_origin_type_idx").on(table.originType),
  index("students_phone_e164_idx").on(table.phoneE164),
  index("students_staff_scope_idx")
    .on(table.branchId, table.assignedToId, table.createdAt)
    .where(sql`${table.deletedAt} IS NULL`),
]);

export const insertStudentSchema = createInsertSchema(studentsTable).omit({ id: true, createdAt: true, updatedAt: true, deletedAt: true });
export type InsertStudent = z.infer<typeof insertStudentSchema>;
export type Student = typeof studentsTable.$inferSelect;
