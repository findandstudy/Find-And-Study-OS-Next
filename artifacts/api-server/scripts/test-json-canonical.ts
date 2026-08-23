import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../src/lib/jsonCanonical.js";

test("canonicalJson ignores nested object-key order", () => {
  const fromFile = {
    meta: { key: "okan", experimental: true },
    steps: [{ action: "navigate", options: { b: 2, a: 1 } }],
  };
  const fromJsonb = {
    steps: [{ options: { a: 1, b: 2 }, action: "navigate" }],
    meta: { experimental: true, key: "okan" },
  };
  assert.equal(canonicalJson(fromFile), canonicalJson(fromJsonb));
});

test("canonicalJson still detects a material spec change", () => {
  assert.notEqual(
    canonicalJson({ enabled: false, selector: "#old" }),
    canonicalJson({ enabled: false, selector: "#new" }),
  );
});
