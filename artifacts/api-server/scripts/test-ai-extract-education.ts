/**
 * educationExtraction — unit tests (FAZ 3).
 *
 * AE-1  Level mapping: Bachelor apply → only high_school record kept.
 * AE-2  Master apply → only bachelor record kept.
 * AE-3  PhD apply → bachelor + master kept, ordered.
 * AE-4  GPA normalize: "3.5/4" → percent with gpaRaw + gpaScale=100.
 * AE-5  Unnormalizable GPA kept raw (gpaScale null).
 * AE-6  high_school program force-nulled; dedup levels (first wins).
 * AE-7  Garbage / non-array input → [].
 * AE-8  Prompt section lists required records per level.
 * AE-9  Passport soft-warning helper: expired → true (route pushes code).
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:ai-extract-education
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEducationPromptSection,
  mapExtractionToEducation,
  decideEducationExtraction,
  decideLegacyEducationAutoUpsert,
  decideAutoEducationTrigger,
  hasRequiredEducationCoverage,
  isEducationTriggerDocType,
  EDUCATION_SOURCE_DOC_TYPES,
  EDUCATION_FUZZY_KEYWORDS,
  AI_EDUCATION_RECORD_SOURCE,
  type EducationRecordOutput,
} from "../src/lib/educationExtraction.js";
import { isPassportExpired } from "../src/lib/passportValidity.js";

const mockAll = [
  { level: "high_school", institution: "Ankara Lisesi", graduationYear: "2019", gpa: "87.5", languageScore: null },
  { level: "bachelor", institution: "Bilkent University", program: "Computer Science", graduationYear: 2023, gpa: "3.5/4", languageScore: "IELTS 7.0" },
  { level: "master", institution: "METU", program: "AI", graduationYear: 2025, gpa: "3.8/4", languageScore: "TOEFL 100" },
];

it("AI detailed education rows use the live DB-allowed source", () => {
  assert.equal(AI_EDUCATION_RECORD_SOURCE, "ai_extracted");
  assert.ok(["manual", "ai_extracted", "migrated"].includes(AI_EDUCATION_RECORD_SOURCE));
});

describe("mapExtractionToEducation — level mapping", () => {
  it("AE-1 Bachelor apply (group A) → only high_school", () => {
    const out = mapExtractionToEducation(mockAll, "Bachelor");
    assert.equal(out.length, 1);
    assert.equal(out[0].level, "high_school");
    assert.equal(out[0].institution, "Ankara Lisesi");
    assert.equal(out[0].graduationYear, 2019);
  });
  it("AE-2 Master apply (group B) → only bachelor", () => {
    const out = mapExtractionToEducation(mockAll, "Master");
    assert.equal(out.length, 1);
    assert.equal(out[0].level, "bachelor");
    assert.equal(out[0].program, "Computer Science");
    assert.equal(out[0].languageScore, "IELTS 7.0");
  });
  it("AE-3 PhD apply (group C) → bachelor + master ordered", () => {
    const out = mapExtractionToEducation(mockAll, "PhD");
    assert.deepEqual(out.map((r) => r.level), ["bachelor", "master"]);
  });
});

describe("hasRequiredEducationCoverage — current level aware", () => {
  it("does not accept an old high-school row for a Master application", () => {
    assert.equal(
      hasRequiredEducationCoverage("Master", [
        {
          level: "high_school",
          institution: "OLD SCHOOL",
          program: null,
          graduationYear: 2019,
          gpa: "75",
          gpaRaw: "75 / 100",
          gpaScale: 100,
          languageScore: null,
        },
      ]),
      false,
    );
  });

  it("does not accept a partial bachelor row for a Master application", () => {
    assert.equal(
      hasRequiredEducationCoverage("Master", [
        {
          level: "bachelor",
          institution: "UNIVERSITY",
          program: null,
          graduationYear: null,
          gpa: null,
          gpaRaw: null,
          gpaScale: null,
          languageScore: null,
        },
      ]),
      false,
    );
  });

  it("accepts a complete bachelor row for a Master application", () => {
    assert.equal(
      hasRequiredEducationCoverage("Master", [
        {
          level: "bachelor",
          institution: "UNIVERSITY",
          program: null,
          graduationYear: 2020,
          gpa: "75",
          gpaRaw: "75 / 100",
          gpaScale: 100,
          languageScore: null,
        },
      ]),
      true,
    );
  });
});

describe("mapExtractionToEducation — GPA guarantee", () => {
  it("AE-4 '3.5/4' → percent, gpaRaw kept, gpaScale=100", () => {
    const out = mapExtractionToEducation(mockAll, "Master");
    const b = out[0];
    assert.equal(b.gpaRaw, "3.5/4");
    assert.equal(b.gpaScale, 100);
    const pct = Number(b.gpa);
    assert.ok(pct > 80 && pct <= 100, `expected percent-ish value, got ${b.gpa}`);
  });
  it("AE-4b '87.5' → integer percent (portal compatibility), raw kept", () => {
    const out = mapExtractionToEducation(mockAll, "Bachelor");
    assert.equal(out[0].gpa, "88");
    assert.equal(out[0].gpaRaw, "87.5");
    assert.equal(out[0].gpaScale, 100);
  });
  it("AE-5 unnormalizable gpa kept raw with null scale", () => {
    const out = mapExtractionToEducation(
      [{ level: "high_school", gpa: "Pekiyi" }],
      "Foundation",
    );
    assert.equal(out[0].gpa, "Pekiyi");
    assert.equal(out[0].gpaRaw, "Pekiyi");
    assert.equal(out[0].gpaScale, null);
  });
});

describe("mapExtractionToEducation — hygiene", () => {
  it("AE-6 high_school program nulled; duplicate level first-wins", () => {
    const out = mapExtractionToEducation(
      [
        { level: "high_school", institution: "First HS", program: "ShouldDrop" },
        { level: "high_school", institution: "Second HS" },
      ],
      "Language Course",
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].institution, "First HS");
    assert.equal(out[0].program, null);
  });
  it("AE-7 garbage input → []", () => {
    assert.deepEqual(mapExtractionToEducation(undefined, "Bachelor"), []);
    assert.deepEqual(mapExtractionToEducation("nope", "Bachelor"), []);
    assert.deepEqual(mapExtractionToEducation([{ level: "kindergarten" }], "Bachelor"), []);
    assert.deepEqual(mapExtractionToEducation({ level: "bachelor" }, "Master"), []);
  });
});

describe("buildEducationPromptSection", () => {
  it("AE-8 lists exactly the required records per applied level", () => {
    const a = buildEducationPromptSection("Bachelor");
    assert.ok(a.includes('"level": "high_school"'));
    assert.ok(!a.includes('"level": "bachelor"'));

    const b = buildEducationPromptSection("Yüksek Lisans");
    assert.ok(b.includes('"level": "bachelor"'));
    assert.ok(!b.includes('"level": "high_school"'));

    const c = buildEducationPromptSection("Doktora");
    assert.ok(c.includes('"level": "bachelor"'));
    assert.ok(c.includes('"level": "master"'));
    assert.ok(c.includes("educationRecords"));
  });
});

// --- FAZ 1: POST /ai/students/:id/extract-education decision core ---------
describe("decideEducationExtraction — extract-education endpoint core", () => {
  it("EE-1 Master apply + mock educationRecords[{level:'bachelor'}] → bachelor record kept", () => {
    const out = decideEducationExtraction({
      levelKey: "Master",
      documentCount: 2,
      educationRecords: [
        { level: "bachelor", institution: "Bilkent University", program: "CS", graduationYear: 2023, gpa: "3.5/4" },
      ],
      confidence: "high",
    });
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0].level, "bachelor");
    assert.equal(out.records[0].institution, "Bilkent University");
    assert.equal(out.levelKey, "Master");
    assert.deepEqual(out.warnings, []);
  });

  it("EE-2 confidence 'low' with readable fields → record SAVED + LOW_CONFIDENCE_EDUCATION", () => {
    const out = decideEducationExtraction({
      levelKey: "Master",
      documentCount: 1,
      educationRecords: [
        { level: "bachelor", institution: "Some University", program: null, graduationYear: null, gpa: null },
      ],
      confidence: "low",
    });
    // Critical gate fix: the record is NOT dropped.
    assert.equal(out.records.length, 1);
    assert.equal(out.records[0].institution, "Some University");
    assert.ok(out.warnings.includes("LOW_CONFIDENCE_EDUCATION"));
  });

  it("EE-2b confidence 'low' with NO readable fields → nothing saved, no low-confidence warning", () => {
    const out = decideEducationExtraction({
      levelKey: "Master",
      documentCount: 1,
      educationRecords: [{ level: "bachelor" }],
      confidence: "low",
    });
    assert.equal(out.records.length, 0);
    assert.ok(!out.warnings.includes("LOW_CONFIDENCE_EDUCATION"));
  });

  it("EE-3 no education documents → NO_EDUCATION_DOCUMENTS, nothing saved (route responds 200, upserted=0)", () => {
    const out = decideEducationExtraction({ levelKey: "Master", documentCount: 0 });
    assert.deepEqual(out.records, []);
    assert.deepEqual(out.warnings, ["NO_EDUCATION_DOCUMENTS"]);
    assert.equal(out.levelKey, "Master");
  });

  it("EE-3b unresolved level → LEVEL_UNRESOLVED", () => {
    const out = decideEducationExtraction({ levelKey: null, documentCount: 3 });
    assert.deepEqual(out.records, []);
    assert.deepEqual(out.warnings, ["LEVEL_UNRESOLVED"]);
    assert.equal(out.levelKey, null);
  });

  it("EE-4 invalid level 'kindergarten' is excluded", () => {
    const out = decideEducationExtraction({
      levelKey: "Master",
      documentCount: 1,
      educationRecords: [
        { level: "kindergarten", institution: "Tiny Tots" },
        { level: "bachelor", institution: "Real University" },
      ],
      confidence: "high",
    });
    // zod schema rejects the whole array on unknown level → nothing kept.
    // (Same behavior as mapExtractionToEducation — see AE-7.)
    assert.ok(out.records.every((r) => (r.level as string) !== "kindergarten"));
    assert.deepEqual(
      mapExtractionToEducation([{ level: "kindergarten", institution: "Tiny Tots" }], "Master"),
      [],
    );
  });
});

describe("decideLegacyEducationAutoUpsert — legacy /ai/extract-document FIX-15D gate", () => {
  const bachelorPartial: EducationRecordOutput = {
    level: "bachelor",
    institution: "Some University",
    program: null,
    graduationYear: null,
    gpa: null,
    gpaRaw: null,
    gpaScale: null,
    languageScore: null,
  };
  const empty: EducationRecordOutput = {
    level: "bachelor",
    institution: null,
    program: null,
    graduationYear: null,
    gpa: null,
    gpaRaw: null,
    gpaScale: null,
    languageScore: null,
  };

  it("EL-1 confidence 'low' + readable bachelor fields → SAVED (partial-save) + lowConfidence flag (parallel to EE-2)", () => {
    const out = decideLegacyEducationAutoUpsert({ confidence: "low", record: bachelorPartial });
    assert.equal(out.save, true);
    assert.equal(out.lowConfidence, true);
  });

  it("EL-1b confidence 'low' + gpa-only record → still SAVED", () => {
    const out = decideLegacyEducationAutoUpsert({
      confidence: "low",
      record: { ...empty, gpa: "88" },
    });
    assert.equal(out.save, true);
    assert.equal(out.lowConfidence, true);
  });

  it("EL-2 confidence 'low' + NO readable fields → skipped, no save", () => {
    const out = decideLegacyEducationAutoUpsert({ confidence: "low", record: empty });
    assert.equal(out.save, false);
    assert.equal(out.lowConfidence, true);
  });

  it("EL-3 normal/high confidence → always saved, no low-confidence flag (legacy behavior unchanged)", () => {
    assert.deepEqual(
      decideLegacyEducationAutoUpsert({ confidence: "high", record: empty }),
      { save: true, lowConfidence: false },
    );
    assert.deepEqual(
      decideLegacyEducationAutoUpsert({ confidence: undefined, record: bachelorPartial }),
      { save: true, lowConfidence: false },
    );
  });
});

describe("decideAutoEducationTrigger — automatic document-upload trigger gate", () => {
  const filled: EducationRecordOutput = {
    level: "high_school", institution: "Ankara Lisesi", program: null,
    graduationYear: "2019", gpa: 88, gpaRaw: "87.5", gpaScale: null, languageScore: null,
  };
  const emptyRec: EducationRecordOutput = {
    level: "bachelor", institution: null, program: null,
    graduationYear: null, gpa: null, gpaRaw: null, gpaScale: null, languageScore: null,
  };

  it("AT-1 transcript uploaded + education EMPTY → trigger fires", () => {
    assert.equal(decideAutoEducationTrigger({ documentType: "transcript", existingRecords: [] }), true);
  });

  it("AT-2 transcript uploaded + education already FILLED → no trigger (idempotent, no AI call)", () => {
    assert.equal(decideAutoEducationTrigger({ documentType: "transcript", existingRecords: [filled] }), false);
  });

  it("AT-3 core types fire; passport/photo/bank/visa/id/other never do", () => {
    assert.equal(decideAutoEducationTrigger({ documentType: "diploma", existingRecords: [] }), true);
    assert.equal(decideAutoEducationTrigger({ documentType: "Degree Certificate", existingRecords: [] }), true);
    assert.equal(decideAutoEducationTrigger({ documentType: "passport", existingRecords: [] }), false);
    assert.equal(decideAutoEducationTrigger({ documentType: "photo", existingRecords: [] }), false);
    assert.equal(decideAutoEducationTrigger({ documentType: "photograph", existingRecords: [] }), false);
    assert.equal(decideAutoEducationTrigger({ documentType: "bank statement", existingRecords: [] }), false);
    assert.equal(decideAutoEducationTrigger({ documentType: "visa", existingRecords: [] }), false);
    assert.equal(decideAutoEducationTrigger({ documentType: "national id", existingRecords: [] }), false);
    assert.equal(decideAutoEducationTrigger({ documentType: "other", existingRecords: [] }), false);
    assert.equal(decideAutoEducationTrigger({ documentType: null, existingRecords: [] }), false);
  });

  it("AT-4 data-less placeholder records do NOT block the trigger", () => {
    assert.equal(decideAutoEducationTrigger({ documentType: "transcript", existingRecords: [emptyRec] }), true);
  });

  it("AT-5 isEducationTriggerDocType is case-insensitive substring match", () => {
    assert.equal(isEducationTriggerDocType("TRANSCRIPT"), true);
    assert.equal(isEducationTriggerDocType("high_school_diploma"), true);
    assert.equal(isEducationTriggerDocType(undefined), false);
    assert.equal(isEducationTriggerDocType(""), false);
    assert.equal(isEducationTriggerDocType(null), false);
  });

  it("AT-6 every keyword in EDUCATION_FUZZY_KEYWORDS triggers isEducationTriggerDocType", () => {
    for (const kw of EDUCATION_FUZZY_KEYWORDS) {
      assert.equal(
        isEducationTriggerDocType(kw),
        true,
        `keyword "${kw}" from EDUCATION_FUZZY_KEYWORDS must trigger`,
      );
      // Also check embedded in a realistic label
      assert.equal(
        isEducationTriggerDocType(`some ${kw} document`),
        true,
        `"some ${kw} document" must trigger`,
      );
    }
  });

  it("AT-7 real-world label variants that must now trigger (broadened matching)", () => {
    const shouldTrigger = [
      "high school diploma translation",        // "diploma" keyword
      "high_school_diploma_translation",        // underscore form (559 docs in prod)
      "class 12th marks sheet",                 // "marks" keyword
      "class_12th_hsc_marks_sheet",             // "hsc" + "marks" (572 docs in prod)
      "bachelor's transcript",                  // "transcript" keyword
      "marksheet",                              // "marks" keyword
      "school leaving certificate",             // "certificate" keyword
      "leaving cert",                           // "cert" abbreviated form
      "a-level cert",                           // "cert" abbreviated form
      "academic record",                        // "academic" keyword
      "secondary school certificate",           // "secondary" keyword
      "grade card",                             // "grade" keyword
      "exam result",                            // "result" keyword
      "baccalaureate",                          // "baccalaur" keyword
      "matriculation certificate",              // "matriculat" keyword
      "HSC marksheet",                          // "hsc" keyword (case-insensitive)
      "SSC certificate",                        // "ssc" keyword
      "credential equivalency",                 // "equivalency" keyword
      "education equivalency document",         // "equivalency" keyword
      "MARKS SHEET",                            // case-insensitive
      "Grade Report",                           // case-insensitive
      "HSC_MARKS",                              // underscore, uppercase
    ];
    for (const label of shouldTrigger) {
      assert.equal(
        isEducationTriggerDocType(label),
        true,
        `"${label}" should trigger education extraction`,
      );
    }
  });

  it("AT-8 unrelated document types must NOT trigger", () => {
    const shouldNotTrigger = [
      "passport",
      "photo",
      "photograph",
      "national id",
      "id card",
      "bank statement",
      "visa",
      "reference letter",
      "financial guarantee",
      "other",
      "",
    ];
    for (const label of shouldNotTrigger) {
      assert.equal(
        isEducationTriggerDocType(label),
        false,
        `"${label}" must NOT trigger education extraction`,
      );
    }
  });
});

describe("passport soft-warning", () => {
  it("AE-9 expired expiry triggers the warning path, valid does not", () => {
    assert.equal(isPassportExpired("2020-01-01"), true);
    assert.equal(isPassportExpired("2099-12-31"), false);
    assert.equal(isPassportExpired("garbage"), false);
  });
});
