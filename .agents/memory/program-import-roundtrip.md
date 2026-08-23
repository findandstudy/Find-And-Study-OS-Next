---
name: Program import/export round-trip
description: Bulk program Excel import must accept the exporter's friendly headers; universities auto-created by name with strict gating.
---
Rule: any bulk importer must round-trip the system's own export unchanged. The program exporter writes friendly headers (`Program`, `University`, `Fee Type`, …) while the import row schema uses camelCase keys — `normalizeProgramImportRows()` (api-server lib/programImportHeaders.ts) alias-maps them case-insensitively before validation. Explicit internal key wins over an alias, but a BLANK explicit cell doesn't block the alias.

**Why:** regression where the system could not re-import its own export ("missing universityId / universityName" on every row); users can never supply internal IDs.

**How to apply:** when adding export columns or new import fields, update the alias map + the exporter together, and keep the round-trip unit test (test-program-import-headers.ts) green. University auto-create (`collectUniversitiesToCreate`) must only run for rows with a non-empty program name — failed imports must not pollute the universities catalog; dedup is case-insensitive+trim; Country column optional → "Unknown".
