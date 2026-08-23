import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePortalPreflight,
} from "../src/preflight.js";
import type { SubmitFiles, SubmitProfile } from "../src/types.js";

const complete: SubmitProfile = {
  firstName: "Ada",
  lastName: "Lovelace",
  passportNumber: "P1234567",
  email: "ada@example.com",
  dateOfBirth: "2000-01-01",
  gender: "female",
  fatherName: "Byron",
  motherName: "Anne",
  nationality: "United Kingdom",
  phone: "+441234567890",
  level: "Bachelor",
  programName: "Software Engineering",
  programId: "123",
  universityName: "Nisantasi University",
  schoolName: "London High School",
  address: "1 Example Street",
  addressCity: "London",
  addressZip: "10000",
  cityOfBirth: "London",
  gpa: 90,
  graduationYear: 2024,
  passportIssueDate: "2024-01-01",
  passportExpiryDate: "2034-01-01",
};

const threeDocs: SubmitFiles = {
  passport: "/tmp/passport.pdf",
  diploma: "/tmp/diploma.pdf",
  transcript: "/tmp/transcript.pdf",
};

test("United blocks the schoolName failure before browser login", () => {
  const result = evaluatePortalPreflight({
    adapterKey: "united",
    profile: { ...complete, schoolName: undefined },
    files: threeDocs,
  });
  assert.equal(result.ready, false);
  assert.deepEqual(result.missingFields, ["schoolName"]);
});

test("placeholder values are treated as missing", () => {
  const result = evaluatePortalPreflight({
    adapterKey: "united",
    profile: { ...complete, fatherName: "-" },
    files: threeDocs,
  });
  assert.equal(result.ready, false);
  assert.ok(result.missingFields.includes("fatherName"));
});

test("document labels can satisfy document slots without downloaded paths", () => {
  const result = evaluatePortalPreflight({
    adapterKey: "united",
    profile: complete,
    documentTypes: ["Passport", "Diploma Certificate", "Diploma Transcript"],
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.missingDocuments, []);
});

test("SIT requires its photo and structured address contract", () => {
  const result = evaluatePortalPreflight({
    adapterKey: "sit",
    profile: { ...complete, addressCity: undefined },
    files: threeDocs,
  });
  assert.equal(result.ready, false);
  assert.ok(result.missingFields.includes("addressCity"));
  assert.ok(result.missingDocuments.includes("photo"));
});

test("Medipol preflight mirrors its profile and four-document contract", () => {
  const result = evaluatePortalPreflight({
    adapterKey: "medipol",
    profile: {
      ...complete,
      passportIssueDate: undefined,
      passportExpiryDate: undefined,
    },
    files: threeDocs,
  });
  assert.equal(result.supported, true);
  assert.equal(result.ready, false);
  assert.ok(result.missingFields.includes("passportIssueDate"));
  assert.ok(result.missingFields.includes("passportExpiryDate"));
  assert.ok(result.missingDocuments.includes("photo"));
});

test("unknown declarative adapters defer to their profilePolicy", () => {
  const result = evaluatePortalPreflight({
    adapterKey: "future-spec-adapter",
    profile: complete,
    files: {},
  });
  assert.equal(result.supported, false);
  assert.equal(result.ready, true);
});

test("invalid identity data is incompatible instead of merely present", () => {
  const result = evaluatePortalPreflight({
    adapterKey: "united",
    profile: {
      ...complete,
      passportNumber: "1111111",
      dateOfBirth: "2030-01-01",
    },
    files: threeDocs,
  });
  assert.equal(result.ready, false);
  assert.ok(result.incompatibleFields.some((issue) => issue.field === "passportNumber"));
  assert.ok(result.incompatibleFields.some((issue) => issue.field === "dateOfBirth"));
});
