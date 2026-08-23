import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isDiagnosablePortalStatus,
  parsePortalDiagnosis,
  portalFailureFingerprint,
  sanitizePortalEvidence,
} from "../src/lib/portalAiGuardianContract";
import { applyGuardianSpecPatch } from "../src/lib/portalAiGuardianPatch";
import {
  stagingReportsMatch,
  validateGuardianStagingPatch,
} from "../src/lib/portalAiGuardianStaging";
import { buildPortalDeployProposalPayload } from "../src/lib/portalAiGuardianApproval";

const validDiagnosis = {
  classification: "selector_changed",
  confidence: 0.91,
  risk: "medium",
  retrySafe: false,
  requiresCodeChange: true,
  summary: "The stored selector no longer has a unique visible match.",
  evidence: ["exact readback failed on the Basic Information step"],
  recommendedAction:
    "Review the proposed selector and publish a disabled spec version.",
  missingDataFields: [],
  selectorCandidates: [
    {
      field: "cityOfBirth",
      current: "#old-city",
      proposed: "[data-field='cityOfBirth'] input",
      evidence: "The proposed locator is unique in the captured structure.",
    },
  ],
  proposedSpecPatch: [
    {
      op: "replace",
      path: "/steps/0/selector",
      value: "[data-field='cityOfBirth'] input",
      rationale: "Replace the stale selector.",
      evidence: "One visible match was observed.",
    },
  ],
};

test("structured diagnosis accepts fenced JSON", () => {
  const parsed = parsePortalDiagnosis(
    `\`\`\`json\n${JSON.stringify(validDiagnosis)}\n\`\`\``,
  );
  assert.equal(parsed.parseError, false);
  assert.equal(parsed.diagnosis.classification, "selector_changed");
  assert.equal(parsed.diagnosis.confidence, 0.91);
});

test("invalid AI output fails closed and never recommends retry", () => {
  const parsed = parsePortalDiagnosis("Retry it now; it should probably work.");
  assert.equal(parsed.parseError, true);
  assert.equal(parsed.diagnosis.classification, "unknown");
  assert.equal(parsed.diagnosis.risk, "high");
  assert.equal(parsed.diagnosis.retrySafe, false);
  assert.equal(parsed.diagnosis.confidence, 0);
});

test("out-of-contract confidence fails closed", () => {
  const parsed = parsePortalDiagnosis(
    JSON.stringify({ ...validDiagnosis, confidence: 1.5, retrySafe: true }),
  );
  assert.equal(parsed.parseError, true);
  assert.equal(parsed.diagnosis.retrySafe, false);
});

test("portal evidence masks credential and student-value keys recursively", () => {
  const safe = sanitizePortalEvidence({
    selector: "#email",
    email: "student@example.com",
    password: "secret",
    login: { value: "raw-password", token: "signed-token" },
    profile: { addressStreet: "Street 1", phone: "+905551234567" },
  }) as Record<string, unknown>;
  assert.equal(safe.selector, "#email");
  assert.equal(safe.email, "[REDACTED]");
  assert.equal(safe.password, "[REDACTED]");
  assert.deepEqual(safe.login, { value: "[REDACTED]", token: "[REDACTED]" });
  assert.deepEqual(safe.profile, {
    addressStreet: "[REDACTED]",
    phone: "[REDACTED]",
  });
});

test("portal evidence redacts PII embedded in otherwise safe text", () => {
  const safe = sanitizePortalEvidence({
    error:
      'Validation failed for student@example.com and +90 555 123 4567; readback="TAJIKISTAN KHUJAND STREET SADI 12" url=https://portal.example/form?token=secret',
  }) as { error: string };
  assert.doesNotMatch(safe.error, /student@example\.com/);
  assert.doesNotMatch(safe.error, /555 123 4567/);
  assert.doesNotMatch(safe.error, /KHUJAND/);
  assert.doesNotMatch(safe.error, /token=secret/);
});

test("failure fingerprint is deterministic and ignores Guardian annotations", () => {
  const base = {
    id: 42,
    adapterKey: "altinbas",
    status: "failed",
    error: "unique selector proof failed",
    attempts: 2,
    resultJson: { detail: "readback mismatch" },
  };
  const first = portalFailureFingerprint(base);
  const second = portalFailureFingerprint({
    ...base,
    resultJson: {
      detail: "readback mismatch",
      aiGuardian: { status: "proposed", runId: 7 },
    },
  });
  assert.equal(first, second);
  assert.notEqual(
    first,
    portalFailureFingerprint({ ...base, error: "session expired" }),
  );
});

test("only reviewable failure outcomes are diagnosable", () => {
  assert.equal(isDiagnosablePortalStatus("failed"), true);
  assert.equal(isDiagnosablePortalStatus("program_missing"), true);
  assert.equal(isDiagnosablePortalStatus("program_full"), true);
  assert.equal(isDiagnosablePortalStatus("submitted"), false);
  assert.equal(isDiagnosablePortalStatus("already_exists"), false);
  assert.equal(isDiagnosablePortalStatus("queued"), false);
});

const selectorOnlyBaseSpec = {
  specVersion: 2,
  meta: {
    key: "guardian_fixture",
    name: "Guardian Fixture",
    baseUrl: "https://portal.example.com",
    matches: ["guardian fixture"],
    resolution: "override",
    dryRunPolicy: "strict",
  },
  auth: {
    loginUrl: "https://portal.example.com/login",
    loginSteps: [
      {
        action: "fill",
        selector: "#username",
        value: "credential-resolved-by-engine",
      },
    ],
  },
  steps: [
    {
      action: "fill",
      selector: "#old-city",
      valueFrom: "profile.addressCity",
      readback: {
        source: "value",
        comparison: "trimmed",
        rejectAriaInvalid: true,
      },
    },
  ],
  success: {
    successSelector: "[data-status='submitted']",
  },
};

test("Guardian drafts a schema-valid selector-only patch", () => {
  const decision = applyGuardianSpecPatch(
    selectorOnlyBaseSpec,
    {
      ...validDiagnosis,
      risk: "low",
    } as Parameters<typeof applyGuardianSpecPatch>[1],
  );
  assert.equal(decision.accepted, true);
  if (!decision.accepted) return;
  assert.equal(
    (
      decision.patchedSpec.steps as Array<Record<string, unknown>>
    )[0]?.selector,
    "[data-field='cityOfBirth'] input",
  );
  assert.equal(
    (
      selectorOnlyBaseSpec.steps as Array<Record<string, unknown>>
    )[0]?.selector,
    "#old-city",
  );
});

test("Guardian blocks auth, final-submit and executable patch boundaries", () => {
  for (const path of [
    "/auth/loginSteps/0/selector",
    "/meta/baseUrl",
    "/steps/0/final",
    "/workflow/states/0/steps/0/script",
  ]) {
    const decision = applyGuardianSpecPatch(selectorOnlyBaseSpec, {
      ...validDiagnosis,
      risk: "low",
      proposedSpecPatch: [
        {
          op: "replace",
          path,
          value: "javascript:alert(1)",
          rationale: "unsafe fixture",
          evidence: "unsafe fixture",
        },
      ],
    } as Parameters<typeof applyGuardianSpecPatch>[1]);
    assert.equal(decision.accepted, false);
  }
});

test("Guardian refuses medium-risk or weak-evidence automatic drafts", () => {
  const decision = applyGuardianSpecPatch(selectorOnlyBaseSpec, {
    ...validDiagnosis,
    confidence: 0.84,
    risk: "medium",
  } as Parameters<typeof applyGuardianSpecPatch>[1]);
  assert.deepEqual(decision, {
    accepted: false,
    reason: "CONFIDENCE_OR_RISK_GATE",
  });
});

test("offline staging passes an exact selector-only patch and requires a canary", () => {
  const diagnosis = {
    ...validDiagnosis,
    risk: "low" as const,
  } as Parameters<typeof applyGuardianSpecPatch>[1];
  const decision = applyGuardianSpecPatch(selectorOnlyBaseSpec, diagnosis);
  assert.equal(decision.accepted, true);
  if (!decision.accepted) return;
  const report = validateGuardianStagingPatch({
    baseSpec: selectorOnlyBaseSpec,
    patchedSpec: decision.patchedSpec,
    operations: decision.operations,
    testedAt: "2026-07-31T00:00:00.000Z",
  });
  assert.equal(report.status, "passed");
  assert.equal(report.mode, "offline_structural");
  assert.equal(report.canaryRequired, true);
  assert.deepEqual(report.changedPaths, ["/steps/0/selector"]);
  assert.equal(stagingReportsMatch(report, report), true);
});

test("offline staging rejects undeclared protected-surface changes", () => {
  const diagnosis = {
    ...validDiagnosis,
    risk: "low" as const,
  } as Parameters<typeof applyGuardianSpecPatch>[1];
  const decision = applyGuardianSpecPatch(selectorOnlyBaseSpec, diagnosis);
  assert.equal(decision.accepted, true);
  if (!decision.accepted) return;
  const tampered = structuredClone(decision.patchedSpec);
  (tampered.meta as Record<string, unknown>).baseUrl =
    "https://attacker.example.com";
  const report = validateGuardianStagingPatch({
    baseSpec: selectorOnlyBaseSpec,
    patchedSpec: tampered,
    operations: decision.operations,
  });
  assert.equal(report.status, "failed");
  assert.equal(
    report.checks.find((check) => check.key === "changed_paths_exact")?.passed,
    false,
  );
  assert.equal(
    report.checks.find(
      (check) => check.key === "protected_surfaces_unchanged",
    )?.passed,
    false,
  );
});

test("staging report hashes are tamper evident", () => {
  const diagnosis = {
    ...validDiagnosis,
    risk: "low" as const,
  } as Parameters<typeof applyGuardianSpecPatch>[1];
  const decision = applyGuardianSpecPatch(selectorOnlyBaseSpec, diagnosis);
  assert.equal(decision.accepted, true);
  if (!decision.accepted) return;
  const report = validateGuardianStagingPatch({
    baseSpec: selectorOnlyBaseSpec,
    patchedSpec: decision.patchedSpec,
    operations: decision.operations,
  });
  assert.equal(
    stagingReportsMatch(
      { ...report, patchedSpecHash: "tampered" },
      report,
    ),
    false,
  );
});

test("deploy proposal is explicitly non-executing and rollback-aware", () => {
  const diagnosis = {
    ...validDiagnosis,
    risk: "low" as const,
  } as Parameters<typeof applyGuardianSpecPatch>[1];
  const decision = applyGuardianSpecPatch(selectorOnlyBaseSpec, diagnosis);
  assert.equal(decision.accepted, true);
  if (!decision.accepted) return;
  const staging = validateGuardianStagingPatch({
    baseSpec: selectorOnlyBaseSpec,
    patchedSpec: decision.patchedSpec,
    operations: decision.operations,
  });
  const payload = buildPortalDeployProposalPayload({
    sourceActionId: 10,
    submissionId: 20,
    universityKey: "fixture-university",
    adapterKey: "guardian_fixture",
    fingerprint: "fingerprint",
    baseSpecId: 30,
    baseSpecVersion: 4,
    draftSpecId: 31,
    draftSpecVersion: 5,
    diagnosis,
    staging,
  });
  assert.equal(payload.deployment.automaticExecution, false);
  assert.equal(payload.deployment.productionChanged, false);
  assert.equal(payload.deployment.requiresAuthorizedCanary, true);
  assert.deepEqual(payload.deployment.rollback, {
    specId: 30,
    specVersion: 4,
  });
});

test("review endpoint contains no spec activation or privileged approval side effect", () => {
  const source = readFileSync(
    new URL("../src/routes/ai-personas.ts", import.meta.url),
    "utf8",
  );
  const reviewSection = source.slice(
    source.indexOf('"/ai-personas/queue/actions/:id/review"'),
    source.indexOf("export default router"),
  );
  assert.doesNotMatch(reviewSection, /privilegedApproved\s*:\s*true/);
  assert.doesNotMatch(
    reviewSection,
    /update\(portalAdapterSpecsTable\)[\s\S]{0,300}enabled\s*:\s*true/,
  );
  assert.match(reviewSection, /productionChanged:\s*false/);
});

test("Guardian queues only proposals that pass its validation gates", () => {
  const guardianSource = readFileSync(
    new URL("../src/lib/portalAiGuardian.ts", import.meta.url),
    "utf8",
  );
  const personaSource = readFileSync(
    new URL("../src/lib/personaService.ts", import.meta.url),
    "utf8",
  );
  assert.match(guardianSource, /queueSideEffectTools:\s*false/);
  assert.match(guardianSource, /proposalReady\s*=\s*[\s\S]*draftStatus === "created"[\s\S]*staging\?\.status === "passed"/);
  assert.match(guardianSource, /status:\s*proposalReady \? "proposed" : "diagnosed_no_proposal"/);
  assert.doesNotMatch(guardianSource, /status:\s*proposalReady \? "pending_approval" : "failed"/);
  assert.match(personaSource, /queueSideEffectTools = true/);
  assert.match(personaSource, /if \(!queueSideEffectTools\)/);
});
