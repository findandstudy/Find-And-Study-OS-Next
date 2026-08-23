/**
 * test-doc-slot-mapping.ts — Pure mapDocType unit tests (no DB, no browser)
 *
 * Imports directly from lib source to avoid barrel → browser.js → playwright hang.
 *
 * TMD1–TMD10: mapDocType canonical cases including #2103 document types
 *
 * Skip-reason surface tests (TSR1, TSR2) live in test-portal-process.ts.
 *
 * Run:
 *   pnpm --filter @workspace/api-server run test:doc-slot-mapping
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// Direct source import — bypasses barrel (which re-exports browser.js → playwright)
import { mapDocType, REQUIRED_DOCS } from "../../../lib/portal-adapters/src/profile.js";

// ===========================================================================
// TMD1–TMD3: Canonical photo + passport
// ===========================================================================

test("TMD1: passport → 'passport'", () => {
  assert.equal(mapDocType("passport"), "passport");
});

test("TMD2: photo → 'photo'", () => {
  assert.equal(mapDocType("photo"), "photo");
});

test("TMD3: photograph → 'photo'", () => {
  assert.equal(mapDocType("photograph"), "photo");
});

// ===========================================================================
// TMD4–TMD5: #2103 actual DB document types
// ===========================================================================

test("TMD4: class_12th_hsc_marks_sheet → 'transcript' (#2103 transcript doc)", () => {
  assert.equal(mapDocType("class_12th_hsc_marks_sheet"), "transcript");
});

test("TMD5: high_school_diploma_translation → 'diploma' (#2103 diploma doc)", () => {
  assert.equal(mapDocType("high_school_diploma_translation"), "diploma");
});

// ===========================================================================
// TMD6–TMD8: Extended patterns
// ===========================================================================

test("TMD6: hsc standalone → 'transcript' (new hsc keyword)", () => {
  assert.equal(mapDocType("hsc"), "transcript");
});

test("TMD7: hsc_marksheet → 'transcript' (hsc+marksheet, transcript wins)", () => {
  assert.equal(mapDocType("hsc_marksheet"), "transcript");
});

test("TMD8: bachelors_certificate → 'diploma' (new certificate keyword)", () => {
  assert.equal(mapDocType("bachelors_certificate"), "diploma");
});

test("TMD9: unknown_document_type → null (unmapped returns null)", () => {
  assert.equal(mapDocType("unknown_document_type"), null);
});

// ===========================================================================
// TMD10: All 4 REQUIRED_DOCS slots covered for #2103 student
// ===========================================================================

test("TMD10: #2103 scenario — all 4 REQUIRED_DOCS slots filled by the student's doc types", () => {
  const studentDocTypes = [
    "photo",
    "passport",
    "class_12th_hsc_marks_sheet",
    "high_school_diploma_translation",
  ];

  const mappedSlots = new Set(
    studentDocTypes.map(mapDocType).filter((s): s is string => s !== null),
  );

  for (const required of REQUIRED_DOCS) {
    assert.ok(
      mappedSlots.has(required),
      `Required slot "${required}" not covered. Mapped: [${[...mappedSlots].join(", ")}]`,
    );
  }
  assert.equal(
    mappedSlots.size,
    4,
    `Expected 4 unique slots, got ${mappedSlots.size}: [${[...mappedSlots].join(", ")}]`,
  );
});
