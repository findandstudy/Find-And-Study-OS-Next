import assert from "node:assert/strict";
import test from "node:test";
import { resolveCountryInput, validateStudentIntakeForm } from "../../edcons/src/lib/studentIntakeValidation";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const VALID = {
  email: "student@example.com",
  dateOfBirth: "2001-02-03",
  passportIssueDate: "2024-01-01",
  passportExpiry: "2034-01-01",
  graduationYear: "2025",
  gpa: "3.5",
  gradingSystem: "4",
};

test("manual student intake accepts coherent identity and academic fields", () => {
  assert.deepEqual(validateStudentIntakeForm(VALID, NOW), []);
});

test("custom country text is preserved when the field closes", () => {
  assert.equal(resolveCountryInput("  Kosovo  ", "Turkey"), "Kosovo");
  assert.equal(resolveCountryInput("   ", "Turkey"), "Turkey");
});

test("manual student intake rejects invalid identity dates and email", () => {
  const errors = validateStudentIntakeForm({
    ...VALID,
    email: "invalid",
    dateOfBirth: "2027-01-01",
    passportIssueDate: "2030-01-01",
    passportExpiry: "2025-01-01",
  }, NOW);
  assert.ok(errors.some((error) => error.includes("email")));
  assert.ok(errors.some((error) => error.includes("birth")));
  assert.ok(errors.some((error) => error.includes("issue date")));
  assert.ok(errors.some((error) => error.includes("expired")));
});

test("manual student intake rejects invalid GPA and graduation year", () => {
  const errors = validateStudentIntakeForm({
    ...VALID,
    graduationYear: "2200",
    gpa: "4.5",
  }, NOW);
  assert.ok(errors.some((error) => error.includes("Graduation year")));
  assert.ok(errors.some((error) => error.includes("GPA")));
});
