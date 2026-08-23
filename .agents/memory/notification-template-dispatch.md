---
name: notification template dispatch (multilingual)
description: Design rules for the notification dispatcher's multilingual templates, email HTML safety, and delivery sequencing.
---

# Notification template dispatch

The dispatcher resolves a per-recipient localized `{subject, body}` from a template
shaped `{subject, body, translations: {[lang]: {subject, body}}}`.

## Rules
- **Field-level fallback.** Resolve `subject` and `body` INDEPENDENTLY through the
  chain `recipientLang → top-level → en → tr`. Resolving them as a single picked
  object is wrong: a translation that has only `body` would otherwise drop the
  missing `subject` straight to the generic ctx.title.
  **Why:** partial translations are common; field-level keeps each field localized.
- **Top-level is the universal fallback.** When authoring in the UI, derive the
  template's top-level subject/body from the EN translation (then TR, then first
  authored). Recipients whose language has no translation (es/fa/hi/id/zh) hit
  top-level first, so English is the safest default.
- **Escape interpolated vars in trusted-HTML email bodies.** Author HTML is
  trusted, but `{{var}}` values (e.g. senderName) are user-controlled and MUST be
  HTML-escaped before substitution into an HTML body, or it's an injection vector.
  Plain-text bodies are substituted first, then fully escaped + nl2br.
- **Channel isolation.** Each channel block (in_app / email / whatsapp), including
  its recipient query, must be in its own try/catch so one channel failing never
  aborts the others. The whole dispatch is wrapped so it never throws to callers.

## How to apply
- WhatsApp config is loaded from `integrationsTable` (key `whatsapp`) + `decryptConfig`,
  cached ~60s. `sendWhatsAppText` returns simulated success in dev unless
  ALLOW_LIVE_INTEGRATIONS/prod. Only users with `phoneE164` are messaged.
- Callers (e.g. message.new in routes/messages.ts) `await dispatchNotification(...)`
  — it's internally error-safe, so awaiting preserves the synchronous in-app
  delivery guarantee without risking a throw into the route handler.
