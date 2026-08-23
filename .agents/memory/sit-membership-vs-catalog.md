---
name: SIT membership vs catalog
description: Why being in the SIT catalog is not the same as being a SIT member, and how the runner enforces it without a migration.
---

# SIT membership guard

Being present in the SIT **catalog** (zoho_universities / zoho_programs) is NOT the
same as being a SIT **member** for FAS. Members are the universities FAS actually
applies to *through the SIT channel* — the agreed `SIT_ALLOWLIST` (11 unis). Some
universities are applied to **directly** via their own panels (e.g. Altınbaş /
İstanbul Okan / Üsküdar) and must never have anything created in SIT.

- `isSitMember(name)` (portal-adapters `sit/helpers.ts`) = union of `isAllowedUniversity`
  (agreed allowlist, token-set matched) + optional env `SIT_MEMBER_UNIVERSITIES`
  (comma/semicolon/newline separated). Env can only **extend**, never shrink. Exported
  from the package index so the runner can import it.
- Runner guard runs at **step 1.5** (after adapter resolve, BEFORE creds/login) only when
  `adapter.key==="sit"` and `SIT_ENFORCE_MEMBERSHIP !== "false"` (default ON). Non-member →
  return early with `skippedNotMember:true, routeTo:"direct"` and NO login/student/application.

**Why:** creating a student/application in SIT for a non-member pollutes the SIT panel and
routes an application down the wrong channel; must be prevented preventively, before any write.

**How to apply:** membership is checked against `profile.universityName ?? submission.universityName`.
For **aggregator member routing**, the profile builder already overrides `universityName` to the
member name (from submission meta `targetUniversityName`), so the guard sees the member — keep it
that way or aggregator members get wrongly skipped.

**No-migration constraint:** `portal_submission_status` is a pg enum; adding a value needs a
migration (forbidden). So `stageWriteback` maps `skippedNotMember` to the existing terminal status
`exclusive_region`, and keeps it distinguishable via `meta.reason="SIT üyesi değil"` + `meta.routeTo`
+ error text (checked BEFORE the exclusiveRegion branch). Do not confuse it with a nationality
exclusion — the meta reason is the discriminator.

## SIT member universities (report to user)
Haliç, Atlas, Ankara Medipol, Galata, Beykoz, İstinye, İstanbul Aydın, İstanbul Kent,
Fenerbahçe, İstanbul Kültür, TED. (TODO(user): confirm the definitive list.)
