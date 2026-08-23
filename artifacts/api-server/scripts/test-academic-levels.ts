import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  academicGroupForLevel,
  requiredEducationLevels,
  academicFieldsForLevel,
} from "@workspace/db";

describe("academicGroupForLevel", () => {
  it("maps Group A levels (high-school based)", () => {
    for (const key of [
      "foundation",
      "Foundation",
      "language course",
      "Language",
      "pathway",
      "associate",
      "Önlisans",
      "onlisans",
      "bachelor",
      "Bachelor's",
      "lisans",
      "Lisans",
      "undergraduate",
    ]) {
      assert.equal(academicGroupForLevel(key), "A", `expected A for "${key}"`);
    }
  });

  it("maps Group B levels (bachelor based)", () => {
    for (const key of [
      "master",
      "Master",
      "Master's",
      "yüksek lisans",
      "Yüksek Lisans",
      "graduate",
      "MSc",
      "MA",
    ]) {
      assert.equal(academicGroupForLevel(key), "B", `expected B for "${key}"`);
    }
  });

  it("maps Group C levels (bachelor+master based)", () => {
    for (const key of ["phd", "PhD", "Ph.D.", "doctorate", "doctoral", "doktora", "Doktora"]) {
      assert.equal(academicGroupForLevel(key), "C", `expected C for "${key}"`);
    }
  });

  it("fail-safes unknown/empty levels to A", () => {
    assert.equal(academicGroupForLevel("unknown-level"), "A");
    assert.equal(academicGroupForLevel(""), "A");
    assert.equal(academicGroupForLevel("   "), "A");
  });

  it('does not misclassify "yüksek lisans" as A despite containing "lisans"', () => {
    assert.equal(academicGroupForLevel("yüksek lisans"), "B");
    assert.equal(academicGroupForLevel("yükseklisans"), "B");
  });
});

describe("requiredEducationLevels", () => {
  it("Group A requires high_school only", () => {
    assert.deepEqual(requiredEducationLevels("bachelor"), ["high_school"]);
    assert.deepEqual(requiredEducationLevels("foundation"), ["high_school"]);
    assert.deepEqual(requiredEducationLevels("language course"), ["high_school"]);
  });

  it("Group B requires bachelor", () => {
    assert.deepEqual(requiredEducationLevels("master"), ["bachelor"]);
    assert.deepEqual(requiredEducationLevels("yüksek lisans"), ["bachelor"]);
  });

  it("Group C requires bachelor + master", () => {
    assert.deepEqual(requiredEducationLevels("phd"), ["bachelor", "master"]);
    assert.deepEqual(requiredEducationLevels("doktora"), ["bachelor", "master"]);
  });

  it("unknown falls back to high_school (Group A)", () => {
    assert.deepEqual(requiredEducationLevels("whatever"), ["high_school"]);
  });
});

describe("academicFieldsForLevel", () => {
  it("high_school has no program field", () => {
    const fields = academicFieldsForLevel("high_school");
    assert.ok(!fields.includes("program"));
    assert.deepEqual(fields, ["institution", "graduationYear", "gpa", "languageScore"]);
  });

  it("bachelor/master include program", () => {
    for (const lvl of ["bachelor", "master"] as const) {
      assert.deepEqual(academicFieldsForLevel(lvl), [
        "institution",
        "program",
        "graduationYear",
        "gpa",
        "languageScore",
      ]);
    }
  });
});
