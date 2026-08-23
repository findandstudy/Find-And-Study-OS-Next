import { pgTable, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";

export const educationRecordsTable = pgTable("education_records", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").notNull(),
  level: text("level").notNull(),
  schoolName: text("school_name"),
  country: text("country"),
  fieldOfStudy: text("field_of_study"),
  startMonth: text("start_month"),
  startYear: integer("start_year"),
  endMonth: text("end_month"),
  endYear: integer("end_year"),
  city: text("city"),
  languageScore: text("language_score"),
  gpa: text("gpa"),
  gpaType: text("gpa_type"),
  source: text("source").notNull().default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("education_records_student_id_idx").on(table.studentId),
  uniqueIndex("education_records_student_level_uniq").on(table.studentId, table.level),
]);

export type EducationRecord = typeof educationRecordsTable.$inferSelect;
export type InsertEducationRecord = typeof educationRecordsTable.$inferInsert;
