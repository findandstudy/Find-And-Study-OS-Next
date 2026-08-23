---
name: SIT Step-2 id-less controls & custom date widgets
description: Why SIT Add-Student Step-2 Gender/Nationality/date fields come back BULUNAMADI and how to resolve them
---

# SIT "Add Student" wizard — Step-2 field resolution

**Rule:** SIT's shadcn form controls (Gender/Nationality `<select>`, and the date
fields) carry **no `id`**, so `resolveControl()`'s `label[for=id]` / wrapping-label
association returns null and the field is never filled → live run logs BULUNAMADI.
Resolve them by scoping to the labelled wrapper instead:
`div[data-slot="form-item"]` that `has:` a `label[data-slot="form-label"]` matching
the question (the SAME pattern the working Step-1 Radix toggle fix uses). Helper:
`formItemByLabel(page, labelRe)` in the SIT adapter.

**Why:** the FORM DUMP (`$$eval` over `input/select/textarea`) showed Gender/
Nationality as `<select>` with empty `id`, and the date fields did **not appear at
all** — meaning they are custom NON-input components (button/calendar popover),
not `<input>`s. Any input-only helper silently misses them.

**How to apply:**
- Selects: read `select.options`, match an anchored `optionRe` against option
  text OR value, skip disabled/empty-placeholder options, `selectOption` + verify
  `select.value`.
- Nationality: CRM stores the country in **Turkish** ("Özbekistan") but the
  wizard's select carries **English** option text ("Uzbekistan"). Translate with
  `toEnglishCountryName()` (helpers.ts — Turkish-fold + TR→EN map, mirrors
  Topkapı's; returns the raw name unchanged on a miss). Build an **anchored**
  regex `^\s*(EN|raw)` so "Samoa" can't match "American Samoa". On a miss, log the
  live option texts (`[sit] nationality opt eşleşmedi …`) instead of a silent fail.
- Gender regexes must stay anchored (`^\s*(male|erkek)\s*$`) or `male` substring-
  matches `Female`.
- **Dates = popover calendar, NOT inputs.** Each date field is a
  `button[data-slot="popover-trigger"]` opening a shadcn Calendar
  (react-day-picker). `setDateField` drives it via `fillPopoverDate`: open trigger
  → set date by (a) writable popover input, (b) month/year `<select>` dropdowns +
  day click, (c) chevron month-nav + day click → verify. Durable gotchas that
  cost correctness here:
  - **Scope the popover to the trigger that opened it**, never a global
    `.first()` — Radix content is portaled to `<body>`, so resolve via the
    trigger's `aria-controls` (then open-state content) or a stray popover hijacks
    the fill.
  - **Verify the day AND year, not just the year** — a wrong click within the
    same year otherwise passes. Trigger-text format is unknown, so assert
    word-boundary day + year tokens (format-agnostic).
  - **Day-cell click is ambiguous in multi-month views** — filter outside/disabled
    cells; if a day number still matches more than once, only click when full-date
    metadata (aria-label/`data-day`) names the target month+year, else refuse.
  - `[sit] DATEPOP <label>: <innerHTML>` is logged once on first open so the real
    calendar shape (input vs dropdown vs chevron-only) is diagnosable live; the
    first deploy run confirms which of a/b/c actually applies.
