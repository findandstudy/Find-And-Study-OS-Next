import test from "node:test";
import assert from "node:assert/strict";
import { courseFinderFilterCacheKey } from "../src/lib/courseFinderFilterCache";

test("filter cache key is stable and follows the server filter order", () => {
  assert.equal(
    courseFinderFilterCacheKey({
      language: "English",
      country: "Turkey",
      level: "Bachelor",
    }),
    "country=Turkey&level=Bachelor&language=English",
  );
});

test("filter cache key ignores unknown query parameters", () => {
  assert.equal(
    courseFinderFilterCacheKey({
      country: "Turkey",
      ignored: "must-not-fragment-cache",
    }),
    "country=Turkey",
  );
});

test("filter cache key trims values and escapes separators", () => {
  assert.equal(
    courseFinderFilterCacheKey({
      search: "  Law & Business  ",
      city: "",
    }),
    "search=Law%20%26%20Business",
  );
});

test("filter cache key caps individual values to prevent cache abuse", () => {
  const value = "x".repeat(400);
  assert.equal(
    courseFinderFilterCacheKey({ search: value }),
    `search=${"x".repeat(300)}`,
  );
});
