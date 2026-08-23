import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (relativePath: string): string =>
  readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("every supported portal synchronizes and verifies passport identity", () => {
  const source = read("src/lib/portalApplicationPreflight.ts");

  assert.match(
    source,
    /if \(result\.supported\) \{\s+const identitySync = await autoSyncProfileIdentityFromPassport/,
  );
  assert.match(source, /verifyStudentIdentityAgainstPassport\(\{/);
  assert.match(source, /passportIdentitySyncStatus === "passport_conflict"/);
  assert.match(source, /const reusableIdentityFailure =/);
  assert.match(source, /const identityProof = reusableIdentityFailure/);
  assert.match(
    source,
    /else if \(identityProof\.status === "ai_unavailable"\) \{[\s\S]*passportIdentity:verification_unavailable/,
  );
  assert.doesNotMatch(
    source,
    /reason: identityProof\.status === "ai_unavailable"/,
  );
  assert.match(source, /result = \{ \.\.\.result, ready: false, incompatibleFields \}/);
});

test("manual and automatic queue paths park blocked inquiries in Missing Documents", () => {
  const manual = read("src/lib/portalManualEnqueue.ts");
  const automatic = read("src/lib/portalAutoTrigger.ts");

  assert.ok(
    (manual.match(/parkApplicationInMissingDocsStage\(/g) ?? []).length >= 2,
    "manual queue must park both mandatory-document and preflight failures",
  );
  assert.ok(
    (automatic.match(/parkApplicationInMissingDocsStage\(/g) ?? []).length >= 3,
    "automatic queue must park document, preflight, and identity failures",
  );
});

test("Missing Documents transition never downgrades an advanced application", () => {
  const source = read("src/lib/mandatoryDocs.ts");

  assert.match(
    source,
    /eq\(applicationsTable\.stage, "inquiry"\)/,
  );
  assert.match(source, /stage: "missing_docs"/);
});

test("student and public intake boundaries reject malformed passport numbers", () => {
  for (const path of [
    "src/routes/students.ts",
    "src/routes/public-apply.ts",
    "src/routes/embed.ts",
  ]) {
    const source = read(path);
    assert.match(source, /validatePassportNumber/);
    assert.match(source, /PASSPORT_NUMBER_INVALID/);
  }

  const leadConversion = read("src/routes/leads.ts");
  assert.match(leadConversion, /const safeAiPassportNumber =/);
  assert.match(leadConversion, /!validatePassportNumber\(aiPassportNumber\)/);
});
