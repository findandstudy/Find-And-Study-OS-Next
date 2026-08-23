import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInboxStudentExtraction } from "../src/lib/inboxStudentExtraction";

test("normalizes Pakistan marks to an integer percentage and preserves raw evidence", () => {
  const result = normalizeInboxStudentExtraction({
    gpa: "955 / 1200",
    gender: "M",
    graduationYear: "HSSC Annual-I 2024",
    passportIssueDate: "2025-12-18",
  });

  assert.equal(result.gpaRaw, "955 / 1200");
  assert.equal(result.gpa, "80");
  assert.equal(result.gpaScale, 100);
  assert.equal(result.gender, "male");
  assert.equal(result.graduationYear, 2024);
  assert.equal(result.passportIssueDate, "2025-12-18");
});

test("rejects a numerator above 100 when the denominator is missing", () => {
  const result = normalizeInboxStudentExtraction({ gpa: "955" });

  assert.equal(result.gpaRaw, "955");
  assert.equal(result.gpa, null);
  assert.equal(result.gpaScale, null);
});

test("keeps valid percentage and 4-point inputs compatible", () => {
  assert.deepEqual(normalizeInboxStudentExtraction({ gpa: "79.58%" }), {
    gpa: "80",
    gpaRaw: "79.58%",
    gpaScale: 100,
  });
  assert.deepEqual(normalizeInboxStudentExtraction({ gpa: "3.5/4" }), {
    gpa: "88",
    gpaRaw: "3.5/4",
    gpaScale: 100,
  });
});

test("unknown gender is fail-closed", () => {
  assert.equal(
    normalizeInboxStudentExtraction({ gender: "unsure" }).gender,
    null,
  );
});

test("rejects quoted OCR passport numbers instead of auto-filling them", () => {
  for (const passportNumber of ["A0'0458U", "A0’0458U", 'A0"0458U', "A0`0458U"]) {
    const result = normalizeInboxStudentExtraction({ passportNumber });
    assert.equal(result.passportNumber, null);
    assert.equal(result.passportNumberRejected, true);
  }
});

test("preserves a valid passport number", () => {
  const result = normalizeInboxStudentExtraction({ passportNumber: " AB1234567 " });
  assert.equal(result.passportNumber, "AB1234567");
  assert.equal(result.passportNumberRejected, undefined);
});
