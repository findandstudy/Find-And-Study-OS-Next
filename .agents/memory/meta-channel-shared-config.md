---
name: Meta channel shared config (Faz 1 foundation)
description: How Facebook Messenger + Instagram config foundation mirrors WhatsApp in the edcons inbox
---

Faz 1 added config-only foundation for Messenger + Instagram (no message flow).

- Signature verification is shared: `verifyMetaSignature(rawBody, sigHeader, appSecret)` and `META_API_VERSION` live in `artifacts/api-server/src/lib/inbox/channels/meta-shared.ts`. `whatsapp.ts` `verifyWhatsAppSignature` now delegates to it (behavior identical — WA route + tests unchanged).
- Channel constants (incl. messenger, instagram) live in `inbox/channels/constants.ts`.
- New integration keys `facebook_messenger` + `instagram` go in BOTH backend and frontend `LIVE_GATED_KEYS` sets, and get per-key Test handlers in `routes/integrations.ts` (Graph page-name / IG-username lookups, simulated-mode skip).

**Why:** keep one HMAC implementation across all Meta channels so a fix applies everywhere; gate enabling on production like WhatsApp.

**How to apply (frontend i18n pattern):** `IntegrationsManager.tsx` was historically all-hardcoded English. To i18n a card without touching every other card, set optional `i18nKey` + `metaWebhook` on its `IntegrationDef`; resolver helpers `defName/defDesc/fieldLabel` look up `integrationsManager.<i18nKey>.{name,description,fields.<fieldKey>}` and fall back to the static string when the key is absent. The `integrationsManager` namespace is NEW (distinct from the short prod-banner `integrations` namespace) and must exist in all 10 lang files; getTranslation silently falls back to en. Meta webhook callback URL is `/api/webhooks/meta` (single shared route, not per-channel).

**Faz 2 (inbound flow):** ONE `/api/webhooks/meta` route serves BOTH channels. GET handshake accepts EITHER integration's `webhookVerifyToken`. POST verifies the HMAC against EITHER config's `appSecret` (try messenger then instagram → 401 if neither matches), then branches on `payload.object`: `"page"`→messenger, `"instagram"`→instagram, anything else→200 skip (comments live in `changes[]`, not `messaging[]` — logged/skipped, NOT processed in Faz 2). Parser `parseMetaMessaging` skips `is_echo` (outbound) and non-message events; `externalThreadId`/`externalUserId` = sender PSID/IGSID; attachment-only messages get a text fallback. Routes call `processInboundMessage` (same dedup-by-externalMessageId as WhatsApp); no `maybeAutoReply` yet (Faz 3 = outbound + AI bot + Graph profile-name fetch for displayName).
