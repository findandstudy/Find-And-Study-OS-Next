/**
 * test-altinbas-flow-fields.ts — unit tests for flow-fields.ts (mapCountry)
 *
 * Run: pnpm --filter @workspace/api-server run test:altinbas-flow-fields
 *
 * Covers:
 *  - mapCountry: empty/null → null (no silent Turkey fallback)
 *  - mapCountry: adjective form → canonical portal name
 *  - mapCountry: country name form (as stored in prod DB) → canonical name
 *  - mapCountry: ISO alpha-2 code → canonical name
 *  - mapCountry: unknown value → title-cased raw (not null, not "Turkey")
 *  - buildPersonalFields: throws MISSING_NATIONALITY when nationality absent
 *  - buildPersonalFields: succeeds with a valid nationality
 *  - browser.ts MEM_ARGS: --no-zygote and --disable-setuid-sandbox present
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapCountry,
  buildPersonalFields,
  buildQuestionnaireFields,
  classifyProfileLevel,
  checkMissingEduRecord,
} from "../../../lib/portal-adapters/src/universities/altinbas/flow-fields.js";

describe("buildQuestionnaireFields — explicit answer only", () => {
  it("rejects a missing answer instead of defaulting to Yes", () => {
    assert.throws(
      () => buildQuestionnaireFields(undefined),
      /DATA_MISSING: needsVisaSupport/,
    );
  });
  it("normalizes an explicit no", () => {
    const fields = buildQuestionnaireFields(" no ");
    assert.deepEqual(
      fields.map((field) => field.value),
      ["No", "No"],
    );
  });
});

// ---------------------------------------------------------------------------
// mapCountry — null on empty input
// ---------------------------------------------------------------------------

describe("mapCountry — empty / missing input → null", () => {
  it("undefined → null", () => assert.equal(mapCountry(undefined), null));
  it("empty string → null", () => assert.equal(mapCountry(""), null));
  it("whitespace-only → null", () => assert.equal(mapCountry("   "), null));
});

// ---------------------------------------------------------------------------
// mapCountry — adjective / demonym forms (legacy CRM convention)
// ---------------------------------------------------------------------------

describe("mapCountry — adjective forms", () => {
  const cases: [string, string][] = [
    ["Pakistani",    "Pakistan"],
    ["afghan",       "Afghanistan"],
    ["Nigerian",     "Nigeria"],
    ["TURKISH",      "Turkey"],
    ["turk",         "Turkey"],
    ["moroccan",     "Morocco"],
    ["uzbek",        "Uzbekistan"],
    ["kazakh",       "Kazakhstan"],
    ["azerbaijani",  "Azerbaijan"],
    ["british",      "United Kingdom"],
    ["saudi",        "Saudi Arabia"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => assert.equal(mapCountry(input), expected));
  }
});

// ---------------------------------------------------------------------------
// mapCountry — country name forms (as stored in prod DB, lowercase)
// ---------------------------------------------------------------------------

describe("mapCountry — country name forms (prod DB convention)", () => {
  const cases: [string, string][] = [
    ["pakistan",         "Pakistan"],
    ["afghanistan",      "Afghanistan"],
    ["nigeria",          "Nigeria"],
    ["morocco",          "Morocco"],
    ["uzbekistan",       "Uzbekistan"],
    ["tanzania",         "Tanzania"],
    ["kazakhstan",       "Kazakhstan"],
    ["azerbaijan",       "Azerbaijan"],
    ["ethiopia",         "Ethiopia"],
    ["rwanda",           "Rwanda"],
    ["vietnam",          "Vietnam"],
    ["libya",            "Libya"],
    ["sudan",            "Sudan"],
    ["india",            "India"],
    ["kenya",            "Kenya"],
    ["algeria",          "Algeria"],
    ["somalia",          "Somalia"],
    ["turkey",           "Turkey"],
    ["france",           "France"],
    ["germany",          "Germany"],
    ["bangladesh",       "Bangladesh"],
    ["tunisia",          "Tunisia"],
    ["indonesia",        "Indonesia"],
    ["ghana",            "Ghana"],
    ["south africa",     "South Africa"],
    ["syria",            "Syria"],
    ["lebanon",          "Lebanon"],
    ["palestine",        "Palestine"],
    ["united kingdom",   "United Kingdom"],
    ["iran",             "Iran"],
    ["germany",          "Germany"],
    ["kyrgyzstan",       "Kyrgyzstan"],
    ["ivory coast",      "Ivory Coast"],
    ["democratic republic of the congo", "Democratic Republic of the Congo"],
    ["united states",    "United States"],
    ["united states of america", "United States"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => assert.equal(mapCountry(input), expected));
  }
});

// ---------------------------------------------------------------------------
// mapCountry — ISO alpha-2 codes seen in prod
// ---------------------------------------------------------------------------

describe("mapCountry — ISO alpha-2 codes", () => {
  const cases: [string, string][] = [
    ["tr", "Turkey"],
    ["pk", "Pakistan"],
    ["af", "Afghanistan"],
    ["ng", "Nigeria"],
    ["gb", "United Kingdom"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => assert.equal(mapCountry(input), expected));
  }
});

// ---------------------------------------------------------------------------
// mapCountry — unknown value → title-cased raw (NOT null, NOT "Turkey")
// ---------------------------------------------------------------------------

describe("mapCountry — unknown nationality → title-cased raw, not Turkey", () => {
  it("unknown nationality returns title-cased raw, not null", () => {
    const result = mapCountry("freedonia");
    assert.ok(result !== null, "should not return null for a non-empty unknown value");
    assert.ok(result !== "Turkey", "should NOT fall back to Turkey for unknown nationality");
    assert.equal(result, "Freedonia", "should title-case the raw value");
  });

  it("already title-cased unknown still works", () => {
    const result = mapCountry("Ruritania");
    assert.equal(result, "Ruritania");
  });
});

// ---------------------------------------------------------------------------
// buildPersonalFields — throws when nationality is missing
// ---------------------------------------------------------------------------

describe("buildPersonalFields — throws MISSING_NATIONALITY when nationality absent", () => {
  const base = {
    firstName: "Ali",
    lastName: "Hassan",
    dateOfBirth: "1995-03-15",
    passportNumber: "AB1234567",
    passportIssueDate: "2020-01-01",
    passportExpiryDate: "2030-01-01",
    phone: "5321234567",
    gender: "male",
    address: "123 Main St, Istanbul",
    addressStreet: "123 Main St",
    addressCity: "Istanbul",
    addressZip: "34000",
  };

  it("throws when nationality is undefined", () => {
    assert.throws(
      () => buildPersonalFields({ ...base, nationality: undefined }),
      (err: Error) => {
        assert.ok(err.message.includes("MISSING_NATIONALITY"), `expected MISSING_NATIONALITY, got: ${err.message}`);
        return true;
      },
    );
  });

  it("throws when nationality is empty string", () => {
    assert.throws(
      () => buildPersonalFields({ ...base, nationality: "" }),
      (err: Error) => {
        assert.ok(err.message.includes("MISSING_NATIONALITY"), `expected MISSING_NATIONALITY, got: ${err.message}`);
        return true;
      },
    );
  });

  it("does NOT throw for 'pakistan' (country name form)", () => {
    assert.doesNotThrow(() => buildPersonalFields({ ...base, nationality: "pakistan" }));
  });

  it("does NOT throw for 'Pakistani' (adjective form)", () => {
    assert.doesNotThrow(() => buildPersonalFields({ ...base, nationality: "Pakistani" }));
  });

  it("does NOT throw for 'tr' (ISO code)", () => {
    assert.doesNotThrow(() => buildPersonalFields({ ...base, nationality: "tr" }));
  });

  it("country field in output matches canonical name for 'pakistan'", () => {
    const fields = buildPersonalFields({ ...base, nationality: "pakistan" });
    const birthCountryField = fields.find(
      (f) => typeof f.field === "string" && f.field.startsWith("Country_of_Birth.CountryList."),
    );
    assert.ok(birthCountryField, "Country_of_Birth picklist field should be present");
    assert.ok(
      String(birthCountryField.field).includes(".Pakistan."),
      `expected Pakistan in field name, got: ${birthCountryField.field}`,
    );
  });

  it("never fabricates city, street or postal code", () => {
    assert.throws(
      () => buildPersonalFields({
        ...base,
        nationality: "pakistan",
        addressCity: undefined,
        addressZip: undefined,
      }),
      /DATA_MISSING:.*addressCity.*postalCode/,
    );
  });

  it("uses only explicit structured address values", () => {
    const fields = buildPersonalFields({ ...base, nationality: "pakistan" });
    const values = Object.fromEntries(fields.map((field) => [field.field, field.value]));
    assert.equal(values.Address_Street, "123 Main St");
    assert.equal(values.Address_City, "Istanbul");
    assert.equal(values.Address_Zip_Code, "34000");
    assert.notEqual(values.Address_Zip_Code, "1000001");
  });
});

// ---------------------------------------------------------------------------
// classifyProfileLevel — degree tier classification
// ---------------------------------------------------------------------------

describe("classifyProfileLevel — master variants", () => {
  const cases: [string, "master"][] = [
    ["master",        "master"],
    ["Master",        "master"],
    ["MASTER",        "master"],
    ["yüksek lisans", "master"],
    ["yuksek lisans", "master"],
    ["Yüksek Lisans", "master"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () =>
      assert.equal(classifyProfileLevel(input), expected));
  }
});

describe("classifyProfileLevel — phd variants", () => {
  const cases: [string, "phd"][] = [
    ["phd",       "phd"],
    ["PhD",       "phd"],
    ["doctorate", "phd"],
    ["Doctorate", "phd"],
    ["doktora",   "phd"],
    ["Doktora",   "phd"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () =>
      assert.equal(classifyProfileLevel(input), expected));
  }
});

describe("classifyProfileLevel — bachelor variants", () => {
  const cases: [string, "bachelor"][] = [
    ["bachelor",  "bachelor"],
    ["Bachelor",  "bachelor"],
    ["BACHELOR",  "bachelor"],
    ["lisans",    "bachelor"],
    ["Lisans",    "bachelor"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () =>
      assert.equal(classifyProfileLevel(input), expected));
  }

  it('"lisans" must NOT classify as "master" (yüksek lisans vs lisans ambiguity)', () => {
    assert.equal(classifyProfileLevel("lisans"), "bachelor");
    assert.notEqual(classifyProfileLevel("lisans"), "master");
  });
});

describe("classifyProfileLevel — associate variants", () => {
  const cases: [string, "associate"][] = [
    ["associate",  "associate"],
    ["Associate",  "associate"],
    ["önlisans",   "associate"],
    ["Önlisans",   "associate"],
    ["onlisans",   "associate"],
    ["ön lisans",  "associate"],
  ];
  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () =>
      assert.equal(classifyProfileLevel(input), expected));
  }
});

describe("classifyProfileLevel — bachelor/associate must never be master", () => {
  const notMaster = ["bachelor", "lisans", "Bachelor", "associate", "önlisans", "onlisans", "ön lisans"];
  for (const level of notMaster) {
    it(`"${level}" classifies as bachelor or associate, NOT master`, () => {
      const cls = classifyProfileLevel(level);
      assert.notEqual(cls, "master", `"${level}" must not map to "master" (would silently submit wrong degree)`);
    });
  }
});

// ---------------------------------------------------------------------------
// checkMissingEduRecord — prior-education gate per degree tier
// ---------------------------------------------------------------------------

describe("checkMissingEduRecord — Master requires bachelor; PhD requires bachelor + master", () => {
  const bachelorRec = { level: "bachelor" };
  const masterRec = { level: "master" };
  const highSchoolRec = { level: "high_school" };

  it("master + no records → missing bachelor", () =>
    assert.equal(checkMissingEduRecord([], "master"), "bachelor_education_record"));
  it("master + only high_school → missing bachelor", () =>
    assert.equal(checkMissingEduRecord([highSchoolRec], "master"), "bachelor_education_record"));
  it("master + bachelor record → ok", () =>
    assert.equal(checkMissingEduRecord([bachelorRec], "master"), null));
  it("master + bachelor + high_school → ok", () =>
    assert.equal(checkMissingEduRecord([bachelorRec, highSchoolRec], "master"), null));

  it("phd + no records → missing bachelor", () =>
    assert.equal(checkMissingEduRecord([], "phd"), "bachelor_education_record"));
  it("phd + bachelor record → missing master", () =>
    assert.equal(checkMissingEduRecord([bachelorRec], "phd"), "master_education_record"));
  it("phd + master record → still missing bachelor first", () =>
    assert.equal(checkMissingEduRecord([masterRec], "phd"), "bachelor_education_record"));
  it("phd + bachelor + master records → ok", () =>
    assert.equal(checkMissingEduRecord([bachelorRec, masterRec], "phd"), null));

  it("yüksek lisans + no records → missing bachelor (Turkish master alias)", () =>
    assert.equal(checkMissingEduRecord([], "yüksek lisans"), "bachelor_education_record"));
  it("doktora + no records → missing bachelor (Turkish phd alias)", () =>
    assert.equal(checkMissingEduRecord([], "doktora"), "bachelor_education_record"));
});

describe("checkMissingEduRecord — Bachelor/Associate require high_school record (NOT bachelor)", () => {
  const bachelorRec = { level: "bachelor" };
  const highSchoolRec = { level: "high_school" };

  it("bachelor + no records → missing high_school", () =>
    assert.equal(checkMissingEduRecord([], "bachelor"), "high_school_education_record"));
  it("bachelor + only bachelor record → still missing high_school", () =>
    assert.equal(checkMissingEduRecord([bachelorRec], "bachelor"), "high_school_education_record"));
  it("bachelor + high_school record → ok", () =>
    assert.equal(checkMissingEduRecord([highSchoolRec], "bachelor"), null));

  it("associate + no records → missing high_school", () =>
    assert.equal(checkMissingEduRecord([], "associate"), "high_school_education_record"));
  it("associate + high_school record → ok", () =>
    assert.equal(checkMissingEduRecord([highSchoolRec], "associate"), null));

  it("lisans + no records → missing high_school (Turkish bachelor alias)", () =>
    assert.equal(checkMissingEduRecord([], "lisans"), "high_school_education_record"));
  it("önlisans + no records → missing high_school (Turkish associate alias)", () =>
    assert.equal(checkMissingEduRecord([], "önlisans"), "high_school_education_record"));

  it("bachelor MUST NOT require a bachelor record (would be a circular self-requirement)", () => {
    assert.notEqual(
      checkMissingEduRecord([], "bachelor"),
      "bachelor_education_record",
      "bachelor applicants should NOT need a bachelor record (that's for master/phd)",
    );
  });
  it("associate MUST NOT require a bachelor record", () => {
    assert.notEqual(
      checkMissingEduRecord([], "associate"),
      "bachelor_education_record",
      "associate applicants should NOT need a bachelor record",
    );
  });
});

describe("checkMissingEduRecord — undefined records treated as empty", () => {
  it("master + undefined → missing bachelor", () =>
    assert.equal(checkMissingEduRecord(undefined, "master"), "bachelor_education_record"));
  it("bachelor + undefined → missing high_school", () =>
    assert.equal(checkMissingEduRecord(undefined, "bachelor"), "high_school_education_record"));
});

// ---------------------------------------------------------------------------
// browser.ts MEM_ARGS — --no-zygote and --disable-setuid-sandbox present
// ---------------------------------------------------------------------------

describe("browser.ts MEM_ARGS — SIGBUS mitigation flags present", () => {
  it("--no-zygote is in MEM_ARGS (prevents zygote shm IPC SIGBUS)", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../../../lib/portal-adapters/src/browser.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(src.includes('"--no-zygote"'), "browser.ts MEM_ARGS must contain --no-zygote");
  });

  it("--disable-setuid-sandbox is in MEM_ARGS (belt-and-suspenders for containers)", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../../../lib/portal-adapters/src/browser.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(
      src.includes('"--disable-setuid-sandbox"'),
      "browser.ts MEM_ARGS must contain --disable-setuid-sandbox",
    );
  });

  it("--disable-dev-shm-usage is still present (not accidentally removed)", async () => {
    const src = await import("node:fs/promises").then((fs) =>
      fs.readFile(
        new URL("../../../lib/portal-adapters/src/browser.ts", import.meta.url),
        "utf8",
      ),
    );
    assert.ok(
      src.includes('"--disable-dev-shm-usage"'),
      "browser.ts MEM_ARGS must still contain --disable-dev-shm-usage",
    );
  });
});
