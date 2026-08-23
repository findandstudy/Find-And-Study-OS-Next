import { pgTable, serial, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const notificationsTable = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  icon: text("icon"),
  actionUrl: text("action_url"),
  data: jsonb("data").default({}),
  isRead: boolean("is_read").notNull().default(false),
  readAt: timestamp("read_at", { withTimezone: true }),
  channel: text("channel").notNull().default("in_app"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Full index on user_id: the FK to users is ON DELETE CASCADE and the
  // cascade needs this index, or user deletions time out on large tables.
  index("notifications_user_id_idx").on(table.userId),
]);

export const notificationRulesTable = pgTable("notification_rules", {
  id: serial("id").primaryKey(),
  event: text("event").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull().default("general"),
  channels: jsonb("channels").notNull().default(["in_app"]),
  recipientType: text("recipient_type").notNull().default("specific"),
  recipientRoles: jsonb("recipient_roles").default([]),
  isActive: boolean("is_active").notNull().default(true),
  template: jsonb("template").default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export type Notification = typeof notificationsTable.$inferSelect;
export type NotificationRule = typeof notificationRulesTable.$inferSelect;

export const NOTIFICATION_CHANNELS = [
  { id: "in_app", label: "In-App", icon: "Bell" },
  { id: "email", label: "Email", icon: "Mail" },
  { id: "whatsapp", label: "WhatsApp", icon: "MessageCircle" },
  { id: "telegram", label: "Telegram", icon: "Send" },
  { id: "sms", label: "SMS", icon: "Smartphone" },
] as const;

export const NOTIFICATION_EVENTS = {
  leads: {
    label: "Leads",
    events: {
      "lead.created": { name: "New Lead Created", description: "When a new lead is submitted via contact form or manually created" },
      "lead.assigned": { name: "Lead Assigned", description: "When a lead is assigned to a staff member" },
      "lead.stage_changed": { name: "Lead Stage Changed", description: "When a lead moves to a different pipeline stage" },
      "lead.follow_up_due": { name: "Follow-up Due", description: "When a scheduled follow-up is approaching" },
    },
  },
  applications: {
    label: "Applications",
    events: {
      "application.created": { name: "New Application", description: "When a new application is created" },
      "application.stage_changed": { name: "Application Status Changed", description: "When an application moves to a new stage" },
      "application.offer_received": { name: "Offer Received", description: "When an offer is received from a university" },
      "application.offer_letter_expiring": { name: "Offer Letter Expiring", description: "When an uploaded offer/acceptance letter is approaching its valid-until date" },
      "application.visa_update": { name: "Visa Update", description: "When visa status changes" },
    },
  },
  students: {
    label: "Students",
    events: {
      "student.created": { name: "New Student Registered", description: "When a new student is added to the system" },
      "student.document_uploaded": { name: "Document Uploaded", description: "When a student uploads a new document" },
      "student.status_changed": { name: "Student Status Changed", description: "When student status changes" },
    },
  },
  finance: {
    label: "Finance",
    events: {
      "finance.commission_confirmed": { name: "Commission Confirmed", description: "When a commission is confirmed by the university" },
      "finance.payment_received": { name: "Payment Received", description: "When a payment/collection is recorded" },
      "finance.payment_due": { name: "Payment Due", description: "When a service fee installment is approaching due date" },
      "finance.agent_payout": { name: "Agent Payout Processed", description: "When an agent commission payment is processed" },
    },
  },
  agents: {
    label: "Agents",
    events: {
      "agent.new_registration": { name: "New Agent Registration", description: "When a new agent registers in the system" },
      "agent.sub_agent_added": { name: "Sub-Agent Added", description: "When a sub-agent is added under an agent" },
      "agent.contract_expiring": { name: "Agent Contract Expiring", description: "When an agent's contract end date is approaching one of the configured thresholds" },
    },
  },
  system: {
    label: "System",
    events: {
      "system.user_activated": { name: "User Account Activated", description: "When an admin activates a user account" },
      "system.broadcast": { name: "Broadcast Message", description: "When a broadcast message is sent to users" },
      "system.announcement": { name: "Announcement", description: "When a new system announcement is published" },
    },
  },
  messages: {
    label: "Messages",
    events: {
      "message.new": { name: "New Message", description: "When you receive a new internal message" },
      "message.mention": { name: "Mentioned in Message", description: "When you are mentioned in a message" },
    },
  },
  notes: {
    label: "Notes",
    events: {
      "note.created": { name: "Note Added", description: "When a note is added to an application, student, or lead record" },
    },
  },
  tasks: {
    label: "Tasks",
    events: {
      "task.assigned": { name: "Task Assigned", description: "When a task is assigned to you" },
      "task.mention": { name: "Mentioned in Task Note", description: "When a teammate mentions you with @ in a task note" },
    },
  },
  inbox: {
    label: "Inbox",
    events: {
      "inbox.new_message": { name: "New External Message", description: "When a new WhatsApp or web-form message arrives" },
      "inbox.message_unmatched": { name: "Unmatched message — needs review", description: "When an inbound message (web form, WhatsApp, Instagram…) cannot be linked to a known contact" },
      "inbox.assigned": { name: "Conversation Assigned", description: "When a conversation is assigned to you" },
      "inbox.send_failed": { name: "Outbound Send Failed", description: "When an outbound channel message fails to send" },
    },
  },
  contracts: {
    label: "Contracts",
    events: {
      "contract.sent": { name: "Contract Sent to Signer", description: "When a contract signing link is sent or resent to a signer" },
      "contract.verification_code": { name: "Email Verification Code", description: "The verification code email sent to the signer before signing (customizable template)" },
      "contract.signed": { name: "Contract Signed", description: "When a signer successfully completes contract signing" },
    },
  },
} as const;

export const DEFAULT_NOTIFICATION_RULES = [
  { event: "lead.created", name: "New Lead Created", category: "leads", channels: ["in_app", "email"], recipientType: "role", recipientRoles: ["super_admin", "admin", "manager", "staff", "consultant"] },
  { event: "lead.assigned", name: "Lead Assigned", category: "leads", channels: ["in_app"], recipientType: "assigned", recipientRoles: [] },
  { event: "lead.stage_changed", name: "Lead Stage Changed", category: "leads", channels: ["in_app"], recipientType: "assigned", recipientRoles: [] },
  { event: "lead.follow_up_due", name: "Follow-up Due", category: "leads", channels: ["in_app", "email"], recipientType: "assigned", recipientRoles: [] },
  { event: "application.created", name: "New Application", category: "applications", channels: ["in_app"], recipientType: "role", recipientRoles: ["super_admin", "admin", "manager"] },
  { event: "application.stage_changed", name: "Application Status Changed", category: "applications", channels: ["in_app", "email"], recipientType: "owner", recipientRoles: [] },
  { event: "application.offer_received", name: "Offer Received", category: "applications", channels: ["in_app", "email", "whatsapp"], recipientType: "owner", recipientRoles: [] },
  { event: "application.offer_letter_expiring", name: "Offer Letter Expiring", category: "applications", channels: ["in_app", "email"], recipientType: "owner", recipientRoles: [] },
  { event: "application.visa_update", name: "Visa Update", category: "applications", channels: ["in_app", "email", "whatsapp"], recipientType: "owner", recipientRoles: [] },
  { event: "student.created", name: "New Student Registered", category: "students", channels: ["in_app"], recipientType: "role", recipientRoles: ["super_admin", "admin", "manager"] },
  { event: "student.document_uploaded", name: "Document Uploaded", category: "students", channels: ["in_app"], recipientType: "assigned", recipientRoles: [] },
  { event: "student.status_changed", name: "Student Status Changed", category: "students", channels: ["in_app"], recipientType: "assigned", recipientRoles: [] },
  { event: "finance.commission_confirmed", name: "Commission Confirmed", category: "finance", channels: ["in_app", "email"], recipientType: "role", recipientRoles: ["super_admin", "accountant"] },
  { event: "finance.payment_received", name: "Payment Received", category: "finance", channels: ["in_app"], recipientType: "role", recipientRoles: ["super_admin", "accountant"] },
  { event: "finance.payment_due", name: "Payment Due", category: "finance", channels: ["in_app", "email"], recipientType: "role", recipientRoles: ["super_admin", "accountant"] },
  { event: "finance.agent_payout", name: "Agent Payout Processed", category: "finance", channels: ["in_app", "email"], recipientType: "role", recipientRoles: ["super_admin", "accountant"] },
  { event: "agent.new_registration", name: "New Agent Registration", category: "agents", channels: ["in_app", "email"], recipientType: "role", recipientRoles: ["super_admin", "admin"] },
  { event: "agent.sub_agent_added", name: "Sub-Agent Added", category: "agents", channels: ["in_app"], recipientType: "role", recipientRoles: ["super_admin", "admin"] },
  { event: "agent.contract_expiring", name: "Agent Contract Expiring", category: "agents", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "system.user_activated", name: "User Account Activated", category: "system", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "system.broadcast", name: "Broadcast Message", category: "system", channels: ["in_app"], recipientType: "all", recipientRoles: [] },
  { event: "system.announcement", name: "Announcement", category: "system", channels: ["in_app"], recipientType: "all", recipientRoles: [] },
  { event: "note.created", name: "Note Added", category: "notes", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "message.new", name: "New Message", category: "messages", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "message.mention", name: "Mentioned in Message", category: "messages", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "task.assigned", name: "Task Assigned", category: "tasks", channels: ["in_app"], recipientType: "specific", recipientRoles: [] },
  { event: "task.mention", name: "Mentioned in Task Note", category: "tasks", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "inbox.new_message", name: "New External Message", category: "inbox", channels: ["in_app"], recipientType: "role", recipientRoles: ["super_admin", "admin", "manager", "staff", "consultant"] },
  { event: "inbox.message_unmatched", name: "Unmatched message — needs review", category: "inbox", channels: ["in_app"], recipientType: "role", recipientRoles: ["super_admin", "admin", "manager"] },
  { event: "inbox.assigned", name: "Conversation Assigned", category: "inbox", channels: ["in_app"], recipientType: "specific", recipientRoles: [] },
  { event: "inbox.send_failed", name: "Outbound Send Failed", category: "inbox", channels: ["in_app", "email"], recipientType: "role", recipientRoles: ["super_admin", "admin", "manager"] },
  { event: "university_contract.expiring", name: "University Contract Expiring", category: "agents", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "university_contract.expired", name: "University Contract Expired", category: "agents", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "company_contract.expiring", name: "Company Contract Expiring", category: "agents", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "company_contract.expired", name: "Company Contract Expired", category: "agents", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "mandatory_docs_missing", name: "Application Parked: Missing Mandatory Docs", category: "applications", channels: ["in_app"], recipientType: "assigned", recipientRoles: [] },
  { event: "mandatory_docs_missing_student", name: "Required Documents Missing (Student)", category: "applications", channels: ["in_app", "email"], recipientType: "specific", recipientRoles: [] },
  { event: "contract.sent", name: "Contract Sent to Signer", category: "contracts", channels: ["in_app", "email"], recipientType: "role", recipientRoles: ["super_admin", "admin"] },
  { event: "contract.verification_code", name: "Email Verification Code", category: "contracts", channels: ["email"], recipientType: "specific", recipientRoles: [] },
  { event: "contract.signed", name: "Contract Signed", category: "contracts", channels: ["in_app", "email"], recipientType: "role", recipientRoles: ["super_admin", "admin"] },
];
