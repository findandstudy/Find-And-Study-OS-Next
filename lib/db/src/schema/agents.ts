import { pgTable, text, serial, timestamp, integer, real, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const agentsTable = pgTable("agents", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  parentAgentId: integer("parent_agent_id"),
  agencyCode: text("agency_code"),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email"),
  phone: text("phone"),
  phoneE164: text("phone_e164"),
  country: text("country"),
  state: text("state"),
  city: text("city"),
  address: text("address"),
  companyName: text("company_name"),
  businessName: text("business_name"),
  category: text("category"),
  commissionRate: real("commission_rate"),
  subAgentCommissionRate: real("sub_agent_commission_rate"),
  hideServiceFees: boolean("hide_service_fees").notNull().default(false),
  status: text("status").notNull().default("active"),
  logoUrl: text("logo_url"),
  agentIdProofUrl: text("agent_id_proof_url"),
  businessCertUrl: text("business_cert_url"),
  contractUrl: text("contract_url"),
  contractStartDate: timestamp("contract_start_date", { withTimezone: true }),
  contractEndDate: timestamp("contract_end_date", { withTimezone: true }),
  contractLastNotified: text("contract_last_notified"),
  entityType: text("entity_type").notNull().default("company"),
  taxNumber: text("tax_number"),
  preferredContractLanguage: text("preferred_contract_language").notNull().default("en"),
  assignedContractTemplateId: integer("assigned_contract_template_id"),
  canManageStaff: boolean("can_manage_staff").notNull().default(true),
  branch: text("branch"),
  assignedStaffId: integer("assigned_staff_id").references(() => usersTable.id, { onDelete: "set null" }),
  pointOfContact: text("point_of_contact"),
  notes: text("notes"),
  embedToken: text("embed_token"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("agents_user_id_idx").on(table.userId),
  index("agents_parent_agent_id_idx").on(table.parentAgentId),
  index("agents_status_idx").on(table.status),
  uniqueIndex("agents_embed_token_idx").on(table.embedToken),
  index("agents_phone_e164_idx").on(table.phoneE164),
]);

export const insertAgentSchema = createInsertSchema(agentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type Agent = typeof agentsTable.$inferSelect;
