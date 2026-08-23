---
name: i18n namespace copy-paste gap
description: Keys added to one i18n namespace are silently absent from others and from non-en language files.
---

## Rule
When adding a new i18n key to any component, you must add it to **every namespace that uses it** AND to **all 10 language files** simultaneously.

**Why:** `getTranslation()` falls back to `en` silently when a key is missing in another language. But if the key is missing from `en` itself (or from the wrong namespace), the console logs `[i18n] Missing translation key: "ns.key" (lang=en)` — which only shows up in the browser, not during `tsc`.

**Common gap pattern:** A key (e.g. `allCities`) is added to `programs` namespace for one feature, then a new page uses `catalogPage.allCities` — but no one copies it to `catalogPage` in any of the 10 lang files.

**How to apply:**
1. Grep for the key across all namespaces: `grep -r "allCities" artifacts/edcons/src/lib/i18n/translations/`
2. If found in one namespace but not the target, copy the values to the target namespace in all 10 lang files using a Python script (load JSON, insert key after sibling key, dump with `ensure_ascii=False, indent=2`)
3. Check browser console after HMR reload for `[i18n] Missing translation key` warnings

**Discovered:** `catalogPage.allCities` was missing from all 10 lang files despite `programs.allCities` existing everywhere.
