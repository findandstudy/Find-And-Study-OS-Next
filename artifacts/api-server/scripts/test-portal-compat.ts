/**
 * test-portal-compat.ts — Faz 1: portal compatibility matrix + normalization utils
 *
 * Run: pnpm --filter @workspace/api-server test:portal-compat
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  portalRequirements,
  normalizeGpaInteger,
  cleanCity,
  formatDateISO,
  canonicalCountry,
  CANONICAL_COUNTRIES,
} from "@workspace/db";

test("PC1: portalRequirements('sit','high_school') — bachelor applicant matrix", () => {
  const rules = portalRequirements("sit", "high_school");
  const keys = rules.map((r) => r.key);
  // personal + residence + family + toggles + docs
  for (const k of [
    "dob", "gender", "nationality", "passportNo", "passportIssueDate",
    "passportExpiryDate", "email", "mobile", "countryOfResidence", "city",
    "fatherName", "fatherJob", "motherName", "motherJob",
    "transferStudent", "hasTcId", "hasBlueCard",
    "photo", "passport", "transcript", "diploma",
    "hsCountry", "hsName", "hsGpa",
  ]) {
    const rule = rules.find((r) => r.key === k);
    assert.ok(rule, `rule present: ${k}`);
    assert.equal(rule.required, true, `${k} required`);
  }
  assert.ok(!keys.includes("bachelorGpa"), "no bachelor academic for HS-based applicant");
  const lang = rules.find((r) => r.key === "languageScore");
  assert.ok(lang && lang.required === false, "languageScore optional");
  const gpa = rules.find((r) => r.key === "hsGpa");
  assert.equal(gpa?.type, "integer");
  assert.equal(gpa?.min, 0);
  assert.equal(gpa?.max, 100);
});

test("PC2: portalRequirements('sit','bachelor') — master applicant needs bachelor academic", () => {
  const keys = portalRequirements("sit", "bachelor").map((r) => r.key);
  for (const k of ["bachelorCountry", "bachelorSchool", "bachelorGpa"]) {
    assert.ok(keys.includes(k), `has ${k}`);
  }
  assert.ok(!keys.includes("hsGpa"), "no HS academic for master applicant");
  assert.ok(!keys.includes("masterGpa"), "no master academic for master applicant");
});

test("PC3: portalRequirements('sit','master') — PhD applicant needs bachelor+master", () => {
  const keys = portalRequirements("sit", "master").map((r) => r.key);
  for (const k of ["bachelorGpa", "masterCountry", "masterSchool", "masterGpa"]) {
    assert.ok(keys.includes(k), `has ${k}`);
  }
});

test("PC4: non-SIT portals return skeleton []", () => {
  assert.deepEqual(portalRequirements("united", "bachelor"), []);
  assert.deepEqual(portalRequirements("topkapi", "high_school"), []);
});

test("PC5: normalizeGpaInteger", () => {
  assert.equal(normalizeGpaInteger("86.6"), 87);
  assert.equal(normalizeGpaInteger(86.6), 87);
  assert.equal(normalizeGpaInteger("4.33"), 4);
  assert.equal(normalizeGpaInteger("76"), 76);
  assert.equal(normalizeGpaInteger("87,5"), 88); // comma decimal
  assert.equal(normalizeGpaInteger(150), 100); // clamp high
  assert.equal(normalizeGpaInteger(-5), 0); // clamp low
  assert.equal(normalizeGpaInteger("abc"), null);
  assert.equal(normalizeGpaInteger(""), null);
  assert.equal(normalizeGpaInteger(null), null);
  assert.equal(normalizeGpaInteger(undefined), null);
});

test("PC6: cleanCity", () => {
  assert.equal(cleanCity("HOUSE NO. 165"), null);
  assert.equal(cleanCity("Lahore"), "Lahore");
  assert.equal(cleanCity("  Istanbul  "), "Istanbul");
  assert.equal(cleanCity("Şanlıurfa"), "Şanlıurfa");
  assert.equal(cleanCity("Sector 12 Block B"), null);
  assert.equal(cleanCity("Flat 4, Main Street"), null);
  assert.equal(cleanCity("123"), null);
  assert.equal(cleanCity(""), null);
  assert.equal(cleanCity(null), null);
  assert.equal(cleanCity("A"), null); // too short
  assert.equal(
    cleanCity("Some Extremely Long Address Line That Cannot Be A City Name"),
    null,
  );
  assert.equal(cleanCity("New York"), "New York");
});

test("PC7: canonicalCountry", () => {
  assert.equal(canonicalCountry("PAKISTAN"), "Pakistan");
  assert.equal(canonicalCountry("pakistan "), "Pakistan");
  assert.equal(canonicalCountry("Türkiye"), "Turkey");
  assert.equal(canonicalCountry("UAE"), "United Arab Emirates");
  assert.equal(canonicalCountry("USA"), "United States");
  assert.equal(canonicalCountry("Syrian Arab Republic"), "Syria");
  assert.equal(canonicalCountry("Russian Federation"), "Russia");
  assert.equal(canonicalCountry("xyz"), null);
  assert.equal(canonicalCountry(""), null);
  assert.equal(canonicalCountry(null), null);
  assert.ok(CANONICAL_COUNTRIES.includes("Pakistan"));
});

test("PC8: formatDateISO", () => {
  assert.equal(formatDateISO("2001-05-07"), "2001-05-07");
  assert.equal(formatDateISO("07.05.2001"), "2001-05-07");
  assert.equal(formatDateISO("7/5/2001"), "2001-05-07");
  assert.equal(formatDateISO("2001-5-7"), "2001-05-07");
  assert.equal(formatDateISO("2001-05-07T00:00:00Z"), "2001-05-07");
  assert.equal(formatDateISO("31.02.2001"), null); // invalid date
  assert.equal(formatDateISO("not a date"), null);
  assert.equal(formatDateISO(""), null);
  assert.equal(formatDateISO(null), null);
  assert.equal(formatDateISO(new Date(Date.UTC(2001, 4, 7))), "2001-05-07");
});
