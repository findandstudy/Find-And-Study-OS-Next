import assert from "node:assert/strict";
import test from "node:test";
import {
  hasSalesforceCompletionProof,
  inferSalesforceDocumentSlot,
  isOwnedSalesforceApplicant,
  normalizeSalesforceStage,
  parseSalesforceStageMarker,
  resolveSalesforceProgramTarget,
  salesforceApplicantReadbackFailures,
  salesforceDuplicateDisposition,
  salesforcePortalProgramCandidates,
  salesforcePortalProgramName,
} from "../src/universities/salesforce/portalState.js";

test("normalizes CRM degree prefixes to the portal programme label", () => {
  assert.equal(
    salesforcePortalProgramName(
      "Bachelor of Computer Engineering (English)",
    ),
    "Computer Engineering (English)",
  );
  assert.equal(
    salesforcePortalProgramName(
      "Associate of Medical Laboratory Techniques (Turkish)",
    ),
    "Medical Laboratory Techniques (Turkish)",
  );
  assert.equal(
    salesforcePortalProgramName("PhD in Psychology (English)"),
    "Psychology (English)",
  );
});

test("university Salesforce programme mapping wins without using catalogue ids", () => {
  assert.deepEqual(
    resolveSalesforceProgramTarget(
      "Bachelor of Software Engineering (English)",
      {
        "Software Engineering (English)": "Bachelor of Software Engineering (English)",
      },
      {
        "Yazılım Mühendisliği (Türkçe)": "Bachelor of Software Engineering (English)",
      },
    ),
    {
      label: "Software Engineering (English)",
      source: "university",
      ambiguous: false,
    },
  );
});

test("normalized Salesforce programme target supports exact live language suffix variants", () => {
  assert.deepEqual(
    salesforcePortalProgramCandidates(
      resolveSalesforceProgramTarget(
        "Bachelor of Business Administration (English)",
      ),
    ),
    [
      "Business Administration - English",
      "Business Administration (English)",
    ],
  );
  assert.deepEqual(
    salesforcePortalProgramCandidates(
      resolveSalesforceProgramTarget("Associate of Nursing (Turkish)"),
    ),
    ["Nursing - Turkish", "Nursing (Turkish)"],
  );
});

test("explicit Salesforce mappings remain exact and are never expanded", () => {
  assert.deepEqual(
    salesforcePortalProgramCandidates(
      resolveSalesforceProgramTarget(
        "Bachelor of Business Administration (English)",
        {
          "İşletme - İngilizce":
            "Bachelor of Business Administration (English)",
        },
      ),
    ),
    ["İşletme - İngilizce"],
  );
});

test("ambiguous Salesforce programme mappings fail closed", () => {
  assert.deepEqual(
    resolveSalesforceProgramTarget("Bachelor of Law (Turkish)", {
      "Law (Turkish)": "Bachelor of Law (Turkish)",
      "Hukuk (Türkçe)": "Bachelor of Law (Turkish)",
    }),
    {
      label: "",
      source: "university",
      ambiguous: true,
    },
  );
});

test("Salesforce applicant proof requires exact native readback for all four fields", () => {
  const expected = {
    firstName: "Muhammad",
    lastName: "Example",
    passportNumber: "P123456",
    email: "student@example.com",
  };
  assert.deepEqual(
    salesforceApplicantReadbackFailures(expected, {
      ...expected,
      email: "STUDENT@EXAMPLE.COM",
    }),
    [],
  );
  assert.deepEqual(
    salesforceApplicantReadbackFailures(expected, {
      ...expected,
      email: "",
    }),
    ["email"],
  );
  assert.deepEqual(
    salesforceApplicantReadbackFailures(expected, {
      ...expected,
      invalidFields: ["passportNumber"],
    }),
    ["passportNumber"],
  );
});

test("applicant duplicate is never application success without completion proof", () => {
  assert.equal(
    salesforceDuplicateDisposition({
      activeStage: null,
      ownedApplicant: false,
      completionProved: false,
    }),
    "blocked",
  );
  assert.equal(
    salesforceDuplicateDisposition({
      activeStage: null,
      ownedApplicant: true,
      completionProved: false,
    }),
    "resume",
  );
  assert.equal(
    salesforceDuplicateDisposition({
      activeStage: "Program Selection",
      ownedApplicant: false,
      completionProved: false,
    }),
    "continue",
  );
  assert.equal(
    salesforceDuplicateDisposition({
      activeStage: null,
      ownedApplicant: true,
      completionProved: true,
    }),
    "already_exists",
  );
});

test("parses the live SLDS path stage marker", () => {
  assert.equal(
    parseSalesforceStageMarker("Stage: Personal Information"),
    "Personal Information",
  );
  assert.equal(parseSalesforceStageMarker("Stage: Documents"), "Documents");
  assert.equal(parseSalesforceStageMarker("not a stage"), null);
});

test("maps upload controls by document semantics, never by position", () => {
  assert.equal(inferSalesforceDocumentSlot("Passport Upload"), "passport");
  assert.equal(
    inferSalesforceDocumentSlot("High School Transcript"),
    "transcript",
  );
  assert.equal(
    inferSalesforceDocumentSlot("Diploma Certificate"),
    "diploma",
  );
  assert.equal(inferSalesforceDocumentSlot("Photograph"), "photo");
  assert.equal(inferSalesforceDocumentSlot("Other certificate"), null);
});

test("recognizes only exact Salesforce wizard stages", () => {
  assert.equal(
    normalizeSalesforceStage("Review and Submit"),
    "Review and Submit",
  );
  assert.equal(
    normalizeSalesforceStage("Program Selection Review and Submit Completed"),
    null,
  );
});

test("future Review and Submit label is not completion proof", () => {
  assert.equal(
    hasSalesforceCompletionProof({
      activeStage: "Program Selection",
    }),
    false,
  );
  assert.equal(
    hasSalesforceCompletionProof({
      activeStage: "Review and Submit",
    }),
    false,
  );
});

test("active Completed stage is completion proof", () => {
  assert.equal(
    hasSalesforceCompletionProof({
      activeStage: "Completed",
    }),
    true,
  );
});

test("track proof requires both reference and durable submitted state", () => {
  assert.equal(
    hasSalesforceCompletionProof({
      externalRef: "USK-123456",
      applicationStatus: "Submitted",
    }),
    true,
  );
  assert.equal(
    hasSalesforceCompletionProof({
      externalRef: "USK-123456",
      applicationStatus: "",
      trackStage: "",
    }),
    false,
  );
  assert.equal(
    hasSalesforceCompletionProof({
      applicationStatus: "Submitted",
    }),
    false,
  );
});

test("owned applicant requires exact name variant and exact email", () => {
  assert.equal(
    isOwnedSalesforceApplicant({
      firstName: "Waleed",
      lastName: "Example",
      email: "waleed@example.com",
      rowName: "Applicant — EXAMPLE WALEED",
      rowEmail: "mailto:Waleed@Example.com",
    }),
    true,
  );
  assert.equal(
    isOwnedSalesforceApplicant({
      firstName: "Waleed",
      lastName: "Example",
      email: "waleed@example.com",
      rowName: "Waleed Example",
      rowEmail: "other@example.com",
    }),
    false,
  );
});
