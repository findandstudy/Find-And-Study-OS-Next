---
name: Academic levels dual helpers + applied-level ranking
description: Frontend copy of academicLevels helpers must stay in sync with lib/db; applied-level derivation must be order-independent.
---
- `artifacts/edcons/src/lib/academicLevels.ts` is a hand-copied browser version of `lib/db/src/academicLevels.ts` (db package isn't browser-importable). Any change to groups/levels/required-fields must be made in BOTH.
- **Why:** silent drift shows wrong required education records in Student Detail / apply flows.
- Applied level for a student with multiple applications must be derived by ranking academic group (C=PhD > B=Master > A=other) — a `.find(first truthy)` under-selects depending on array order (architect-flagged regression).
- **How to apply:** any UI deriving "applied level" from an applications array should reuse `academicGroupForLevel` ranking.
