import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Records the user who requested the upload URL for each storage object,
 * keyed by the canonical object key (e.g. `uploads/<uuid>`).
 *
 * This binding is the authoritative basis for storage access control: the
 * generic `GET /api/storage/objects/*path` endpoint trusts reference fields
 * (avatars, logos, contracts, attachments) only when they are consistent with
 * the recorded uploader. Many reference fields are self-writable by ordinary
 * users (e.g. `users.avatarUrl`, `agents.logoUrl`, message attachments), so
 * without an uploader binding an attacker could point one of their own fields
 * at a victim's object key and download it (IDOR).
 *
 * `uploadedBy` is nullable so that admin/server-managed objects (finance files,
 * admin branding) can be marked as bound without a meaningful uploader.
 */
export const objectOwnersTable = pgTable("object_owners", {
  objectKey: text("object_key").primaryKey(),
  uploadedBy: integer("uploaded_by").references(() => usersTable.id, { onDelete: "set null" }),
  // Precedence of the writer that produced this binding: LOWER is more
  // authoritative. `0` is the upload-time binding (the true uploader, recorded
  // by `recordObjectOwner`); backfill-reconstructed bindings use higher numbers
  // in source-priority order. Upserts only overwrite a row when the incoming
  // binding is strictly more authoritative, so (a) backfill never clobbers a
  // real upload-time binding and (b) a retried backfill converges to the
  // highest-authority source even after a transient partial run.
  sourcePriority: integer("source_priority").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
