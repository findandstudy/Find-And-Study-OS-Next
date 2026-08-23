import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import {
  APPLICATION_DOCUMENT_MAX_SIZE,
  validateApplicationDocumentFile,
  validateStudentDocumentFile,
} from "@workspace/file-upload-validation";
import { validateStudentDocumentBuffer } from "../src/lib/fileUploadValidation";
import { buildBotSystemPrompt } from "../src/lib/inbox/botBrain";
import { normalizeDocumentTypeKey } from "../src/lib/docNaming";

test("student documents enforce the 5 MB boundary and reject empty files", () => {
  assert.equal(
    validateApplicationDocumentFile("passport.pdf", "application/pdf", APPLICATION_DOCUMENT_MAX_SIZE),
    null,
  );
  assert.equal(
    validateApplicationDocumentFile("passport.pdf", "application/pdf", APPLICATION_DOCUMENT_MAX_SIZE + 1)?.type,
    "size_exceeded",
  );
  assert.equal(
    validateApplicationDocumentFile("passport.pdf", "application/pdf", 0)?.type,
    "empty_file",
  );
});

test("passport and photograph slots accept PDF/JPG/JPEG/PNG", () => {
  assert.equal(validateStudentDocumentFile("passport", "passport.pdf", "application/pdf", 1024), null);
  assert.equal(validateStudentDocumentFile("photo", "photo.pdf", "application/pdf", 1024), null);
  assert.equal(validateStudentDocumentFile("photograph", "photo.jpg", "image/jpeg", 1024), null);
});

test("content validation accepts a readable PDF and rejects a corrupt PDF", async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);
  const valid = Buffer.from(await pdf.save());
  assert.equal(await validateStudentDocumentBuffer("passport", "passport.pdf", "application/pdf", valid), null);

  const corrupt = Buffer.from("%PDF-1.7\nthis is not a readable PDF document\n%%EOF");
  assert.ok(await validateStudentDocumentBuffer("passport", "passport.pdf", "application/pdf", corrupt));
});

test("AI intake prompt keeps document safety rules outside editable knowledge", () => {
  const prompt = buildBotSystemPrompt("en", "Custom university knowledge only");
  assert.match(prompt, /at most 5 MB/i);
  assert.match(prompt, /separate file/i);
  assert.match(prompt, /passport-style photo.*PDF, JPG, JPEG or PNG/i);
  assert.match(prompt, /one PDF appears to contain multiple document types/i);
  assert.match(prompt, /Do not treat a mere attachment as a completed document/i);
});

test("staff profile upload surfaces use canonical types and downstream lifecycle hooks", () => {
  const studentDetail = readFileSync(
    new URL("../../edcons/src/pages/staff/StudentDetail.tsx", import.meta.url),
    "utf8",
  );
  const studentDocumentsRoute = readFileSync(
    new URL("../src/routes/documents.ts", import.meta.url),
    "utf8",
  );
  const leadDocumentsRoute = readFileSync(
    new URL("../src/routes/leads.ts", import.meta.url),
    "utf8",
  );

  assert.match(studentDetail, /queryFn:\s*\(\)\s*=>\s*customFetch\("\/api\/catalog-options"\)/);
  assert.match(studentDetail, /key:\s*"diploma_certificate"/);
  assert.match(studentDetail, /key:\s*"diploma_transcript"/);
  assert.doesNotMatch(studentDetail, /key:\s*"diploma"\s*,/);
  assert.doesNotMatch(studentDetail, /key:\s*"transcript"\s*,/);

  assert.match(studentDocumentsRoute, /const type = normalizeDocumentTypeKey\(requestedType\)/);
  assert.match(studentDocumentsRoute, /key === "type"[\s\S]*normalizeDocumentTypeKey\(req\.body\[key\]\)/);
  assert.match(studentDocumentsRoute, /reEvaluateMandatoryDocsForStudent\(doc\.studentId\)/);
  assert.match(leadDocumentsRoute, /recompressStoredObjectIfNeeded\(fileKey, mimeType\)/);
  assert.match(leadDocumentsRoute, /db\.transaction\(async \(tx\) =>/);
  assert.match(leadDocumentsRoute, /recomputeStudentPhoto\(doc\.studentId\)/);
  assert.match(leadDocumentsRoute, /reEvaluateMandatoryDocsForStudent\(doc\.studentId\)/);
});

test("Add Student flows persist canonical document keys", () => {
  const staffAddStudent = readFileSync(
    new URL("../../edcons/src/components/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );
  const agentAddStudent = readFileSync(
    new URL("../../edcons/src/components/agent/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );

  for (const source of [staffAddStudent, agentAddStudent]) {
    assert.match(source, /type:\s*d\.key/);
    assert.doesNotMatch(source, /type:\s*d\.label\?\.toLowerCase\(\)/);
  }
});

test("Add Student flows report partial document upload failures", () => {
  const staffAddStudent = readFileSync(
    new URL("../../edcons/src/components/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );
  const agentAddStudent = readFileSync(
    new URL("../../edcons/src/components/agent/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );

  for (const source of [staffAddStudent, agentAddStudent]) {
    assert.doesNotMatch(source, /Promise\.allSettled/);
    assert.match(source, /await createDocumentRecord\(/);
    assert.match(source, /result\.failed\.length > 0/);
    assert.match(source, /Student created, but document upload is incomplete/);
    assert.match(source, /Failed: \$\{result\.failed\.join\(", "\)\}/);
    assert.doesNotMatch(source, /\$\{docCount\} document\$\{docCount !== 1/);
  }
});

test("Add Student flows keep documentless people in the lead workflow", () => {
  const staffAddStudent = readFileSync(
    new URL("../../edcons/src/components/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );
  const agentAddStudent = readFileSync(
    new URL("../../edcons/src/components/agent/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );

  for (const source of [staffAddStudent, agentAddStudent]) {
    assert.doesNotMatch(source, /No documents\? Use <strong>"Skip to Form"<\/strong>/);
    assert.doesNotMatch(source, />\s*Skip to Form\s*</);
    assert.match(source, /Student profiles require documents/);
    assert.match(source, /title:\s*"No documents uploaded"/);
    assert.match(source, /const canProceedToForm = [^;]*uploadedCount > 0/);
    assert.match(source, /disabled=\{!canProceedToForm\}/);
    assert.match(source, /Skip AI Analysis/);
  }
});

test("application level persists as the editable interested level across intake surfaces", () => {
  const staffAddStudent = readFileSync(
    new URL("../../edcons/src/components/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );
  const agentAddStudent = readFileSync(
    new URL("../../edcons/src/components/agent/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );
  const publicPrograms = readFileSync(
    new URL("../../edcons/src/pages/public/Programs.tsx", import.meta.url),
    "utf8",
  );
  const publicApplyRoute = readFileSync(new URL("../src/routes/public-apply.ts", import.meta.url), "utf8");
  const embedRoute = readFileSync(new URL("../src/routes/embed.ts", import.meta.url), "utf8");

  assert.match(staffAddStudent, /function selectApplicationLevel\(level: string\)/);
  assert.match(staffAddStudent, /interestedLevel: level/);
  assert.match(staffAddStudent, /onValueChange=\{selectApplicationLevel\}/);
  assert.match(staffAddStudent, /interestedLevel: form\.interestedLevel \|\| null/);
  assert.match(staffAddStudent, /appliedLevel: form\.interestedLevel \|\| applicationLevel/);

  assert.match(agentAddStudent, /useStudyLevels\(\)/);
  assert.match(agentAddStudent, /function selectApplicationLevel\(level: string\)/);
  assert.match(agentAddStudent, /onValueChange=\{selectInterestedLevel\}/);
  assert.match(agentAddStudent, /interestedLevel: form\.interestedLevel \|\| null/);
  assert.match(agentAddStudent, /appliedLevel: form\.interestedLevel/);

  assert.match(publicPrograms, /programDegree: program\?\.degree \|\| null/);
  assert.match(publicApplyRoute, /resolveProgramInterestedLevel\(programIdNum, programDegree\)/);
  assert.match(embedRoute, /resolveProgramInterestedLevel\(programId, desiredLevel\)/);
  for (const route of [publicApplyRoute, embedRoute]) {
    assert.match(route, /interestedLevel: resolvedInterestedLevel/);
  }
});

test("agent Add Student uses the canonical dynamic level document policy", () => {
  const agentAddStudent = readFileSync(
    new URL("../../edcons/src/components/agent/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(agentAddStudent, /const LEVELS:/);
  assert.match(agentAddStudent, /canonicalStudyLevels\.map\(\(lv, index\)/);
  assert.match(agentAddStudent, /hasCatalogData: hasCanonicalStudyLevels/);
  assert.match(agentAddStudent, /Study levels could not be loaded from the catalog/);
  assert.match(agentAddStudent, /degree-doc-reqs/);
  assert.match(agentAddStudent, /\/api\/degrees\/by-value\/\$\{encodeURIComponent\(applicationLevel\)\}\/document-requirements/);
  assert.match(agentAddStudent, /required: requirement\.mandatory/);
  assert.match(agentAddStudent, /const documentPolicyReady =/);
  assert.match(agentAddStudent, /Document requirements could not be loaded/);
  assert.match(agentAddStudent, /No reviewed document policy exists for this level/);
  assert.match(agentAddStudent, /const canProceedToForm = documentPolicyReady/);
  assert.doesNotMatch(agentAddStudent, /required: false/);
});

test("staff and agent Add Student fail closed and enforce the same 5 MB policy", () => {
  const staffAddStudent = readFileSync(
    new URL("../../edcons/src/components/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );
  const agentAddStudent = readFileSync(
    new URL("../../edcons/src/components/agent/AddStudentModal.tsx", import.meta.url),
    "utf8",
  );

  for (const source of [staffAddStudent, agentAddStudent]) {
    assert.match(source, /validateApplicationDocumentFileObj\(file\)/);
    assert.match(source, /APPLICATION_DOCUMENT_HELP_TEXT/);
    assert.match(source, /const documentPolicyReady =/);
    assert.match(source, /const canProceedToForm = documentPolicyReady/);
    assert.match(source, /Document requirements could not be loaded/);
    assert.doesNotMatch(source, /validateFileObj as validateFile/);
  }
});

test("known legacy document labels normalize without guessing ambiguous labels", () => {
  assert.equal(normalizeDocumentTypeKey("Diploma Certificate"), "diploma_certificate");
  assert.equal(normalizeDocumentTypeKey("diploma transcript"), "diploma_transcript");
  assert.equal(normalizeDocumentTypeKey("Bachelor's Cert."), "bachelors_certificate");
  assert.equal(normalizeDocumentTypeKey("passport"), "passport");
  assert.equal(normalizeDocumentTypeKey("All Sem. Transcript"), "all sem. transcript");
});

test("embed widget keeps the canonical requirement key in its document payload", () => {
  const embedRoute = readFileSync(
    new URL("../src/routes/embed.ts", import.meta.url),
    "utf8",
  );

  assert.match(embedRoute, /uploadedDocs\[key\]=\{label:key,/);
  assert.match(embedRoute, /return \{type:d\.isImage\?'image':'pdf',data:d\.base64,mediaType:d\.mediaType,label:d\.label,/);
});

test("all application intake surfaces combine document parts before AI or persistence", () => {
  const sources = [
    "../../edcons/src/components/AddStudentModal.tsx",
    "../../edcons/src/components/agent/AddStudentModal.tsx",
    "../../edcons/src/pages/staff/CourseFinder.tsx",
    "../../edcons/src/pages/public/Programs.tsx",
  ].map((path) => readFileSync(new URL(path, import.meta.url), "utf8"));
  for (const source of sources) {
    assert.match(source, /mergeDocumentParts/);
    assert.match(source, /partCount/);
    assert.match(source, /multiple=\{!isSingleImageDocumentType\(docType\.key\)\}/);
  }

  const embedRoute = readFileSync(new URL("../src/routes/embed.ts", import.meta.url), "utf8");
  const publicApplyRoute = readFileSync(new URL("../src/routes/public-apply.ts", import.meta.url), "utf8");
  assert.match(embedRoute, /function handleDocumentFiles\(key,files\)/);
  assert.match(embedRoute, /public\/documents\/merge-parts/);
  assert.match(embedRoute, /isPhotoDocumentKey\(key\)&&files\.length>1/);
  assert.match(publicApplyRoute, /documentMergeSessionLimiter/);
  assert.match(publicApplyRoute, /\/public\/documents\/merge-parts/);
  assert.doesNotMatch(publicApplyRoute, /"\/public\/documents\/merge-parts",\s*aiExtractIpLimiter/);
});
