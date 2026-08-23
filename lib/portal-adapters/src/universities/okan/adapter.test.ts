import assert from "node:assert/strict";
import test from "node:test";
import type { SubmitProfile } from "../../types.js";
import {
  chooseOkanProgramIndex,
  resolveOkanDegreeValue,
  resolveOkanRequiredFields,
  verifyOkanSubmissionEvidence,
} from "./adapter.js";

const baseProfile = {
  addressCity: "Istanbul",
  cityOfBirth: "Dushanbe",
  schoolName: "Example School",
  educationRecords: [
    {
      level: "High School",
      schoolName: "Example School",
      city: "Khujand",
    },
  ],
} as SubmitProfile;

test("Okan uses dedicated residence, birth and education city fields", () => {
  assert.deepEqual(resolveOkanRequiredFields(baseProfile), {
    city: "Istanbul",
    birthplace: "Dushanbe",
    secondarySchoolCity: "Khujand",
    missing: [],
    policyFallbacks: [],
  });
});

test("Okan never parses city or birthplace from a free-text address", () => {
  const resolved = resolveOkanRequiredFields({
    ...baseProfile,
    address: "COUNTRY REGION STREET 12",
    addressCity: undefined,
    cityOfBirth: undefined,
    educationRecords: [],
  });
  assert.equal(resolved.city, "");
  assert.equal(resolved.birthplace, "");
  assert.deepEqual(resolved.missing, [
    "addressCity",
    "cityOfBirth",
    "secondarySchoolCity",
  ]);
});

test("Okan legacy policy may reuse explicit residence city for school city", () => {
  const resolved = resolveOkanRequiredFields({
    ...baseProfile,
    educationRecords: [],
  });
  assert.equal(resolved.secondarySchoolCity, "Istanbul");
  assert.deepEqual(resolved.policyFallbacks, [
    "secondarySchoolCity<-addressCity",
  ]);
});

test("Okan degree mapping fails closed for unknown levels", () => {
  assert.equal(resolveOkanDegreeValue("Associate"), "1");
  assert.equal(resolveOkanDegreeValue("Bachelor"), "2");
  assert.equal(resolveOkanDegreeValue("Master"), "3");
  assert.equal(resolveOkanDegreeValue("PhD"), "4");
  assert.equal(resolveOkanDegreeValue("Something New"), null);
});

test("Okan program selection chooses a proven match and refuses ambiguity", () => {
  assert.equal(
    chooseOkanProgramIndex(
      ["Software Engineering (English)", "Civil Engineering (English)"],
      "Software Engineering (English)",
    ),
    0,
  );
  assert.equal(
    chooseOkanProgramIndex(
      ["Business Administration (Thesis)", "Business Administration (Non-Thesis)"],
      "Business Administration",
    ),
    null,
  );
});

test("Okan submission success requires an exact durable Track Applications row", () => {
  const profile = {
    firstName: "Ada",
    lastName: "Lovelace",
    programName: "Software Engineering (English)",
  };
  assert.equal(
    verifyOkanSubmissionEvidence(profile, {
      externalRef: "10234",
      applicantName: "Ada Lovelace",
      programName: "Software Engineering (English)",
      status: "Submitted",
      completed: "Yes",
      stage: "Completed",
    }),
    true,
  );
  assert.equal(
    verifyOkanSubmissionEvidence(profile, {
      externalRef: "10234",
      applicantName: "Ada Lovelace",
      programName: "Software Engineering (English)",
      status: "Pending",
      completed: "No",
      stage: "Documents",
    }),
    false,
  );
  assert.equal(
    verifyOkanSubmissionEvidence(profile, {
      externalRef: "",
      applicantName: "Ada Lovelace",
      programName: "Software Engineering (English)",
      status: "Submitted",
      completed: "Yes",
      stage: "Completed",
    }),
    false,
  );
});
