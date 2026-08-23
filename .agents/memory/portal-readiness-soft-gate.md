---
name: Portal readiness SOFT gate
description: Portal compatibility layer — informational readiness only, never blocks submission
---
Rule: portal readiness (field matrix in lib/db/src/portal/*, computeReadiness in api-server) is display-only. Missing/incompatible fields surface as badges/warnings; NO enqueue/submit path may hard-block on it.

**Why:** Build prompt mandated soft gate — manual path stays unlimited; hard blocking would strand edge-case students.
**How to apply:** New UI surfaces consuming /students/:id/portal-readiness must render warnings only. If Submission Board grows, batch the per-row readiness fetch (known N+1) instead of gating server-side. fatherJob/motherJob intentionally SKIPPED (not in CRM); countryOfResidence falls back to nationality, city derived via cleanCity(address). GPA is integer 0–100 everywhere (normalizeGpaInteger / AI extract rounds).
