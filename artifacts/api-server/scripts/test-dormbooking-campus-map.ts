import test from "node:test";
import assert from "node:assert/strict";
import { resolveDormBookingCampusGuidance } from "../src/lib/inbox/dormBookingCampusMap.js";

test("Kültür University routes only to the European side", () => {
  const guidance = resolveDormBookingCampusGuidance("Which dorm for İstanbul Kültür University?") || "";
  assert.match(guidance, /European/);
  assert.match(guidance, /Bakırköy/);
  assert.match(guidance, /opposite-side/);
});

test("Beykent fails closed until programme and campus are confirmed", () => {
  const guidance = resolveDormBookingCampusGuidance("Beykent University yakınında yurt") || "";
  assert.match(guidance, /Ask for the department\/programme and exact campus/);
  assert.match(guidance, /Do not recommend/);
});

test("unknown universities do not receive a guessed campus", () => {
  assert.equal(resolveDormBookingCampusGuidance("Unknown University"), null);
});
