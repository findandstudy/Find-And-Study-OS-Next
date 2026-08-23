import test from "node:test";
import assert from "node:assert/strict";
import {
  courseFinderUniversityLogoUrl,
  sanitizeCourseFinderProgram,
} from "../src/lib/courseFinderVisibility";

const program = {
  id: 42,
  name: "Visible Program",
  universityContactName: "Private Contact",
  universityContactPhone: "+000000000",
  universityContactEmail: "private@example.test",
  commissionRate: 15,
  applicationFee: 100,
  serviceFeeAmount: 250,
};

test("student/anonymous response excludes all internal fee fields", () => {
  const result = sanitizeCourseFinderProgram(program, {
    contacts: false,
    internalFees: false,
    serviceFee: false,
  });

  assert.equal(result.id, 42);
  assert.equal(result.name, "Visible Program");
  assert.equal("commissionRate" in result, false);
  assert.equal("applicationFee" in result, false);
  assert.equal("serviceFeeAmount" in result, false);
  assert.equal("universityContactEmail" in result, false);
});

test("authorised response keeps internal fee fields", () => {
  const result = sanitizeCourseFinderProgram(program, {
    contacts: true,
    internalFees: true,
    serviceFee: true,
  });

  assert.equal(result.commissionRate, 15);
  assert.equal(result.applicationFee, 100);
  assert.equal(result.serviceFeeAmount, 250);
  assert.equal(result.universityContactEmail, "private@example.test");
});

test("service-fee permission is independent of commission permission", () => {
  const result = sanitizeCourseFinderProgram(program, {
    contacts: true,
    internalFees: true,
    serviceFee: false,
  });

  assert.equal(result.commissionRate, 15);
  assert.equal(result.applicationFee, 100);
  assert.equal("serviceFeeAmount" in result, false);
});

test("course finder rows reference the cached logo endpoint instead of inline data", () => {
  assert.equal(
    courseFinderUniversityLogoUrl(2218, true),
    "/api/universities/2218/logo",
  );
  assert.equal(courseFinderUniversityLogoUrl(2218, false), null);
});
