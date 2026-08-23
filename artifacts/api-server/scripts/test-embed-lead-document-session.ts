import assert from "node:assert/strict";
import test from "node:test";
import {
  createEmbedLeadDocumentSessionToken,
  verifyEmbedLeadDocumentSessionToken,
} from "../src/lib/embedLeadDocumentSession";

const secret = "local-test-secret";
const now = Date.UTC(2026, 7, 4, 12, 0, 0);

test("round-trips a slug-bound lead document session", () => {
  const token = createEmbedLeadDocumentSessionToken(secret, "okan-programs", 3399, now);
  assert.deepEqual(
    verifyEmbedLeadDocumentSessionToken(secret, token, "okan-programs", now + 1000),
    { leadId: 3399 },
  );
});

test("rejects tampered, cross-widget and expired sessions", () => {
  const token = createEmbedLeadDocumentSessionToken(secret, "okan-programs", 3399, now);
  assert.equal(verifyEmbedLeadDocumentSessionToken(secret, `${token}x`, "okan-programs", now), null);
  assert.equal(verifyEmbedLeadDocumentSessionToken(secret, token, "another-widget", now), null);
  assert.equal(verifyEmbedLeadDocumentSessionToken(secret, token, "okan-programs", now + 3 * 60 * 60 * 1000), null);
});
