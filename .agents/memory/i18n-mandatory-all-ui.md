---
name: i18n mandatory for ALL UI text
description: Every user-visible string in edcons must go through t(); never hardcode any language in JSX. 10 supported languages must all have the key.
---

# i18n: NEVER hardcode user-visible strings

## Rule
Any string that appears in the UI — labels, messages, placeholders, helper text — MUST use `t("namespace.key")` or `t("namespace.key", { var: value })`. Never write a raw string literal inside JSX where users can see it.

## Supported languages (all 10 must have the key)
`en`, `tr`, `ar`, `fr`, `ru`, `fa`, `zh`, `hi`, `es`, `id`

Files: `artifacts/edcons/src/lib/i18n/translations/<lang>.json`

## Interpolation format
Translation value: `"Created by: {name}"`  
Usage: `t("ns.key", { name: someValue })`  
The `getTranslation()` engine replaces `{name}` with `String(someValue)`.

## Namespace convention
- `staffDash.*` → Staff Dashboard strings
- `adminDash.*` → Admin Dashboard strings  
- `common.*` → shared across pages

Both `staffDash` and `adminDash` typically need the same string added separately (they're different namespaces in the same JSON files).

## Adding a new key (required steps)
1. Add the key to ALL 10 JSON files (use a Python script for consistency — see below).
2. Update the component to use `t("ns.key")` instead of the hardcoded string.
3. Never rely on English fallback for production UI — the fallback is only a safety net for missing keys.

## Python script template for adding keys
```python
import json
translations = {
    "en": {"myKey": "English text"},
    "tr": {"myKey": "Turkish text"},
    # ... all 10 languages
}
base = "artifacts/edcons/src/lib/i18n/translations"
for lang, keys in translations.items():
    path = f"{base}/{lang}.json"
    with open(path) as f: d = json.load(f)
    for ns in ("staffDash", "adminDash"):  # whichever namespaces need it
        if ns in d:
            d[ns].update(keys)
    with open(path, "w") as f: json.dump(d, f, ensure_ascii=False, indent=2)
```

**Why:** The system has 10 UI languages (EN/TR/AR/FR/RU/FA/ZH/HI/ES/ID). Users select their language in Settings → Language & Region. Hardcoded strings break non-English users and are flagged as bugs immediately.

**How to apply:** Before writing ANY JSX string that a user will read, look up or create a t() key. This includes: button labels, column headers, helper text, metadata lines, status strings, error messages.
