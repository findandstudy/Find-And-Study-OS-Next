---
name: Quick-contact real dispatch scope rules
description: Authorization + phone-fallback rules for POST /api/quick-contact whatsapp/instagram real dispatch
---

Rule: any endpoint that sends a real outbound message on behalf of an entity (lead/student/agent/application) must (1) require the entity, (2) reload it from the DB, (3) apply agent-source scope (isAgentSourcedAndBlockedForStaff → 404 concealment), and (4) never use a client-supplied phone/identifier to select the target contact — only the entity's stored phoneE164 (or toE164(entity.phone)) may drive the WhatsApp contact fallback.

**Why:** the first implementation accepted `recipientPhone` from the client as an OR condition in contact lookup, letting staff message arbitrary contacts/conversations outside their record scope (IDOR flagged in review).

**How to apply:** whenever adding a new quick-contact channel or a similar "message this record" endpoint, mirror the entity-load + scope + entity-phone-only pattern in routes/messages.ts quick-contact whatsapp|instagram branch. Also: the 24h free-text window must be enforced on EVERY outbound path for whatsapp/messenger/instagram — including Zernio-hosted conversations (inbox reply Zernio branch gates before sendZernioConversationMessage).
