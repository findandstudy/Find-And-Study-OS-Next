/**
 * Portal Uyumluluk Katmanı — Faz 3 testleri.
 * computeReadiness saf hesaplayıcısını doğrular (soft gate).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReadiness, matrixLevelForInterestedLevel } from "../src/lib/portalReadiness";
import type { Student, EducationRecord } from "@workspace/db";

function fullStudent(overrides: Partial<Student> = {}): Student {
  return {
    id: 1, userId: null, firstName: "FAIZAN", lastName: "TEST",
    email: "f@example.com", phone: "+905551112233", phoneE164: "+905551112233",
    dateOfBirth: "2004-01-15", gender: "male", nationality: "Pakistan",
    passportNumber: "AB1234567", passportIssueDate: "2022-01-01",
    passportExpiry: "2032-01-01", motherName: "Mother", fatherName: "Father",
    address: "Lahore", status: "active", agentId: null, assignedToId: null,
    branchId: null, highSchool: null, universityBachelor: null, universityMaster: null,
    graduationYear: null, gpa: null, languageScore: null, season: "2026",
    photoUrl: "/api/storage/objects/x.jpg", hasPhoto: true, interestedLevel: "bachelor",
    transferStudent: false, hasTcId: false, hasBlueCard: false, notes: null,
    nextFollowup: null, originType: "direct", originEntityType: null,
    originEntityId: null, originDisplayName: null, originLocked: false,
    originLeadId: null, deletedAt: null, deletedBy: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as Student;
}

function hsRecord(overrides: Partial<EducationRecord> = {}): EducationRecord {
  return {
    id: 1, studentId: 1, level: "high_school", schoolName: "PUNJAB COLLEGE",
    country: "Pakistan", fieldOfStudy: null, startMonth: null, startYear: null,
    endMonth: null, endYear: 2022, city: "Lahore", languageScore: null,
    gpa: "76", gpaType: "percentage", source: "manual",
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as EducationRecord;
}

const DOCS = ["passport", "transcript", "diploma", "photo"];

test("R1: matrix level derivation from interestedLevel", () => {
  assert.equal(matrixLevelForInterestedLevel("bachelor"), "high_school");
  assert.equal(matrixLevelForInterestedLevel("master"), "bachelor");
  assert.equal(matrixLevelForInterestedLevel(null), null);
});

test("R2: complete bachelor applicant → ready", () => {
  const r = computeReadiness(fullStudent(), [hsRecord()], "sit", DOCS);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.incompatible, []);
  assert.equal(r.ready, true);
  assert.equal(r.supported, true);
  assert.equal(r.level, "high_school");
});

test("R3: address-like city + missing docs → missing (soft)", () => {
  const r = computeReadiness(
    fullStudent({ address: "HOUSE NO. 165, Street 4" }),
    [hsRecord()],
    "sit",
    ["passport"],
  );
  assert.ok(r.missing.includes("city"));
  assert.ok(r.missing.includes("transcript"));
  assert.ok(r.missing.includes("diploma"));
  assert.equal(r.ready, false);
});

test("R4: decimal GPA → incompatible gpaMustBeInteger", () => {
  const r = computeReadiness(fullStudent(), [hsRecord({ gpa: "86.6" })], "sit", DOCS);
  assert.ok(r.incompatible.some((i) => i.field === "hsGpa" && i.reason === "gpaMustBeInteger"));
  assert.equal(r.ready, false);
});

test("R5: non-canonical country → incompatible countryUnmatched", () => {
  const r = computeReadiness(fullStudent({ nationality: "Pakistani-ish" }), [hsRecord()], "sit", DOCS);
  assert.ok(r.incompatible.some((i) => i.reason === "countryUnmatched"));
});

test("R6: expired passport → incompatible passportExpired", () => {
  const r = computeReadiness(fullStudent({ passportExpiry: "2020-01-01" }), [hsRecord()], "sit", DOCS);
  assert.ok(r.incompatible.some((i) => i.field === "passportExpiryDate" && i.reason === "passportExpired"));
});

test("R7: fatherJob/motherJob skipped, toggles never missing", () => {
  const r = computeReadiness(fullStudent(), [hsRecord()], "sit", DOCS);
  assert.ok(r.skipped.includes("fatherJob"));
  assert.ok(!r.missing.includes("transferStudent"));
});

test("R8: portal without a readiness matrix is marked unsupported", () => {
  const r = computeReadiness(fullStudent({ nationality: null }), [], "united", []);
  assert.equal(r.ready, true);
  assert.equal(r.supported, false);
  assert.deepEqual(r.missing, []);
});

test("R9: Altınbaş requires dedicated city/postal/visa fields", () => {
  const missing = computeReadiness(
    fullStudent({ address: "A full street address" }),
    [hsRecord()],
    "altinbas",
    DOCS,
  );
  assert.ok(missing.missing.includes("addressCity"));
  assert.ok(missing.missing.includes("postalCode"));
  assert.ok(missing.missing.includes("needsVisaSupport"));

  const ready = computeReadiness(
    fullStudent({
      address: "A full street address",
      addressCity: "Istanbul",
      postalCode: "34000",
      needsVisaSupport: false,
    }),
    [hsRecord()],
    "altinbas",
    DOCS,
  );
  assert.deepEqual(ready.missing, []);
  assert.deepEqual(ready.incompatible, []);
  assert.equal(ready.ready, true);

  const followupMissing = computeReadiness(
    fullStudent({
      address: "A full street address",
      addressCity: "Istanbul",
      postalCode: "34000",
      needsVisaSupport: true,
    }),
    [hsRecord()],
    "altinbas",
    DOCS,
  );
  assert.ok(
    followupMissing.incompatible.some(
      (item) =>
        item.field === "needsVisaSupport" &&
        item.reason === "questionnaireFollowupUnmapped",
    ),
  );
});
