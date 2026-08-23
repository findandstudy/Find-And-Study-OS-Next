// ---------------------------------------------------------------------------
// Multico adapter — pure-function unit tests
//
// Tests the pure, side-effect-free functions in the multico adapter:
//   - isMulticoNationality: nationality string matching
//   - mapProgramType: CRM level → Multico program_type
//   - matchMulticoProgram (via matchProgram): program name fuzzy match
//   - parseStudentIdFromHtml: HTML ID extraction
//   - toMulticoDate: date formatting
//   - parseLatestApplication: HTML application row parsing
//
// These tests run without a browser or DB connection.
// ---------------------------------------------------------------------------

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isMulticoNationality,
  MULTICO_NATIONALITIES,
  shouldRouteTopkapiToMultico,
  mapProgramType,
  MULTICO_STUDENT_FORM_PATH,
  normalizeMulticoGpaSystem,
  parseMulticoStudentIdFromHtml,
  isExpectedMulticoApplicationFormUrl,
  extractMulticoResponseDiagnostics,
  findMatchingMulticoApplication,
  isMulticoMultipartWithinSafeBudget,
  MULTICO_MULTIPART_SAFE_BYTES,
  isExpectedMulticoStudentEditUrl,
} from "./adapter.js";

// ---------------------------------------------------------------------------
// isMulticoNationality
// ---------------------------------------------------------------------------

describe("isMulticoNationality", () => {
  // --- Positive cases (exact country names) ---
  for (const nat of MULTICO_NATIONALITIES) {
    it(`matches lowercase country name: ${nat}`, () => {
      assert.ok(isMulticoNationality(nat));
    });
    it(`matches title-case: ${nat.charAt(0).toUpperCase() + nat.slice(1)}`, () => {
      assert.ok(isMulticoNationality(nat.charAt(0).toUpperCase() + nat.slice(1)));
    });
    it(`matches UPPERCASE: ${nat.toUpperCase()}`, () => {
      assert.ok(isMulticoNationality(nat.toUpperCase()));
    });
  }

  // --- Positive cases (adjective / demonym forms) ---
  it("matches 'Azerbaijani'", () => assert.ok(isMulticoNationality("Azerbaijani")));
  it("matches 'Kazakh'", () => assert.ok(isMulticoNationality("Kazakh")));
  it("matches 'Uzbek'", () => assert.ok(isMulticoNationality("Uzbek")));
  it("matches 'Kyrgyz'", () => assert.ok(isMulticoNationality("Kyrgyz")));
  it("matches 'Tajik'", () => assert.ok(isMulticoNationality("Tajik")));
  it("matches 'Turkmen'", () => assert.ok(isMulticoNationality("Turkmen")));
  it("matches 'Mongolian'", () => assert.ok(isMulticoNationality("Mongolian")));
  it("matches mixed case 'AZERbaijani'", () => assert.ok(isMulticoNationality("AZERbaijani")));

  // --- Positive cases (Turkish country names used by CRM/catalog records) ---
  it("matches 'Azerbaycan'", () => assert.ok(isMulticoNationality("Azerbaycan")));
  it("matches 'Kazakistan'", () => assert.ok(isMulticoNationality("Kazakistan")));
  it("matches 'Özbekistan'", () => assert.ok(isMulticoNationality("Özbekistan")));
  it("matches 'Kırgızistan'", () => assert.ok(isMulticoNationality("Kırgızistan")));
  it("matches 'Tacikistan'", () => assert.ok(isMulticoNationality("Tacikistan")));
  it("matches 'Türkmenistan'", () => assert.ok(isMulticoNationality("Türkmenistan")));
  it("matches 'Moğolistan'", () => assert.ok(isMulticoNationality("Moğolistan")));

  // --- Negative cases (non-Central-Asian nationalities) ---
  it("does not match 'Turkish'", () => assert.ok(!isMulticoNationality("Turkish")));
  it("does not match 'Turkish Republic of Azerbaijan' ... no wait Turkish is not azeri", () => {
    // "Turkish" does not include "azerbaijan", "kazakhstan" etc.
    assert.ok(!isMulticoNationality("Turkish"));
  });
  it("does not match 'German'", () => assert.ok(!isMulticoNationality("German")));
  it("does not match 'Iranian'", () => assert.ok(!isMulticoNationality("Iranian")));
  it("does not match 'Pakistani'", () => assert.ok(!isMulticoNationality("Pakistani")));
  it("does not match empty string", () => assert.ok(!isMulticoNationality("")));
  it("does not match null", () => assert.ok(!isMulticoNationality(null)));
  it("does not match undefined", () => assert.ok(!isMulticoNationality(undefined)));
  it("does not match 'Nigerian'", () => assert.ok(!isMulticoNationality("Nigerian")));
  it("does not route arbitrary text that only contains a known demonym", () => {
    assert.ok(!isMulticoNationality("Mongolian-German dual national"));
  });
});

describe("live Multico form contract", () => {
  it("routes by stable Topkapı adapter key, not the mutable portal row key", () => {
    assert.ok(shouldRouteTopkapiToMultico("topkapi", "Kazakhstan"));
    assert.ok(shouldRouteTopkapiToMultico("topkapi", "Türkmenistan"));
    assert.ok(!shouldRouteTopkapiToMultico("topkapi_university", "Kazakhstan"));
    assert.ok(!shouldRouteTopkapiToMultico("sit", "Kazakhstan"));
    assert.ok(!shouldRouteTopkapiToMultico("topkapi", "Pakistan"));
  });

  it("uses the observed authenticated add-student route", () => {
    assert.equal(MULTICO_STUDENT_FORM_PATH, "/students/add");
  });

  it("derives a valid catalog context from the live students/edit URL", () => {
    assert.equal(
      parseMulticoStudentIdFromHtml(
        '<a href="https://www.multico.com.tr/crm/students/edit/33286">Edit</a>',
      ),
      "33286",
    );
    assert.equal(
      parseMulticoStudentIdFromHtml(
        '<a href="https://www.multico.com.tr/crm/students">Students</a>',
      ),
      null,
    );
  });

  it("rejects the silent invalid-student redirect as a catalog form", () => {
    assert.ok(
      isExpectedMulticoApplicationFormUrl(
        "https://www.multico.com.tr/crm/student-applications/add/33286",
        "33286",
      ),
    );
    assert.ok(
      !isExpectedMulticoApplicationFormUrl(
        "https://www.multico.com.tr/crm/students",
        "1",
      ),
    );
    assert.ok(
      !isExpectedMulticoApplicationFormUrl(
        "https://evil.example/crm/student-applications/add/33286",
        "33286",
      ),
    );
  });

  it("accepts only the exact same-origin Multico student edit route", () => {
    assert.equal(
      isExpectedMulticoStudentEditUrl(
        "https://www.multico.com.tr/crm/students/edit/33409",
        "33409",
      ),
      true,
    );
    assert.equal(
      isExpectedMulticoStudentEditUrl(
        "https://www.multico.com.tr/crm/students/edit/334090",
        "33409",
      ),
      false,
    );
    assert.equal(
      isExpectedMulticoStudentEditUrl(
        "https://evil.example/crm/students/edit/33409",
        "33409",
      ),
      false,
    );
  });

  it("extracts safe field-level form diagnostics without retaining PII", () => {
    assert.deepEqual(
      extractMulticoResponseDiagnostics(`
        <input name="graduate_year" class="form-control is-invalid" value="2027">
        <div class="invalid-feedback">
          Passport 123456789 and user@example.com: file is too large.
        </div>
      `),
      [
        "invalid:graduate_year",
        "Passport [number] and [email]: file is too large.",
      ],
    );
  });

  it("parses the live two-ID Multico application edit URL exactly", () => {
    assert.deepEqual(
      findMatchingMulticoApplication(
        `<table><tr>
          <td>38738</td><td>Topkapı University</td>
          <td>Architecture</td><td>Bachelor</td>
          <td>2026-2027 Fall Semester</td><td>3.900,00 USD</td>
          <td>Pending Review</td>
          <td><a href="/crm/student-applications/edit/33408/38738">Edit</a></td>
        </tr></table>`,
        "Architecture (Bachelor - TURKISH)",
      ),
      {
        applicationId: "38738",
        fee: "3.900,00 USD",
        status: "Pending Review",
      },
    );
  });

  it("fails closed when Multico multipart content exceeds its safe budget", () => {
    assert.equal(
      isMulticoMultipartWithinSafeBudget([
        MULTICO_MULTIPART_SAFE_BYTES - 1,
        1,
      ]),
      true,
    );
    assert.equal(
      isMulticoMultipartWithinSafeBudget([
        MULTICO_MULTIPART_SAFE_BYTES,
        1,
      ]),
      false,
    );
    assert.equal(isMulticoMultipartWithinSafeBudget([1, -1]), false);
  });

  it("maps all supported levels and fails closed for unknown levels", () => {
    assert.equal(mapProgramType("Associate"), "Associate");
    assert.equal(mapProgramType("Bachelor"), "Bachelor");
    assert.equal(mapProgramType("Master (Thesis)"), "Master Thesis");
    assert.equal(
      mapProgramType("Master (Non-Thesis)"),
      "Master Non-Thesis",
    );
    assert.equal(mapProgramType("PhD"), "Doctorate");
    assert.equal(mapProgramType(""), null);
    assert.equal(mapProgramType("Foundation"), null);
  });

  it("normalizes GPA scales to exact live select values", () => {
    assert.equal(normalizeMulticoGpaSystem("4.0"), "4");
    assert.equal(normalizeMulticoGpaSystem("100"), "100");
    assert.equal(normalizeMulticoGpaSystem("6"), null);
    assert.equal(normalizeMulticoGpaSystem(""), null);
  });
});
