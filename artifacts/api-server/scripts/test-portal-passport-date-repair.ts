import assert from "node:assert/strict";
import test from "node:test";
import { buildPassportDateRepairDecision } from "../src/lib/portalPassportDateRepair.js";

const student = {
  firstName: "MUHAMMAD",
  lastName: "KAIF",
  passportNumber: "AC4980651",
  dateOfBirth: "2024-12-24",
  passportIssueDate: "2024-10-07",
  passportExpiry: "2034-10-06",
};
const extracted = {
  firstName: "MUHAMMAD",
  lastName: "KAIF",
  passportNumber: "AC4980651",
  dateOfBirth: "2005-12-24",
  passportIssueDate: "2024-10-07",
  passportExpiry: "2034-10-06",
  confidence: "high",
};

test("repairs only the invalid high-confidence passport-backed date", () => {
  const result = buildPassportDateRepairDecision({
    student,
    extracted,
    confidenceScore: 1,
    documentId: 8569,
    invalidFields: ["dateOfBirth", "passportIssueDate"],
  });
  assert.deepEqual(result, {
    status: "repairable",
    patch: { dateOfBirth: "2005-12-24" },
    fields: ["dateOfBirth"],
  });
});

test("refuses to repair when passport identity does not match", () => {
  const result = buildPassportDateRepairDecision({
    student,
    extracted: { ...extracted, passportNumber: "WRONG123" },
    confidenceScore: 1,
    documentId: 8569,
    invalidFields: ["dateOfBirth"],
  });
  assert.equal(result.status, "identity_mismatch");
  assert.deepEqual(result.patch, {});
});

test("refuses low-confidence extraction", () => {
  const result = buildPassportDateRepairDecision({
    student,
    extracted: { ...extracted, confidence: "low" },
    confidenceScore: 0.3,
    documentId: 8569,
    invalidFields: ["dateOfBirth"],
  });
  assert.equal(result.status, "low_confidence");
  assert.deepEqual(result.patch, {});
});

test("ignores non-date incompatible fields", () => {
  const result = buildPassportDateRepairDecision({
    student,
    extracted,
    confidenceScore: 1,
    documentId: 8569,
    invalidFields: ["passportNumber", "email"],
  });
  assert.equal(result.status, "no_invalid_fields");
  assert.deepEqual(result.patch, {});
});
