---
name: Inbox bot lead capture concurrency & template convention
description: Why bot-driven lead/document writes must be advisory-lock serialized, and how the re-engagement template is resolved without touching the ai_agent OpenAPI config.
---

# Inbox bot funnel-advance (lead capture / docs / re-engagement template)

## maybeAutoReply is fire-and-forget — bot DB writes must self-serialize
`maybeAutoReply` is invoked as `void maybeAutoReply(cand).catch(...)` in `routes/webhooks.ts`, so two
inbound messages (same or different conversations) can run lead capture **concurrently**. The
`bot_last_handled_message_id` idempotency claim only stops re-handling the *same* message — it does
NOT serialize different messages for the same person.

**Rule:** any bot-path write that must be unique-per-identity needs a Postgres advisory lock, not just
select-then-insert.

**How to apply (in `lib/inbox/leadCapture.ts`):**
- Lead create: collect EVERY available identity key (`email:<lower>`, `phone:<phoneE164>`,
  `phone:<normalizedPhone>`), dedup via Set, **sort** them (deterministic acquisition order ⇒ no
  deadlock), and `pg_advisory_xact_lock(LEAD_CAPTURE_LOCK_NS, hashtext(key))` for EACH inside the tx.
  Then re-check inside the lock by `phoneE164 OR lower(email) OR normalized leads.phone` — the recheck
  must cover the SAME identifier surface as the locks, or an email-only worker and a phone-only worker
  lock different keys and both insert. If a dup is found, enrich (fill-empty + forward-only advance)
  instead of inserting.
- Document insert: `pg_advisory_xact_lock(DOC_CAPTURE_LOCK_NS, hashtext("wa:"+mediaId))` + recheck per row.
- **Why not a unique index?** `documents.file_key` is a shared column that may already hold dup/null
  keys in prod; adding a UNIQUE index risks failing on existing data. Advisory locks are prod-safe and
  need no schema change. (Established pattern already used in `routes/inbox.ts`, `missingDocsFulfillment.ts`.)

## Re-engagement template resolved by convention, NOT via ai_agent config
Outside the WhatsApp 24h window the bot must send an approved template, not free-form text. The template
is resolved from `message_templates` by convention (`isActive`, `category='reengagement'`, channel in
whatsapp/all, `externalTemplateName NOT NULL`, newest first) — it is deliberately NOT added to the
`ai_agent` config object.
**Why:** the ai_agent config has a strict OpenAPI schema; adding a field forces codegen + generated-lib
(`api.schemas.ts`) + dist rebuilds and risks drift. Consuming an existing table avoids all of that.
If NO active template exists, the bot DEFERS (no send) — this preserves backward compat with the prior
"outside-window ⇒ no send" behavior.
