/**
 * Portal Uyumluluk Katmanı — Faz 2 testleri (AC1-AC6).
 * ai-extract hizalamasının saf yardımcılarını doğrular:
 *  - mapExtractionToEducation GPA'yı TAM SAYI yüzdeye çevirir
 *  - canonicalCountry / cleanCity soft-normalizasyon davranışı
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalCountry, cleanCity } from "@workspace/db";
import { mapExtractionToEducation } from "../src/lib/educationExtraction";

test("AC1: education gpa 3.42/4 → integer percent (no decimals)", () => {
  const out = mapExtractionToEducation(
    [{ level: "high_school", institution: "X HS", gpa: "3.42/4", graduationYear: 2020 }],
    "bachelor",
  );
  assert.equal(out.length, 1);
  assert.ok(out[0].gpa != null);
  assert.ok(!String(out[0].gpa).includes("."), `gpa should be integer, got ${out[0].gpa}`);
  assert.equal(out[0].gpaRaw, "3.42/4");
  assert.equal(out[0].gpaScale, 100);
});

test("AC2: education gpa 87.5 → rounded integer 88", () => {
  const out = mapExtractionToEducation(
    [{ level: "high_school", gpa: "87.5" }],
    "bachelor",
  );
  assert.equal(out[0].gpa, "88");
});

test("AC3: unnormalizable gpa kept raw with null scale", () => {
  const out = mapExtractionToEducation(
    [{ level: "high_school", gpa: "Pekiyi" }],
    "bachelor",
  );
  assert.equal(out[0].gpa, "Pekiyi");
  assert.equal(out[0].gpaScale, null);
});

test("AC4: canonicalCountry matches variants, rejects garbage", () => {
  assert.equal(canonicalCountry("turkey"), "Turkey");
  assert.equal(canonicalCountry("Türkiye"), "Turkey");
  assert.equal(canonicalCountry("NotACountryXYZ"), null);
});

test("AC5: cleanCity accepts bare city, rejects address fragments", () => {
  assert.equal(cleanCity("Istanbul"), "Istanbul");
  assert.equal(cleanCity("Mahalle 5, Sokak 12 No: 3"), null);
  assert.equal(cleanCity("Blok C Apt 4"), null);
});

test("AC6: empty/null inputs are null (never 0 / never throw)", () => {
  assert.equal(cleanCity(""), null);
  assert.equal(cleanCity(null), null);
  assert.equal(canonicalCountry(""), null);
  assert.equal(canonicalCountry(null), null);
});
