import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildPortalDraftPreflightError,
  type RoutedPortalDraftPreflight,
} from "../src/lib/portalDraftPreflight.js";

function blocked(): RoutedPortalDraftPreflight {
  return {
    universityKey: "study_in_turkey",
    adapterKey: "sit",
    preflight: {
      ready: false,
      supported: true,
      adapterKey: "sit",
      studentId: 42,
      missingFields: ["addressCity"],
      incompatibleFields: [{ field: "passportNumber", reason: "invalid" }],
      missingDocuments: ["photo", "diploma"],
      autoFilledFields: ["passportExpiry"],
      enrichmentWarnings: [],
    },
  };
}

test("destination preflight error exposes machine keys and staff labels", () => {
  const result = buildPortalDraftPreflightError(blocked());
  assert.equal(result.code, "PORTAL_PREFLIGHT_NOT_READY");
  assert.equal(result.adapterKey, "sit");
  assert.deepEqual(result.missingFields, ["addressCity"]);
  assert.deepEqual(result.missingFieldLabels, ["Residence city"]);
  assert.deepEqual(result.incompatibleFieldLabels, ["Passport number"]);
  assert.deepEqual(result.missingDocumentLabels, ["Photograph", "Diploma"]);
  assert.equal(
    result.error,
    "Complete these items before portal submission: Residence city, Passport number (invalid), Photograph, Diploma.",
  );
});
