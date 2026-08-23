---
name: i18n key parity (edcons)
description: How to validate that all locale JSONs fully cover en.json keys, and the letter-filter trap
---

# i18n key parity for edcons translations

`getTranslation(lang, key)` falls back to en when a key is absent, so missing keys
are silent — they only surface as English text in a non-en locale. Strict parity
(every string key in `en.json` exists in every `translations/<lang>.json`) is the
acceptance bar for "fully multilingual".

**The trap:** when extracting "needs translation" keys, do NOT filter out values
that have no Latin letters (e.g. `"—"`, `"555 123 4567"`, pure symbols/digits).
Such keys are language-neutral, but if you skip them during extraction they also
never get written into the locale files, so a strict key-parity check (which counts
ALL keys, not just letter-bearing ones) reports them missing.

**How to apply:**
- For the *translation* step, you can skip letter-less values (they don't need
  translation).
- But for the *parity/fill* step, copy EVERY missing en string key into each locale
  verbatim (letter-less values copy as-is; they're universal). Then a full-parity
  validator (all en string keys ∈ locale) returns 0 missing.
- Remaining "same-as-en" values after this are legitimate cognates (Blog, Email,
  CV, WhatsApp, Min/Max, Agent) and acceptable.
- Validate with a flatten + `enStrKeys.filter(k => !(k in localeFlat))` check per
  locale, not a letter-filtered one.

**Namespace-duplication trap:** `leadDetailPage` and `studentDetailPage` are
SEPARATE namespaces with near-identical doc-table keys (`tableFile`, `tableType`,
`tableUploaded`, `preview`, `download`). A grep for `tableFile`/`preview` returns
BOTH; the first match is usually `studentDetailPage`, not `leadDetailPage`. When
adding a key for `t("leadDetailPage.X")`, confirm the namespace boundary (find the
nearest `^  "<ns>": {` opener above the insert line) before editing — inserting in
the wrong namespace renders the raw key. To get correct per-locale values cheaply,
copy them from the sibling namespace that already has them (e.g. studentDetailPage).
