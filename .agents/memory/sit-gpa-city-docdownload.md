---
name: SIT GPA integer, city fill, doc-download fallback chain
description: Zoho GPA must be int 0-100 fail-closed; SIT city from address; doc download must chain public URL → signed URL → base64
---

- Zoho gpa fields (gpa_percent etc.) accept ONLY integers 0-100; decimals (even "3.0") → INVALID_DATA: High_School_GPA. normalizeGpa (sit/helpers.ts) rounds+clamps; never send a default GPA — skip the field + warn (fail-closed) when non-numeric.
- **Why:** the old SCHOOLFIX "3.0" decimal default was itself the cause of the Zoho error.
- SIT Contact & Location city has no CRM column; derive from address via deriveAddressParts(address).city, fill best-effort (never block the step).
- Doc-download in BOTH profile builders (portal-runner + worker) must try candidates in order: docFetchUrl public URL → buildSignedDocumentPath signed retry → base64 fileData, with per-attempt logging (doc id/slot/HTTP status). A single stale public fileUrl failing must NOT skip the base64 fallback — that was the "zero-doc create blocked" root cause.
- **How to apply:** any new download path or third profile builder must replicate the full candidate chain, not just path A.
- portal-adapters/portal-runner export src directly (noEmit:true) — no dist rebuild; full tsc -b fails on pre-existing errors in emu/okan/topkapi/united adapters (unrelated).
