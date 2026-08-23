import { pgTable, text, serial, timestamp, integer, numeric, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { studentsTable } from "./students";
import { applicationsTable } from "./applications";
import { agentsTable } from "./agents";
import { usersTable } from "./users";

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  invoiceNumber: text("invoice_number").notNull().unique(),
  studentId: integer("student_id").notNull().references(() => studentsTable.id, { onDelete: "restrict" }),
  applicationId: integer("application_id").references(() => applicationsTable.id, { onDelete: "set null" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull().default("draft"),
  dueDate: timestamp("due_date", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("invoices_student_id_idx").on(table.studentId),
  index("invoices_application_id_idx").on(table.applicationId),
  index("invoices_status_idx").on(table.status),
]);

export const commissionsTable = pgTable("commissions", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id").references(() => applicationsTable.id, { onDelete: "set null" }),
  studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
  agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),

  studentName: text("student_name"),
  universityName: text("university_name"),
  programName: text("program_name"),
  isStateUniversity: boolean("is_state_university").default(false),

  season: text("season").notNull().default("2026"),
  currency: text("currency").notNull().default("USD"),

  programFee: numeric("program_fee", { precision: 12, scale: 2 }),

  universityCommissionRate: numeric("university_commission_rate", { precision: 5, scale: 2 }),
  universityCommissionAmount: numeric("university_commission_amount", { precision: 12, scale: 2 }),
  universityCollected: numeric("university_collected", { precision: 12, scale: 2 }).default("0"),

  agentCommissionRate: numeric("agent_commission_rate", { precision: 5, scale: 2 }),
  agentCommissionAmount: numeric("agent_commission_amount", { precision: 12, scale: 2 }),
  agentPaid: numeric("agent_paid", { precision: 12, scale: 2 }).default("0"),

  subAgentId: integer("sub_agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  subAgentCommissionRate: numeric("sub_agent_commission_rate", { precision: 5, scale: 2 }),
  subAgentCommissionAmount: numeric("sub_agent_commission_amount", { precision: 12, scale: 2 }),
  subAgentPaid: numeric("sub_agent_paid", { precision: 12, scale: 2 }).default("0"),

  staffUserId: integer("staff_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  staffCommissionAmount: numeric("staff_commission_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  staffCommissionCurrency: text("staff_commission_currency"),

  status: text("status").notNull().default("potential"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),

  offsetAmount: numeric("offset_amount", { precision: 12, scale: 2 }).default("0"),

  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("commissions_application_id_idx").on(table.applicationId),
  index("commissions_agent_id_idx").on(table.agentId),
  index("commissions_season_idx").on(table.season),
  index("commissions_status_idx").on(table.status),
]);

export const serviceFeesTable = pgTable("service_fees", {
  id: serial("id").primaryKey(),
  applicationId: integer("application_id").references(() => applicationsTable.id, { onDelete: "set null" }),
  studentId: integer("student_id").references(() => studentsTable.id, { onDelete: "set null" }),
  agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),

  studentName: text("student_name"),
  universityName: text("university_name"),
  isStateUniversity: boolean("is_state_university").default(false),

  payerType: text("payer_type").notNull().default("student"),
  season: text("season").notNull().default("2026"),
  currency: text("currency").notNull().default("USD"),

  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull(),

  firstInstallmentAmount: numeric("first_installment_amount", { precision: 12, scale: 2 }),
  firstInstallmentPaidAt: timestamp("first_installment_paid_at", { withTimezone: true }),

  secondInstallmentAmount: numeric("second_installment_amount", { precision: 12, scale: 2 }),
  secondInstallmentPaidAt: timestamp("second_installment_paid_at", { withTimezone: true }),

  financeStatus: text("finance_status").notNull().default("potential"),
  status: text("status").notNull().default("pending"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("service_fees_application_id_idx").on(table.applicationId),
  index("service_fees_agent_id_idx").on(table.agentId),
  index("service_fees_season_idx").on(table.season),
  index("service_fees_status_idx").on(table.status),
]);

export const financialTransactionsTable = pgTable("financial_transactions", {
  id: serial("id").primaryKey(),
  commissionId: integer("commission_id").references(() => commissionsTable.id, { onDelete: "set null" }),
  type: text("type").notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  transactionDate: timestamp("transaction_date", { withTimezone: true }),
  reference: text("reference"),
  universityName: text("university_name"),
  agentId: integer("agent_id").references(() => agentsTable.id, { onDelete: "set null" }),
  agentName: text("agent_name"),
  studentName: text("student_name"),
  fileUrl: text("file_url"),
  fileName: text("file_name"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("fin_tx_commission_id_idx").on(table.commissionId),
  index("fin_tx_agent_id_idx").on(table.agentId),
  index("fin_tx_type_idx").on(table.type),
]);

export const staffCommissionPayoutsTable = pgTable("staff_commission_payouts", {
  id: serial("id").primaryKey(),
  commissionId: integer("commission_id").references(() => commissionsTable.id, { onDelete: "set null" }),
  staffUserId: integer("staff_user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  reference: text("reference"),
  attachmentUrl: text("attachment_url"),
  notes: text("notes"),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;

export const insertCommissionSchema = createInsertSchema(commissionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCommission = z.infer<typeof insertCommissionSchema>;
export type Commission = typeof commissionsTable.$inferSelect;

export const insertServiceFeeSchema = createInsertSchema(serviceFeesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertServiceFee = z.infer<typeof insertServiceFeeSchema>;
export type ServiceFee = typeof serviceFeesTable.$inferSelect;

export const insertFinancialTransactionSchema = createInsertSchema(financialTransactionsTable).omit({ id: true, createdAt: true });
export type InsertFinancialTransaction = z.infer<typeof insertFinancialTransactionSchema>;
export type FinancialTransaction = typeof financialTransactionsTable.$inferSelect;

export const insertStaffCommissionPayoutSchema = createInsertSchema(staffCommissionPayoutsTable).omit({ id: true, createdAt: true, deletedAt: true });
export type InsertStaffCommissionPayout = z.infer<typeof insertStaffCommissionPayoutSchema>;
export type StaffCommissionPayout = typeof staffCommissionPayoutsTable.$inferSelect;
