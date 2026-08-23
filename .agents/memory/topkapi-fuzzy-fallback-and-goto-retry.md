---
name: Topkapi fuzzy program-match fallback + goto retry
description: Address-guard, domcontentloaded/retry goto helper, and synonym-aware fuzzy program matching added on top of the shared matcher — how they're wired and why exports were added to programMatch.ts
---

Three residual Topkapi bugs fixed without touching other adapters:

1. **Address guard**: worker's `buildProfile` call site never passes an empty
   string for `address` (portal-adapters' `profile.ts` REQUIRED_FIELDS treats
   it as mandatory) — falls back to `student.address?.trim() || nationality
   || "-"` with a `console.warn`, mirroring the existing motherName/fatherName
   pattern. Students schema has no separate `city` column.

2. **Post-login navigation timeouts**: `gotoAndWait(page, url, readySelector,
   logger)` helper (domcontentloaded, 60s timeout, `waitForSelector`, 1 retry)
   replaces the `/panel/applications/add` gotos in both `submit()` and
   `listPrograms()`. Pre-login gotos were intentionally left alone (timeout
   was only observed post-login).

3. **Program matching**: the shared `matchProgram()` in `programMatch.ts`
   (used by SIT/United/Altınbaş too) under-scores terse portal labels like
   "Siber Güvenlik Tezsiz (Türkçe)" against verbose CRM names like "Master of
   Cyber Security (Non-Thesis) (Turkish)" — filler tokens (master/of/non)
   dilute the Jaccard score below its threshold. Rather than editing the
   shared matcher (risk to other adapters), Topkapi runs a **local-only**
   fallback when `matchProgram()` returns null: strips degree-prefix +
   parenthetical/variant-word noise, then scores by synonym-expanded token
   overlap (Jaccard ∪ containment) with its own conf/margin gate.

**Why `programMatch.ts` gained new exports** (`hasThesisMarker`,
`hasNonThesisMarker`, `expandProgramTokens`, plus the already-exported
`parseTrack`/`fold`): the fuzzy fallback needs the SAME thesis/track hard
filter and the SAME EN↔TR synonym dictionary (e.g. cyber↔siber,
security↔güvenlik) as the primary matcher, or subject-word overlap silently
scores 0 and every fuzzy match fails. These are **pure additive re-exports of
existing internal functions with zero behavior change** — safe even under a
"don't touch programMatch.ts" constraint, since SIT/United never call the new
names and `matchProgram()`'s own logic is untouched. Duplicating the ~150-line
synonym dictionary locally in the adapter was rejected as a drift risk.

**How to apply**: if another adapter needs a similar noise-tolerant fallback
matcher, reuse this same pattern (local fallback function + additive exports
from `programMatch.ts`) rather than forking the synonym dictionary.

## Follow-up: portal switched country selects to English-only

Topkapı's `resolveCountry()` always returns a **Turkish** country name (the
portal used to be Turkish-only). At some point the countryOfBirth/
nationality/addressCountry AND the Step-3 `applicationEducationInformation
Country[]` selects switched to **English-only** option text — matching the
Turkish name against them silently fails (value stays `"0"`), and Topkapı's
Step-2 "Next" rejects the whole step with a generic "Please check field(s)"
jconfirm (no per-field detail). Fix: translate the Turkish name to English
(`TR_TO_EN_COUNTRY` dict + `normalizeTr` fold, keyed to cover every possible
`resolveCountry()` output) and pass `[countryEn, country]` as ordered
candidates into the existing `selectByCandidatesVerified()` (exact-fold match
first, then substring, verified read-back, retries, clear "tried X vs
options Y" log) — reused as-is rather than writing new select/verify logic.
**Why:** the portal's language for a given field can drift over time (it has
before), so trying English first with Turkish as a same-call fallback is
more robust than hardcoding one language.
