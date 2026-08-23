import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// ---------------------------------------------------------------------------
// portal_credentials
//
// Stores encrypted portal login credentials per (organization, portalKey).
// AES-256-GCM encrypted values are stored in *Enc columns (enc::v1:: prefix).
// Plain-text credentials are NEVER stored or returned.
// ---------------------------------------------------------------------------
export const portalCredentialsTable = pgTable(
  "portal_credentials",
  {
    id: serial("id").primaryKey(),

    /** Multi-tenant org ID — matches other tables' pattern. */
    organizationId: integer("organization_id"),

    /** Adapter key: "topkapi" | "uskudar" | "sit" | "united" | ... */
    portalKey: text("portal_key").notNull(),

    /** Human-readable label shown in admin UI. */
    label: text("label").notNull().default(""),

    /** Encrypted username / email — decrypt with lib/encryption.ts. */
    usernameEnc: text("username_enc").notNull(),

    /** Encrypted password — decrypt with lib/encryption.ts. */
    passwordEnc: text("password_enc").notNull(),

    /** Optional encrypted JSON blob (client_id, tenant_id, etc.). */
    extraEnc: text("extra_enc"),

    isActive: boolean("is_active").notNull().default(true),

    /** Staff member who created this credential entry. */
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
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (table) => [
    // Per-org uniqueness: one active credential per (org, portalKey).
    uniqueIndex("portal_creds_org_key_uniq").on(
      table.organizationId,
      table.portalKey,
    ),
    index("portal_creds_org_idx").on(table.organizationId),
    index("portal_creds_active_idx").on(table.isActive),
  ],
);

// ---------------------------------------------------------------------------
// Zod schemas & TS types
// ---------------------------------------------------------------------------
export const insertPortalCredentialSchema = createInsertSchema(
  portalCredentialsTable,
  {
    portalKey: z.string().min(1),
    label:     z.string().default(""),
  },
);

export type PortalCredential    = typeof portalCredentialsTable.$inferSelect;
export type NewPortalCredential = typeof portalCredentialsTable.$inferInsert;

// Legacy alias kept for backward compat with existing code.
export type InsertPortalCredential = NewPortalCredential;
