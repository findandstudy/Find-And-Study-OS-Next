import { pgTable, text, serial, timestamp, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// Long-lived bearer tokens for programmatic API access. The plain token value is
// shown exactly once at creation time; only its SHA-256 hash is persisted.
// `tokenPrefix` keeps a non-secret leading slice (e.g. "fas_live_ab3d…") so the
// UI can identify a token without ever exposing the secret. Scopes are
// resource:action strings (e.g. "applications:read") gating what the token can do.
export const apiTokensTable = pgTable("api_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull(),
  tokenPrefix: text("token_prefix").notNull(),
  scopes: text("scopes").array().notNull().default([]),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
}, (table) => [
  uniqueIndex("api_tokens_token_hash_unique").on(table.tokenHash),
  index("api_tokens_user_id_idx").on(table.userId),
  index("api_tokens_token_prefix_idx").on(table.tokenPrefix),
]);

export const insertApiTokenSchema = createInsertSchema(apiTokensTable).omit({ id: true, createdAt: true, lastUsedAt: true });
export type InsertApiToken = z.infer<typeof insertApiTokenSchema>;
export type ApiToken = typeof apiTokensTable.$inferSelect;
