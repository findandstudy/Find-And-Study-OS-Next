---
name: programMatch fold Step 7 — yuksek lisans compound normalisation
description: Why Turkish master's programs score as bachelor-matches and how fold() step 7 fixes it.
---

## The bug

Turkish portals name master's programs "Yüksek Lisans" (two words).
After fold() steps 1-6: "yuksek lisans" → tokens ["yuksek", "lisans"].
- "yuksek" has NO synonym group → ignored by expansion
- "lisans" IS in ["lisans", "bachelor", "undergraduate"] → expands to "bachelor"
Result: master's portal options acquire a "bachelor" token → false-positive matches with bachelor CRM queries.

## The fix (programMatch.ts fold() Step 7)

```ts
.replace(/\byuksek lisans\b/g, "yukseklisans")
```

Run AFTER steps 1-6 (clean ASCII). "yukseklisans" (one word) is already in:
`["yukseklisans", "master", "masters", "graduate"]`

## PROGRAM_MAP in topkapi/adapter.ts

Populated for all 11 known CRM programIds (9303, 9298, 9299, 9316, 9325, 9339,
13583, 13588, 13589, 13607, 13610) with Turkish name-based overrides.

**Why name-based, not numeric IDs:** numeric `<option value="...">` IDs require a live portal scrape (dump-program-options script). Name-based works via fold(c.name) === fold(override) equality in matchProgram().

**TODO:** Run `pnpm --filter @workspace/portal-automation-worker dump-program-options` against the live portal and replace name strings with numeric IDs for bulletproof matching.

## Verification

- fold("Yüksek Lisans") = "yukseklisans" ✅
- Simulation: 11/11 CRM programs → conf=1.00 with PROGRAM_MAP
- Before fix: 2/11 matched (one false positive); after: 11/11 correct
