---
name: buildProfile HARD vs SOFT required fields
description: Why a missing soft CRM field (address/phone/parent names/gender) must never crash an entire portal submission build.
---

`buildProfile()` in `lib/portal-adapters/src/profile.ts` splits its
required-field check into `HARD_REQUIRED_FIELDS` (email, passportNumber,
firstName, lastName, dateOfBirth, nationality, level, programName, programId
— throws a clear "eksik veri: <field>" message when missing, since the
submission is meaningless without them) and `SOFT_FIELDS` (gender, fatherName,
motherName, address, phone — degrade to a logged fallback: parent
name/phone/gender → `""`, address → nationality or `"-"` as last resort).

**Why:** real CRM data commonly has blank address/phone/parent-name/gender,
and throwing on any of them was killing the ENTIRE portal submission across
multiple universities (Istinye/Topkapı/SIT "missing required field address",
Topkapı "motherName", United "passportNumber") — the same
degrade-gracefully-never-crash-the-whole-build philosophy already used for
GPA/graduationYear (`normalizeGpaRange`/`firstFiniteNumber`) now applies here.

**How to apply:** when adding a new profile field, decide HARD (no reasonable
fallback exists → add to HARD_REQUIRED_FIELDS, keep the throw) vs SOFT
(a reasonable fallback exists → add to SOFT_FIELDS with an explicit fallback +
`logger.warn`). Never add a field to the plain unconditional-throw path again.
