import test from "node:test";
import assert from "node:assert/strict";
import { collectPortalPreflightIssueLabels } from "../src/lib/portalBulkRunFeedback.js";

test("includes missing and incompatible passport fields", () => {
  assert.deepEqual(
    collectPortalPreflightIssueLabels([
      {
        missingFields: ["addressCity"],
        incompatibleFields: [
          { field: "firstName", reason: "mismatch" },
          { field: "passportNumber", reason: "mismatch" },
        ],
      },
    ]),
    ["Residence city", "First name (passport)", "Passport number"],
  );
});

test("never renders an empty dash for an unknown blocker", () => {
  assert.deepEqual(
    collectPortalPreflightIssueLabels([{}]),
    ["Passport or required profile information could not be verified"],
  );
});

test("distinguishes temporary AI verification failure from an invalid passport", () => {
  assert.deepEqual(
    collectPortalPreflightIssueLabels([
      {
        incompatibleFields: [
          {
            field: "passportIdentityProof",
            reason: "verification_unavailable",
          },
        ],
      },
    ]),
    ["Passport verification temporarily unavailable — retry shortly"],
  );
});
