---
name: i18n lazy language loading
description: edcons translations are dynamic-imported per language; rules to avoid raw-key flashes and races.
---
Rule: translation JSONs (~3MB across 10 langs) load via dynamic import per language (lib/i18n/index.ts loadLanguage/isLanguageLoaded). getTranslation stays synchronous, reading an in-memory cache.

**Why:** statically importing all 10 JSONs put ~2.9MB into the main index chunk — the "site slow everywhere" regression. After the fix the index chunk is ~277KB (74KB gzip).

**How to apply:**
- I18nProvider gates the FIRST render until BOTH the active language AND English (fallback dict) are cached — otherwise partially translated locales flash raw keys.
- setLang loads the new dict BEFORE switching state, uses a last-write-wins token, and does NOT commit/persist on fetch failure.
- Any component using getTranslation with a language outside the provider's active lang (e.g. SignFlow uses the contract template's language) must call loadLanguage(lang) itself and re-render on completion.
- /ar (and possibly other RTL-prefixed public routes) rendered blank BEFORE this change — pre-existing, unrelated.

**Circular manualChunks incident:** splitting recharts/d3/victory-vendor into a `vendor-charts` manualChunk created a circular chunk (vendor-charts <-> vendor-react); build only WARNED but production crashed at runtime ("Cannot access 'S' before initialization") with blank screens on every page. Never manually chunk react-dependent heavy libs apart from react; leave recharts in its lazy route chunks. Treat any "Circular chunk" build warning as a hard failure, and always runtime-verify a production build (vite preview + headless chromium, check #root non-empty on /en /tr /ar) before shipping bundling changes. The `/ar` blank screen seen in the dev server is dev-only; the prod build renders /ar fine (dir=rtl).
