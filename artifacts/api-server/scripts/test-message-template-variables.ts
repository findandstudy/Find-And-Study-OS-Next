import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMessageTemplateVariableContext,
  extractNamedMessageTemplateVariables,
  resolveNamedMessageTemplateVariables,
} from "../src/lib/inbox/templateVariables";

test("resolves supported aliases without touching numeric Meta placeholders", () => {
  const result = resolveNamedMessageTemplateVariables(
    "Hi {{ student_name }}, {{program}} at {{UniversityName}} / {{1}}",
    {
      studentName: "Ada Lovelace",
      programName: "Computer Engineering",
      universityName: "Example University",
    },
  );

  assert.equal(
    result.content,
    "Hi Ada Lovelace, Computer Engineering at Example University / {{1}}",
  );
  assert.deepEqual(result.missingVariables, []);
});

test("fails closed when a required value or unknown variable is missing", () => {
  const result = resolveNamedMessageTemplateVariables(
    "{{studentName}} — {{programName}} — {{unsupportedThing}}",
    { studentName: "Ada Lovelace" },
  );

  assert.equal(result.content, "Ada Lovelace — {{programName}} — {{unsupportedThing}}");
  assert.deepEqual(result.missingVariables, ["programName", "unsupportedThing"]);
});

test("extracts canonical variable names once and in display order", () => {
  assert.deepEqual(
    extractNamedMessageTemplateVariables(
      "{{student_name}} {{studentName}} {{program}} {{university_name}}",
    ),
    ["studentName", "programName", "universityName"],
  );
});

test("student and latest application values take priority over lead fallbacks", () => {
  assert.deepEqual(
    buildMessageTemplateVariableContext({
      displayName: "Contact Name",
      lead: {
        firstName: "Lead",
        lastName: "Person",
        interestedProgram: "Lead Program",
        interestedUniversity: "Lead University",
        interestedLevel: "Lead Level",
      },
      student: {
        firstName: "Student",
        lastName: "Person",
        interestedLevel: "Student Level",
      },
      application: {
        programName: "Application Program",
        universityName: "Application University",
        level: "Application Level",
        intake: "Sep 2026",
      },
    }),
    {
      studentName: "Student Person",
      firstName: "Student",
      lastName: "Person",
      programName: "Application Program",
      universityName: "Application University",
      level: "Application Level",
      intake: "Sep 2026",
    },
  );
});

test("unlinked student context falls back to lead and external display name", () => {
  assert.deepEqual(
    buildMessageTemplateVariableContext({
      displayName: "External Contact",
      lead: {
        interestedProgram: "Business",
        interestedUniversity: "Example University",
      },
    }),
    {
      studentName: "External Contact",
      firstName: undefined,
      lastName: undefined,
      programName: "Business",
      universityName: "Example University",
      level: undefined,
      intake: undefined,
    },
  );
});
