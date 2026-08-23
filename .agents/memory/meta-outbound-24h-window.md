---
name: Meta outbound + 24h window (Messenger/Instagram)
description: How Messenger/Instagram outbound sends, recipient addressing, and the 24h messaging-window enforcement are wired across inbox reply route, bot, and frontend.
---

Messenger and Instagram outbound replies share ONE transport with WhatsApp's
shape but a different endpoint and addressing.

- **Shared send helper** lives in `channels/meta-shared.ts` (`sendMetaText`):
  POSTs to Graph `me/messages` with `{recipient:{id}, messaging_type:"RESPONSE", message:{text}}`,
  Bearer page access token. Has its own retry helper (429 long back-off, 5xx exp
  back-off, max 3). `messenger.ts`/`instagram.ts` are thin wrappers passing
  `pageAccessToken` + simulatedPrefix + notConfiguredError + logLabel. Dev
  (no ALLOW_LIVE_INTEGRATIONS) returns simulated success.
- **Recipient addressing differs by channel**: WhatsApp uses phone E.164;
  Messenger/Instagram use the user's page-/IG-scoped id stored as
  `externalContacts.externalId` (fallback `conversation.externalThreadId`).
  This is the #1 thing to get right — do NOT use phone for Meta.
- **24h window** governs whatsapp + messenger + instagram (set
  `CHANNELS_WITH_24H_WINDOW` in inbox.ts; reflected in GET-detail `withinWindow`).
  Reply route returns 409 `outside_24h_window` for Meta outside window.
- **Bot routing** (`botAutoReply.ts`): `BotSendInput.recipient` (renamed from
  `toPhoneE164`); `sendBotReply` switches on channel. WhatsApp outside-window
  falls back to a re-engagement TEMPLATE; **Meta has NO template path in scope**,
  so outside-window Meta just defers to staff (`outside_window`, bot stays silent).
- **Frontend** (edcons Messages.tsx): window-closed notice shows for all 3
  channels; the "use template" button is WhatsApp-only. Meta uses i18n key
  `messagesPage.outside24hReplyWindowMeta` (10 langs).

**Why:** Meta blocks free-text outside the 24h window; the only in-scope reaction
is to block with a clear 4xx + UI, not to send tags/templates.
