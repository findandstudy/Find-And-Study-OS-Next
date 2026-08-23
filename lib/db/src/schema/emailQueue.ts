import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";

export const emailQueueTable = pgTable("email_queue", {
  id: serial("id").primaryKey(),
  toEmail: text("to_email").notNull(),
  subject: text("subject").notNull(),
  htmlBody: text("html_body").notNull(),
  textBody: text("text_body").notNull(),
  status: text("status").notNull().default("pending"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  retryCount: integer("retry_count").notNull().default(0),
  maxRetries: integer("max_retries").notNull().default(3),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
}, (table) => [
  index("email_queue_status_idx").on(table.status),
  index("email_queue_retry_idx").on(table.status, table.nextRetryAt),
]);
