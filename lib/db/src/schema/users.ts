import { pgTable, text, serial, timestamp, boolean, integer, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  replitId: text("replit_id").unique(),
  email: text("email").unique(),
  firstName: text("first_name").default(""),
  lastName: text("last_name").default(""),
  role: text("role").notNull().default("staff"),
  avatarUrl: text("avatar_url"),
  phone: text("phone"),
  phoneE164: text("phone_e164"),
  passwordHash: text("password_hash"),
  language: text("language").notNull().default("en"),
  isActive: boolean("is_active").notNull().default(true),
  emailVerified: boolean("email_verified").notNull().default(false),
  startDate: text("start_date"),
  homeAddress: text("home_address"),
  passportNumber: text("passport_number"),
  contractUrl: text("contract_url"),
  passportUrl: text("passport_url"),
  emergencyContactName: text("emergency_contact_name"),
  emergencyContactPhone: text("emergency_contact_phone"),
  locationCountry: text("location_country"),
  locationCity: text("location_city"),
  timezone: text("timezone"),
  passwordResetToken: text("password_reset_token"),
  passwordResetExpires: timestamp("password_reset_expires", { withTimezone: true }),
  emailVerificationToken: text("email_verification_token"),
  createdFromSource: text("created_from_source"),
  managingAgentId: integer("managing_agent_id"),
  academyAccess: boolean("academy_access"),
  agentStaffPermissions: jsonb("agent_staff_permissions"),
  permissionOverrides: jsonb("permission_overrides"),
  branchId: integer("branch_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: integer("deleted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("users_role_idx").on(table.role),
  index("users_managing_agent_id_idx").on(table.managingAgentId),
  index("users_phone_e164_idx").on(table.phoneE164),
]);

export const emailVerificationCodesTable = pgTable("email_verification_codes", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  code: text("code").notNull(),
  // Optional URL-safe one-time onboarding token. When present, the email link
  // can verify without exposing the 6-digit code in the URL. Nullable so
  // existing flows that only need the manual 6-digit code keep working.
  token: text("token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("email_verification_codes_token_idx").on(table.token),
]);

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
