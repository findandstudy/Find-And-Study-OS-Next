---
name: Unmatched inbox notification rule
description: Event key rename inbox.unmatched → inbox.message_unmatched, email OFF by default, legacy row kept inert
---

The "unmatched inbound message" notification dispatches as event `inbox.message_unmatched` (channel is in the payload `data.channel`, single event for all channels). Default rule: channels `["in_app"]`, role recipients `[super_admin, admin, manager]` — email is intentionally OFF by default because the legacy `inbox.unmatched` rule (email-enabled, incl. staff role) flooded prod mailboxes (~3.3k mails, Hostinger ratelimit).

**Why:** rule-based routing (`dispatchNotification` returns early when no active rule) makes the card fully manageable in Settings → Notifications → Inbox; hardcoded channel defaults caused the flood.

**How to apply:**
- Never re-introduce or dispatch `inbox.unmatched`; the legacy notification_rules row is kept (additive migration) but is_active=false with email stripped — do NOT delete it and do NOT re-add it to DEFAULT_NOTIFICATION_RULES or the schema event catalog.
- New notification events need: schema catalog + DEFAULT_NOTIFICATION_RULES (lib/db, rebuild dist), seed.sql, boot-DDL insert ON CONFLICT DO NOTHING in api-server index.ts, and (for localized card titles) an entry in NotificationRulesManager EVENT_LABEL_KEYS + `notificationRules.event_*` keys ×10 langs (older rules render English DB name verbatim).
