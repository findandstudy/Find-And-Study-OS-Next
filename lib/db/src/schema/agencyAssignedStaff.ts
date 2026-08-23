import { pgTable, serial, integer, boolean, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { agentsTable } from "./agents";
import { usersTable } from "./users";

export const agencyAssignedStaffTable = pgTable("agency_assigned_staff", {
  id: serial("id").primaryKey(),
  agentId: integer("agent_id").notNull().references(() => agentsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("agency_assigned_staff_agent_user_idx").on(table.agentId, table.userId),
  index("agency_assigned_staff_agent_idx").on(table.agentId),
  index("agency_assigned_staff_user_idx").on(table.userId),
]);

export type AgencyAssignedStaff = typeof agencyAssignedStaffTable.$inferSelect;
