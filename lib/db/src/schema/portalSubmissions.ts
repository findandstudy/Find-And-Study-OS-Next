import {
  pgTable,
  pgEnum,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { applicationsTable } from "./applications";
import { studentsTable } from "./students";
import { usersTable } from "./users";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const portalSubmissionModeEnum = pgEnum("portal_submission_mode", [
  "dry",
  "real",
]);

export const portalSubmissionStatusEnum = pgEnum("portal_submission_status", [
  "queued",
  "running",
  "submitted",
  "already_exists",
  "program_missing",
  "failed",
  "canceled",
  "dry_run",
  "program_full",
  "exclusive_region",
  "accepted",
  "rejected",
]);

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------
export const portalSubmissionsTable = pgTable(
  "portal_submissions",
  {
    id: serial("id").primaryKey(),

    /** Multi-tenant org ID — matches other tables' pattern. */
    organizationId: integer("organization_id"),

    applicationId: integer("application_id")
      .notNull()
      .references(() => applicationsTable.id, { onDelete: "cascade" }),

    /** Nullable: preserved as evidence even if student record is deleted. */
    studentId: integer("student_id").references(() => studentsTable.id, {
      onDelete: "set null",
    }),

    universityKey: text("university_key").notNull(),
    universityName: text("university_name").notNull(),

    /**
     * Adapter key the submission is (or was) routed to at enqueue time
     * (e.g. "topkapi", "sit"). Nullable: historical rows predate the column
     * and are backfilled best-effort from portal_universities. Drives
     * adapter auto-graduation (live COUNT of status='submitted' per key).
     */
    adapterKey: text("adapter_key"),

    mode: portalSubmissionModeEnum("mode").notNull().default("dry"),

    status: portalSubmissionStatusEnum("status").notNull().default("queued"),

    externalRef: text("external_ref"),
    resultJson: jsonb("result_json"),
    screenshotUrls: jsonb("screenshot_urls"),
    error: text("error"),

    /** Free-form metadata (e.g. supersession context, fallback chain). */
    meta: jsonb("meta"),

    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),

    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),

    enqueuedBy: integer("enqueued_by").references(() => usersTable.id, {
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
    index("portal_submissions_application_id_idx").on(table.applicationId),
    index("portal_submissions_status_idx").on(table.status),
    index("portal_submissions_locked_at_idx").on(table.lockedAt),
    // Added: worker poll filter by universityKey
    index("portal_submissions_university_key_idx").on(table.universityKey),
    // Added: worker poll query — multi-tenant status filter
    index("portal_submissions_org_status_idx").on(
      table.organizationId,
      table.status,
    ),
    // Added: adapter auto-graduation success COUNT per adapter key
    index("portal_submissions_adapter_key_status_idx").on(
      table.adapterKey,
      table.status,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Zod schemas & TS types
// ---------------------------------------------------------------------------
export const insertPortalSubmissionSchema = createInsertSchema(
  portalSubmissionsTable,
  {
    universityKey: z.string().min(1),
    universityName: z.string().min(1),
  },
);

export type PortalSubmission = typeof portalSubmissionsTable.$inferSelect;
export type NewPortalSubmission = typeof portalSubmissionsTable.$inferInsert;
