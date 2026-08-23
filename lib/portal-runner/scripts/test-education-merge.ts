import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSubmitProfileFromRecords,
  mergePortalEducationRecords,
} from "../src/profile.js";

test("current AI education fills only gaps in detailed education", () => {
  const detailed = [{
    id: 10,
    studentId: 20,
    level: "high_school",
    schoolName: null,
    country: "Pakistan",
    fieldOfStudy: null,
    startMonth: null,
    startYear: null,
    endMonth: null,
    endYear: null,
    city: "Lahore",
    languageScore: null,
    gpa: "91",
    gpaType: "100",
    source: "manual",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
  }];
  const current = [{
    id: 30,
    studentId: 20,
    level: "high_school",
    institution: "Punjab School",
    program: null,
    graduationYear: 2025,
    gpa: "87",
    gpaRaw: "955/1100",
    gpaScale: 100,
    languageScore: null,
    sortOrder: 0,
    createdAt: new Date("2026-01-02"),
    updatedAt: new Date("2026-01-02"),
    deletedAt: null,
  }];

  const [merged] = mergePortalEducationRecords(detailed, current);
  assert.equal(merged.schoolName, "Punjab School");
  assert.equal(merged.endYear, 2025);
  assert.equal(merged.gpa, "91", "existing detailed GPA must not be overwritten");
  assert.equal(merged.country, "Pakistan");
});

test("portal profile can use live label matching when a catalog program id was retired", () => {
  const student = {
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.com",
    passportNumber: "P1234567",
    dateOfBirth: "2000-01-01",
    gender: "female",
    fatherName: "Byron",
    motherName: "Anne",
    nationality: "United Kingdom",
    address: "1 Example Street",
    phone: "+441234567890",
  } as any;
  const application = {
    level: "Bachelor",
    programName: "Software Engineering",
    programId: null,
    universityName: "Example University",
  } as any;

  const profile = buildSubmitProfileFromRecords(student, application, {
    allowMissingProgramId: true,
  });
  assert.equal(profile.programId, "");
  assert.equal(profile.programName, "Software Engineering");
  assert.equal(profile.universityName, "Example University");
});
