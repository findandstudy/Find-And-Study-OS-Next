/**
 * test-identity-validation.ts — unit tests for the shared identity validation module.
 *
 * Run: pnpm --filter @workspace/api-server run test:identity-validation
 *
 * Covers:
 *  - Passport number: valid samples, placeholder strings, all-same-digit,
 *    too-short/too-long, pure-digit overflow, CNIC pattern, special chars.
 *  - Name: valid, empty, too-short, placeholder, all-same-char.
 *  - Date consistency: DOB in future, impossible ages, issue > expiry,
 *    DOB > issue date, all-absent (no errors).
 *  - Combined validateIdentityFields: all-valid passes, multi-field failure.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validatePassportNumber,
  validatePersonName,
  validateDateConsistency,
  validateIdentityFields,
  formatIdentityErrors,
} from "../../../lib/portal-adapters/src/identityValidation.js";

// ---------------------------------------------------------------------------
// Passport number tests
// ---------------------------------------------------------------------------

describe("validatePassportNumber", () => {
  const valid = (v: string, label: string) =>
    it(`PP-VALID: ${label}`, () => assert.equal(validatePassportNumber(v), null));
  const invalid = (v: string | null | undefined, label: string, snippet?: string) =>
    it(`PP-INVALID: ${label}`, () => {
      const err = validatePassportNumber(v);
      assert.ok(err, `expected error for: ${JSON.stringify(v)}`);
      assert.equal(err.field, "passportNumber");
      if (snippet) assert.match(err.reason, new RegExp(snippet, "i"));
    });

  // Valid samples
  valid("A12345678", "Turkish passport (letter + 8 digits)");
  valid("U12345678", "Turkish passport U-prefix");
  valid("AB1234567", "Generic 2-letter prefix");
  valid("123456789", "All-digit 9-char (e.g. Chinese)");
  valid("0123456789", "10-digit all-numeric boundary (max allowed)");
  valid("FP1234567", "Pakistan passport (valid)");
  valid("P123456", "Short valid passport");
  valid("AA000000", "Zeros with a letter prefix — valid");
  valid("ABCDE12345", "Alphanumeric 10 chars");
  valid("MR AB 123456", "Spaced format (some countries)");

  // Russian-style spaced series+number formats (spaces ignored for length)
  valid("76 7365488", "Russian internal format '76 7365488' (2+7 digits with space)");
  valid("76 4550075", "Russian internal format '76 4550075'");
  valid("AE 6558052", "Spaced letter-prefix 'AE 6558052'");
  valid("NA4152481", "Namibian-style 'NA4152481' — 'NA' prefix must NOT match placeholder 'na'");
  valid("FV0760011", "'FV0760011' letter prefix + digits");

  // Placeholder / test values from production
  invalid("pending", "placeholder 'pending'", "placeholder");
  invalid("N/A", "placeholder 'N/A'", "placeholder");
  invalid("n/a", "placeholder 'n/a' lowercase", "placeholder");
  invalid("Applying", "placeholder 'Applying'", "placeholder");
  invalid("applied", "placeholder 'applied'", "placeholder");
  invalid("none", "placeholder 'none'", "placeholder");
  invalid("unknown", "placeholder 'unknown'", "placeholder");
  invalid("PE2EFIXTURE001", "contains FIXTURE keyword", "placeholder");
  invalid("-", "single hyphen", "placeholder");

  // All-same character
  invalid("111111111", "all same digit 1", "same character");
  invalid("000000000", "all zeros 9 chars", "same character");
  invalid("AAAAAAAAA", "all same letter A", "same character");

  // Length violations (5–12 chars after stripping spaces/hyphens)
  invalid("A123", "4 chars — too short", "outside the valid");
  invalid("A" + "1".repeat(20), "21 chars — too long", "outside the valid");
  invalid("AB 12", "5 chars raw but 4 stripped — too short", "outside the valid");
  invalid(null, "null", "required");
  invalid("", "empty string", "required");
  invalid("   ", "whitespace only", "required");

  // Pure-digit overflow (> 10 digits all-numeric)
  invalid("62408085540048", "14-digit all-numeric", "too long for any real passport");
  invalid("0805200982082", "13-digit all-numeric (too long)", "too long for any real passport");
  invalid("12345678901", "11-digit all-numeric", "too long for any real passport");
  invalid("12345678901234567890", "20-digit all-numeric", "too long");

  // Pakistan CNIC pattern (DDDDD-DDDDDDD-D)
  invalid("37405-8069526-0", "CNIC pattern DDDDD-DDDDDDD-D", "CNIC");
  invalid("12345-6789012-3", "CNIC pattern DDDDD-DDDDDDD-D variant", "CNIC");

  // Invalid characters
  invalid("AB/123456", "contains slash", "invalid characters");
  invalid("AB_123456", "contains underscore", "invalid characters");
  invalid("AB@123456", "contains @", "invalid characters");
  invalid("A0'0458U", "contains ASCII apostrophe", "invalid characters");
  invalid("A0’0458U", "contains curly apostrophe", "invalid characters");
  invalid('A0"0458U', "contains quotation mark", "invalid characters");
  invalid("A0`0458U", "contains backtick", "invalid characters");
});

// ---------------------------------------------------------------------------
// Name tests
// ---------------------------------------------------------------------------

describe("validatePersonName", () => {
  const valid = (v: string, label: string) =>
    it(`NAME-VALID: ${label}`, () => assert.equal(validatePersonName(v, "firstName"), null));
  const invalid = (v: string | null | undefined, label: string, snippet?: string) =>
    it(`NAME-INVALID: ${label}`, () => {
      const err = validatePersonName(v, "firstName");
      assert.ok(err, `expected error for: ${JSON.stringify(v)}`);
      assert.equal(err.field, "firstName");
      if (snippet) assert.match(err.reason, new RegExp(snippet, "i"));
    });

  valid("AHMED", "simple uppercase name");
  valid("Mary-Anne", "hyphenated name");
  valid("AL SAYED", "name with space");
  valid("Özbek", "name with diacritic");
  valid("محمد", "Arabic name");
  valid("AB", "2-char minimum");

  invalid("", "empty", "required");
  invalid(null, "null", "required");
  invalid("A", "single char — too short", "too short");
  invalid("n/a", "placeholder n/a", "placeholder");
  invalid("none", "placeholder none", "placeholder");
  invalid("pending", "placeholder pending", "placeholder");
  invalid("-", "placeholder hyphen", "placeholder");
  invalid("AAAAAAA", "all same letter", "same character");
  invalid("a".repeat(101), "101 chars — too long", "too long");
});

// ---------------------------------------------------------------------------
// Date consistency tests
// ---------------------------------------------------------------------------

describe("validateDateConsistency", () => {
  const NOW = new Date("2025-07-01T00:00:00Z");

  it("DC-1 all absent → no errors", () => {
    const errors = validateDateConsistency({ now: NOW });
    assert.equal(errors.length, 0);
  });

  it("DC-2 valid set — 1998-04-15 DOB, issued 2015-06-01, expiry 2025-06-01", () => {
    const errors = validateDateConsistency({
      dateOfBirth: "1998-04-15",
      passportIssueDate: "2015-06-01",
      passportExpiryDate: "2025-06-01",
      now: NOW,
    });
    assert.equal(errors.length, 0);
  });

  it("DC-3 DOB in the future → error", () => {
    const errors = validateDateConsistency({
      dateOfBirth: "2030-01-01",
      now: NOW,
    });
    assert.ok(errors.some((e) => e.field === "dateOfBirth" && /future/.test(e.reason)));
  });

  it("DC-4 DOB before 1900 → error", () => {
    const errors = validateDateConsistency({
      dateOfBirth: "1800-01-01",
      now: NOW,
    });
    assert.ok(errors.some((e) => e.field === "dateOfBirth" && /1900/.test(e.reason)));
  });

  it("DC-5 age < 10 years → error", () => {
    const errors = validateDateConsistency({
      dateOfBirth: "2020-01-01",
      now: NOW,
    });
    assert.ok(errors.some((e) => e.field === "dateOfBirth" && /too young/.test(e.reason)));
  });

  it("DC-6 issue date in the future → error", () => {
    const errors = validateDateConsistency({
      passportIssueDate: "2030-01-01",
      now: NOW,
    });
    assert.ok(errors.some((e) => e.field === "passportIssueDate" && /future/.test(e.reason)));
  });

  it("DC-7 issue date before DOB → error", () => {
    const errors = validateDateConsistency({
      dateOfBirth: "1998-04-15",
      passportIssueDate: "1990-01-01",
      now: NOW,
    });
    assert.ok(errors.some((e) => e.field === "passportIssueDate" && /after date of birth/.test(e.reason)));
  });

  it("DC-8 expiry before issue → error", () => {
    const errors = validateDateConsistency({
      passportIssueDate: "2015-06-01",
      passportExpiryDate: "2010-01-01",
      now: NOW,
    });
    assert.ok(errors.some((e) => e.field === "passportExpiryDate" && /after issue/.test(e.reason)));
  });

  it("DC-9 unparseable DOB → error", () => {
    const errors = validateDateConsistency({
      dateOfBirth: "not-a-date",
      now: NOW,
    });
    assert.ok(errors.some((e) => e.field === "dateOfBirth" && /cannot parse/i.test(e.reason)));
  });

  it("DC-10 expiry same as issue → error (not strictly after)", () => {
    const errors = validateDateConsistency({
      passportIssueDate: "2015-06-01",
      passportExpiryDate: "2015-06-01",
      now: NOW,
    });
    assert.ok(errors.some((e) => e.field === "passportExpiryDate" && /after issue/.test(e.reason)));
  });
});

// ---------------------------------------------------------------------------
// Combined validateIdentityFields
// ---------------------------------------------------------------------------

describe("validateIdentityFields — combined gate", () => {
  const NOW = new Date("2025-07-01T00:00:00Z");

  it("VI-1 fully valid student → no errors", () => {
    const errors = validateIdentityFields({
      passportNumber: "A12345678",
      firstName: "AHMED",
      lastName: "YILMAZ",
      dateOfBirth: "1998-04-15",
      passportIssueDate: "2015-06-01",
      passportExpiryDate: "2025-06-01",
      now: NOW,
    });
    assert.equal(errors.length, 0);
  });

  it("VI-2 placeholder passport + missing last name → 2 errors", () => {
    const errors = validateIdentityFields({
      passportNumber: "pending",
      firstName: "AHMED",
      lastName: "",
      now: NOW,
    });
    assert.equal(errors.length, 2);
    assert.ok(errors.some((e) => e.field === "passportNumber"));
    assert.ok(errors.some((e) => e.field === "lastName"));
  });

  it("VI-3 real prod bad examples all fail validation", () => {
    // 13-digit all-numeric — no real passport uses 13+ all-digit numbers
    const err1 = validatePassportNumber("0805200982082");
    assert.ok(err1, "13-digit all-numeric must fail");
    // 14-digit all-numeric
    const err2 = validatePassportNumber("62408085540048");
    assert.ok(err2, "14-digit all-numeric must fail");
    // CNIC pattern
    const err3 = validatePassportNumber("37405-8069526-0");
    assert.ok(err3, "CNIC pattern must fail");
  });

  it("VI-4 prod placeholder 'N/A, Applying' — strip and test both parts", () => {
    const err1 = validatePassportNumber("N/A");
    const err2 = validatePassportNumber("Applying");
    assert.ok(err1, "N/A must fail");
    assert.ok(err2, "Applying must fail");
  });

  it("VI-5 formatIdentityErrors produces readable output", () => {
    const errors = validateIdentityFields({
      passportNumber: "pending",
      firstName: "",
      now: NOW,
    });
    const msg = formatIdentityErrors(errors);
    assert.match(msg, /\[passportNumber\]/);
    assert.match(msg, /\[firstName\]/);
  });

  it("VI-6 optional date fields absent → still validates passport/name", () => {
    const errors = validateIdentityFields({
      passportNumber: "AB1234567",
      firstName: "MEHMET",
      lastName: "DEMİR",
    });
    assert.equal(errors.length, 0);
  });
});
