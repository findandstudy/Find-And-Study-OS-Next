import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_LEAD_SOURCE_OPTIONS,
  buildLeadSourceFilterOptions,
} from "../src/lib/leadSourceOptions";

test("uses source values returned from the complete lead-source endpoint", () => {
  const options = buildLeadSourceFilterOptions([
    { value: "embed:isik-iabot", label: "Embed: Isik AI Bot", kind: "embed" },
    { value: "Whatsapp", label: "Whatsapp", kind: "other" },
  ]);

  assert.deepEqual(options.map((option) => option.value), ["embed:isik-iabot", "Whatsapp"]);
  assert.equal(options.some((option) => option.value === "website"), false);
});

test("deduplicates sources, ignores blanks and preserves a previously selected source", () => {
  const options = buildLeadSourceFilterOptions([
    { value: "Whatsapp", label: "Whatsapp", kind: "other" },
    { value: "Whatsapp", label: "Duplicate", kind: "other" },
    { value: " ", label: "Blank", kind: "other" },
  ], "legacy_source");

  assert.deepEqual(options.map((option) => option.value), ["Whatsapp", "legacy_source"]);
  assert.equal(options[1]?.label, "legacy source");
});

test("keeps standard source choices as a safe fallback while the endpoint is unavailable", () => {
  assert.deepEqual(
    buildLeadSourceFilterOptions(undefined).map((option) => option.value),
    DEFAULT_LEAD_SOURCE_OPTIONS.map((option) => option.value),
  );
});
