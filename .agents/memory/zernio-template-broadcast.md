---
name: Zernio template send = broadcast flow
description: WhatsApp templates via Zernio must use the 3-step broadcast API, never the inbox messages endpoint.
---

**Rule:** Zernio's inbox messages endpoint (`/api/v1/inbox/conversations/{id}/messages`) accepts ONLY `{accountId, message}` free text (plus attachmentUrl). A Meta Cloud API-shaped template body returns 400 "Message, attachment, or interactive content is required". Templates — even to one recipient — go through the 3-step broadcast flow: POST `/api/v1/broadcasts` {profileId, accountId, platform:"whatsapp", name, template:{name, language, variableMapping?}} → POST `.../{id}/recipients` {phones:[E.164]} → POST `.../{id}/send` → {sent, failed}.

**Why:** Zernio has no per-conversation template endpoint; the inbox route is text-only by contract.

**How to apply:**
- `profileId` is resolved via GET `/api/v1/profiles` (isDefault else first), cached in-memory 1h (`resolveZernioProfileId`); never a manual config field.
- Positional params map to `variableMapping` `{"1":{field:"custom",customValue}}`; the route validates param count === placeholder count in template body BEFORE sending (else Meta rejects with opaque 132000).
- STRICT: `sent<1 || failed>0` ⇒ NOT sent (message row status "failed"). `broadcastId` persisted in message metadata for webhook correlation.
- Broadcast is keyed by recipient phone (E.164), NOT externalThreadId — conversations without a Zernio thread id can still receive templates.
- Test seams: `__setZernioApiKeyOverrideForTests`, `__clearZernioProfileCacheForTests`; unit tests in scripts/test-zernio-broadcast.ts (fetch mocked).
