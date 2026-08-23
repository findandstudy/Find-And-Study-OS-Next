import { pgTable, text, serial, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { universitiesTable } from "./universities";
import { destinationsTable } from "./destinations";
import { usersTable } from "./users";

export const universityContractsTable = pgTable("university_contracts", {
  id: serial("id").primaryKey(),
  universityId: integer("university_id").notNull().references(() => universitiesTable.id, { onDelete: "cascade" }),
  destinationId: integer("destination_id").references(() => destinationsTable.id, { onDelete: "set null" }),
  country: text("country").notNull(),
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
  // User IDs of staff explicitly assigned to this contract / university —
  // they receive expiry warnings in addition to active admins.
  assignedUserIds: jsonb("assigned_user_ids").notNull().default([]).$type<number[]>(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("university_contracts_university_id_idx").on(table.universityId),
  index("university_contracts_country_idx").on(table.country),
  index("university_contracts_expiry_date_idx").on(table.expiryDate),
  index("university_contracts_deleted_at_idx").on(table.deletedAt),
]);

export const insertUniversityContractSchema = createInsertSchema(universityContractsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUniversityContract = z.infer<typeof insertUniversityContractSchema>;
export type UniversityContract = typeof universityContractsTable.$inferSelect;

export type UniversityContractStatus = "active" | "expiring_soon" | "expired" | "no_dates";

export function getUniversityContractStatus(expiryDate: Date | string | null | undefined, now: Date = new Date()): UniversityContractStatus {
  if (!expiryDate) return "no_dates";
  const expiry = expiryDate instanceof Date ? expiryDate : new Date(expiryDate);
  if (isNaN(expiry.getTime())) return "no_dates";
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysLeft = Math.ceil((expiry.getTime() - now.getTime()) / msPerDay);
  if (daysLeft <= 0) return "expired";
  if (daysLeft <= 30) return "expiring_soon";
  return "active";
}
