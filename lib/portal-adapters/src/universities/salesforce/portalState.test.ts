import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseSalesforceBinaryCandidate,
  findSalesforceAppliedProgramMatch,
  hasSalesforceCompletionProof,
  hasSalesforceUploadProof,
  salesforceProgramCardMatchesCandidate,
} from "./portalState.js";

test("Haliç Applied Programs proves one exact application and rejects ambiguity", () => {
  assert.deepEqual(
    findSalesforceAppliedProgramMatch(
      [
        {
          applicationNumber: "AP0101755",
          programName: "Robotics and Artificial Intelligence",
        },
      ],
      ["Robotics and Artificial Intelligence (Turkish)"],
    ),
    {
      externalRef: "AP0101755",
      portalProgram: "Robotics and Artificial Intelligence",
    },
  );
  assert.equal(
    findSalesforceAppliedProgramMatch(
      [
        {
          applicationNumber: "AP0101755",
          programName: "Robotics and Artificial Intelligence",
        },
        {
          applicationNumber: "AP0101756",
          programName: "Robotics and Artificial Intelligence",
        },
      ],
      ["Robotics and Artificial Intelligence (Turkish)"],
    ),
    null,
  );
  assert.equal(
    findSalesforceAppliedProgramMatch(
      [
        {
          applicationNumber: "AP0101755",
          programName: "Robotics and Artificial Intelligence",
        },
      ],
      ["Artificial Intelligence Operations (Turkish)"],
    ),
    null,
  );
});

test("Salesforce programme card fallback matches only the exact card", () => {
  assert.equal(
    salesforceProgramCardMatchesCandidate(
      "Select\nArtificial Intelligence Operations\n- Turkish",
      "Artificial Intelligence Operations - Turkish",
    ),
    true,
  );
  assert.equal(
    salesforceProgramCardMatchesCandidate(
      "Select Artificial Intelligence Operations - English",
      "Artificial Intelligence Operations - Turkish",
    ),
    false,
  );
  assert.equal(
    salesforceProgramCardMatchesCandidate(
      "Select Artificial Intelligence Operation - Turkish",
      "Artificial Intelligence Operations - Turkish",
    ),
    false,
  );
});

test("Salesforce binary resolver supports value, data-value and associated labels", () => {
  assert.equal(
    chooseSalesforceBinaryCandidate(
      [
        { index: 0, value: "Yes" },
        { index: 1, value: "No" },
      ],
      "No",
    ),
    1,
  );
  assert.equal(
    chooseSalesforceBinaryCandidate(
      [
        { index: 0, dataValue: "true" },
        { index: 1, label: "Hayır" },
      ],
      "No",
    ),
    1,
  );
  assert.equal(
    chooseSalesforceBinaryCandidate(
      [
        { index: 0, label: "No" },
        { index: 1, ariaLabel: "No" },
      ],
      "No",
    ),
    null,
  );
});

test("Salesforce completion rejects a future step label without durable proof", () => {
  assert.equal(
    hasSalesforceCompletionProof({
      activeStage: "Documents",
      trackStage: "Completed",
    }),
    false,
  );
  assert.equal(
    hasSalesforceCompletionProof({
      externalRef: "USK-292440",
      applicationStatus: "Submitted",
    }),
    true,
  );
});

test("Salesforce upload proof requires exact file selection and portal evidence", () => {
  assert.equal(
    hasSalesforceUploadProof({
      localPath: "/tmp/Passport.pdf",
      inputValue: "C:\\fakepath\\Passport.pdf",
      containerText: "Passport.pdf Uploaded",
      ariaInvalid: "false",
    }),
    true,
  );
  assert.equal(
    hasSalesforceUploadProof({
      localPath: "/tmp/Passport.pdf",
      inputValue: "C:\\fakepath\\Passport.pdf",
      containerText: "Click to upload Passport",
      ariaInvalid: "false",
    }),
    false,
  );
  assert.equal(
    hasSalesforceUploadProof({
      localPath: "/tmp/Passport.pdf",
      inputValue: "C:\\fakepath\\Transcript.pdf",
      containerText: "Upload successful",
      ariaInvalid: "false",
    }),
    false,
  );
  assert.equal(
    hasSalesforceUploadProof({
      localPath: "/tmp/Passport.pdf",
      inputValue: "C:\\fakepath\\Passport.pdf",
      containerText: "Passport.pdf Uploaded",
      ariaInvalid: "true",
    }),
    false,
  );
});
