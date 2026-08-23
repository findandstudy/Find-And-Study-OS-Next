import { pgTable, serial, text, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const leadAssignmentRulesTable = pgTable("lead_assignment_rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  priority: integer("priority").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  countries: jsonb("countries").$type<string[]>().notNull().default([]),
  universityIds: jsonb("university_ids").$type<number[]>().notNull().default([]),
  cities: jsonb("cities").$type<string[]>().notNull().default([]),
  phoneCodes: jsonb("phone_codes").$type<string[]>().notNull().default([]),
  sources: jsonb("sources").$type<string[]>().notNull().default([]),
  staffUserIds: jsonb("staff_user_ids").$type<number[]>().notNull().default([]),
  strategy: text("strategy").notNull().default("first"),
  lastAssignedIndex: integer("last_assigned_index").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type LeadAssignmentRule = typeof leadAssignmentRulesTable.$inferSelect;
export type InsertLeadAssignmentRule = typeof leadAssignmentRulesTable.$inferInsert;
