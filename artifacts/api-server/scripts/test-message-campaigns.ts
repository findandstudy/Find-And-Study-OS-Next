import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const migration = source("../../../lib/db/drizzle/0036_message_campaigns.sql");
const schema = source("../../../lib/db/src/schema/messageCampaigns.ts");
const apiStartup = source("../src/index.ts");
const route = source("../src/routes/messageCampaigns.ts");
const worker = source("../src/lib/inbox/messageCampaignWorker.ts");
const sender = source("../src/lib/inbox/startWhatsAppTemplate.ts");
const messagesUi = source("../../edcons/src/pages/staff/Messages.tsx");
const bulkDialog = source("../../edcons/src/components/BulkMessageDialog.tsx");
const leadsUi = source("../../edcons/src/pages/staff/Leads.tsx");
const studentsUi = source("../../edcons/src/pages/staff/Students.tsx");
const applicationsUi = source("../../edcons/src/pages/staff/Applications.tsx");

test("campaign tables retain an auditable, constrained recipient ledger", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS message_campaigns/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS message_campaign_recipients/);
  assert.match(migration, /CHECK \(source_entity_type IN \('lead', 'student', 'application'\)\)/);
  assert.match(migration, /CHECK \(status IN \('queued', 'processing', 'retrying', 'sent', 'failed', 'skipped', 'cancelled'\)\)/);
  assert.match(migration, /UNIQUE \(campaign_id, recipient_key\)/);
  assert.match(schema, /providerBroadcastId:/);
  assert.match(schema, /variablesSnapshot:/);
  assert.match(schema, /sourceSnapshot:/);
  assert.match(apiStartup, /CREATE TABLE IF NOT EXISTS message_campaigns/);
  assert.match(apiStartup, /CREATE TABLE IF NOT EXISTS message_campaign_recipients/);
  assert.match(apiStartup, /CREATE INDEX IF NOT EXISTS message_campaign_recipients_claim_idx/);
});

test("campaign creation is bounded, authorized, deduplicated and approval-gated", () => {
  assert.match(route, /entityIds: z\.array\([\s\S]*?\.min\(1\)\.max\(500\)/);
  assert.match(route, /loadWhatsAppEntitySnapshot\(req\.user!, entityType, entityId\)/);
  assert.match(route, /const seenPhones = new Set<string>\(\)/);
  assert.match(route, /duplicate_recipient/);
  assert.match(route, /errorCode: "no_phone"/);
  assert.match(route, /template\.approvalStatus[\s\S]*?toLowerCase\(\) !== "approved"/);
  assert.match(route, /requireRole\(\.\.\.STAFF_ROLES, \.\.\.ADMIN_ROLES\)/);
});

test("worker claims exactly one due recipient without cross-worker races", () => {
  assert.match(worker, /FOR UPDATE SKIP LOCKED/);
  assert.match(worker, /UPDATE message_campaign_recipients AS recipient/);
  assert.match(worker, /WHERE recipient\.id = \([\s\S]*?LIMIT 1/);
  assert.match(worker, /if \(busy\) return/);
});

test("recipient identity and provider approval are rechecked immediately before send", () => {
  const phoneGuard = sender.indexOf("recipient_phone_changed");
  const approvalCheck = sender.indexOf("const availability = await resolveApprovedZernioTemplate");
  const providerSend = sender.indexOf("await sendZernioTemplate");
  assert.ok(phoneGuard > 0, "campaign phone snapshot must be enforced");
  assert.ok(approvalCheck > phoneGuard, "line-specific approval must follow recipient resolution");
  assert.ok(providerSend > approvalCheck, "provider send must happen only after exact-line approval");
  assert.match(worker, /expectedPhoneE164: recipient\.phone_e164 \|\| undefined/);
});

test("unknown provider outcomes fail closed and cannot be bulk retried", () => {
  assert.match(worker, /error_code = 'delivery_outcome_unknown'/);
  assert.match(worker, /status = 'failed'/);
  assert.match(worker, /async function recoverStaleProcessing/);
  assert.match(worker, /now - lastStaleRecoveryAt >= STALE_RECOVERY_INTERVAL_MS/);
  assert.match(worker, /error\.code === "template_availability_check_failed"/);
  assert.doesNotMatch(worker, /return error\.status >= 500/);
  assert.match(route, /SAFE_BULK_RETRY_ERROR_CODES/);
  assert.match(route, /inArray\(messageCampaignRecipientsTable\.errorCode, \[\.\.\.SAFE_BULK_RETRY_ERROR_CODES\]\)/);
  assert.doesNotMatch(route, /SAFE_BULK_RETRY_ERROR_CODES[\s\S]*?"delivery_outcome_unknown"/);
  assert.doesNotMatch(route, /SAFE_BULK_RETRY_ERROR_CODES[\s\S]*?"template_send_failed"/);
});

test("bulk template campaigns are reachable from all three CRM lists", () => {
  for (const [ui, entityType] of [
    [leadsUi, "lead"],
    [studentsUi, "student"],
    [applicationsUi, "application"],
  ] as const) {
    assert.match(ui, /<BulkMessageDialog/);
    assert.match(ui, new RegExp(`entityType="${entityType}"`));
    assert.match(ui, /entityIds=\{Array\.from\(selectedIds\)\}/);
  }
  assert.match(bulkDialog, /approvalStatus[\s\S]*?=== "approved"/);
  assert.match(bulkDialog, /\/api\/message-campaigns/);
});

test("internal announcements remain separate from tracked CRM campaigns", () => {
  assert.match(messagesUi, /Internal Announcements/);
  assert.match(messagesUi, /This does not contact CRM leads or students/);
  assert.match(messagesUi, /CRM Campaigns/);
  assert.match(messagesUi, /\/api\/message-campaigns/);
  assert.match(messagesUi, /Recipient history/);
});
