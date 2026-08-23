---
name: Widget JS regex escaping inside template literal
description: The embed widget client JS is a JS template literal, so every regex backslash must be doubled in source or it silently de-escapes (or crashes).
---

The embed lead-capture widget's client JavaScript is emitted from a **JS template literal** in `artifacts/api-server/src/routes/embed.ts` (generateWidgetHTML). Anything written in the static (non-`${}`) parts of that literal is template-cooked before it reaches the browser.

**Rule:** every regex escape in that static widget text must use a DOUBLE backslash in source (`\\p{L}`, `\\d`, `\\D`, `\\.`), because the template literal drops a single backslash:
- `` `\p{L}` `` → `p{L}` → emitted `/p{L}/u` = **parse-time SyntaxError** ("Invalid regular expression: Incomplete quantifier") → the whole widget `<script>` fails to load → zero leads captured.
- `` `\d` `` / `` `\D` `` / `` `\s` `` / `` `\.` `` → `d`/`D`/`s`/`.` → VALID regex but semantically wrong (e.g. `.replace(/\D/g,'')` phone-strip silently becomes `/D/g`, matching only the letter D). No crash, so it hides.
- `` `\u` `` and `` `\b` `` are *recognized* template escapes (unicode / backspace) — different failure mode, watch out.

**Why it hid so long:** only `\p{L}` crashes (parse-time). The de-escaped `\d`/`\D` phone strippers were broken for as long as they existed but server-side `normalizePhoneField` compensated, so leads still landed.

**How to apply:**
- Fix = double the backslash on every mis-escaped regex in the STATIC widget text (crash `\p` AND the silent `\d`/`\D` class — same root cause).
- Do NOT touch backslashes inside `${...}` interpolations — those are real server-side TS regex literals (e.g. `${JSON.stringify(x).replace(/<\/script/gi,...)}` is correct as single-backslash).
- Verify by curling the live widget (`/api/public/embed/<slug>/widget`) and grepping the served JS: want `/\p{L}/u`, `/\D/g`, ZERO naked `/p{L}/u` or `/D/g`. A node snippet also proves it deterministically: `` `\p{L}` `` → `"p{L}"`.
- Restart the `api-server` workflow after editing so the updated widget JS is served.
- Server-side `textNormalize.ts containsNonLatinLetter` uses `/\p{L}/u` correctly (real regex literal, not in a template literal) — leave it alone.
