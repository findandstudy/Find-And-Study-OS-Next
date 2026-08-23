import { test } from "node:test";
import assert from "node:assert/strict";
import { selectCanonicalPortalUniversity } from "../src/lib/portalUniversityIdentity.js";

type Row = {
  universityKey: string;
  isActive: boolean;
  adapterKey: string;
};

const active = (universityKey: string, adapterKey = "shared"): Row => ({
  universityKey,
  adapterKey,
  isActive: true,
});

test("exact active university key wins over adapter aliases", () => {
  const exact = active("topkapi_university", "topkapi");
  const result = selectCanonicalPortalUniversity(exact, [active("other")]);
  assert.deepEqual(result, {
    ok: true,
    portalUniversity: exact,
    matchedBy: "university_key",
  });
});

test("exact inactive university key fails closed", () => {
  const exact = { ...active("disabled_portal"), isActive: false };
  const result = selectCanonicalPortalUniversity(exact, []);
  assert.deepEqual(result, {
    ok: false,
    reason: "inactive",
    matches: ["disabled_portal"],
  });
});

test("one active adapter alias resolves to its canonical university key", () => {
  const canonical = active("altinbas_univeristy", "altinbas");
  const result = selectCanonicalPortalUniversity(undefined, [canonical]);
  assert.deepEqual(result, {
    ok: true,
    portalUniversity: canonical,
    matchedBy: "adapter_alias",
  });
});

test("shared adapter alias is ambiguous and never guessed", () => {
  const result = selectCanonicalPortalUniversity(undefined, [
    active("member_a", "salesforce"),
    active("member_b", "salesforce"),
  ]);
  assert.deepEqual(result, {
    ok: false,
    reason: "ambiguous",
    matches: ["member_a", "member_b"],
  });
});

test("unknown portal identity fails closed", () => {
  const result = selectCanonicalPortalUniversity<Row>(undefined, []);
  assert.deepEqual(result, {
    ok: false,
    reason: "unknown",
    matches: [],
  });
});
