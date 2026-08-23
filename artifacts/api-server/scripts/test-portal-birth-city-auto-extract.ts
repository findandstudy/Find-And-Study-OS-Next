import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  birthCityDocumentPriority,
  cleanBirthCityCandidate,
  parseBirthCityAiExtraction,
  parseStoredBirthCityExtraction,
} from "../src/lib/portalBirthCityAutoExtract.js";

const read = (relativePath: string): string =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("portal preflight invokes the birth-city fallback and passport prompt is field-specific", () => {
  const preflight = read("src/lib/portalApplicationPreflight.ts");
  const passport = read("src/lib/portalProfileAutoExtract.ts");
  assert.match(preflight, /autoFillMissingBirthCityFromDocuments\(\{/);
  assert.match(preflight, /result\.missingFields\.includes\("cityOfBirth"\)/);
  assert.match(passport, /"cityOfBirthConfidence": "high\|medium\|low"/);
  assert.match(passport, /extracted\.cityOfBirthConfidence/);
});

test("document priority keeps authoritative identity sources first", () => {
  assert.equal(birthCityDocumentPriority({ type: "passport" }), 0);
  assert.equal(birthCityDocumentPriority({ type: "National ID Card" }), 1);
  assert.equal(birthCityDocumentPriority({ type: "Diploma Certificate" }), 2);
  assert.equal(birthCityDocumentPriority({ type: "Diploma Transcript" }), 3);
  assert.equal(birthCityDocumentPriority({ type: "other" }), 4);
  assert.equal(birthCityDocumentPriority({ type: "Photograph" }), -1);
});

test("stored extraction requires field-specific high confidence", () => {
  assert.equal(
    parseStoredBirthCityExtraction({
      cityOfBirth: "Lahore",
      cityOfBirthConfidence: "high",
    }),
    "Lahore",
  );
  assert.equal(
    parseStoredBirthCityExtraction({
      cityOfBirth: "Lahore",
      confidence: "high",
    }),
    null,
  );
  assert.equal(
    parseStoredBirthCityExtraction({
      cityOfBirth: "Lahore",
      cityOfBirthConfidence: "medium",
    }),
    null,
  );
});

test("AI extraction requires high confidence, evidence and a valid source", () => {
  assert.deepEqual(
    parseBirthCityAiExtraction(
      {
        cityOfBirth: "Dushanbe",
        evidenceLabel: "Place of birth",
        evidenceValue: "DUSHANBE",
        sourceDocument: 2,
        confidence: "high",
      },
      3,
    ),
    { city: "Dushanbe", sourceDocument: 2 },
  );
  assert.equal(
    parseBirthCityAiExtraction(
      {
        cityOfBirth: "Dushanbe",
        evidenceLabel: "Place of birth",
        evidenceValue: "DUSHANBE",
        sourceDocument: 4,
        confidence: "high",
      },
      3,
    ),
    null,
  );
  assert.equal(
    parseBirthCityAiExtraction(
      {
        cityOfBirth: "Dushanbe",
        evidenceLabel: "Place of birth",
        evidenceValue: "DUSHANBE",
        sourceDocument: 1,
        confidence: "medium",
      },
      3,
    ),
    null,
  );
});

test("residence, institution and address fields are never accepted as birth city", () => {
  assert.equal(
    parseStoredBirthCityExtraction({
      cityOfBirthConfidence: "high",
      city: "Istanbul",
      eduCity: "Ankara",
      addressCity: "Lahore",
    } as never),
    null,
  );
  assert.equal(cleanBirthCityCandidate("Lahore District"), null);
  assert.equal(cleanBirthCityCandidate("House 12 Lahore"), null);
  assert.equal(cleanBirthCityCandidate("St. John's"), "St. John's");
});
