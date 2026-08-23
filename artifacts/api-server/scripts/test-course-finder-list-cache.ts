import test from "node:test";
import assert from "node:assert/strict";
import {
  courseFinderListCacheKey,
  courseFinderVisibilityCacheKey,
} from "../src/lib/courseFinderListCache";
import {
  canonicalCourseFinderStudyLevel,
  canonicalCourseFinderStudyLevels,
  courseFinderStudyLevelSearchValues,
} from "../src/lib/courseFinderStudyLevels";

test("list cache key is stable and ignores unknown parameters", () => {
  const first = courseFinderListCacheKey({
    search: "Political",
    page: "2",
    limit: "24",
    unknown: "ignored",
  });
  const second = courseFinderListCacheKey({
    limit: "24",
    page: "2",
    search: "Political",
  });
  assert.equal(first, second);
  assert.doesNotMatch(first, /unknown/);
});

test("list cache key keeps pagination and sort isolated", () => {
  const base = courseFinderListCacheKey({ page: "1", limit: "24" });
  assert.notEqual(base, courseFinderListCacheKey({ page: "2", limit: "24" }));
  assert.notEqual(base, courseFinderListCacheKey({ page: "1", limit: "24", sort: "price_asc" }));
});

test("list cache keeps each private-field permission set isolated", () => {
  const publicShape = courseFinderVisibilityCacheKey({
    contacts: false,
    internalFees: false,
    serviceFee: false,
  });
  const staffShape = courseFinderVisibilityCacheKey({
    contacts: true,
    internalFees: false,
    serviceFee: false,
  });
  const financeShape = courseFinderVisibilityCacheKey({
    contacts: true,
    internalFees: true,
    serviceFee: true,
  });
  assert.notEqual(publicShape, staffShape);
  assert.notEqual(staffShape, financeShape);
});

test("PhD spelling variants are canonicalised and remain searchable", () => {
  assert.equal(canonicalCourseFinderStudyLevel("Ph.D."), "PhD");
  assert.deepEqual(
    canonicalCourseFinderStudyLevels(["Master", "Ph.D", "PhD", "Ph.D."]),
    ["Master", "PhD"],
  );
  assert.deepEqual(
    courseFinderStudyLevelSearchValues(["PhD"]),
    ["PhD", "Ph.D", "Ph.D."],
  );
});
