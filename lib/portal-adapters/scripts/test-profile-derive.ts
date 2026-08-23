/**
 * test-profile-derive.ts — unit tests for the three pure helpers added in
 * Altınbaş Faz-B: deriveAddressParts, derivePhoneCountry, deriveEducation.
 * Also verifies that PROFILE_FIELDS now has 35 entries and that
 * parseAdapterSpec accepts the new fields in `valueFrom`.
 *
 * Run:
 *   pnpm --filter @workspace/portal-adapters run test:adapters
 *   (or: tsx --test ./scripts/test-profile-derive.ts)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveAddressParts,
  derivePhoneCountry,
  deriveEducation,
  buildProfile,
} from "../src/profile.js";
import { PROFILE_FIELDS } from "../src/shared.js";
import { parseAdapterSpec } from "../src/declarative/schema.js";

// ---------------------------------------------------------------------------
// PF0 — PROFILE_FIELDS count
// ---------------------------------------------------------------------------

test("PF0: PROFILE_FIELDS has exactly 35 entries", () => {
  assert.equal(
    PROFILE_FIELDS.length,
    35,
    `Expected 35 PROFILE_FIELDS, got ${PROFILE_FIELDS.length}: ${PROFILE_FIELDS.join(", ")}`,
  );
});

test("PF0b: original 21 fields are still present and in order", () => {
  const original21 = [
    "email", "passportNumber", "firstName", "lastName", "dateOfBirth", "gender",
    "fatherName", "motherName", "nationality", "address", "phone", "level",
    "programName", "programId", "universityName", "schoolName", "gpa",
    "graduationYear", "languageScore", "passportIssueDate", "passportExpiryDate",
  ];
  for (let i = 0; i < original21.length; i++) {
    assert.equal(
      PROFILE_FIELDS[i],
      original21[i],
      `Field at index ${i} changed: expected "${original21[i]}", got "${PROFILE_FIELDS[i]}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// DA — deriveAddressParts
// ---------------------------------------------------------------------------

test("DA1: typical comma-separated address → city = text before comma, street = full", () => {
  const r = deriveAddressParts("KABUL, AFGHANISTAN");
  assert.equal(r.street, "KABUL, AFGHANISTAN", "street is the full address");
  assert.equal(r.city, "KABUL", "city is text before the comma");
  assert.equal(r.zip, "", "zip is always empty");
});

test("DA2: address without comma → city equals street", () => {
  const r = deriveAddressParts("Istanbul");
  assert.equal(r.street, "Istanbul");
  assert.equal(r.city, "Istanbul");
  assert.equal(r.zip, "");
});

test("DA3: blank string → all parts empty", () => {
  const r = deriveAddressParts("");
  assert.equal(r.street, "");
  assert.equal(r.city, "");
  assert.equal(r.zip, "");
});

test("DA4: undefined → all parts empty", () => {
  const r = deriveAddressParts(undefined);
  assert.equal(r.street, "");
  assert.equal(r.city, "");
  assert.equal(r.zip, "");
});

test("DA5: multi-comma address → city is only the first segment", () => {
  const r = deriveAddressParts("Çankaya, Ankara, Turkey");
  assert.equal(r.city, "Çankaya");
  assert.equal(r.street, "Çankaya, Ankara, Turkey");
});

test("DA6: whitespace-padded comma → city is trimmed", () => {
  const r = deriveAddressParts("  Paris  ,  France  ");
  assert.equal(r.city, "Paris");
  assert.equal(r.street, "Paris  ,  France");
});

// ---------------------------------------------------------------------------
// DPC — derivePhoneCountry
// ---------------------------------------------------------------------------

test("DPC1: +93 dial code → Afghanistan", () => {
  assert.equal(derivePhoneCountry("+93782122729", "Afghanistan"), "Afghanistan");
});

test("DPC2: +90 dial code → Turkey", () => {
  assert.equal(derivePhoneCountry("+905001234567", "Turkish"), "Turkey");
});

test("DPC3: undefined phone → nationality fallback", () => {
  assert.equal(derivePhoneCountry(undefined, "Afghanistan"), "Afghanistan");
});

test("DPC4: empty phone string → nationality fallback", () => {
  assert.equal(derivePhoneCountry("", "Uzbekistan"), "Uzbekistan");
});

test("DPC5: unrecognised dial code → nationality fallback", () => {
  assert.equal(derivePhoneCountry("+000123456", "Narnia"), "Narnia");
});

test("DPC6: both phone and nationality absent → undefined", () => {
  assert.equal(derivePhoneCountry(undefined, undefined), undefined);
});

test("DPC7: +880 → Bangladesh", () => {
  assert.equal(derivePhoneCountry("+8801712345678", "Bangladeshi"), "Bangladesh");
});

test("DPC8: +998 → Uzbekistan (longer prefix wins over +7 Russia)", () => {
  assert.equal(derivePhoneCountry("+99890123456", "Uzbek"), "Uzbekistan");
});

test("DPC9: +1876 Jamaica wins over +1 Canada/US", () => {
  assert.equal(derivePhoneCountry("+18761234567", "Jamaican"), "Jamaica");
});

// ---------------------------------------------------------------------------
// DE — deriveEducation
// ---------------------------------------------------------------------------

test("DE1: student with universityBachelor → eduDegree Bachelor", () => {
  const r = deriveEducation({
    universityBachelor: "Kabul University",
    graduationYear: 2022,
    gpa: "3.5",
  });
  assert.equal(r.eduDegree, "Bachelor");
  assert.equal(r.eduEndYear, "2022");
  assert.equal(r.eduGpaType, "4.0");
  assert.equal(r.eduField, undefined);
  assert.equal(r.eduStartMonth, undefined);
  assert.equal(r.eduStartYear, undefined);
  assert.equal(r.eduEndMonth, undefined);
});

test("DE2: student with universityMaster (no bachelor) → eduDegree Master", () => {
  const r = deriveEducation({
    universityMaster: "Boğaziçi University",
    graduationYear: 2024,
    gpa: "85",
  });
  assert.equal(r.eduDegree, "Master");
  assert.equal(r.eduEndYear, "2024");
  assert.equal(r.eduGpaType, "percentage");
});

test("DE3: student with only highSchool → eduDegree High School", () => {
  const r = deriveEducation({
    highSchool: "Ankara Lisesi",
    graduationYear: 2020,
    gpa: "75",
  });
  assert.equal(r.eduDegree, "High School");
  assert.equal(r.eduGpaType, "percentage");
});

test("DE4: no education fields → all values undefined", () => {
  const r = deriveEducation({});
  assert.equal(r.eduDegree, undefined);
  assert.equal(r.eduEndYear, undefined);
  assert.equal(r.eduGpaType, undefined);
});

test("DE5: null input → all values undefined (never throws)", () => {
  const r = deriveEducation(null);
  assert.equal(r.eduDegree, undefined);
});

test("DE6: string input → all values undefined (never throws)", () => {
  const r = deriveEducation("not an object");
  assert.equal(r.eduDegree, undefined);
});

test("DE7: gpa = 4.0 scale → eduGpaType '4.0'", () => {
  const r = deriveEducation({ universityBachelor: "X", gpa: "3.8" });
  assert.equal(r.eduGpaType, "4.0");
});

test("DE8: gpa = percentage scale → eduGpaType 'percentage'", () => {
  const r = deriveEducation({ universityBachelor: "X", gpa: "92" });
  assert.equal(r.eduGpaType, "percentage");
});

test("DE9: gpa absent → eduGpaType undefined", () => {
  const r = deriveEducation({ universityBachelor: "X" });
  assert.equal(r.eduGpaType, undefined);
});

test("DE10: bachelor wins over master when both present", () => {
  const r = deriveEducation({
    universityBachelor: "BA School",
    universityMaster: "MA School",
  });
  assert.equal(r.eduDegree, "Bachelor");
});

// ---------------------------------------------------------------------------
// BP — buildProfile regression: intakeTerm + new fields derived correctly
// ---------------------------------------------------------------------------

/** Minimal valid data record for buildProfile. */
const BASE_DATA: Record<string, unknown> = {
  email: "test@example.com",
  passportNumber: "A1234567",
  firstName: "Ali",
  lastName: "Yılmaz",
  dateOfBirth: "2000-01-01",
  nationality: "Afghan",
  level: "Bachelor",
  programName: "Computer Science",
  programId: "42",
};

test("BP1: buildProfile populates intakeTerm from intakeTerm field", () => {
  const profile = buildProfile({ ...BASE_DATA, intakeTerm: "Fall 2026" });
  assert.equal(profile.intakeTerm, "Fall 2026");
});

test("BP2: buildProfile populates intakeTerm from term field (alias)", () => {
  const profile = buildProfile({ ...BASE_DATA, term: "Spring 2027" });
  assert.equal(profile.intakeTerm, "Spring 2027");
});

test("BP3: buildProfile intakeTerm is undefined when neither intakeTerm nor term provided", () => {
  const profile = buildProfile({ ...BASE_DATA });
  assert.equal(profile.intakeTerm, undefined);
});

test("BP4: buildProfile preserves street but never derives structured city/zip", () => {
  const profile = buildProfile({ ...BASE_DATA, address: "Kabul, Afghanistan" });
  assert.equal(profile.addressCity, undefined);
  assert.equal(profile.addressStreet, "Kabul, Afghanistan");
  assert.equal(profile.addressZip, undefined);
});

test("BP5: buildProfile derives phoneCountry from E.164 phone", () => {
  const profile = buildProfile({
    ...BASE_DATA,
    phone: "+93782122729",
    nationality: "Afghan",
  });
  assert.equal(profile.phoneCountry, "Afghanistan");
});

test("BP6: buildProfile never infers visaSupport from Turkish nationality", () => {
  const profile = buildProfile({ ...BASE_DATA, nationality: "Turkish" });
  assert.equal(profile.visaSupport, undefined);
});

test("BP7: buildProfile accepts only explicit Yes/No visaSupport", () => {
  const profile = buildProfile({ ...BASE_DATA, visaSupport: "yes" });
  assert.equal(profile.visaSupport, "Yes");
});

test("BP8: buildProfile derives eduDegree from universityBachelor", () => {
  const profile = buildProfile({
    ...BASE_DATA,
    universityBachelor: "Kabul University",
    graduationYear: 2022,
    gpa: "3.2",
  });
  assert.equal(profile.eduDegree, "Bachelor");
  assert.equal(profile.eduEndYear, "2022");
  assert.equal(profile.eduGpaType, "4.0");
});

test("BP9: buildProfile never derives cityOfBirth from addressCity", () => {
  const profile = buildProfile({ ...BASE_DATA, address: "Ankara, Turkey" });
  assert.equal(profile.cityOfBirth, undefined);
});

test("BP10: buildProfile cityOfBirth prefers explicit value over addressCity", () => {
  const profile = buildProfile({
    ...BASE_DATA,
    address: "Ankara, Turkey",
    cityOfBirth: "Istanbul",
  });
  assert.equal(profile.cityOfBirth, "Istanbul");
});

test("BP11: no-comma address never leaks into cityOfBirth", () => {
  const profile = buildProfile({
    ...BASE_DATA,
    address: "TAJIKISTAN KHUJAND STREET SADI 12",
  });
  assert.equal(profile.addressCity, undefined);
  assert.equal(profile.cityOfBirth, undefined);
});

test("BP12: explicit structured address fields are preserved", () => {
  const profile = buildProfile({
    ...BASE_DATA,
    address: "Street Sadi 12",
    addressCity: "Khujand",
    postalCode: "735700",
  });
  assert.equal(profile.addressStreet, "Street Sadi 12");
  assert.equal(profile.addressCity, "Khujand");
  assert.equal(profile.addressZip, "735700");
});

test("BP13: missing programId remains fail-closed by default", () => {
  assert.throws(
    () => buildProfile({ ...BASE_DATA, programId: "" }),
    /missing required field "programId"/,
  );
});

test("BP14: explicitly scoped name-based adapters may omit legacy programId", () => {
  const profile = buildProfile(
    { ...BASE_DATA, programId: "" },
    { allowMissingProgramId: true },
  );
  assert.equal(profile.programId, "");
  assert.equal(profile.programName, BASE_DATA.programName);
});

test("BP15: readiness inspection preserves blanks instead of fabricating undefined text", () => {
  const profile = buildProfile(
    {
      ...BASE_DATA,
      email: "",
      passportNumber: null,
      programId: "",
    },
    { allowIncompleteProfile: true, allowMissingProgramId: true },
  );
  assert.equal(profile.email, "");
  assert.equal(profile.passportNumber, "");
  assert.equal(profile.programId, "");
});

// ---------------------------------------------------------------------------
// SV_NEW — parseAdapterSpec accepts new PROFILE_FIELDS in valueFrom
// ---------------------------------------------------------------------------

function validRawSpec(): unknown {
  return {
    specVersion: 1,
    meta: {
      key: "altinbas_test",
      name: "Altınbaş Test",
      baseUrl: "https://apply.altinbas.example.com",
      matches: ["altinbas"],
    },
    auth: {
      loginUrl: "https://apply.altinbas.example.com/login",
      loginSteps: [
        { action: "fill", selector: "#email", valueFrom: "profile.email" },
        { action: "click", selector: "button[type=submit]" },
      ],
    },
    steps: [
      { action: "fill", selector: "#city", valueFrom: "profile.addressCity" },
      { action: "fill", selector: "#street", valueFrom: "profile.addressStreet" },
      { action: "fill", selector: "#zip", valueFrom: "profile.addressZip" },
      { action: "fill", selector: "#birthCity", valueFrom: "profile.cityOfBirth" },
      { action: "fill", selector: "#phoneCountry", valueFrom: "profile.phoneCountry" },
      { action: "fill", selector: "#eduDegree", valueFrom: "profile.eduDegree" },
      { action: "fill", selector: "#eduField", valueFrom: "profile.eduField" },
      { action: "fill", selector: "#eduStartMonth", valueFrom: "profile.eduStartMonth" },
      { action: "fill", selector: "#eduStartYear", valueFrom: "profile.eduStartYear" },
      { action: "fill", selector: "#eduEndMonth", valueFrom: "profile.eduEndMonth" },
      { action: "fill", selector: "#eduEndYear", valueFrom: "profile.eduEndYear" },
      { action: "fill", selector: "#eduGpaType", valueFrom: "profile.eduGpaType" },
      { action: "fill", selector: "#visaSupport", valueFrom: "profile.visaSupport" },
      { action: "fill", selector: "#intakeTerm", valueFrom: "profile.intakeTerm" },
      { action: "click", selector: "#submit", final: true },
    ],
    success: { successText: "submitted" },
  };
}

test("SV_NEW1: parseAdapterSpec accepts valueFrom: 'profile.eduDegree'", () => {
  const raw = { ...validRawSpec() as Record<string, unknown> };
  (raw.steps as Array<Record<string, unknown>>) = [
    { action: "fill", selector: "#deg", valueFrom: "profile.eduDegree" },
    { action: "click", selector: "#go", final: true },
  ];
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, true, `Should accept profile.eduDegree — errors: ${!res.ok ? JSON.stringify(res.issues) : "none"}`);
});

test("SV_NEW2: parseAdapterSpec accepts all 14 new profile fields in valueFrom", () => {
  const res = parseAdapterSpec(validRawSpec());
  assert.equal(
    res.ok,
    true,
    `Spec with all new fields should parse — errors: ${!res.ok ? JSON.stringify(res.issues.map((i) => i.message)) : "none"}`,
  );
});

test("SV_NEW3: parseAdapterSpec still rejects unknown profile field after expansion", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>)[0] = {
    action: "fill",
    selector: "#x",
    valueFrom: "profile.notARealField",
  };
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, false, "Unknown profile field must still be rejected");
});
