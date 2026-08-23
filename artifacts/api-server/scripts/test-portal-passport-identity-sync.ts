import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPassportIdentitySyncDecision } from "../src/lib/portalPassportIdentitySync.js";

const student = {
  firstName: "Student Entered",
  lastName: "Name",
  passportNumber: "OLD123",
};

const proof = {
  firstName: "Passport",
  lastName: "Holder",
  passportNumber: "NEW456",
};

test("passport identity overwrites student-entered identity", () => {
  const result = buildPassportIdentitySyncDecision({ student, proof });
  assert.equal(result.status, "updated");
  assert.deepEqual(result.patch, proof);
  assert.deepEqual(result.mismatchedFields, [
    "firstName",
    "lastName",
    "passportNumber",
  ]);
});

test("a later human edit remains authoritative field by field", () => {
  const result = buildPassportIdentitySyncDecision({
    student,
    proof,
    lockedFields: ["firstName"],
  });
  assert.equal(result.status, "updated");
  assert.deepEqual(result.patch, {
    lastName: "Holder",
    passportNumber: "NEW456",
  });
  assert.deepEqual(result.lockedFields, ["firstName"]);
});

test("fully human-overridden identity is not changed by AI", () => {
  const result = buildPassportIdentitySyncDecision({
    student,
    proof,
    lockedFields: ["firstName", "lastName", "passportNumber"],
  });
  assert.equal(result.status, "manual_override");
  assert.deepEqual(result.patch, {});
});

test("duplicate passport number fails closed", () => {
  const result = buildPassportIdentitySyncDecision({
    student,
    proof,
    passportConflict: true,
  });
  assert.equal(result.status, "passport_conflict");
  assert.deepEqual(result.patch, {});
});

test("equivalent normalized identity is already matched", () => {
  const result = buildPassportIdentitySyncDecision({
    student: {
      firstName: "passport",
      lastName: "HOLDER",
      passportNumber: "new-456",
    },
    proof,
  });
  assert.equal(result.status, "already_matches");
  assert.deepEqual(result.patch, {});
});

test("duplicate passport ownership fails even when profile already matches", () => {
  const result = buildPassportIdentitySyncDecision({
    student: proof,
    proof,
    passportConflict: true,
  });
  assert.equal(result.status, "passport_conflict");
  assert.deepEqual(result.patch, {});
});
