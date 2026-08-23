import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInboxEducationPayload,
  findMissingInboxAcademicFields,
} from "../src/components/inbox/inboxEducationPayload";

const base = {
  school1: "KABUL POLYTECHNIC UNIVERSITY",
  school2: "",
  educationProgram: "COMPUTING AND INFORMATION SCIENCE",
  educationCountry: "Afghanistan",
  graduationYear: "2019",
  gpa: "66",
  gradingSystem: "100",
  languageScore: "",
};

test("Master applicant persists prior university as bachelor, never high school", () => {
  const payload = buildInboxEducationPayload({ ...base, selectedLevel: "Master" });
  assert.equal(payload.highSchool, null);
  assert.equal(payload.universityBachelor, base.school1);
  assert.equal(payload.educationRecords.length, 1);
  assert.deepEqual(payload.educationRecords[0], {
    level: "bachelor",
    institution: base.school1,
    program: base.educationProgram,
    country: base.educationCountry,
    graduationYear: 2019,
    gpa: "66",
    gpaRaw: "66 / 100",
    gpaScale: 100,
    languageScore: null,
  });
});

test("Bachelor applicant persists prior education as high school", () => {
  const payload = buildInboxEducationPayload({ ...base, selectedLevel: "Bachelor" });
  assert.equal(payload.highSchool, base.school1);
  assert.equal(payload.universityBachelor, null);
  assert.equal(payload.educationRecords[0]?.level, "high_school");
  assert.equal(payload.educationRecords[0]?.program, null);
});

test("PhD applicant maps bachelor and master to separate records", () => {
  const payload = buildInboxEducationPayload({
    ...base,
    selectedLevel: "Ph.D",
    school2: "ISTANBUL TECHNICAL UNIVERSITY",
  });
  assert.equal(payload.highSchool, null);
  assert.equal(payload.universityBachelor, base.school1);
  assert.equal(payload.universityMaster, "ISTANBUL TECHNICAL UNIVERSITY");
  assert.deepEqual(payload.educationRecords.map((record) => record.level), [
    "bachelor",
    "master",
  ]);
  assert.equal(payload.educationRecords[0]?.gpa, null);
  assert.equal(payload.educationRecords[1]?.gpa, "66");
});

test("empty school does not manufacture an education record", () => {
  const payload = buildInboxEducationPayload({
    ...base,
    selectedLevel: "Master",
    school1: " ",
  });
  assert.deepEqual(payload.educationRecords, []);
  assert.equal(payload.universityBachelor, null);
});

test("student creation gate identifies unverified academic fields", () => {
  assert.deepEqual(
    findMissingInboxAcademicFields({
      selectedLevel: "Master",
      school1: "",
      school2: "",
      graduationYear: "",
      gpa: "",
    }),
    ["Bachelor university", "Graduation year", "GPA"],
  );
  assert.deepEqual(
    findMissingInboxAcademicFields({
      selectedLevel: "Ph.D",
      school1: "UNIVERSITY A",
      school2: "",
      graduationYear: "2020",
      gpa: "3.2",
    }),
    ["Master university"],
  );
});
