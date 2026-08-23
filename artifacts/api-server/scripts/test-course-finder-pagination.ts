import test from "node:test";
import assert from "node:assert/strict";
import { parseCourseFinderPagination } from "../src/lib/courseFinderPagination";

test("uses the public defaults when pagination values are missing or invalid", () => {
  assert.deepEqual(parseCourseFinderPagination(undefined, undefined), {
    page: 1,
    limit: 24,
    offset: 0,
  });
  assert.deepEqual(parseCourseFinderPagination("abc", "abc"), {
    page: 1,
    limit: 24,
    offset: 0,
  });
  assert.deepEqual(parseCourseFinderPagination("-1", "0"), {
    page: 1,
    limit: 24,
    offset: 0,
  });
});

test("calculates a stable offset for valid values", () => {
  assert.deepEqual(parseCourseFinderPagination("3", "50"), {
    page: 3,
    limit: 50,
    offset: 100,
  });
});

test("caps excessive values and rejects partial or unsafe integers", () => {
  assert.deepEqual(parseCourseFinderPagination("999999999", "999999999"), {
    page: 1_000_000,
    limit: 500,
    offset: 499_999_500,
  });
  assert.deepEqual(parseCourseFinderPagination("2abc", "24.5"), {
    page: 1,
    limit: 24,
    offset: 0,
  });
});
