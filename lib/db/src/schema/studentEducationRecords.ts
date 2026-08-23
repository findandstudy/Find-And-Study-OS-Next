import { pgTable, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { isNull } from "drizzle-orm";
import { studentsTable } from "./students";

export const studentEducationRecordsTable = pgTable("student_education_records", {
  id: serial("id").primaryKey(),
  studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "cascade" }),
  level: text("level").notNull(), // "high_school" | "bachelor" | "master"
  institution: text("institution"),
  program: text("program"),
  graduationYear: integer("graduation_year"),
  gpa: text("gpa"), // normalized percent string, e.g. "87"
  gpaRaw: text("gpa_raw"), // original value as extracted/entered
  gpaScale: integer("gpa_scale"),
  languageScore: text("language_score"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
}, (table) => [
  index("student_education_records_student_id_idx").on(table.studentId),
  uniqueIndex("student_education_records_student_level_uniq")
    .on(table.studentId, table.level)
    .where(isNull(table.deletedAt)),
]);

export const insertStudentEducationRecordSchema = createInsertSchema(studentEducationRecordsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

export type StudentEducationRecord = typeof studentEducationRecordsTable.$inferSelect;
export type InsertStudentEducationRecord = typeof studentEducationRecordsTable.$inferInsert;
