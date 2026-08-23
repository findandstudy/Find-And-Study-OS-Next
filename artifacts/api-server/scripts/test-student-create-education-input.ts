import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanStudentEducationRecords,
  toLegacyEducationRecord,
} from "../src/lib/studentEducationInput";

test("cleans a Master applicant's bachelor evidence for both stores", () => {
  const result = cleanStudentEducationRecords([{
    level: "bachelor",
    institution: " KABUL POLYTECHNIC UNIVERSITY ",
    program: " COMPUTING AND INFORMATION SCIENCE ",
    country: " Afghanistan ",
    graduationYear: "2019",
    gpa: "66",
    gpaRaw: "66 / 100",
    gpaScale: "100",
  }]);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.records[0], {
    level: "bachelor",
    institution: "KABUL POLYTECHNIC UNIVERSITY",
    program: "COMPUTING AND INFORMATION SCIENCE",
    country: "Afghanistan",
    graduationYear: 2019,
    gpa: "66",
    gpaRaw: "66 / 100",
    gpaScale: 100,
    languageScore: null,
    sortOrder: 0,
  });
  assert.deepEqual(toLegacyEducationRecord(2465, result.records[0]), {
    studentId: 2465,
    level: "bachelor",
    schoolName: "KABUL POLYTECHNIC UNIVERSITY",
    country: "Afghanistan",
    fieldOfStudy: "COMPUTING AND INFORMATION SCIENCE",
    endYear: 2019,
    languageScore: null,
    gpa: "66",
    gpaType: "percentage",
    source: "manual",
  });
});

test("rejects duplicate and invalid education levels", () => {
  assert.equal(
    cleanStudentEducationRecords([
      { level: "bachelor" },
      { level: "bachelor" },
    ]).ok,
    false,
  );
  assert.equal(
    cleanStudentEducationRecords([{ level: "primary_school" }]).ok,
    false,
  );
});

test("high school cannot carry a fabricated program", () => {
  const result = cleanStudentEducationRecords([{
    level: "high_school",
    institution: "School",
    program: "Must be dropped",
  }]);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.records[0]?.program, null);
});

test("rejects implausible graduation years and GPA values above their scale", () => {
  assert.equal(cleanStudentEducationRecords([{
    level: "bachelor",
    graduationYear: 2200,
  }]).ok, false);
  assert.equal(cleanStudentEducationRecords([{
    level: "bachelor",
    gpa: "4.5",
    gpaScale: 4,
  }]).ok, false);
  assert.equal(cleanStudentEducationRecords([{
    level: "bachelor",
    graduationYear: "unknown",
    gpaScale: "four",
  }]).ok, false);
});
