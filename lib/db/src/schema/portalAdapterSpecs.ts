import {
  pgTable,
  pgEnum,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./users";

// ---------------------------------------------------------------------------
// Enum — where a spec came from. `builtin` specs are trusted (may run jsHook);
// `uploaded` specs are untrusted until a super_admin approves jsHook execution.
// ---------------------------------------------------------------------------

export const portalAdapterSpecSourceEnum = pgEnum("portal_adapter_spec_source", [
  "builtin",
  "uploaded",
]);

// ---------------------------------------------------------------------------
// Table — VERSIONED declarative adapter specs.
//
// One row per (key, version). Uploading a new spec for an existing key inserts
// a new version (monotonic). `enabled` marks the single active version per key
// that the loader resolves; enabling/rolling-back flips this flag. This is an
// OPT-IN parallel system to portal_adapters (flat DeclarativeConfig) — code
// adapters and portal_adapters resolve first; specs are the lowest-priority
// fallback in this phase.
// ---------------------------------------------------------------------------

export const portalAdapterSpecsTable = pgTable(
  "portal_adapter_specs",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    name: text("name").notNull(),
    /** The validated AdapterSpec object (see lib/portal-adapters declarative/schema). */
    spec: jsonb("spec").$type<Record<string, unknown>>().notNull(),
    version: integer("version").notNull(),
    /** The single active version for this key (loader resolves this row). */
    enabled: boolean("enabled").notNull().default(false),
    source: portalAdapterSpecSourceEnum("source").notNull().default("uploaded"),
    /** super_admin approval required before jsHook steps may execute. */
    jsHookApproved: boolean("js_hook_approved").notNull().default(false),
    /**
     * super_admin approval required before a privileged spec (containing
     * http, graphql, or jsHook steps) may be enabled. Set via the PATCH
     * endpoint by a super_admin; the enable endpoint enforces this gate.
     */
    privilegedApproved: boolean("privileged_approved").notNull().default(false),
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
  (table) => [
    uniqueIndex("portal_adapter_specs_key_version_uniq").on(
      table.key,
      table.version,
    ),
    index("portal_adapter_specs_key_idx").on(table.key),
    index("portal_adapter_specs_enabled_idx").on(table.enabled),
    // Invariant: at most one enabled version per key. Concurrent enable/rollback
    // transactions that would leave two enabled rows fail on this constraint
    // rather than silently corrupting adapter resolution.
    uniqueIndex("portal_adapter_specs_one_enabled_per_key")
      .on(table.key)
      .where(sql`${table.enabled}`),
  ],
);

export type PortalAdapterSpec = typeof portalAdapterSpecsTable.$inferSelect;
export type InsertPortalAdapterSpec = typeof portalAdapterSpecsTable.$inferInsert;
