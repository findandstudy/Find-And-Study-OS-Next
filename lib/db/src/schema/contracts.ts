import { pgTable, text, serial, timestamp, integer, boolean, index, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const contractBrandProfilesTable = pgTable("contract_brand_profiles", {
  id: serial("id").primaryKey(),
  key: text("key").notNull(),
  name: text("name").notNull(),
  config: jsonb("config").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  updatedByUserId: integer("updated_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("contract_brand_profiles_key_unique").on(table.key),
  index("contract_brand_profiles_active_idx").on(table.isActive),
]);

export const contractTemplatesTable = pgTable("contract_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  title: text("title").notNull().default(""),
  language: text("language").notNull().default("en"),
  entityType: text("entity_type").notNull().default("company"),
  version: integer("version").notNull().default(1),
  bodyHtml: text("body_html").notNull().default(""),
  intakeSchema: jsonb("intake_schema"),
  signingPageConfig: jsonb("signing_page_config"),
  brandProfileId: integer("brand_profile_id").references(() => contractBrandProfilesTable.id, { onDelete: "set null" }),
  publicationStatus: text("publication_status").notNull().default("published"),
  supersedesTemplateId: integer("supersedes_template_id"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedByUserId: integer("reviewed_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedByUserId: integer("published_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("contract_templates_language_idx").on(table.language),
  index("contract_templates_entity_type_idx").on(table.entityType),
  index("contract_templates_active_idx").on(table.isActive),
  index("contract_templates_publication_status_idx").on(table.publicationStatus),
  index("contract_templates_brand_profile_idx").on(table.brandProfileId),
]);

export const signingSessionsTable = pgTable("signing_sessions", {
  id: serial("id").primaryKey(),
  templateId: integer("template_id").notNull(),
  agentId: integer("agent_id"),
  tokenHash: text("token_hash").notNull(),
  mode: text("mode").notNull().default("admin_driven"),
  status: text("status").notNull().default("review_pending"),
  intakeData: jsonb("intake_data"),
  signerEmail: text("signer_email").notNull(),
  expectedEmail: text("expected_email"),
  verifiedEmail: text("verified_email"),
  signerName: text("signer_name"),
  templateVersionSnapshot: integer("template_version_snapshot"),
  templateNameSnapshot: text("template_name_snapshot"),
  templateLanguageSnapshot: text("template_language_snapshot"),
  templateEntityTypeSnapshot: text("template_entity_type_snapshot"),
  templateBodyHtmlSnapshot: text("template_body_html_snapshot"),
  templateIntakeSchemaSnapshot: jsonb("template_intake_schema_snapshot"),
  templateSigningPageConfigSnapshot: jsonb("template_signing_page_config_snapshot"),
  subjectType: text("subject_type"),
  subjectId: integer("subject_id"),
  subjectLabel: text("subject_label"),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  lastReminderAt: timestamp("last_reminder_at", { withTimezone: true }),
  sendCount: integer("send_count").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdByUserId: integer("created_by_user_id").references(() => usersTable.id, { onDelete: "set null" }),
  isPrimaryOnboarding: boolean("is_primary_onboarding").notNull().default(false),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  signedAt: timestamp("signed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index("signing_sessions_token_hash_idx").on(table.tokenHash),
  index("signing_sessions_status_idx").on(table.status),
  index("signing_sessions_agent_id_idx").on(table.agentId),
  index("signing_sessions_template_id_idx").on(table.templateId),
  index("signing_sessions_subject_idx").on(table.subjectType, table.subjectId),
]);

export const signedContractsTable = pgTable("signed_contracts", {
  id: serial("id").primaryKey(),
  signingSessionId: integer("signing_session_id").notNull(),
  agentId: integer("agent_id"),
  templateId: integer("template_id").notNull(),
  pdfObjectKey: text("pdf_object_key"),
  signatureImageObjectKey: text("signature_image_object_key"),
  signatureImageBase64: text("signature_image_base64"),
  evidenceHash: text("evidence_hash"),
  signerEmail: text("signer_email").notNull(),
  signerName: text("signer_name"),
  signerIp: text("signer_ip"),
  signerUserAgent: text("signer_user_agent"),
  subjectType: text("subject_type"),
  subjectId: integer("subject_id"),
  subjectLabel: text("subject_label"),
  signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
  emailedAt: timestamp("emailed_at", { withTimezone: true }),
  deliveryClaimedAt: timestamp("delivery_claimed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("signed_contracts_session_id_unique").on(table.signingSessionId),
  index("signed_contracts_agent_id_idx").on(table.agentId),
  index("signed_contracts_template_id_idx").on(table.templateId),
  index("signed_contracts_subject_idx").on(table.subjectType, table.subjectId),
]);

export const insertContractBrandProfileSchema = createInsertSchema(contractBrandProfilesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertContractBrandProfile = z.infer<typeof insertContractBrandProfileSchema>;
export type ContractBrandProfile = typeof contractBrandProfilesTable.$inferSelect;

export const insertContractTemplateSchema = createInsertSchema(contractTemplatesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertContractTemplate = z.infer<typeof insertContractTemplateSchema>;
export type ContractTemplate = typeof contractTemplatesTable.$inferSelect;

export const insertSigningSessionSchema = createInsertSchema(signingSessionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSigningSession = z.infer<typeof insertSigningSessionSchema>;
export type SigningSession = typeof signingSessionsTable.$inferSelect;

export const insertSignedContractSchema = createInsertSchema(signedContractsTable).omit({ id: true, createdAt: true });
export type InsertSignedContract = z.infer<typeof insertSignedContractSchema>;
export type SignedContract = typeof signedContractsTable.$inferSelect;
