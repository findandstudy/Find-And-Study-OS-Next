import { pgTable, text, serial, timestamp, integer, primaryKey, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { agentsTable } from "./agents";
import { usersTable } from "./users";

export const branchesTable = pgTable("branches", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  country: text("country"),
  city: text("city"),
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  contactUserId: integer("contact_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  logoUrl: text("logo_url"),
  notes: text("notes"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("branches_name_idx").on(table.name),
  index("branches_archived_idx").on(table.archivedAt),
]);

export const agentBranchesTable = pgTable("agent_branches", {
  agentId: integer("agent_id").notNull().references(() => agentsTable.id, { onDelete: "cascade" }),
  branchId: integer("branch_id").notNull().references(() => branchesTable.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.agentId, table.branchId] }),
  index("agent_branches_branch_id_idx").on(table.branchId),
]);

export const insertBranchSchema = createInsertSchema(branchesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertBranch = z.infer<typeof insertBranchSchema>;
export type Branch = typeof branchesTable.$inferSelect;
