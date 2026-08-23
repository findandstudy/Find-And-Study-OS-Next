import {
  pgTable,
  pgEnum,
  serial,
  boolean,
  integer,
  jsonb,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const portalAutomationModeEnum = pgEnum("portal_automation_mode", [
  "dry",
  "real",
]);

export const portalAutomationScopeEnum = pgEnum("portal_automation_scope", [
  "only_applied",
  "selected",
  "all",
]);

// ---------------------------------------------------------------------------
// Table — single-row global settings
// ---------------------------------------------------------------------------

export const portalAutomationSettingsTable = pgTable(
  "portal_automation_settings",
  {
    id: serial("id").primaryKey(),
    isEnabled: boolean("is_enabled").notNull().default(false),
    triggerStages: jsonb("trigger_stages")
      .$type<string[]>()
      .notNull()
      .default([]),
    mode: portalAutomationModeEnum("mode").notNull().default("dry"),
    scope: portalAutomationScopeEnum("scope").notNull().default("only_applied"),
    selectedUniversityKeys: jsonb("selected_university_keys")
      .$type<string[]>()
      .notNull()
      .default([]),
    // ---------------------------------------------------------------------------
    // Scheduled auto-process settings
    // ---------------------------------------------------------------------------
    /** When true, drain-once.ts (scheduled deployment) will process queued submissions. */
    autoProcessEnabled: boolean("auto_process_enabled").notNull().default(false),
    /** Minimum minutes between two consecutive auto-drain runs (interval gate). */
    autoProcessIntervalMinutes: integer("auto_process_interval_minutes").notNull().default(20),
    /** Timestamp of the last successful auto-drain run; NULL if never run. */
    lastAutoDrainAt: timestamp("last_auto_drain_at", { withTimezone: true }),
    // ---------------------------------------------------------------------------
    // Program-fallback orchestrator kill-switch (Phase 3)
    // ---------------------------------------------------------------------------
    /**
     * Master on/off switch for the automatic program-fallback (supersession)
     * orchestrator. Default false → opt-in: when a submission ends in
     * status='program_full' the worker only supersedes the full programme with a
     * configured fallback rule when this flag is on. false = no-op + log.
     */
    fallbackEnabled: boolean("fallback_enabled").notNull().default(false),
    // ---------------------------------------------------------------------------
    // Fan-out mode (global default; per-university override lives on portal_universities)
    // ---------------------------------------------------------------------------
    /**
     * Global default fan-out mode.
     *   'off'    — no fan-out (only submit to the directly applied university). Default.
     *   'manual' — operator presses the fan-out button to trigger for a given application.
     *   'auto'   — fan out automatically when a student reaches a trigger stage.
     * Overridden per-university via portal_universities.fan_out_mode (null = inherit).
     * Master kill-switch (isEnabled=false) always forces 'off' regardless.
     */
    fanOutMode: text("fan_out_mode").notNull().default("off"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export type PortalAutomationSettings =
  typeof portalAutomationSettingsTable.$inferSelect;
export type InsertPortalAutomationSettings =
  typeof portalAutomationSettingsTable.$inferInsert;
