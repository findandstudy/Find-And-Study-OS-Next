import { pgTable, text, serial, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Company Contracts mirror University Contracts but the counterparty is an
// external company rather than a university. There is no dedicated "company"
// master entity in this system, so the company identity is stored directly on
// the contract record: `companyName` (required) and an optional free-text
// `country`. Everything else — validity dates, uploaded file, expiry-warning
// bookkeeping columns and assigned staff — mirrors university_contracts.
export const companyContractsTable = pgTable("company_contracts", {
  id: serial("id").primaryKey(),
  companyName: text("company_name").notNull(),
  country: text("country"),
  year: integer("year"),
  effectiveDate: timestamp("effective_date", { withTimezone: true }),
  expiryDate: timestamp("expiry_date", { withTimezone: true }),
  fileObjectKey: text("file_object_key"),
  fileName: text("file_name"),
  fileMime: text("file_mime"),
  fileSize: integer("file_size"),
  notes: text("notes"),
  lastWarning30SentAt: timestamp("last_warning_30_sent_at", { withTimezone: true }),
  lastWarning14SentAt: timestamp("last_warning_14_sent_at", { withTimezone: true }),
  lastWarning7SentAt: timestamp("last_warning_7_sent_at", { withTimezone: true }),
  lastWarning1SentAt: timestamp("last_warning_1_sent_at", { withTimezone: true }),
  expiryNoticeSentAt: timestamp("expiry_notice_sent_at", { withTimezone: true }),
  uploadedByUserId: integer("uploaded_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  // User IDs of staff explicitly assigned to this contract — they receive
  // expiry warnings in addition to active admins.
  assignedUserIds: jsonb("assigned_user_ids").notNull().default([]).$type<number[]>(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("company_contracts_company_name_idx").on(table.companyName),
  index("company_contracts_country_idx").on(table.country),
  index("company_contracts_expiry_date_idx").on(table.expiryDate),
  index("company_contracts_deleted_at_idx").on(table.deletedAt),
]);

export const insertCompanyContractSchema = createInsertSchema(companyContractsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCompanyContract = z.infer<typeof insertCompanyContractSchema>;
export type CompanyContract = typeof companyContractsTable.$inferSelect;

export type CompanyContractStatus = "active" | "expiring_soon" | "expired" | "no_dates";

export function getCompanyContractStatus(expiryDate: Date | string | null | undefined, now: Date = new Date()): CompanyContractStatus {
  if (!expiryDate) return "no_dates";
  const expiry = expiryDate instanceof Date ? expiryDate : new Date(expiryDate);
  if (isNaN(expiry.getTime())) return "no_dates";
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / msPerDay);
  if (daysLeft <= 0) return "expired";
  if (daysLeft <= 30) return "expiring_soon";
  return "active";
}
