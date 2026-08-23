import { pgTable, text, serial, timestamp, integer, numeric, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { agentsTable } from "./agents";
import { studentsTable } from "./students";
import { applicationsTable } from "./applications";

export const staffWorkSchedulesTable = pgTable("staff_work_schedules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  weekday: integer("weekday").notNull(),
  startMinutes: integer("start_minutes").notNull(),
  endMinutes: integer("end_minutes").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("staff_work_schedules_user_weekday_start_idx").on(table.userId, table.weekday, table.startMinutes),
  index("staff_work_schedules_user_idx").on(table.userId),
  index("staff_work_schedules_user_weekday_idx").on(table.userId, table.weekday),
]);

export const staffLanguagesTable = pgTable("staff_languages", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  language: text("language").notNull(),
  proficiency: text("proficiency"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("staff_languages_user_lang_idx").on(table.userId, table.language),
  index("staff_languages_user_idx").on(table.userId),
]);

export const staffCountriesTable = pgTable("staff_countries", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  country: text("country").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("staff_countries_user_country_idx").on(table.userId, table.country),
  index("staff_countries_user_idx").on(table.userId),
]);

export const staffDocumentsTable = pgTable("staff_documents", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  docType: text("doc_type").notNull(),
  filename: text("filename").notNull(),
  objectPath: text("object_path").notNull(),
  sizeBytes: integer("size_bytes").notNull().default(0),
  mimeType: text("mime_type").notNull().default("application/octet-stream"),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("staff_documents_user_idx").on(table.userId),
  index("staff_documents_doc_type_idx").on(table.docType),
]);

export const staffSalaryPaymentsTable = pgTable("staff_salary_payments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  period: text("period").notNull().default("monthly"),
  payDate: timestamp("pay_date", { withTimezone: true }),
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("staff_salary_payments_user_idx").on(table.userId),
  index("staff_salary_payments_status_idx").on(table.status),
  index("staff_salary_payments_pay_date_idx").on(table.payDate),
]);

export const staffCommissionsTable = pgTable("staff_commissions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
  agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  applicationId: integer("application_id").references(() => applicationsTable.id, { onDelete: "set null" }),
  status: text("status").notNull().default("pending"),
  payDate: timestamp("pay_date", { withTimezone: true }),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("staff_commissions_user_idx").on(table.userId),
  index("staff_commissions_status_idx").on(table.status),
  index("staff_commissions_student_idx").on(table.studentId),
  index("staff_commissions_agent_idx").on(table.agentId),
  index("staff_commissions_application_idx").on(table.applicationId),
]);

export const insertStaffWorkScheduleSchema = createInsertSchema(staffWorkSchedulesTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertStaffLanguageSchema = createInsertSchema(staffLanguagesTable).omit({ id: true, createdAt: true });
export const insertStaffCountrySchema = createInsertSchema(staffCountriesTable).omit({ id: true, createdAt: true });
export const insertStaffDocumentSchema = createInsertSchema(staffDocumentsTable).omit({ id: true, uploadedAt: true, deletedAt: true });
export const insertStaffSalaryPaymentSchema = createInsertSchema(staffSalaryPaymentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertStaffCommissionSchema = createInsertSchema(staffCommissionsTable).omit({ id: true, createdAt: true, updatedAt: true });

export type StaffWorkSchedule = typeof staffWorkSchedulesTable.$inferSelect;
export type StaffLanguage = typeof staffLanguagesTable.$inferSelect;
export type StaffCountry = typeof staffCountriesTable.$inferSelect;
export type StaffDocument = typeof staffDocumentsTable.$inferSelect;
export type StaffSalaryPayment = typeof staffSalaryPaymentsTable.$inferSelect;
export type StaffCommission = typeof staffCommissionsTable.$inferSelect;

export const STAFF_DOC_TYPES = ["contract", "diploma", "passport"] as const;
export type StaffDocType = typeof STAFF_DOC_TYPES[number];

export const STAFF_DOC_RULES: Record<StaffDocType, { maxBytes: number; mimeTypes: string[] }> = {
  contract: {
    maxBytes: 25 * 1024 * 1024,
    mimeTypes: [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },
  diploma: {
    maxBytes: 10 * 1024 * 1024,
    mimeTypes: [
      "application/pdf",
      "image/jpeg",
      "image/png",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },
  passport: {
    maxBytes: 10 * 1024 * 1024,
    mimeTypes: ["application/pdf", "image/jpeg", "image/png"],
  },
};

export const STAFF_SALARY_STATUSES = ["pending", "paid", "cancelled"] as const;
export const STAFF_COMMISSION_STATUSES = ["potential", "pending", "approved", "paid", "cancelled"] as const;
export const STAFF_SALARY_PERIODS = ["monthly", "weekly", "biweekly", "project", "hourly"] as const;
