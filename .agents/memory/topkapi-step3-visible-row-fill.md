---
name: Topkapı Step 3 visible-row text inputs
description: Why Step-3 education text inputs (schoolName/gpa/graduationDate) fill empty and how to fill them reliably.
---

# Topkapı Step 3 visible-row text inputs

The education-history fields use repeatable `name="...[]"` selectors
(`applicationEducationInformationSchoolName[]`, `...GPA[]`,
`...GraduationDate[]`). The portal renders a HIDDEN template row alongside the
VISIBLE row, both matching the same name. A bare `querySelector` / `page.fill` /
`$eval` targets the FIRST match = the hidden template, so the value never lands
on the real field and the read-back is always empty ("empty after retry").

**Rule:** locate the VISIBLE instance and fill+verify the SAME element handle.
- `locateVisibleInput` scans every selector's matches, logs `count` +
  `visibleIndex` (diagnostic proof of the hidden-template theory), returns the
  first `:visible` `Locator.nth(i)` (falls back to `.first()`).
- `fillVisibleVerified` fills via `Locator.fill()` then verifies via the SAME
  `Locator.inputValue()`; on empty it falls back to `setValueViaEvents`
  (focus → value → input&change `{bubbles:true}` → blur) for twopulse binding;
  retries once.

**graduationDate is a twopulse-datepicker** (native `type="text"`, class includes
`twopulse-datepicker twopulse`), so `formatGraduationForInput` (year-only) gets
silently cleared. Detect via `/datepicker/i.test(describeInput().desc)`, read
`data-date-format` with `readDatepickerFormat` (also logs `outerHTML` + `data-*`),
then expand the year with `formatGraduationForDatepicker` (default `01.01.YYYY`).
Datepicker fill path clicks the field, sets via events, and presses **Escape** to
dismiss the calendar overlay so it can't block later steps.

**Why:** plain assignment / `page.fill` on the hidden template + bare-year value
on a jQuery datepicker were the two distinct causes of the empty-field gate.

**Do NOT break:** the select2 fields `educationLevel` (applied-degree value) and
`country` already work via the in-page jQuery val+trigger path — unrelated to this
text-input fix.
