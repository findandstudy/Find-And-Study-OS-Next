import { pgTable, text, serial, timestamp, integer, index, boolean, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  resourceId: integer("resource_id"),
  changes: text("changes"),
  ipAddress: text("ip_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("audit_logs_user_id_idx").on(table.userId),
  index("audit_logs_action_idx").on(table.action),
  index("audit_logs_created_at_idx").on(table.createdAt),
  index("audit_logs_resource_idx").on(table.resource, table.resourceId),
]);

// Records lifecycle changes made by application-stage automation.  This is
// deliberately separate from the append-only audit log: reconciliation needs
// a synchronous, transactionally-written marker before it may restore a parent
// status.  Manually-set LOST statuses have no marker and are never guessed.
export const lifecycleCascadeStateTable = pgTable("lifecycle_cascade_state", {
  id: serial("id").primaryKey(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  previousStatus: text("previous_status").notNull(),
  cascadedStatus: text("cascaded_status").notNull(),
  sourceApplicationId: integer("source_application_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("lifecycle_cascade_state_entity_idx").on(table.entityType, table.entityId),
  index("lifecycle_cascade_state_source_app_idx").on(table.sourceApplicationId),
]);

export const notesTable = pgTable("notes", {
  id: serial("id").primaryKey(),
  content: text("content").notNull(),
  authorId: integer("author_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  resourceType: text("resource_type").notNull(),
  resourceId: integer("resource_id").notNull(),
  isInternal: boolean("is_internal").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("notes_author_id_idx").on(table.authorId),
  index("notes_resource_idx").on(table.resourceType, table.resourceId),
]);

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({ id: true, createdAt: true });
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;

export const insertNoteSchema = createInsertSchema(notesTable).omit({ id: true, createdAt: true });
export type InsertNote = z.infer<typeof insertNoteSchema>;
export type Note = typeof notesTable.$inferSelect;
