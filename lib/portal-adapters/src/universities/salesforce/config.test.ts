import assert from "node:assert/strict";
import test from "node:test";
import { SALESFORCE_SCHOOLS } from "./config.js";

test("requested Salesforce schools use the strict verification contract", () => {
  const requested = new Set([
    "halic",
    "uskudar",
    "bau",
    "ozyegin",
    "sabanci",
    "yeditepe",
    "beykent",
    "isik",
  ]);
  const configured = SALESFORCE_SCHOOLS.filter((school) =>
    requested.has(school.key),
  );

  assert.equal(configured.length, requested.size);
  for (const school of configured) {
    assert.equal(
      school.strictContract,
      true,
      `${school.key} must fail closed`,
    );
  }
});

test("Haliç has a dedicated fail-closed Salesforce configuration", () => {
  const halic = SALESFORCE_SCHOOLS.find((school) => school.key === "halic");

  assert.ok(halic, "Haliç Salesforce configuration must exist");
  assert.equal(halic.label, "Haliç Üniversitesi");
  assert.equal(halic.portalUrl, "https://applyonline.halic.edu.tr/agency/s");
  assert.deepEqual(halic.namePatterns, ["halic"]);
  assert.equal(
    halic.strictContract,
    true,
    "Haliç must require strict readback and completion proof",
  );
});
