---
name: Identity validation single source
description: Where passport/name/date identity validation lives and the layered guard chain for real portal submissions
---

**Rule:** All identity-field rules (passport number, names, DOB/issue/expiry consistency) live ONLY in `@workspace/portal-adapters` (`identityValidation.ts`), including `parseFlexibleDate` + `isPassportExpired`. The api-server's `passportValidity.ts` is a pure re-export — never re-implement these in api-server or the worker.

**Why:** Duplicated date parsers/validators drifted before; these values are typed into REAL university portals, so one divergent copy silently submits wrong data.

**How to apply:**
- Turkish staff messages + severity (error/warning) layer = api-server `criticalFieldValidation.ts`, keyed by the shared `code` (`IdentityErrorCode`) — never match on English reason text.
- Guard chain (all must stay): Gate 5 in portalAutoTrigger (enqueue), worker runner.ts guard 2.5, and the LAST defense in portal-runner `profile.ts buildStudentProfile` (gated `sub.mode === "real"`, throws `[VERİ DOĞRULAMA] ...` before document download/browser). Dry runs and `buildProfileFromApplication` are intentionally unblocked.
- Passport length counts STRIPPED chars (spaces/hyphens ignored, 5–12) so Russian "76 7365488" formats pass; placeholder regex has unanchored `fixture|placeholder` to catch e2e fixture values; CNIC and >10 pure-digit checks run BEFORE charset/length so they get the specific "national ID" code.
- Expired passport is a WARNING in criticalFieldValidation (the FAZ 2 expiry gate owns blocking).
