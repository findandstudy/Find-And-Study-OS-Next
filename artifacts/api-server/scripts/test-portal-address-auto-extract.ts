import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveDeterministicAddressCity,
  parseAddressCityExtraction,
} from "../src/lib/portalAddressAutoExtract.js";

test("explicit CITY segment is resolved without AI", () => {
  assert.equal(
    deriveDeterministicAddressCity(
      "RASHID BEHBUDOV STREET 71, KHIRDALAN CITY, ABSHERON DISTRICT, AZERBAIJAN",
      "Azerbaijan",
    ),
    "KHIRDALAN",
  );
});

test("single bare city is resolved without AI", () => {
  assert.equal(
    deriveDeterministicAddressCity("GUJRAT", "Pakistan"),
    "GUJRAT",
  );
});

test("street-like first segment is never treated as a city", () => {
  assert.equal(
    deriveDeterministicAddressCity(
      "HOUSE NO. 165, STREET 02, MADAN PURA, FAISALABAD, PUNJAB, PAKISTAN",
      "Pakistan",
    ),
    null,
  );
});

test("AI result requires high confidence and exact evidence", () => {
  const address =
    "HOUSE NO. 165, STREET 02, MADAN PURA, FAISALABAD, PUNJAB, PAKISTAN";
  assert.equal(
    parseAddressCityExtraction(address, "Pakistan", {
      city: "FAISALABAD",
      evidence: "FAISALABAD",
      confidence: "high",
    }),
    "FAISALABAD",
  );
  assert.equal(
    parseAddressCityExtraction(address, "Pakistan", {
      city: "LAHORE",
      evidence: "LAHORE",
      confidence: "high",
    }),
    null,
  );
  assert.equal(
    parseAddressCityExtraction(address, "Pakistan", {
      city: "FAISALABAD",
      evidence: "FAISALABAD",
      confidence: "medium",
    }),
    null,
  );
});

test("country/state/address fragments are rejected", () => {
  assert.equal(
    deriveDeterministicAddressCity("PAKISTAN", "Pakistan"),
    null,
  );
  assert.equal(
    parseAddressCityExtraction("LAGOS STATE", "Nigeria", {
      city: "LAGOS STATE",
      evidence: "LAGOS STATE",
      confidence: "high",
    }),
    null,
  );
});
