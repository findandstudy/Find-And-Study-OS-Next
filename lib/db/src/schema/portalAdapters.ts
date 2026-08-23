import {
  pgTable,
  pgEnum,
  serial,
  text,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

export const portalAdapterKindEnum = pgEnum("portal_adapter_kind", [
  "code",
  "declarative",
]);

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export const portalAdaptersTable = pgTable(
  "portal_adapters",
  {
    id: serial("id").primaryKey(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    baseUrl: text("base_url").notNull(),
    matchNames: text("match_names").notNull(),
    kind: portalAdapterKindEnum("kind").notNull().default("code"),
    configJson: jsonb("config_json").$type<Record<string, unknown>>(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("portal_adp_key_uniq").on(table.key),
    index("portal_adp_is_active_idx").on(table.isActive),
  ],
);

export type PortalAdapter = typeof portalAdaptersTable.$inferSelect;
export type InsertPortalAdapter = typeof portalAdaptersTable.$inferInsert;
