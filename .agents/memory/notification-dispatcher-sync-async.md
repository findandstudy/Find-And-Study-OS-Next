---
name: Notification dispatcher in_app-sync / email-async split
description: in_app DB insert must be awaited; email+WA must be fire-and-forget; processInbound must await dispatchNotification
---

## Rule
`dispatchNotification` has two distinct tiers:
1. **in_app DB insert** — must be `await`ed. Tests (webhook-dedup) query `notificationsTable` immediately after the webhook POST; if this is fire-and-forget the row isn't there yet and the test sees `recipients=0`.
2. **Email + WhatsApp sends** — must be fire-and-forget (`(async () => { ... })()`). SMTP rate-limits (Hostinger 451) and slow WA API calls would otherwise stall the webhook response path and cause the SMTP timeout to propagate as a test failure.

`processInbound.ts` must `await dispatchNotification(...)` (not `.catch()` fire-and-forget) so the in_app tier runs synchronously relative to the caller.

**Why:** The webhook-dedup test POST-then-immediately-SELECT pattern only works if the in_app insert is committed before the POST response returns. Making the whole dispatch fire-and-forget caused `recipients=0` for web_form (whatsapp passed coincidentally due to timing). Making only email/WA fire-and-forget (inside dispatchNotification) while keeping processInbound's `await` fixed both constraints.

**How to apply:**
- In `notificationDispatcher.ts`: wrap email block and WhatsApp block each in `(async () => { ... })()` IIFE, no `await` on those blocks.
- In any caller that needs post-dispatch assertions (tests, dedup checks): `await dispatchNotification(...)` — never `.catch()`-and-forget.
- The audit-log FK errors (`user_id=0`) from test harness calls are pre-existing noise; not related.
