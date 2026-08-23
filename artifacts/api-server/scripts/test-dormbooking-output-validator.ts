import test from "node:test";
import assert from "node:assert/strict";
import { validateDormBookingOutput } from "../src/lib/inbox/dormBookingOutputValidator.js";

test("accepts a concise catalog-grounded discovery reply", () => {
  const result = validateDormBookingOutput({
    text: "Which university will you attend?\nWhat is your gender and preferred room type?",
    firstReply: true,
  });
  assert.equal(result.ok, true);
});

test("rejects praise, excessive questions and mixed language", () => {
  const result = validateDormBookingOutput({
    text: "Perfect! Merhaba, I can help you.\nWhich university?\nWhich room?\nWhat budget?\nWhen?",
    firstReply: true,
  });
  assert.deepEqual(new Set(result.ruleIds), new Set(["length", "question_count", "praise_opener", "language_mixing"]));
});

test("rejects a currency added to the student's currency-free figure", () => {
  const result = validateDormBookingOutput({
    text: "Your budget is USD 4000.",
    latestInbound: "My budget is 4000",
    firstReply: false,
  });
  assert.deepEqual(result.ruleIds, ["currency_assumption"]);
});
