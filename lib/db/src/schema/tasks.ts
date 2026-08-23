import { pgTable, serial, text, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const tasksTable = pgTable("tasks", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  assignedTo: integer("assigned_to"),
  assignedToName: text("assigned_to_name"),
  dueDate: text("due_date"),
  priority: text("priority").notNull().default("medium"),
  status: text("status").notNull().default("todo"),
  taskNotes: jsonb("task_notes"),
  createdBy: integer("created_by"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("tasks_status_idx").on(table.status),
  index("tasks_assigned_to_idx").on(table.assignedTo),
  index("tasks_archived_at_idx").on(table.archivedAt),
  index("tasks_completed_at_idx").on(table.completedAt),
]);

export type TaskNote = {
  id: string;
  text: string;
  createdAt: string;
  authorName: string;
  mentions?: number[];
};

export type Task = typeof tasksTable.$inferSelect;
export type InsertTask = typeof tasksTable.$inferInsert;
