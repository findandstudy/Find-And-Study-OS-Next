import assert from "node:assert/strict";
import test from "node:test";

import { resolveInboxStudentContactPrefill } from "../src/components/inbox/studentDraftContact";

test("linked student contact wins over every other source", () => {
  assert.deepEqual(
    resolveInboxStudentContactPrefill(
      {
        student: { email: " student@example.com ", phone: " +90001 " },
        lead: { email: "lead@example.com", phone: "+90002" },
        externalContact: { email: "external@example.com", phone: "+90003" },
      },
      { email: "ai@example.com", phone: "+90004" },
    ),
    { email: "student@example.com", phone: "+90001" },
  );
});

test("blank student fields fall back independently to the linked lead", () => {
  assert.deepEqual(
    resolveInboxStudentContactPrefill({
      student: { email: "", phone: "+90001" },
      lead: { email: "lead@example.com", phone: "+90002" },
    }),
    { email: "lead@example.com", phone: "+90001" },
  );
});

test("external contact is used before AI extraction", () => {
  assert.deepEqual(
    resolveInboxStudentContactPrefill(
      { externalContact: { email: "external@example.com", phone: "+90003" } },
      { email: "ai@example.com", phone: "+90004" },
    ),
    { email: "external@example.com", phone: "+90003" },
  );
});

test("AI extraction remains the final fallback", () => {
  assert.deepEqual(
    resolveInboxStudentContactPrefill({}, { email: "ai@example.com", phone: "+90004" }),
    { email: "ai@example.com", phone: "+90004" },
  );
});

test("non-string and whitespace-only values are ignored", () => {
  assert.deepEqual(
    resolveInboxStudentContactPrefill(
      {
        student: { email: 42, phone: "   " },
        lead: { email: " lead@example.com ", phone: null },
      },
      { phone: " +90004 " },
    ),
    { email: "lead@example.com", phone: "+90004" },
  );
});
