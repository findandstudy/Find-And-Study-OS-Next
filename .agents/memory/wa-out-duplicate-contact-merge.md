---
name: wa_out duplicate contact merge
description: Three-part fix for the Lead→Student conversion broken inbox panel bug — wa_out placeholder contacts, loadConversationLink, identityResolver.
---

## Problem
When CRM initiates a WhatsApp outbound conversation (`POST /inbox/conversations/start`):
- `external_contacts.external_id = "wa_out:<digits>"` placeholder created
- `conversations.external_thread_id = NULL` (no real thread yet)

When the student replies:
- `processInbound` upserts a NEW contact with real `externalId` (e.g. `"971568368419"`)
- This creates a second `external_contact` row and a second `conversation` row
- The wa_out conversation keeps the entity links (leadId/studentId); the real one doesn't
- Right-panel tabs (STUDENT / APPLICATION / DOCUMENTS) show "No student linked"

## Three-part fix

### Fix 1 — processInbound.ts (forward path)
After the `agent_ref` pipeline block, before conversation upsert:
- Look for `wa_out:<digits>` counterpart by `channel + phoneE164`
- Copy entity links (leadId/studentId/agentId) to real contact
- Re-key wa_out conversation: set `externalContactId = real, externalThreadId = realThreadId`
- Move any remaining conversations to real contact
- Delete wa_out external_contact
- Wrapped in try/catch — non-fatal

### Fix 2 — index.ts boot DDL `backfillWaOutExternalContacts()`
Runs on every boot. Idempotent (no-op once pairs are gone).
- Finds all `(wa_out contact, real contact)` pairs via JOIN on `channel + phone_e164`
- For each pair: copy entity links, merge messages to best real conversation, move participants, delete wa_out conversation + contact

### Fix 3 — inbox.ts `loadConversationLink()`
If `externalContact.studentId` is null but the linked lead has `convertedStudentId`:
- Resolve and surface the student — panels now show the converted student's data

### Fix 4 — identityResolver.ts
Added `isNull(leadsTable.convertedStudentId)` to leads query so converted leads are not returned as separate candidates. Their student record becomes the sole "strong" match.

## Why
- `wa_out:` prefix is intentional — it marks contacts with no real wa_id yet
- The real inbound reply creates a fresh contact because the externalId doesn't match
- Boot backfill needed for already-created production duplicate pairs

## How to apply
- Any new outbound-start flow that might create placeholder contacts needs the same merge pattern
- The backfill is boot-DDL only — no migration file needed
- `loadConversationLink` must always check `converted_student_id` when `studentId` is null on the contact
