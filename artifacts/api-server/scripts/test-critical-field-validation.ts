/**
 * test-critical-field-validation.ts — unit tests for the staff-facing
 * critical field validation layer (severity + Turkish messages).
 *
 * Run: pnpm --filter @workspace/api-server run test:critical-field-validation
 *
 * Covers:
 *  - hasErrors / hasWarnings / issues schema
 *  - severity: identity rule violations = "error", expired passport = "warning"
 *  - Turkish staff messages for the key production failure modes
 *  - Russian-format spaced passport numbers pass (no false positives)
 *  - Placeholder/test values (PE2EFIXTURE001, pending) are rejected
 *  - isPassportExpired single-source re-export from @workspace/portal-adapters
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateCriticalIdentityFields,
  checkPassportNumber,
  checkPersonName,
  checkDateConsistency,
} from "../src/lib/criticalFieldValidation.js";
import { isPassportExpired as apiIsPassportExpired, parseFlexibleDate as apiParseFlexibleDate } from "../src/lib/passportValidity.js";
import {
  isPassportExpired as sharedIsPassportExpired,
  parseFlexibleDate as sharedParseFlexibleDate,
} from "../../../lib/portal-adapters/src/identityValidation.js";

const NOW = new Date("2025-07-01T00:00:00Z");

describe("single-source re-export", () => {
  it("SS-1 passportValidity re-exports the SAME functions as @workspace/portal-adapters", () => {
    assert.equal(apiIsPassportExpired, sharedIsPassportExpired);
    assert.equal(apiParseFlexibleDate, sharedParseFlexibleDate);
  });
});

describe("validateCriticalIdentityFields — schema & severity", () => {
  it("CF-1 fully valid student → no errors, no warnings", () => {
    const res = validateCriticalIdentityFields({
      passportNumber: "A12345678",
      firstName: "AHMED",
      lastName: "YILMAZ",
      dateOfBirth: "1998-04-15",
      passportIssueDate: "2015-06-01",
      passportExpiryDate: "2026-06-01",
    }, NOW);
    assert.equal(res.hasErrors, false);
    assert.equal(res.hasWarnings, false);
    assert.deepEqual(res.issues, []);
  });

  it("CF-2 placeholder passport → error with Turkish message", () => {
    const res = validateCriticalIdentityFields({
      passportNumber: "pending",
      firstName: "AHMED",
      lastName: "YILMAZ",
    }, NOW);
    assert.equal(res.hasErrors, true);
    const issue = res.issues.find((i) => i.field === "passportNumber");
    assert.ok(issue);
    assert.equal(issue.severity, "error");
    assert.equal(issue.code, "placeholder_value");
    assert.match(issue.message, /gerçek pasaport numarası girilmemiş/);
  });

  it("CF-3 CNIC-looking value → looks_like_national_id_not_passport with Turkish message", () => {
    const res = validateCriticalIdentityFields({
      passportNumber: "37405-8069526-0",
      firstName: "ALI",
      lastName: "KHAN",
    }, NOW);
    const issue = res.issues.find((i) => i.field === "passportNumber");
    assert.ok(issue);
    assert.equal(issue.code, "looks_like_national_id_not_passport");
    assert.match(issue.message, /kimlik kartı/);
  });

  it("CF-4 expired passport → WARNING (not error), Turkish message", () => {
    const res = validateCriticalIdentityFields({
      passportNumber: "A12345678",
      firstName: "AHMED",
      lastName: "YILMAZ",
      passportIssueDate: "2014-06-01",
      passportExpiryDate: "2024-06-01",
    }, NOW);
    assert.equal(res.hasErrors, false);
    assert.equal(res.hasWarnings, true);
    const issue = res.issues.find((i) => i.code === "passport_expired");
    assert.ok(issue);
    assert.equal(issue.severity, "warning");
    assert.match(issue.message, /geçerlilik süresi dolmuş/);
  });

  it("CF-5 expiry before issue → error takes precedence, no duplicate expired warning", () => {
    const res = validateCriticalIdentityFields({
      passportNumber: "A12345678",
      firstName: "AHMED",
      lastName: "YILMAZ",
      passportIssueDate: "2020-06-01",
      passportExpiryDate: "2019-06-01",
    }, NOW);
    assert.equal(res.hasErrors, true);
    const expiryIssues = res.issues.filter((i) => i.field === "passportExpiryDate");
    assert.equal(expiryIssues.length, 1);
    assert.equal(expiryIssues[0].code, "expiry_before_issue");
  });

  it("CF-6 multiple bad fields → all reported with severities", () => {
    const res = validateCriticalIdentityFields({
      passportNumber: "PE2EFIXTURE001",
      firstName: "",
      lastName: "12345",
      dateOfBirth: "2030-01-01",
    }, NOW);
    assert.equal(res.hasErrors, true);
    const fields = res.issues.map((i) => i.field);
    assert.ok(fields.includes("passportNumber"));
    assert.ok(fields.includes("firstName"));
    assert.ok(fields.includes("lastName"));
    assert.ok(fields.includes("dateOfBirth"));
    assert.ok(res.issues.every((i) => i.severity === "error"));
  });
});

describe("Russian-format spaced passports — no false positives", () => {
  const validSamples = ["76 7365488", "76 4550075", "AE 6558052", "NA4152481", "FV0760011"];
  for (const v of validSamples) {
    it(`RU-VALID: "${v}" passes`, () => {
      assert.equal(checkPassportNumber(v), null);
    });
  }

  it("RU-1 full record with '76 7365488' → clean", () => {
    const res = validateCriticalIdentityFields({
      passportNumber: "76 7365488",
      firstName: "IVAN",
      lastName: "PETROV",
      dateOfBirth: "2000-05-20",
      passportIssueDate: "2018-03-10",
      passportExpiryDate: "2028-03-10",
    }, NOW);
    assert.equal(res.hasErrors, false);
    assert.equal(res.hasWarnings, false);
  });
});

describe("Placeholder/test fixtures rejected", () => {
  it("FX-1 'PE2EFIXTURE001' → error placeholder_value", () => {
    const issue = checkPassportNumber("PE2EFIXTURE001");
    assert.ok(issue);
    assert.equal(issue.severity, "error");
    assert.equal(issue.code, "placeholder_value");
  });

  it("FX-2 'test-placeholder-123' → error", () => {
    const issue = checkPassportNumber("test-placeholder-123");
    assert.ok(issue);
    assert.equal(issue.code, "placeholder_value");
  });
});

describe("checkPersonName / checkDateConsistency Turkish messages", () => {
  it("NM-1 digits-only lastName → numeric_name Turkish message", () => {
    const issue = checkPersonName("12345", "lastName");
    assert.ok(issue);
    assert.equal(issue.code, "numeric_name");
    assert.match(issue.message, /harf içermiyor/);
  });

  it("NM-2 empty firstName → 'Ad boş' message", () => {
    const issue = checkPersonName("", "firstName");
    assert.ok(issue);
    assert.match(issue.message, /^Ad boş/);
  });

  it("DT-1 unparseable DOB → Turkish format message", () => {
    const issues = checkDateConsistency({ dateOfBirth: "not-a-date", now: NOW });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "unparseable_date");
    assert.match(issues[0].message, /okunamıyor/);
  });

  it("DT-2 issue before birth → Turkish message", () => {
    const issues = checkDateConsistency({
      dateOfBirth: "1998-04-15",
      passportIssueDate: "1990-01-01",
      now: NOW,
    });
    assert.ok(issues.some((i) => i.code === "issue_before_birth" && /doğum tarihinden önce/.test(i.message)));
  });
});
