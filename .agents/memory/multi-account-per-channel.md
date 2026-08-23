---
name: Multi-account per channel (WhatsApp/Messenger/Instagram)
description: How multiple credentials per inbox channel resolve, and why the admin UI bypasses OpenAPI/Orval.
---

# Multi-account per channel

`channel_accounts` rows hold one credential set per (channel, account); `conversations.channelAccountId`
points a conversation at the account that owns it. Resolution lives in
`artifacts/api-server/src/lib/inbox/channelAccountConfig.ts`:

- **Inbound** (`resolveInboundAccount(channel, externalAccountId)`): match by (channel, externalAccountId)
  and ONLY when `isActive`. Returns `null` otherwise → caller falls back to the legacy single-config
  integration row. Never weaken signature verification: verify against THAT account's appSecret.
- **Outbound** (`resolveOutboundConfig(channel, channelAccountId)`): returns the referenced account's
  config only when active; `null`/inactive/wrong-channel → legacy fallback (resolveLegacyConfig).
- **Legacy fallback is load-bearing**: rows with `channelAccountId = null` must keep working off the old
  `integrations` (whatsapp/facebook_messenger/instagram) config. Migration 0021 seeds the first account
  per channel by copying that configEncrypted; api-server boot DDL adds is_active/is_default idempotently.

**Why:** existing live conversations have null channelAccountId and must not break when multi-account ships.

## Masking / no credential loss
Reuse `src/lib/configMasking.ts` (`maskSecrets`/`mergeConfig`) — the SAME rules as integrations.ts.
A secret field whose incoming value contains "•" is treated as unchanged and preserved. Any new CRUD
surface that round-trips secrets MUST use mergeConfig or it will store the literal "abcd••••" placeholder.

## Integrations admin UI uses customFetch, NOT OpenAPI/Orval
`IntegrationsManager.tsx` (and ~17 other components) call `customFetch` directly against `/api/...`;
the integrations surface has ZERO OpenAPI entries. Adding openapi.yaml endpoints + Orval hooks for
`/api/channel-accounts*` would generate dead/inconsistent client code that nothing imports.
**Decision:** for the integrations surface, skip OpenAPI/Orval and call customFetch, matching the
existing convention. (i18n is still mandatory across all 10 locales.)
