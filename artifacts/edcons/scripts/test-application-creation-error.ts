import assert from "node:assert/strict";
import { test } from "node:test";
import { applicationCreationErrorMessage } from "../src/lib/applicationCreationError";

test("portal preflight explains fields, invalid values and documents", () => {
  const error = new Error(JSON.stringify({
    code: "PORTAL_PREFLIGHT_NOT_READY",
    missingFieldLabels: ["Residence city"],
    incompatibleFieldLabels: ["Passport number"],
    missingDocumentLabels: ["Photograph", "Diploma"],
  }));
  assert.equal(
    applicationCreationErrorMessage(error),
    "Complete these items before portal submission: Residence city, Passport number (invalid), Photograph, Diploma.",
  );
});

test("generated-client response body is understood", () => {
  assert.equal(
    applicationCreationErrorMessage({
      data: {
        code: "STUDENT_DOCS_REQUIRED",
        missingDocLabels: ["Passport", "Transcript"],
      },
    }),
    "Missing required documents: Passport, Transcript.",
  );
});

test("plain API errors remain readable", () => {
  assert.equal(
    applicationCreationErrorMessage(new Error("Program quota is full")),
    "Program quota is full",
  );
});
