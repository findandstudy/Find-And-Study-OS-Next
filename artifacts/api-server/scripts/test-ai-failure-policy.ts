import assert from "node:assert/strict";
import test from "node:test";
import { aiRetryDelaySeconds, classifyAiFailure } from "../src/lib/aiFailurePolicy";

test("classifies transient failures as retryable", () => {
  assert.deepEqual(classifyAiFailure(new Error("HTTP 429 rate limit")), {
    category: "rate_limit",
    retryable: true,
    retryAfterSeconds: 60,
  });
  assert.equal(classifyAiFailure(new Error("request timed out")).category, "timeout");
  assert.equal(classifyAiFailure(new Error("503 service unavailable")).retryable, true);
});

test("does not retry auth, invalid request, safety or unknown failures", () => {
  for (const message of [
    "401 invalid API key",
    "400 invalid request",
    "blocked by content policy",
    "unexpected response shape",
  ]) {
    assert.equal(classifyAiFailure(new Error(message)).retryable, false, message);
  }
});

test("uses bounded exponential backoff", () => {
  assert.equal(aiRetryDelaySeconds(1, 30), 30);
  assert.equal(aiRetryDelaySeconds(2, 30), 60);
  assert.equal(aiRetryDelaySeconds(3, 120), 300);
  assert.equal(aiRetryDelaySeconds(99, 120), 300);
});
