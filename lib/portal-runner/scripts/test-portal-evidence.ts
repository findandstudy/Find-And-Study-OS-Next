import assert from "node:assert/strict";
import test from "node:test";
import {
  redactPortalEvidenceText,
  sanitizePortalRunEvidence,
  type PortalRunEvidence,
} from "../src/portalEvidence.js";

test("portal evidence redactor removes student values and URL queries", () => {
  const raw =
    'Validation email=student@example.com phone=+90 555 123 4567 readback="Secret Street 12" https://portal.example/form?token=abc';
  const safe = redactPortalEvidenceText(raw);
  assert.doesNotMatch(safe, /student@example\.com/);
  assert.doesNotMatch(safe, /555 123 4567/);
  assert.doesNotMatch(safe, /Secret Street/);
  assert.doesNotMatch(safe, /token=abc/);
});

test("portal evidence preserves selector structure but never control values", () => {
  const evidence: PortalRunEvidence = {
    schemaVersion: 1,
    capturedAt: "2026-07-26T00:00:00.000Z",
    adapterKey: "beykent",
    url: {
      origin: "https://beykent.my.site.com",
      pathname: "/agency/s/application-form",
    },
    title: "Application Form",
    headings: ["Please Select the Term"],
    buttons: ["Next"],
    fields: [
      {
        tag: "input",
        type: "text",
        id: "Student_Email",
        name: "Student_Email",
        label: "Applicant Email",
        placeholder: "student@example.com",
        required: true,
        invalid: false,
        visible: true,
      },
    ],
    validation: ['readback="Secret Street 12"'],
    progress: [
      {
        tag: "span",
        text: "Stage: Personal Information",
        className: "slds-path__stage-name",
      },
    ],
    shadowHosts: ["lightning-input"],
    counts: {
      shadowRoots: 4,
      visibleFields: 1,
      invalidFields: 0,
      fileInputs: 0,
    },
  };
  const safe = sanitizePortalRunEvidence(evidence);
  assert.equal(safe.fields[0]?.id, "Student_Email");
  assert.equal(safe.fields[0]?.required, true);
  assert.doesNotMatch(safe.fields[0]?.placeholder ?? "", /student@/);
  assert.doesNotMatch(safe.validation[0] ?? "", /Secret Street/);
  assert.equal(safe.progress[0]?.text, "Stage: Personal Information");
});
