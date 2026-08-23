import test from "node:test";
import assert from "node:assert/strict";
import { resolveResidenceAddress } from "../src/lib/studentAddressDefaults";
import {
  buildStudentEducationRecordsFromLegacy,
  hydrateStudentEducationRecords,
} from "../src/lib/studentEducationHydration";

test("derives city and postal code from a structured address", () => {
  assert.deepEqual(
    resolveResidenceAddress({
      address: "12 Sadi Street, Khujand, Tajikistan 735700",
      nationality: "Tajikistan",
    }),
    { addressCity: "Khujand", postalCode: "735700" },
  );
});

test("rejects a country accidentally stored as residence city", () => {
  assert.deepEqual(
    resolveResidenceAddress({
      address: "AL BARSHA 1",
      addressCity: "Jordan",
      nationality: "Jordan",
    }),
    { addressCity: "city", postalCode: "10000" },
  );
});

test("preserves explicit valid residence values", () => {
  assert.deepEqual(
    resolveResidenceAddress({
      address: "Street 1",
      addressCity: "Dubai",
      postalCode: "00000",
      nationality: "Jordan",
    }),
    { addressCity: "Dubai", postalCode: "00000" },
  );
});

test("hydrates a partial Bachelor academic row from legacy fields", () => {
  const records = hydrateStudentEducationRecords(
    "Bachelor",
    {
      highSchool: "AL MAWAKEB",
      graduationYear: 2026,
      gpa: "3.79",
      languageScore: "8",
    },
    [{ level: "high_school", institution: "AL MAWAKEB" }],
  );
  assert.deepEqual(records[0], {
    level: "high_school",
    institution: "AL MAWAKEB",
    program: null,
    country: null,
    graduationYear: 2026,
    gpa: "3.79",
    gpaRaw: "3.79",
    gpaScale: null,
    languageScore: "8",
    sortOrder: 0,
  });
});

test("reclassifies available prior education when level changes to Master", () => {
  const records = buildStudentEducationRecordsFromLegacy(
    "Master",
    {
      highSchool: "SHAIKH ZAYED UNIVERSITY",
      graduationYear: 2019,
      gpa: "75 / 100",
    },
    [{
      level: "high_school",
      institution: "SHAIKH ZAYED UNIVERSITY",
      program: null,
      country: "Afghanistan",
      graduationYear: 2019,
      gpa: "75",
      gpaRaw: "75 / 100",
      gpaScale: 100,
      languageScore: null,
      sortOrder: 0,
    }],
  );
  const bachelor = records.find((record) => record.level === "bachelor");
  assert.equal(bachelor?.institution, "SHAIKH ZAYED UNIVERSITY");
  assert.equal(bachelor?.graduationYear, 2019);
  assert.equal(bachelor?.gpa, "75");
  assert.equal(bachelor?.gpaScale, 100);
  assert.equal(bachelor?.country, "Afghanistan");
});

test("does not manufacture a bachelor record from an ordinary high school", () => {
  const records = buildStudentEducationRecordsFromLegacy(
    "Master",
    {
      highSchool: "AL MAWAKEB SCHOOL",
      graduationYear: 2026,
      gpa: "3.79",
    },
    [{
      level: "high_school",
      institution: "AL MAWAKEB SCHOOL",
      program: null,
      country: "Jordan",
      graduationYear: 2026,
      gpa: "3.79",
      gpaRaw: "3.79",
      gpaScale: 4,
      languageScore: null,
      sortOrder: 0,
    }],
  );
  assert.equal(
    records.some((record) => record.level === "bachelor"),
    false,
  );
});

test("does not clone one university record into both PhD prerequisites", () => {
  const records = buildStudentEducationRecordsFromLegacy(
    "PhD",
    {
      universityBachelor: "UNIVERSITY A",
      graduationYear: 2020,
      gpa: "3.2 / 4",
    },
    [{
      level: "bachelor",
      institution: "UNIVERSITY A",
      program: "BUSINESS",
      country: "Turkey",
      graduationYear: 2020,
      gpa: "3.2",
      gpaRaw: "3.2 / 4",
      gpaScale: 4,
      languageScore: null,
      sortOrder: 0,
    }],
  );
  assert.deepEqual(
    records.map((record) => record.level),
    ["bachelor"],
  );
});
