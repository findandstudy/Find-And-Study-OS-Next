---
name: Portal program mapping bulk Excel import
description: Per-university Excel template + import that upserts CRM program → portal option value into portal_program_mapping.programOverrides.
---

# Bulk Program Mapping via Excel (portal-automation)

Two raw-xlsx endpoints on portalAutomation.ts:
- GET `/portal-automation/universities/:key/program-template.xlsx` — one row per CRM program (crm_program_id required) + empty `portal_value`.
- POST `/portal-automation/universities/:key/program-import` — raw xlsx body, `raw({type, limit:"2mb"})`, returns `{ applied, skipped, errors:[{row,reason}] }`.

## Rules baked in
- Import is **merge-upsert** (`{...existing.programOverrides, ...toApply}`) — NEVER deletes existing overrides.
- Empty `portal_value` rows are **skipped**, not errored. Missing id → `MISSING_CRM_ID`; unknown value → `INVALID_PORTAL_VALUE`.
- `NO_LIVE_OPTIONS` 400 when portal_program_cache is empty. Live options come from the cache ONLY — no headless fetch in the request path (autoscale OOM lesson).
- A `portal_value` matches by exact option `v` OR by folded label `t`.

**Why canonicalize:** a folded-label match must be stored as the option's `v`, NOT the submitted string. Storing "isletme" instead of "111" silently breaks the "CRM id → portal value" contract that downstream submission reads. Build a `foldedToValue` map (first fold wins) and persist `canonical`.

## Conventions
- Binary xlsx endpoints follow the agents/embed/website convention: raw paths via customFetch, NOT OpenAPI/orval. Those endpoints are intentionally absent from the spec; no orval regen.
- The Program Mapping UI tab is `PortalProgramMappingTab.tsx` (not PortalAutomation.tsx).
- foldProgramValue: Turkish letter map (dotted/dotless i, ç ğ ö ş ü) + NFKD + strip non-alnum.
- Excel schema lives in exportImportExcel.ts: PROGRAM_MAPPING_KIND / PROGRAM_MAPPING_SHEET / programMappingColumns (header==key, all "string").
