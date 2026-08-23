---
name: Portal↔CRM university auto-linker
description: How portal_universities.crm_university_id is auto-reconciled to CRM universities by name, and the wrong-link safety rules.
---

# Portal↔CRM university auto-linker

`portal_universities.crm_university_id` is mostly NULL in prod, and NULL excludes a
portal university from portal fan-out. A scheduled reconciler links them by
Turkish-aware NAME matching to the CRM `universities` table (only writes that one
column; never overwrites an existing link unless `force`).

## Matching stages (in order), all restricted to CRM unis with active programs
1. Exact normalized equality (transliterate TR→latin, lowercase, strip generic
   tokens like university/of/the, collapse whitespace). Ambiguity guard: >1
   distinct CRM id → unmatched.
2. Token Jaccard ≥ 0.8 AND ≥ 0.1 margin over runner-up.
3. One-way unique containment fallback: PORTAL tokens ⊆ CRM tokens, CRM has ≤1
   extra token, EXACTLY ONE such candidate, and portal norm length ≥ 5.

**Why one-way + guards:** portals abbreviate canonical CRM names by dropping a
single city/prefix word (real case: portal "Topkapi" ⊂ CRM "Istanbul Topkapi
University"), never the reverse. Jaccard alone scores that 0.5 and misses it.
Symmetric containment or bare single-token containment wrong-links (e.g. a bare
"Istanbul"); uniqueness + ≤1-extra-token + min-length keep it safe.

## Stale vs linked contract
A link is **stale**, not linked, when the CRM row is missing OR has 0 active
programs (gives fan-out nothing). The reconciler surfaces these in `stale[]`.
`GET /portal-universities` must return an explicit `linkStatus`
(linked|stale|unlinked) — do NOT infer stale from `crmUniversityName == null`,
because the name is populated even for 0-program (stale) links. The frontend
badge keys off `linkStatus`.

**How to apply:** aggregators (isMultiPortal / study_in_turkey) are intentionally
left unlinked. Manual trigger: POST /portal-automation/relink-universities
(ADMIN only). Scheduler runs hourly + ~25s after boot. Known-variant overrides
live in ALIAS_MAP (keyed by universityKey).
