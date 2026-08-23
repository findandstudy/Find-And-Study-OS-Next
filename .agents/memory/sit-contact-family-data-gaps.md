---
name: SIT wizard contact/family data gaps
description: Which Step-3/Step-4 SIT "Add Student" fields the CRM can vs cannot fill, and the phone→parent-mobile cross-contamination gotcha.
---

# SIT Add-Student wizard — contact/family field data availability

The SubmitProfile type and the CRM `students` table provide ONLY these
contact/family fields: `address`, `phone`, `fatherName`, `motherName`.

There is NO CRM data for: city, state/province, postalCode, country of
residence, father/mother job, father/mother mobile. Do NOT fabricate values
for these — if the SIT wizard marks any of them required(*), that is a
data-sourcing gap (CRM has no column), not an adapter bug. The walker's FORM
DUMP + inline-error diagnostics will surface which are actually required.

**Country default:** the only derivable field. Fill Step-3 "Country" with the
applicant's nationality country via `toEnglishCountryName(profile.nationality)`
(select→text fallback, mirroring the nationality control).

**Phone cross-contamination gotcha:** the phone label regex `/phone|mobile/i`
also matches a Family-step "Father's / Mother's Mobile". The walker attempts
every field on every step, so an ungated phone fill leaks the STUDENT's phone
into a parent mobile field on Step-4.

**Why:** the walker re-runs all field fills per step; unanchored labels bleed
across steps.

**How to apply:** gate phone as fill-once via `everSet` (add "phone" after the
first successful fill; it is not a `critical`/`mark` name so no BULUNAMADI
side effect). Same caution for any future unanchored contact label.

## Id-less TEXT/TEL fields need form-item scoping too (not just selects)

SIT's shadcn controls carry NO id and no `label[for=]`/wrapping-label, so
`getByLabel`/`getByPlaceholder`/`resolveControl` all MISS them — this bites
text/tel inputs, not only the selects. The Step-3 "Mobile" is an intl phone
widget whose visible input has a *format-example* placeholder (not `/mobile/`),
so it silently failed to fill while "Email" (matching placeholder) worked.

**Fix:** `fillField` has a final fallback that scopes by `formItemByLabel` and
fills `input[type=tel]` first, then the first visible text-like input, then a
textarea; `.type()` covers widgets that ignore `.fill()`; verify `inputValue()`.

**Why:** label association is unavailable, so only wrapper-scoping reliably
reaches the control.

**How to apply:** any "field didn't fill" on SIT (or a similar id-less shadcn
form) → suspect label association, reach via the form-item wrapper, not by label.
