---
name: edcons i18n conventions
description: How translation keys work in the EduConsult (artifacts/edcons) web app and the conventions to follow when adding/using them.
---

# edcons i18n conventions

Translations live in `artifacts/edcons/src/lib/i18n/translations/*.json`, accessed via `const { t } = useI18n();` then `t("namespace.key")`.

## Add new keys to BOTH en.json and tr.json
There are ~10 language files, but only `en.json` and `tr.json` are maintained. The other 8 languages fall back to English by design.
**Why:** the i18n resolver returns the English value when a key is missing in the active language, so a new key only needs en + tr to be fully functional for the Turkish user; adding it to all 10 is unnecessary churn.
**How to apply:** when introducing any new UI string, add the key to `en.json` and `tr.json` only.

## Constant-driven labels (CHANNEL_META / CATEGORY_LABELS / RECIPIENT_LABELS, etc.)
Components like `NotificationRulesManager.tsx` render labels from module-level constant maps. Those constants are NOT reactive to language. Translate at the render site with a dynamic key derived from the map key, e.g. `t(\`notificationRules.cat_${cat}\`)`, keeping the constant only as a presence/existence guard.

## `t` shadowing in `.map()` loops
A common bug: `tabs.map(t => ...)` shadows the i18n `t` function inside the callback. Rename the loop variable (e.g. `tab`) whenever you need `t()` inside the iteration body.
