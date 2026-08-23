---
name: programMatch exact-match wins + EN thesis detection
description: why an exact folded-name match must bypass the margin gate, and that tez filters must recognize English Thesis/Non-Thesis
---

# programMatch: exact-match short-circuit + EN thesis/non-thesis

Two coupled rules in `lib/portal-adapters/src/programMatch.ts` (shared by
"Submit to All" fan-out AND single-university portal submission).

## Exact folded-name match must bypass the margin gate
`matchProgram` returns `{match, conf: 1.0}` immediately if any candidate has
`fold(name) === fold(query)`, placed AFTER the empty-candidates guard but BEFORE
hard filters/scoring.

**Why:** the confidence gate rejects when the top-2 margin < MARGIN_THRESHOLD
(0.15). Near-identical siblings (e.g. "Master of Cyber Security (Thesis)" vs
"(Non-Thesis)") score ~1.0 and ~0.857, margin 0.143 < 0.15, so the matcher
returned `null` ("no program") EVEN THOUGH a conf-1.0 exact hit existed. This
inverts the intended "prefer the identical programme, else the closest" rule and
was the chronic cause of Topkapı "Program Missing".

**How to apply:** never raise/lower CONF/MARGIN thresholds to fix an exact-hit
miss — the exact short-circuit already bypasses margin. Genuine ambiguity (two
different close programs, NO exact hit) still correctly returns null.

## Thesis (tezli) / non-thesis (tezsiz) filters must be bilingual
`hasTezsiz` matches TR `tezsiz` OR EN `non thesis`/`nonthesis`; `hasTez` matches
TR `tezli` OR EN `thesis` but must call `hasTezsiz` FIRST and return false —
otherwise the `thesis` substring inside "non-thesis" is misread as tezli.
`fold()` turns "Non-Thesis" into two tokens "non thesis", so TR-only `\btezsiz\b`
silently failed on English labels and left the wrong sibling in the pool.
