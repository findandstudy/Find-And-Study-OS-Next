import { test } from "node:test";
import assert from "node:assert/strict";

import {
  resolveAltinbasPassportDates,
  resolveLegacyAddressCity,
  selectFirstDocumentPerMappedSlot,
  shouldDeduplicateDocumentSlots,
} from "../src/altinbasLegacyPolicy.js";

test("ALP1: valid passport dates are preserved", () => {
  assert.deepEqual(
    resolveAltinbasPassportDates({
      dateOfBirth: "2000-01-01",
      passportIssueDate: "2024-05-10",
      passportExpiryDate: "2029-05-10",
      now: new Date("2026-07-25T12:00:00Z"),
    }),
    {
      issueDate: "2024-05-10",
      expiryDate: "2029-05-10",
      fallbackFields: [],
    },
  );
});

test("ALP2: future historical issue date is made portal-valid without DB writes", () => {
  assert.deepEqual(
    resolveAltinbasPassportDates({
      dateOfBirth: "2008-01-09",
      passportIssueDate: "2026-10-05",
      passportExpiryDate: "2031-10-05",
      now: new Date("2026-07-25T12:00:00Z"),
    }),
    {
      issueDate: "2026-07-24",
      expiryDate: "2031-10-05",
      fallbackFields: ["passportIssueDate"],
    },
  );
});

test("ALP3: missing dates receive one deterministic five-year contract", () => {
  assert.deepEqual(
    resolveAltinbasPassportDates({
      dateOfBirth: "2000-01-01",
      now: new Date("2026-07-25T12:00:00Z"),
    }),
    {
      issueDate: "2025-07-24",
      expiryDate: "2030-07-24",
      fallbackFields: ["passportIssueDate", "passportExpiryDate"],
    },
  );
});

test("ALP4: Altınbaş document normalization selects one writer per slot", () => {
  const docs = [
    { id: 20, type: "passport" },
    { id: 19, type: "passport" },
    { id: 18, type: "transcript" },
    { id: 17, type: null },
  ];
  assert.deepEqual(
    selectFirstDocumentPerMappedSlot(
      docs,
      (doc) => doc.type,
    ).map((doc) => doc.id),
    [20, 18],
  );
});

test("ALP5: duplicate-slot protection includes SIT after live SIGBUS evidence", () => {
  for (const key of [
    "beykent_university",
    "isik_university",
    "multico",
    "okan_university",
    "united_education",
    "uskudar_university",
  ]) {
    assert.equal(shouldDeduplicateDocumentSlots(key), true, key);
  }
  assert.equal(shouldDeduplicateDocumentSlots("altinbas_univeristy"), true);
  assert.equal(shouldDeduplicateDocumentSlots("sit"), true);
  assert.equal(shouldDeduplicateDocumentSlots("study_in_turkey"), true);
  assert.equal(shouldDeduplicateDocumentSlots("topkapi_university"), false);
});

test("ALP6: legacy city uses only a validated comma prefix", () => {
  assert.equal(
    resolveLegacyAddressCity({
      universityKey: "uskudar_university",
      address: "Dushanbe, Rudaki Street 12",
      nationality: "Tajikistan",
    }),
    "Dushanbe",
  );
  assert.equal(
    resolveLegacyAddressCity({
      universityKey: "uskudar_university",
      address: "Rudaki Street 12",
      nationality: "Tajikistan",
    }),
    undefined,
  );
  assert.equal(
    resolveLegacyAddressCity({
      universityKey: "uskudar_university",
      address: "Tajikistan, Rudaki Street 12",
      nationality: "Tajikistan",
    }),
    undefined,
  );
});

test("ALP7: legacy city remains disabled for Topkapı", () => {
  assert.equal(
    resolveLegacyAddressCity({
      universityKey: "topkapi_university",
      address: "Dushanbe, Rudaki Street 12",
      nationality: "Tajikistan",
    }),
    undefined,
  );
});

test("ALP8: both SIT keys recover City / District from legacy comma-prefixed addresses", () => {
  for (const universityKey of ["sit", "study_in_turkey"]) {
    assert.equal(
      resolveLegacyAddressCity({
        universityKey,
        address: "Baku, Nizami Street 10",
        nationality: "Azerbaijan",
      }),
      "Baku",
    );
  }
  assert.equal(
    resolveLegacyAddressCity({
      universityKey: "study_in_turkey",
      address: "Nizami Street 10 Baku",
      nationality: "Azerbaijan",
    }),
    undefined,
  );
});
