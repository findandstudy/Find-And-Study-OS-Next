---
name: SIT program language safety (no full-catalog fallback)
description: Why SIT createApplication must NOT fall back to the full program catalog when language filtering empties the candidate pool
---

In the SIT portal adapter `createApplication()`, programs are filtered by
`isLanguageCompatible(desiredName, candidateName)` before fuzzy matching. Do NOT
fall back to the unfiltered catalog when the language-compatible set is empty.

**Rule:** if the catalog is non-empty but every candidate is language-filtered
out, return `programMissing: true` with an explicit reason — never match against
the full catalog.

**Why:** `isLanguageCompatible` only drops a candidate when BOTH the desired and
candidate languages are *detected* AND differ (a null/undetected language on
either side is treated as compatible). So an empty compatible set means a real
language conflict (e.g. desired English while only Turkish is offered). Falling
back to the full catalog let fuzzy matching pick a wrong-language program and
submit it — a wrong application. Code review flagged this as blocking.

**How to apply:** keep `pool = langFiltered` (not `langFiltered.length ? langFiltered : catalog`).
The language-agnostic case is safe automatically: when the desired name has no
detectable language, every candidate is compatible, so `langFiltered === catalog`
and the guard never fires. Empty catalog also stays correct — the guard is gated
on `catalog.length > 0`, and an empty pool then fails matching → programMissing.
