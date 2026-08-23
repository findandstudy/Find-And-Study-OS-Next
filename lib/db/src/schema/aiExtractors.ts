import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export type ExtractorFieldType =
  | "string"
  | "number"
  | "date"
  | "boolean"
  | "enum";

export interface ExtractorFieldDef {
  key: string;
  label: string;
  description?: string;
  type: ExtractorFieldType;
  required?: boolean;
  enumValues?: string[];
  normalize?: "gpa100" | "dateYmd" | "none";
  format?: string;
  labelByLang?: Record<string, string>;
}

export interface ExtractorRules {
  globalRules?: string[];
  perDocType?: Record<string, string[]>;
}

export const aiExtractorsTable = pgTable(
  "ai_extractors",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    provider: text("provider").notNull().default("anthropic"),
    model: text("model").notNull().default("claude-sonnet-4-6"),
    systemPrompt: text("system_prompt").notNull().default(""),
    systemPromptByLang: jsonb("system_prompt_by_lang")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    fields: jsonb("fields").$type<ExtractorFieldDef[]>().notNull().default([]),
    rules: jsonb("rules").$type<ExtractorRules>().notNull().default({}),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    documentTypes: jsonb("document_types")
      .$type<string[]>()
      .notNull()
      .default([]),
    temperature: numeric("temperature", { precision: 4, scale: 2 })
      .notNull()
      .default("0.20"),
    maxTokens: integer("max_tokens").notNull().default(4096),
    isActive: boolean("is_active").notNull().default(true),
    isDefault: boolean("is_default").notNull().default(false),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    unique("ai_extractors_slug_key").on(t.slug),
    index("ai_extractors_active_idx").on(t.isActive),
    index("ai_extractors_default_idx").on(t.isDefault),
  ],
);

export const aiExtractorRunsTable = pgTable(
  "ai_extractor_runs",
  {
    id: serial("id").primaryKey(),
    extractorId: integer("extractor_id")
      .notNull()
      .references(() => aiExtractorsTable.id, { onDelete: "cascade" }),
    scope: text("scope"),
    documentCount: integer("document_count").notNull().default(0),
    documentTypes: jsonb("document_types")
      .$type<string[]>()
      .notNull()
      .default([]),
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull(),
    errorMessage: text("error_message"),
    extractedPayload: jsonb("extracted_payload"),
    triggeredBy: integer("triggered_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_extractor_runs_extractor_idx").on(t.extractorId),
    index("ai_extractor_runs_created_idx").on(t.createdAt),
  ],
);

export type AiExtractor = typeof aiExtractorsTable.$inferSelect;
export type InsertAiExtractor = typeof aiExtractorsTable.$inferInsert;
export type AiExtractorRun = typeof aiExtractorRunsTable.$inferSelect;
