---
name: Education extraction low-confidence partial-save
description: Shared gate rule for AI education extraction — low confidence never blanket-drops readable records
---

Rule: In AI education extraction, `confidence === "low"` must NEVER blanket-skip saving. A record with at least one readable field (institution/program/gpa/graduationYear/languageScore) is saved (partial-save) and flagged with the stable warning token `LOW_CONFIDENCE_EDUCATION` (response `warnings` + `extractedNotes`). Only truly empty low-confidence records are skipped. Normal/high confidence always saves (legacy behavior).

**Why:** The original FIX-15D auto-upsert skipped everything on low confidence, leaving Master applicants' Academic Information (Bachelor) empty even when fields were readable. User explicitly wants automatic profile fill, no manual buttons.

**How to apply:** Both extraction paths (the dedicated extract-education endpoint and the legacy /ai/extract-document auto-upsert) must route their save decision through the shared pure core in `educationExtraction.ts` (`decideEducationExtraction` / `decideLegacyEducationAutoUpsert`, both built on `educationRecordHasData`). Never reintroduce a confidence-based blanket skip; new extraction surfaces should reuse this core. Note: the education tables have no note column — the warning lives only in response/audit/extractedNotes.
