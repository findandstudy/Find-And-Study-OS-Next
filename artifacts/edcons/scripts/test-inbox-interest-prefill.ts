import assert from "node:assert/strict";
import test from "node:test";

import {
  readLeadInterest,
  uniqueExactInterestMatch,
} from "../src/components/inbox/studentDraftInterest";

test("reads and trims the original lead interest", () => {
  assert.deepEqual(
    readLeadInterest({
      lead: {
        interestedCountry: " Turkey ",
        interestedUniversity: " Uskudar University ",
        interestedProgram: " Bachelor of Psychology (English) ",
      },
    }),
    {
      country: "Turkey",
      university: "Uskudar University",
      program: "Bachelor of Psychology (English)",
    },
  );
});

test("matches a single canonical name exactly", () => {
  const rows = [
    { id: 1, name: "Uskudar University" },
    { id: 2, name: "Istanbul Kent University" },
  ];

  assert.deepEqual(
    uniqueExactInterestMatch(rows, "ÜSKÜDAR UNIVERSITY", (row) => row.name),
    rows[0],
  );
});

test("does not use substring or fuzzy matching", () => {
  const rows = [{ id: 1, name: "Istanbul Kent University" }];

  assert.equal(
    uniqueExactInterestMatch(rows, "Kent", (row) => row.name),
    null,
  );
});

test("fails closed when canonical names are duplicated", () => {
  const rows = [
    { id: 1, name: "Uskudar University" },
    { id: 2, name: "Üsküdar University" },
  ];

  assert.equal(
    uniqueExactInterestMatch(rows, "Uskudar University", (row) => row.name),
    null,
  );
});

test("does not select anything for an empty lead value", () => {
  assert.equal(
    uniqueExactInterestMatch(
      [{ id: 1, name: "Turkey" }],
      "",
      (row) => row.name,
    ),
    null,
  );
});
