---
name: Direction-aware null-last sort
description: Why negating a null-aware comparator floats nulls to the top in descending order, and the correct pattern.
---

# Direction-aware sort with nulls always last

When a sortable table cycles asc→desc and wants null/empty values to stay at the
bottom in BOTH directions, do NOT build one null-aware ascending comparator and
negate its result for descending (`return dir === "asc" ? r : -r` applied to a
comparator that already returned ±1 for nulls). Negation flips the null verdict
too, so nulls jump to the top in descending order.

**Why:** the null placement is not part of the value ordering — it is a separate
"missing rows go last" rule. Negating the whole comparator incorrectly couples
the two.

**How to apply:** handle nulls first and unconditionally (null → `+1`, other →
`-1`, both null → `0`), and apply the direction flip ONLY to the comparison of
two populated values. Also normalize "missing" to `null` (not `""`) in the value
extractor, or empty strings sort as a real value ahead of populated ones.
