import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  numeric,
  pgEnum,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const aiPersonaTypeEnum = pgEnum("ai_persona_type", [
  "advisor",
  "operator",
]);
export const aiPersonaProviderEnum = pgEnum("ai_persona_provider", [
  "anthropic",
  "openai",
]);
export const aiPersonaTriggerModeEnum = pgEnum("ai_persona_trigger_mode", [
  "manual",
  "scheduled",
  "event_driven",
]);
export const aiPersonaRunTriggeredByEnum = pgEnum(
  "ai_persona_run_triggered_by",
  ["manual", "cron", "event"],
);
export const aiPersonaRunStatusEnum = pgEnum("ai_persona_run_status", [
  "success",
  "error",
  "rate_limited",
  "blocked_by_cap",
]);
export const aiActionQueueStatusEnum = pgEnum("ai_action_queue_status", [
  "pending_approval",
  "approved",
  "rejected",
  "executed",
  "failed",
]);
export const aiPersonaMessageRoleEnum = pgEnum("ai_persona_message_role", [
  "user",
  "assistant",
  "tool",
]);

export const aiPersonasTable = pgTable(
  "ai_personas",
  {
    id: serial("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    personaType: aiPersonaTypeEnum("persona_type").notNull().default("advisor"),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    provider: aiPersonaProviderEnum("provider").notNull().default("anthropic"),
    model: text("model").notNull(),
    systemPrompt: text("system_prompt").notNull().default(""),
    guidelines: text("guidelines").notNull().default(""),
    negativePrompt: text("negative_prompt").notNull().default(""),
    temperature: numeric("temperature", { precision: 4, scale: 2 })
      .notNull()
      .default("0.70"),
    maxTokens: integer("max_tokens").notNull().default(2048),
    allowedDataScopes: jsonb("allowed_data_scopes").notNull().default([]),
    toolsEnabled: jsonb("tools_enabled").notNull().default([]),
    triggerMode: aiPersonaTriggerModeEnum("trigger_mode")
      .notNull()
      .default("manual"),
    scheduleCron: text("schedule_cron"),
    eventSubscriptions: jsonb("event_subscriptions"),
    outputTargets: jsonb("output_targets").notNull().default([]),
    monthlyCostCapUsd: numeric("monthly_cost_cap_usd", {
      precision: 10,
      scale: 2,
    }),
    isActive: boolean("is_active").notNull().default(false),
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
    unique("ai_personas_slug_key").on(t.slug),
    index("ai_personas_active_idx").on(t.isActive),
    index("ai_personas_type_idx").on(t.personaType),
  ],
);

export const aiPersonaRunsTable = pgTable(
  "ai_persona_runs",
  {
    id: serial("id").primaryKey(),
    personaId: integer("persona_id")
      .notNull()
      .references(() => aiPersonasTable.id, { onDelete: "cascade" }),
    triggeredBy: aiPersonaRunTriggeredByEnum("triggered_by")
      .notNull()
      .default("manual"),
    triggerActor: integer("trigger_actor").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    inputPayload: jsonb("input_payload"),
    outputPayload: jsonb("output_payload"),
    model: text("model"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 6 }),
    latencyMs: integer("latency_ms"),
    status: aiPersonaRunStatusEnum("status").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_persona_runs_persona_idx").on(t.personaId),
    index("ai_persona_runs_created_idx").on(t.createdAt),
    index("ai_persona_runs_status_idx").on(t.status),
  ],
);

export const aiActionQueueTable = pgTable(
  "ai_action_queue",
  {
    id: serial("id").primaryKey(),
    personaId: integer("persona_id")
      .notNull()
      .references(() => aiPersonasTable.id, { onDelete: "cascade" }),
    runId: integer("run_id").references(() => aiPersonaRunsTable.id, {
      onDelete: "set null",
    }),
    actionType: text("action_type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    preview: text("preview"),
    status: aiActionQueueStatusEnum("status")
      .notNull()
      .default("pending_approval"),
    reviewedBy: integer("reviewed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    executedAt: timestamp("executed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_action_queue_status_idx").on(t.status),
    index("ai_action_queue_persona_idx").on(t.personaId),
  ],
);

export const aiPersonaMessagesTable = pgTable(
  "ai_persona_messages",
  {
    id: serial("id").primaryKey(),
    personaId: integer("persona_id")
      .notNull()
      .references(() => aiPersonasTable.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id").notNull(),
    role: aiPersonaMessageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    toolCalls: jsonb("tool_calls"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("ai_persona_messages_conv_idx").on(t.conversationId),
    index("ai_persona_messages_persona_idx").on(t.personaId),
  ],
);

export type AiPersona = typeof aiPersonasTable.$inferSelect;
export type InsertAiPersona = typeof aiPersonasTable.$inferInsert;
export type AiPersonaRun = typeof aiPersonaRunsTable.$inferSelect;
export type AiActionQueueItem = typeof aiActionQueueTable.$inferSelect;

export const aiDefaultConfigsTable = pgTable("ai_default_configs", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().$type<unknown>(),
  updatedBy: integer("updated_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type AiDefaultConfig = typeof aiDefaultConfigsTable.$inferSelect;
