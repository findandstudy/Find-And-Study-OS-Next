import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseMedipolAcademicIntake,
  chooseMedipolProgramIndex,
  missingMedipolProfileDocuments,
  resolveMedipolProxy,
  resolveMedipolLevel,
  verifyMedipolApplicationEvidence,
} from "./adapter.js";

test("Medipol degree mapping fails closed", () => {
  assert.equal(resolveMedipolLevel("Associate"), "Associate");
  assert.equal(resolveMedipolLevel("Bachelor"), "Bachelor");
  assert.equal(resolveMedipolLevel("Master"), "Master");
  assert.equal(resolveMedipolLevel("PhD"), "Doctorate");
  assert.equal(resolveMedipolLevel("Unknown"), null);
});

test("Medipol intake uses a unique option and refuses ambiguous years", () => {
  assert.equal(
    chooseMedipolAcademicIntake(["2026-2027 Academic Year"], "Sep"),
    "2026-2027 Academic Year",
  );
  assert.equal(
    chooseMedipolAcademicIntake(
      ["2025-2026 Academic Year", "2026-2027 Academic Year"],
      "2026-2027",
    ),
    "2026-2027 Academic Year",
  );
  assert.equal(
    chooseMedipolAcademicIntake(
      ["2025-2026 Academic Year", "2026-2027 Academic Year"],
      "Sep",
    ),
    null,
  );
});

test("Medipol program matching rejects disabled and ambiguous choices", () => {
  assert.equal(
    chooseMedipolProgramIndex(
      [
        { value: "1", name: "Bachelor of Psychology (English)", enabled: true },
        { value: "2", name: "Bachelor of Psychology (Turkish)", enabled: true },
      ],
      "Bachelor of Psychology (English)",
    ),
    0,
  );
  assert.equal(
    chooseMedipolProgramIndex(
      [
        { value: "1", name: "Bachelor of Medicine (English)", enabled: false },
      ],
      "Bachelor of Medicine (English)",
    ),
    null,
  );
});

test("Medipol success requires durable exact application evidence", () => {
  const profile = {
    firstName: "Ada",
    lastName: "Lovelace",
    programName: "Bachelor of Computer Engineering (English)",
  };
  assert.equal(
    verifyMedipolApplicationEvidence(profile, {
      externalRef: "121766",
      applicantName: "Ada Lovelace",
      programName: "Bachelor of Computer Engineering (English)",
      academicIntake: "2026-2027 Academic Year",
      status: "Pending Review",
    }),
    true,
  );
  assert.equal(
    verifyMedipolApplicationEvidence(profile, {
      externalRef: "121766",
      applicantName: "Ada Lovelace",
      programName: "Bachelor of Computer Engineering (English)",
      academicIntake: "2026-2027 Academic Year",
      status: "Draft",
    }),
    false,
  );
  assert.equal(
    verifyMedipolApplicationEvidence(profile, {
      externalRef: "",
      applicantName: "Ada Lovelace",
      programName: "Bachelor of Computer Engineering (English)",
      academicIntake: "2026-2027 Academic Year",
      status: "Pending Review",
    }),
    false,
  );
});

test("Medipol existing profile documents are proven from portal file labels", () => {
  assert.deepEqual(
    missingMedipolProfileDocuments(
      "APPLICANT DOCUMENTS Passport Files passport.pdf Diploma diploma.pdf Transcript transcript.pdf",
    ),
    [],
  );
  assert.deepEqual(
    missingMedipolProfileDocuments(
      "APPLICANT DOCUMENTS Passport Files passport.pdf Diploma diploma.pdf",
    ),
    ["transcript"],
  );
});

test("Medipol proxy config is explicit and validates the server URL", () => {
  assert.equal(resolveMedipolProxy(), undefined);
  assert.deepEqual(
    resolveMedipolProxy({
      proxyServer: "https://proxy.example.test:8443",
      proxyUsername: "worker",
      proxyPassword: "secret",
    }),
    {
      server: "https://proxy.example.test:8443",
      username: "worker",
      password: "secret",
      bypass: undefined,
    },
  );
  assert.throws(
    () => resolveMedipolProxy({ proxyServer: "not-a-proxy" }),
    /proxyServer/,
  );
});
