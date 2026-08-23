import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasHighConfidencePassportIdentityExtraction,
  shouldRefreshPassportIdentityExtraction,
  stampPassportIdentityExtraction,
} from "../src/lib/portalPassportExtractionPolicy.js";

const mediumIdentity = {
  firstName: "Aisha",
  lastName: "Khan",
  passportNumber: "AB123",
  confidence: "medium",
};

test("legacy medium extraction is refreshed once", () => {
  assert.equal(
    shouldRefreshPassportIdentityExtraction(mediumIdentity, 0.6),
    true,
  );
});

test("versioned medium extraction does not create an infinite retry loop", () => {
  const stamped = stampPassportIdentityExtraction(mediumIdentity);
  assert.equal(
    shouldRefreshPassportIdentityExtraction(stamped, 0.6),
    false,
  );
});

test("identity-specific high confidence is accepted independently", () => {
  const extracted = {
    ...mediumIdentity,
    identityConfidence: "high",
  };
  assert.equal(hasHighConfidencePassportIdentityExtraction(extracted, 0.6), true);
  assert.equal(shouldRefreshPassportIdentityExtraction(extracted, 0.6), false);
});

test("explicit medium identity confidence cannot be upgraded by general confidence", () => {
  const extracted = {
    ...mediumIdentity,
    identityConfidence: "medium",
    confidence: "high",
  };
  assert.equal(hasHighConfidencePassportIdentityExtraction(extracted, 1), false);
  assert.equal(shouldRefreshPassportIdentityExtraction(extracted, 1), false);
});

test("missing extraction is eligible for a first read", () => {
  assert.equal(shouldRefreshPassportIdentityExtraction(null, 0), true);
});

test("a previously accepted quoted passport number is re-read once", () => {
  const malformed = {
    firstName: "Aisha",
    lastName: "Khan",
    passportNumber: "A0'0458U",
    identityConfidence: "high",
    confidence: "high",
    portalPassportIdentityExtractionVersion: 1,
  };
  assert.equal(shouldRefreshPassportIdentityExtraction(malformed, 1), true);

  const stamped = stampPassportIdentityExtraction({
    ...malformed,
    passportNumber: null,
  });
  assert.equal(shouldRefreshPassportIdentityExtraction(stamped, 1), false);
});
