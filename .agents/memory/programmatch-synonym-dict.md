---
name: programMatch built-in synonym dictionary
description: Rules/constraints for editing the EN↔TR SYNONYM_GROUPS in the portal program-name matcher.
---

# programMatch built-in synonym dictionary

`lib/portal-adapters/src/programMatch.ts` → `SYNONYM_GROUPS: readonly string[][]`
is the cross-portal EN↔TR equivalence dictionary used by `matchProgram()` for ALL
portals (Topkapi, SIT, etc.). DB/panel synonyms only EXTEND it (passed as the
`synonyms` arg; never replace built-ins).

**Rules when adding groups:**
- Tokens MUST be in `fold()` form: lowercase, Turkish chars mapped to ASCII
  (ü→u, ş→s, ı/İ/I→i, ç→c, ö→o, ğ→g), single words only. Multi-word/hyphenated
  tokens (e.g. "fine-arts", "non-thesis", "public-finance") NEVER match because
  `tokenize()` splits folded names on spaces — they are silent no-ops. Drop them
  or split into single tokens.
- Tokens must be length > 1 (`tokenize` filters length ≤ 1). Short ones like
  "ic" (interior), "dis" (dental) are fine at length 2.
- `buildSynonymMap` unions synonyms per token, so a shared "hub" token bridges
  groups — appending a new group that reuses an existing token still works
  (no need to edit the existing group). Appending is preferred over editing so
  existing entries stay untouched.
- Expansion is FALLBACK-only (runs when primary Jaccard finds nothing), gated by
  conf ≥ 0.6 AND (single candidate OR margin ≥ 0.15). This limits false-positive
  blast radius from generic tokens (ozel↔special where özel can mean "private",
  ilk↔first, yeni↔new, insan↔human). Acceptable but watch real portal logs.

**Why:** `programMissing` rises when a CRM program name in one language can't
reach the portal option in the other language; the dictionary is the cross-lingual
bridge. Format mistakes (spaces/hyphens) compile fine but silently never match.

**Test gotcha:** `scripts/test-program-match.ts` SYN-DB1 asserts a term is ABSENT
from built-ins to prove DB synonyms extend the dict. If you ADD that term to
built-ins, retarget SYN-DB1 to a still-absent pair (currently underground/yeralti
+ mining/maden). Consumers import from `src` directly (package `exports` → src),
so no `tsc -b` dist rebuild is needed for the dictionary to take effect.
Pre-existing tsc errors in `universities/topkapi/adapter.ts` ($eval DOM typings)
are unrelated to dictionary edits.
