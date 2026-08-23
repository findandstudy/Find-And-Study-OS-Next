import assert from "node:assert/strict";
import test from "node:test";
import { isValidStudentGpa, validateStudentCreateFields } from "../src/lib/studentCreateValidation";

const NOW = new Date("2026-08-07T12:00:00.000Z");

test("accepts valid optional student create fields", () => {
  assert.deepEqual(validateStudentCreateFields({
    email: "student@example.com",
    dateOfBirth: "2002-04-20",
    passportIssueDate: "2024-01-01",
    passportExpiry: "2034-01-01",
    graduationYear: 2026,
    gpa: "3.5 / 4",
  }, NOW), []);
});

test("rejects invalid email and unsafe date combinations", () => {
  const fields = validateStudentCreateFields({
    email: "not-an-email",
    dateOfBirth: "2027-01-01",
    passportIssueDate: "2030-01-01",
    passportExpiry: "2025-01-01",
  }, NOW).map((issue) => issue.field);
  assert.ok(fields.includes("email"));
  assert.ok(fields.includes("dateOfBirth"));
  assert.ok(fields.includes("passportIssueDate"));
  assert.ok(fields.includes("passportExpiry"));
});

test("rejects expired passports, invalid graduation years, and impossible GPA", () => {
  const fields = validateStudentCreateFields({
    passportExpiry: "2026-08-06",
    graduationYear: 2200,
    gpa: "4.5 / 4",
  }, NOW).map((issue) => issue.field);
  assert.ok(fields.includes("passportExpiry"));
  assert.ok(fields.includes("graduationYear"));
  assert.ok(fields.includes("gpa"));
  assert.equal(isValidStudentGpa("85"), true);
  assert.equal(isValidStudentGpa("101"), false);
  assert.equal(validateStudentCreateFields({ passportExpiry: "2026-08-07" }, NOW).length, 0);
});
