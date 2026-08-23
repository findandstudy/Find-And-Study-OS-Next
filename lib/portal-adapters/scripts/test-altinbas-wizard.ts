import { test } from "node:test";
import assert from "node:assert/strict";

import {
  altinbasBasicFieldLabel,
  altinbasUiDateEntryCandidates,
  altinbasApplicationCoreProgram,
  altinbasMutationCanaryGate,
  altinbasPhoneDigits,
  altinbasGpaTypeLabel,
  canonicalAltinbasWizardStep,
  decideAltinbasSignedUpLookup,
  chooseAltinbasApplicantGridRow,
  chooseAltinbasApplicationRow,
  chooseAltinbasLabeledCombobox,
  decideAltinbasEducationAddCandidate,
  decideAltinbasApplicationRow,
  decideAltinbasExistingApplication,
  decideAltinbasUploadRefresh,
  classifyAltinbasHiddenFlowValidation,
  classifyAltinbasWizardTransition,
  explicitCityOfBirth,
  extractAltinbasFlowUploadedDocumentSlots,
  isAltinbasExistingUploadProved,
  isAltinbasLightningUploadProved,
  isAltinbasPostNextDuplicate,
  isAltinbasUiDateCommitted,
  missingAltinbasPersonalFields,
  normalizeAltinbasPassportNumber,
  parseAltinbasCanaryStage,
  redactAltinbasLog,
  resolveAltinbasLegacyEducation,
  resolveAltinbasLegacyGpa,
  resolveAltinbasResumeFieldAction,
  resolveAltinbasVisaResumeAction,
  resolveAltinbasWizardState,
  selectAltinbasRollbackIds,
  shouldUseAltinbasUiPath,
} from "../src/universities/altinbas/altinbasWizard.js";
import {
  altinbasProgramName,
  isAltinbasQuotaFull,
  isAltinbasKnownLiveBachelorProgram,
  selectAltinbasProgram,
} from "../src/universities/altinbas/altinbasProgram.js";

test("AW1: canonicalizes the live SLDS stage-name marker", () => {
  assert.equal(
    canonicalAltinbasWizardStep("Stage: Personal Information"),
    "Personal Information",
  );
});

test("AW2: accepts only exact live-discovered stage names", () => {
  assert.equal(canonicalAltinbasWizardStep("Documents"), "Documents");
  assert.equal(canonicalAltinbasWizardStep("Required Documents"), "");
  assert.equal(canonicalAltinbasWizardStep("Personal Information Extra"), "");
});

test("AW3: unique stage marker plus matching current-li title resolves", () => {
  assert.deepEqual(
    resolveAltinbasWizardState({
      stageNames: ["Stage: Educational Information"],
      currentTitles: ["Educational Information"],
      fileInputCount: 0,
    }),
    {
      step: "Educational Information",
      fileInputCount: 0,
      documentScreen: false,
      reason: "ok",
    },
  );
});

test("AW4: Documents is stage-driven even when file inputs are hidden/absent", () => {
  const state = resolveAltinbasWizardState({
    stageNames: ["Stage: Documents"],
    currentTitles: ["Documents"],
    fileInputCount: 0,
  });
  assert.equal(state.step, "Documents");
  assert.equal(state.documentScreen, true);
});

test("AW5: file inputs cannot misclassify a non-Documents stage", () => {
  const state = resolveAltinbasWizardState({
    stageNames: ["Stage: Personal Information"],
    currentTitles: ["Personal Information"],
    fileInputCount: 4,
  });
  assert.equal(state.step, "Personal Information");
  assert.equal(state.documentScreen, false);
});

test("AW6: missing, ambiguous and conflicting markers fail closed", () => {
  assert.equal(
    resolveAltinbasWizardState({
      stageNames: [],
      currentTitles: [],
      fileInputCount: 0,
    }).reason,
    "stage_missing",
  );
  assert.equal(
    resolveAltinbasWizardState({
      stageNames: ["Stage: Personal Information", "Stage: Questionnaire"],
      currentTitles: [],
      fileInputCount: 0,
    }).reason,
    "stage_ambiguous",
  );
  assert.equal(
    resolveAltinbasWizardState({
      stageNames: [
        "Stage: Personal Information",
        "Stage: Personal Information",
      ],
      currentTitles: ["Personal Information"],
      fileInputCount: 0,
    }).reason,
    "stage_ambiguous",
  );
  assert.equal(
    resolveAltinbasWizardState({
      stageNames: ["Stage: Personal Information"],
      currentTitles: ["Questionnaire"],
      fileInputCount: 0,
    }).reason,
    "marker_mismatch",
  );
});

test("AW7: transition reducer allows only the next canonical edge", () => {
  assert.equal(
    classifyAltinbasWizardTransition(
      "Personal Information",
      "Educational Information",
    ),
    "advanced",
  );
  assert.equal(
    classifyAltinbasWizardTransition(
      "Personal Information",
      "Personal Information",
    ),
    "unchanged",
  );
  assert.equal(
    classifyAltinbasWizardTransition("", "Educational Information"),
    "unknown",
  );
  assert.equal(
    classifyAltinbasWizardTransition("Personal Information", "Questionnaire"),
    "invalid",
  );
});

test("AW8: City of Birth accepts only a dedicated non-placeholder value", () => {
  assert.equal(explicitCityOfBirth("  Khujand  "), "Khujand");
  assert.equal(explicitCityOfBirth(""), null);
  assert.equal(explicitCityOfBirth(" - "), null);
  assert.equal(explicitCityOfBirth(undefined), null);
});

test("AW8b: Mobile is normalized to the portal's digits-only contract", () => {
  assert.equal(altinbasPhoneDigits("+90 (555) 111-22-33"), "905551112233");
  assert.equal(altinbasPhoneDigits("00992 92 123 4567"), "00992921234567");
  assert.equal(altinbasPhoneDigits("123"), null);
  assert.equal(altinbasPhoneDigits("1234567890123456"), null);
  assert.equal(altinbasPhoneDigits(undefined), null);
});

test("AW9: live Personal contract treats City of Birth optional and structured address required", () => {
  const complete = {
    email: "student@example.com",
    firstName: "Ali",
    lastName: "Yilmaz",
    passportNumber: "A1234567",
    dateOfBirth: "2000-01-01",
    passportIssueDate: "2020-01-01",
    passportExpiryDate: "2030-01-01",
    gender: "Male",
    nationality: "Turkey",
    addressStreet: "Main Street 1",
    addressCity: "Istanbul",
    addressZip: "34000",
  };
  assert.deepEqual(missingAltinbasPersonalFields(complete), []);
  assert.deepEqual(
    missingAltinbasPersonalFields({ ...complete, addressCity: "", addressZip: "" }),
    ["addressCity", "addressZip"],
  );
});

test("AW10: multiple application rows require unique name+programme proof", () => {
  assert.equal(
    chooseAltinbasApplicationRow(
      [
        "aliyilmazbusinessadministrationcompleteapplication",
        "aliyilmazelectricalelectronicsengineeringcompleteapplication",
      ],
      ["aliyilmaz", "yilmazali"],
      ["electricalelectronicsengineering"],
    ),
    1,
  );
  assert.equal(
    chooseAltinbasApplicationRow(
      ["", ""],
      ["aliyilmaz"],
      ["electricalelectronicsengineering"],
    ),
    -1,
  );
  assert.equal(
    chooseAltinbasApplicationRow([""], ["aliyilmaz"], ["computerengineering"]),
    0,
  );
});

test("AW10b: duplicate programme rows require the requested language track", () => {
  const rows = [
    "student name electrical and computer engineering thesis fall 2026 signed up",
    "student name electrical and computer engineering english thesis fall 2026 signed up",
    "student name architecture english thesis fall 2026 signed up",
  ];
  assert.equal(
    chooseAltinbasApplicationRow(
      rows,
      ["student name"],
      ["electrical and computer engineering"],
      "en",
    ),
    1,
  );
  assert.equal(
    chooseAltinbasApplicationRow(
      [
        rows[1],
        "student name electrical and computer engineering english fall 2027 signed up",
      ],
      ["student name"],
      ["electrical and computer engineering"],
      "en",
    ),
    -1,
    "two same-track drafts remain ambiguous",
  );
  assert.equal(
    chooseAltinbasApplicationRow(
      [
        "student name electrical and computer engineering turkish signed up",
        "student name architecture english signed up",
      ],
      ["student name"],
      ["electrical and computer engineering"],
      "en",
    ),
    -1,
    "an explicit opposite-track row is never selected",
  );
});

test("AW10c: unrelated Signed-Up rows are missing, duplicate targets ambiguous", () => {
  assert.deepEqual(
    decideAltinbasApplicationRow(
      [
        "student name economics in english signed up",
        "student name international trade in english signed up",
      ],
      ["student name"],
      ["international relations"],
      "en",
    ),
    { index: -1, reason: "missing", matchCount: 0 },
  );
  assert.deepEqual(
    decideAltinbasApplicationRow(
      [
        "student name international relations in english signed up",
        "student name international relations in english signed up",
      ],
      ["student name"],
      ["international relations"],
      "en",
    ),
    { index: -1, reason: "ambiguous", matchCount: 2 },
  );
});

test("AW10d: a matching Evaluation row is an existing submitted application", () => {
  const rows = [
    "student name economics in english signed up fall 2026 complete application",
    "student name international relations in english evaluation fall 2026 view application",
  ];
  assert.deepEqual(
    decideAltinbasExistingApplication(
      rows,
      ["student name"],
      ["international relations"],
      "en",
    ),
    { outcome: "submitted", index: 1 },
  );
});

test("AW10e: non-draft status proof never trusts a sole unrelated row", () => {
  assert.deepEqual(
    decideAltinbasExistingApplication(
      ["student name economics in english evaluation view application"],
      ["student name"],
      ["international relations"],
      "en",
    ),
    { outcome: "missing", index: -1 },
  );
  assert.deepEqual(
    decideAltinbasExistingApplication(
      ["student name international relations in english rejected view application"],
      ["student name"],
      ["international relations"],
      "en",
    ),
    { outcome: "unknown_status", index: 0 },
  );
});

test("AW11: mutation canary requires UI completion and dry runner mode", () => {
  assert.equal(
    altinbasMutationCanaryGate({ requested: false, uiComplete: false, dryRun: false }),
    "inactive",
  );
  assert.equal(
    altinbasMutationCanaryGate({ requested: true, uiComplete: false, dryRun: true }),
    "requires_ui_complete",
  );
  assert.equal(
    altinbasMutationCanaryGate({ requested: true, uiComplete: true, dryRun: false }),
    "requires_dry_run",
  );
  assert.equal(
    altinbasMutationCanaryGate({ requested: true, uiComplete: true, dryRun: true }),
    "ready",
  );
});

test("AW12: every dry-run uses the read-only UI path", () => {
  assert.equal(
    shouldUseAltinbasUiPath({ uiComplete: false, dryRun: true }),
    true,
  );
  assert.equal(
    shouldUseAltinbasUiPath({ uiComplete: false, dryRun: false }),
    false,
  );
});

test("AW13: portal logging redacts applicant PII and signed tokens", () => {
  const redacted = redactAltinbasLog(
    'email=test@example.com passportNumber="P1234567" addressStreet="Secret Road" phone=+905551112233 https://x.test/file?token=secret',
  );
  assert.ok(!redacted.includes("test@example.com"));
  assert.ok(!redacted.includes("P1234567"));
  assert.ok(!redacted.includes("Secret Road"));
  assert.ok(!redacted.includes("+905551112233"));
  assert.ok(!redacted.includes("token=secret"));
});

test("AW14: GPA system maps only known CRM scales to exact portal labels", () => {
  assert.equal(altinbasGpaTypeLabel("4"), "GRADING SYSTEM OUT OF 4");
  assert.equal(altinbasGpaTypeLabel("4.0"), "GRADING SYSTEM OUT OF 4");
  assert.equal(altinbasGpaTypeLabel("percentage"), "GRADING SYSTEM OUT OF 100");
  assert.equal(
    altinbasGpaTypeLabel("GRADING SYSTEM OUT OF 5"),
    "GRADING SYSTEM OUT OF 5",
  );
  assert.equal(altinbasGpaTypeLabel("letter"), null);
});

test("AW14b: legacy letter GPA is deterministically converted to the 4-point scale", () => {
  assert.deepEqual(
    resolveAltinbasLegacyGpa({
      recordGpa: null,
      recordGpaType: null,
      legacyGpa: "A- (MINUS)",
    }),
    { gpa: "3.7", gpaType: "4", provenance: "legacy_letter" },
  );
  assert.deepEqual(
    resolveAltinbasLegacyGpa({
      recordGpa: null,
      recordGpaType: null,
      legacyGpa: null,
    }),
    { gpa: "3", gpaType: "4", provenance: "policy_default" },
  );
});

test("AW14c: incomplete historical education inherits real legacy fields without inventing a school", () => {
  const resolved = resolveAltinbasLegacyEducation({
    record: {
      schoolName: "MULOT SECONDARY SCHOOL",
      country: null,
      endYear: null,
      gpa: null,
      gpaType: null,
    },
    level: "high_school",
    applicationLevel: "associate",
    legacySchoolName: "MULOT SECONDARY SCHOOL",
    fallbackCountry: "Kenya",
    legacyGraduationYear: 2021,
    legacyGpa: "A- (MINUS)",
    dateOfBirth: "2003-01-01",
    currentYear: 2026,
  });
  assert.equal(resolved.schoolName, "MULOT SECONDARY SCHOOL");
  assert.equal(resolved.country, "Kenya");
  assert.equal(resolved.endYear, 2021);
  assert.equal(resolved.gpa, "3.7");
  assert.equal(resolved.gpaType, "4");
  assert.equal(resolved.gpaProvenance, "legacy_letter");
  assert.deepEqual(
    resolved.fallbackFields,
    ["country", "graduationYear", "gpa", "gpaType"],
  );

  const noSchool = resolveAltinbasLegacyEducation({
    level: "bachelor",
    applicationLevel: "master",
    fallbackCountry: "Kenya",
    legacyGraduationYear: 2024,
    legacyGpa: null,
    currentYear: 2026,
  });
  assert.equal(noSchool.schoolName, null);
});

test("AW14d: education add control requires a unique nearest composed-tree candidate", () => {
  assert.deepEqual(
    decideAltinbasEducationAddCandidate([
      {
        id: "calendar",
        distance: 2,
        semantic: false,
        genericIcon: true,
        excluded: true,
      },
      {
        id: "education-add",
        distance: 3,
        semantic: true,
        genericIcon: true,
        excluded: false,
      },
      {
        id: "far-icon",
        distance: 9,
        semantic: false,
        genericIcon: true,
        excluded: false,
      },
    ]),
    { id: "education-add", proof: "semantic", reason: "ok" },
  );
  assert.deepEqual(
    decideAltinbasEducationAddCandidate([
      {
        id: "stage-unique-utility-add",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
      },
      {
        id: "unanchored-generic-icon",
        distance: 99,
        semantic: false,
        genericIcon: true,
        excluded: false,
      },
    ]),
    { id: "stage-unique-utility-add", proof: "semantic", reason: "ok" },
  );
  assert.deepEqual(
    decideAltinbasEducationAddCandidate([
      {
        id: "semantic-a",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
      },
      {
        id: "semantic-b",
        distance: 4,
        semantic: true,
        genericIcon: true,
        excluded: false,
      },
    ]),
    { id: null, proof: null, reason: "ambiguous" },
  );
  assert.deepEqual(
    decideAltinbasEducationAddCandidate([
      {
        id: "background-add",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        insideDialog: false,
        top: 20,
      },
      {
        id: "education-add",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        targetContext: true,
        insideDialog: true,
        top: 240,
      },
      {
        id: "exam-add",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        insideDialog: true,
        top: 440,
      },
    ]),
    { id: "education-add", proof: "education_context", reason: "ok" },
  );
  assert.deepEqual(
    decideAltinbasEducationAddCandidate([
      {
        id: "dialog-first",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        insideDialog: true,
        top: 240,
      },
      {
        id: "dialog-second",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        insideDialog: true,
        top: 440,
      },
    ]),
    { id: "dialog-first", proof: "dialog_topmost", reason: "ok" },
  );
  assert.deepEqual(
    decideAltinbasEducationAddCandidate([
      {
        id: "education-button",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        interactive: true,
        insideDialog: false,
        top: 366,
      },
      {
        id: "education-inner-icon",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        interactive: false,
        insideDialog: false,
        top: 369,
      },
      {
        id: "exam-button",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        interactive: true,
        insideDialog: false,
        top: 521,
      },
      {
        id: "exam-inner-icon",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        interactive: false,
        insideDialog: false,
        top: 525,
      },
    ]),
    { id: "education-button", proof: "stage_topmost", reason: "ok" },
  );
  assert.deepEqual(
    decideAltinbasEducationAddCandidate([
      {
        id: "education-outer-host",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        interactive: true,
        insideDialog: false,
        top: 366,
      },
      {
        id: "education-inner-host",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        interactive: true,
        insideDialog: false,
        top: 369,
      },
      {
        id: "exam-outer-host",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        interactive: true,
        insideDialog: false,
        top: 521,
      },
    ]),
    { id: "education-outer-host", proof: "stage_topmost", reason: "ok" },
    "the unique higher outer host wins over its inner icon duplicate",
  );
  assert.deepEqual(
    decideAltinbasEducationAddCandidate([
      {
        id: "same-row-a",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        interactive: true,
        insideDialog: false,
        top: 366,
      },
      {
        id: "same-row-b",
        distance: 0,
        semantic: true,
        genericIcon: true,
        excluded: false,
        interactive: true,
        insideDialog: false,
        top: 366,
      },
    ]),
    { id: null, proof: null, reason: "ambiguous" },
    "equal-height sibling controls remain fail-closed",
  );
  assert.deepEqual(
    decideAltinbasEducationAddCandidate([
      {
        id: "nearest",
        distance: 2,
        semantic: false,
        genericIcon: true,
        excluded: false,
      },
      {
        id: "farther",
        distance: 5,
        semantic: false,
        genericIcon: true,
        excluded: false,
      },
    ]),
    { id: "nearest", proof: "nearest_unique_icon", reason: "ok" },
  );
  assert.deepEqual(
    decideAltinbasEducationAddCandidate([
      {
        id: "ambiguous-a",
        distance: 2,
        semantic: false,
        genericIcon: true,
        excluded: false,
      },
      {
        id: "ambiguous-b",
        distance: 2,
        semantic: false,
        genericIcon: true,
        excluded: false,
      },
    ]),
    { id: null, proof: null, reason: "ambiguous" },
  );
});

test("AW14e: exact saved date state is resume-safe and partial drafts fail closed", () => {
  const lightningProof = {
    ariaInvalid: false,
    valid: true,
    nativeDateInput: false,
    nativeValueMatchesExpected: false,
    lightningInputValuePresent: true,
    lightningInputMatchesExpected: true,
    lightningInputValid: true,
    datepickerMatchesExpected: true,
    flowScreenValuePresent: true,
  };
  assert.equal(isAltinbasUiDateCommitted(lightningProof), true);
  assert.equal(
    isAltinbasUiDateCommitted({
      ...lightningProof,
      flowScreenValuePresent: false,
    }),
    false,
    "a native-looking draft without Flow state is never reused",
  );
  assert.equal(
    isAltinbasUiDateCommitted({
      ...lightningProof,
      lightningInputMatchesExpected: false,
    }),
    false,
    "a saved but different date must be rewritten from CRM",
  );
  assert.equal(
    isAltinbasUiDateCommitted({
      ...lightningProof,
      nativeDateInput: true,
      nativeValueMatchesExpected: true,
      lightningInputValuePresent: false,
      lightningInputMatchesExpected: false,
      lightningInputValid: false,
      datepickerMatchesExpected: false,
      flowScreenValuePresent: false,
    }),
    true,
    "a native date input uses exact ISO readback without Lightning hosts",
  );
});

test("AW14e2: blank Lightning dates preserve zero-padded day/month", () => {
  assert.deepEqual(
    altinbasUiDateEntryCandidates(
      "2004-09-05",
      { type: "text", placeholder: "" },
    ),
    ["05/09/2004"],
  );
  assert.deepEqual(
    altinbasUiDateEntryCandidates(
      "2004-09-05",
      { type: "text", placeholder: "MM/DD/YYYY" },
    ),
    ["09/05/2004"],
  );
  assert.deepEqual(
    altinbasUiDateEntryCandidates(
      "2004-09-05",
      { type: "date" },
    ),
    ["2004-09-05"],
  );
  assert.deepEqual(
    altinbasUiDateEntryCandidates("not-a-date", { type: "text" }),
    [],
  );
});

test("AW14f: Lightning upload needs exact local file plus completed Done contract", () => {
  const proof = {
    exactLocalFile: true,
    doneClicked: true,
    doneDismissed: true,
    documentsStage: true,
    portalFilenameSeen: false,
  };
  assert.equal(isAltinbasLightningUploadProved(proof), true);
  assert.equal(
    isAltinbasLightningUploadProved({ ...proof, exactLocalFile: false }),
    false,
  );
  assert.equal(
    isAltinbasLightningUploadProved({ ...proof, doneClicked: false }),
    false,
  );
  assert.equal(
    isAltinbasLightningUploadProved({
      ...proof,
      doneDismissed: false,
      portalFilenameSeen: false,
    }),
    false,
  );
  assert.equal(
    isAltinbasLightningUploadProved({ ...proof, documentsStage: false }),
    false,
  );
  assert.equal(
    isAltinbasLightningUploadProved({
      ...proof,
      doneDismissed: false,
      portalFilenameSeen: true,
    }),
    true,
    "an exact portal filename is sufficient even before the modal disappears",
  );
});

test("AW14g: resumed upload needs an exact filename or scoped Salesforce content id", () => {
  assert.equal(
    isAltinbasExistingUploadProved({
      exactFilenameSeen: true,
      contentReferenceCount: 0,
    }),
    true,
  );
  assert.equal(
    isAltinbasExistingUploadProved({
      exactFilenameSeen: false,
      contentReferenceCount: 1,
    }),
    true,
  );
  assert.equal(
    isAltinbasExistingUploadProved({
      exactFilenameSeen: false,
      contentReferenceCount: 0,
    }),
    false,
  );
  assert.equal(
    isAltinbasExistingUploadProved({
      exactFilenameSeen: false,
      contentReferenceCount: -1,
    }),
    false,
  );
});

test("AW14h: live recordsCV proves all four exact uploaded document slots", () => {
  const sfId = (prefix: "068" | "069", suffix: string) =>
    `${prefix}Q300000${suffix.padStart(5, "0")}`;
  const record = (
    name: string,
    suffix: string,
  ): Record<string, unknown> => ({
    Name: `CV-${suffix}`,
    eduhub__Description__c: name,
    eduhub__Document_Name__c: name,
    eduhub__Status__c: "Uploaded",
    eduhub__Completed__c: "Yes",
    eduhub__Required__c: true,
    eduhub__Content_Document_Id__c: sfId("069", suffix),
    eduhub__Latest_Content_Id__c: sfId("068", suffix),
  });
  const proof = extractAltinbasFlowUploadedDocumentSlots({
    response: {
      fields: [
        { name: "Unrelated" },
        {
          extensionName: "eduhub:eduhubMultipleFileUpload",
          name: "Upload",
          inputs: [{
            name: "recordsCV",
            value: [
              record("Passport", "1"),
              record("High School Diploma", "2"),
              record("High School Transcript", "3"),
              record("Personal Picture", "4"),
            ],
          }],
        },
      ],
    },
  });
  assert.equal(proof.componentFound, true);
  assert.deepEqual(
    proof.slots,
    ["passport", "diploma", "transcript", "photo"],
  );
});

test("AW14i: recordsCV rejects incomplete status and invalid content ids", () => {
  const proof = extractAltinbasFlowUploadedDocumentSlots({
    extensionName: "eduhub:eduhubMultipleFileUpload",
    name: "Upload",
    inputs: [{
      name: "recordsCV",
      value: [
        {
          Name: "CV-1",
          eduhub__Description__c: "Passport",
          eduhub__Document_Name__c: "Passport",
          eduhub__Status__c: "Pending",
          eduhub__Completed__c: "Yes",
          eduhub__Required__c: true,
          eduhub__Content_Document_Id__c: "069Q30000000001",
          eduhub__Latest_Content_Id__c: "068Q30000000001",
        },
        {
          Name: "CV-2",
          eduhub__Description__c: "High School Diploma",
          eduhub__Document_Name__c: "High School Diploma",
          eduhub__Status__c: "Uploaded",
          eduhub__Completed__c: "Yes",
          eduhub__Required__c: true,
          eduhub__Content_Document_Id__c: "not-a-salesforce-id",
          eduhub__Latest_Content_Id__c: "068Q30000000002",
        },
      ],
    }],
  });
  assert.equal(proof.componentFound, true);
  assert.deepEqual(proof.slots, []);
});

test("AW14j: duplicate document names and ambiguous components fail closed", () => {
  const validPassport = {
    Name: "CV-1",
    eduhub__Description__c: "Passport",
    eduhub__Document_Name__c: "Passport",
    eduhub__Status__c: "Uploaded",
    eduhub__Completed__c: "Yes",
    eduhub__Required__c: true,
    eduhub__Content_Document_Id__c: "069Q30000000001",
    eduhub__Latest_Content_Id__c: "068Q30000000001",
  };
  const component = {
    extensionName: "eduhub:eduhubMultipleFileUpload",
    name: "Upload",
    inputs: [{
      name: "recordsCV",
      value: [validPassport, { ...validPassport }],
    }],
  };
  assert.deepEqual(
    extractAltinbasFlowUploadedDocumentSlots(component),
    { componentFound: true, slots: [] },
  );
  assert.deepEqual(
    extractAltinbasFlowUploadedDocumentSlots([component, component]),
    { componentFound: true, slots: [] },
  );
  assert.deepEqual(
    extractAltinbasFlowUploadedDocumentSlots({ name: "Other" }),
    { componentFound: false, slots: [] },
  );
});

test("AW14k: new uploads reopen once for authoritative recordsCV proof", () => {
  assert.equal(
    decideAltinbasUploadRefresh({
      serverUploadedSlots: [
        "passport",
        "diploma",
        "transcript",
        "photo",
      ],
      refreshAttempted: false,
    }),
    "submit",
  );
  assert.equal(
    decideAltinbasUploadRefresh({
      serverUploadedSlots: ["passport", "diploma"],
      refreshAttempted: false,
    }),
    "reopen_once",
  );
  assert.equal(
    decideAltinbasUploadRefresh({
      serverUploadedSlots: [],
      refreshAttempted: true,
    }),
    "fail_closed",
  );
});

test("AW15: rollback accepts only ids proven created in the current run", () => {
  assert.deepEqual(
    selectAltinbasRollbackIds({
      runCreatedIds: ["a02Q30000000001", "a02Q30000000001", "not-an-id"],
      explicitAppIds: ["a02Q30000000999"],
    }),
    ["a02Q30000000001"],
  );
});

test("AW16: canary stage is explicit and can never target Documents", () => {
  assert.equal(parseAltinbasCanaryStage(undefined), "Personal Information");
  assert.equal(
    parseAltinbasCanaryStage("educational"),
    "Educational Information",
  );
  assert.equal(parseAltinbasCanaryStage("questionnaire"), "Questionnaire");
  assert.equal(parseAltinbasCanaryStage("documents"), null);
});

test("AW17: live Program Availability name wins over internal PE record name", () => {
  assert.equal(
    altinbasProgramName({
      Id: "a0AQ3000007Te4WMAS",
      Name: "PE-01904",
      eduhub__Program_Name__c: "Biomedical Sciences (With Thesis)",
    }),
    "Biomedical Sciences (With Thesis)",
  );
});

test("AW18: quota-full requires an explicit true value", () => {
  assert.equal(isAltinbasQuotaFull({ eduhub__Quota_Full__c: true }), true);
  assert.equal(isAltinbasQuotaFull({ eduhub__Quota_Full__c: "true" }), true);
  assert.equal(isAltinbasQuotaFull({ eduhub__Quota_Full__c: false }), false);
  assert.equal(isAltinbasQuotaFull({ eduhub__Quota_Full__c: "false" }), false);
  assert.equal(isAltinbasQuotaFull({}), false);
});

test("AW19: programme selection prefers availability rows and preserves exact quota flags", () => {
  const selection = selectAltinbasProgram(
    [
      [
        "a0BQH000008IDVQ2A4",
        {
          Id: "a0BQH000008IDVQ2A4",
          Name: "Data Analytics (With Thesis)",
        },
      ],
      [
        "a0AQ3000007Te4jMAC",
        {
          Id: "a0AQ3000007Te4jMAC",
          Name: "PE-01917",
          eduhub__Program__c: "a0BQH000008IDVQ2A4",
          eduhub__Program_Name__c: "Data Analytics (With Thesis)",
          eduhub__Quota_Full__c: true,
          eduhub__Quota_of_Program__c: 13,
          // Live capture carries false here even for eligible options; it must
          // never override the dedicated quota flag.
          eduhub__Is_Active__c: false,
        },
      ],
      [
        "a0AQ3000007Te4XMAS",
        {
          Id: "a0AQ3000007Te4XMAS",
          Name: "PE-01905",
          eduhub__Program__c: "a0BQH000008IDS72AO",
          eduhub__Program_Name__c:
            "Biomedical Sciences (With Thesis) (in English)",
          eduhub__Quota_Full__c: false,
          eduhub__Is_Active__c: false,
        },
      ],
    ],
    "Data Analytics (With Thesis)",
  );

  assert.equal(selection.option?.value, "a0AQ3000007Te4jMAC");
  assert.equal(selection.option?.name, "Data Analytics (With Thesis)");
  assert.equal(selection.option?.enabled, false);
  assert.equal(selection.record?.["Name"], "PE-01917");
  assert.equal(selection.candidates.length, 2, "base a0B row is ignored");
  assert.equal(
    selection.candidates.find(
      (candidate) => candidate.value === "a0AQ3000007Te4XMAS",
    )?.enabled,
    true,
    "Quota_Full=false remains selectable even when Is_Active=false",
  );
});

test("AW20: unknown programme never becomes a quota-full false positive", () => {
  const selection = selectAltinbasProgram(
    [
      [
        "a0AQ3000007Te4WMAS",
        {
          eduhub__Program__c: "a0BQH000008IDS62AO",
          eduhub__Program_Name__c: "Biomedical Sciences (With Thesis)",
          eduhub__Quota_Full__c: true,
        },
      ],
    ],
    "A Programme That Does Not Exist",
  );
  assert.equal(selection.option, null);
  assert.equal(selection.record, null);
  assert.equal(selection.candidates[0]?.enabled, false);
});

test("AW20b: legacy degree-prefixed English CRM title resolves one live bare option", () => {
  const selection = selectAltinbasProgram(
    [
      [
        "a0AQ3000007s02HMAQ",
        {
          eduhub__Program__c: "a0BQ300000Software",
          eduhub__Program_Name__c: "Software Engineering",
          eduhub__Quota_Full__c: false,
        },
      ],
    ],
    "Bachelor of Software Engineering (English)",
  );
  assert.equal(selection.option?.value, "a0AQ3000007s02HMAQ");
  assert.equal(selection.option?.name, "Software Engineering");
  assert.equal(selection.confidence, 1);
});

test("AW20c: legacy title refuses ambiguous current programme labels", () => {
  const selection = selectAltinbasProgram(
    [
      [
        "a0AQ3000007s02HMAQ",
        {
          eduhub__Program_Name__c: "Software Engineering",
        },
      ],
      [
        "a0AQ3000007s02JMAQ",
        {
          eduhub__Program_Name__c: "Software Engineering (in English)",
        },
      ],
    ],
    "Bachelor of Software Engineering (English)",
  );
  assert.equal(selection.option, null);
  assert.equal(selection.record, null);
});

test("AW20d: live Bachelor catalog separates applicant dedup from a removed legacy program", () => {
  assert.equal(
    isAltinbasKnownLiveBachelorProgram(
      "Bachelor of Software Engineering (English)",
    ),
    true,
  );
  assert.equal(
    isAltinbasKnownLiveBachelorProgram(
      "Bachelor of International Relations (English)",
    ),
    true,
  );
  assert.equal(
    isAltinbasKnownLiveBachelorProgram(
      "Bachelor of Artificial Intelligence Engineering (English)",
    ),
    false,
  );
  assert.equal(
    isAltinbasKnownLiveBachelorProgram(
      "Master of Software Engineering (English)",
    ),
    false,
  );
});

test("AW21: resumed fields prefer CRM, otherwise require a valid saved portal value", () => {
  assert.equal(
    resolveAltinbasResumeFieldAction({
      crmValue: "CRM value",
      portalValue: "older portal value",
      portalValid: true,
    }),
    "write_crm_value",
  );
  assert.equal(
    resolveAltinbasResumeFieldAction({
      crmValue: "",
      portalValue: "saved portal value",
      portalValid: true,
    }),
    "accept_existing_portal_value",
  );
  assert.equal(
    resolveAltinbasResumeFieldAction({
      crmValue: "",
      portalValue: "",
      portalValid: true,
    }),
    "data_missing",
  );
  assert.equal(
    resolveAltinbasResumeFieldAction({
      crmValue: "",
      portalValue: "saved but invalid",
      portalValid: false,
    }),
    "data_missing",
  );
  assert.equal(
    resolveAltinbasResumeFieldAction({
      crmValue: "",
      portalValue: "-",
      portalValid: true,
    }),
    "data_missing",
  );
  assert.equal(
    resolveAltinbasResumeFieldAction({
      crmValue: "",
      portalValue: "",
      portalValid: true,
      legacyFallback: "Not Provided",
    }),
    "write_legacy_fallback",
  );
  assert.equal(
    resolveAltinbasResumeFieldAction({
      crmValue: "",
      portalValue: "saved portal value",
      portalValid: true,
      legacyFallback: "Not Provided",
    }),
    "accept_existing_portal_value",
    "a valid saved value wins over the fallback",
  );
});

test("AW22: resumed questionnaire reuses only a saved No answer", () => {
  assert.equal(
    resolveAltinbasVisaResumeAction({ crmValue: "No", portalValue: "" }),
    "select_no_from_crm",
  );
  assert.equal(
    resolveAltinbasVisaResumeAction({ crmValue: "", portalValue: "No" }),
    "accept_existing_no",
  );
  assert.equal(
    resolveAltinbasVisaResumeAction({ crmValue: "Yes", portalValue: "No" }),
    "questionnaire_followup_unmapped",
  );
  assert.equal(
    resolveAltinbasVisaResumeAction({ crmValue: "", portalValue: "Yes" }),
    "questionnaire_followup_unmapped",
  );
  assert.equal(
    resolveAltinbasVisaResumeAction({ crmValue: "", portalValue: "" }),
    "data_missing",
  );
  assert.equal(
    resolveAltinbasVisaResumeAction({
      crmValue: "",
      portalValue: "",
      legacyDefaultNo: true,
    }),
    "select_no_from_policy",
  );
  assert.equal(
    resolveAltinbasVisaResumeAction({
      crmValue: "Yes",
      portalValue: "",
      legacyDefaultNo: true,
    }),
    "questionnaire_followup_unmapped",
    "explicit CRM Yes is never overwritten by the historical default",
  );
});

test("AW23: country picker ignores its labeled listbox and requires one actionable input", () => {
  assert.equal(
    chooseAltinbasLabeledCombobox([
      {
        tagName: "INPUT",
        role: "combobox",
        visible: true,
        disabled: false,
        readOnly: false,
      },
      {
        tagName: "DIV",
        role: "listbox",
        visible: false,
        disabled: false,
        readOnly: false,
      },
    ]),
    0,
  );
  assert.equal(
    chooseAltinbasLabeledCombobox([
      {
        tagName: "INPUT",
        role: "combobox",
        visible: true,
        disabled: false,
        readOnly: false,
      },
      {
        tagName: "INPUT",
        role: "combobox",
        visible: true,
        disabled: false,
        readOnly: false,
      },
    ]),
    -1,
    "two actionable inputs remain ambiguous",
  );
  assert.equal(
    chooseAltinbasLabeledCombobox([
      {
        tagName: "INPUT",
        role: "combobox",
        visible: true,
        disabled: false,
        readOnly: true,
      },
    ]),
    -1,
    "read-only controls are never mutated",
  );
  assert.equal(
    chooseAltinbasLabeledCombobox(
      [
        {
          tagName: "INPUT",
          role: "combobox",
          visible: true,
          disabled: false,
          readOnly: true,
        },
        {
          tagName: "DIV",
          role: "listbox",
          visible: false,
          disabled: false,
          readOnly: false,
        },
      ],
      { allowReadOnly: true },
    ),
    0,
    "a readonly selected input remains a valid readback target",
  );
});

test("AW24: Basic Information labels accept the live required marker without becoming broad", () => {
  const firstName = altinbasBasicFieldLabel("firstName");
  const lastName = altinbasBasicFieldLabel("lastName");
  const passport = altinbasBasicFieldLabel("passport");
  const email = altinbasBasicFieldLabel("email");

  assert.match("* First Name", firstName);
  assert.match("*First Name", firstName);
  assert.match("First Name", firstName);
  assert.match("First Name *", firstName);
  assert.doesNotMatch("Guardian First Name", firstName);

  assert.match("* Last Name", lastName);
  assert.match("* Passport Number", passport);
  assert.match("* Applicant Email", email);
});

test("AW25: applicant grid requires email + passport and falls back only for one radio", () => {
  const expectedFoldedEmail = "student@example.com";
  const expectedFoldedPassport = "p1234567";

  assert.equal(
    chooseAltinbasApplicantGridRow({
      foldedRows: [
        "other@example.com p7654321",
        "student@example.com p1234567",
      ],
      foldedPageText: "",
      expectedFoldedEmail,
      expectedFoldedPassport,
      exactSearchReadbackVerified: false,
    }),
    1,
    "a unique row-scoped identity proof wins",
  );

  assert.equal(
    chooseAltinbasApplicantGridRow({
      foldedRows: [""],
      foldedPageText: "student@example.com p1234567",
      expectedFoldedEmail,
      expectedFoldedPassport,
      exactSearchReadbackVerified: false,
    }),
    0,
    "one radio may use composed-page identity proof",
  );

  assert.equal(
    chooseAltinbasApplicantGridRow({
      foldedRows: [""],
      foldedPageText: "student@example.com",
      expectedFoldedEmail,
      expectedFoldedPassport,
      exactSearchReadbackVerified: false,
    }),
    -1,
    "email alone is insufficient",
  );

  assert.equal(
    chooseAltinbasApplicantGridRow({
      foldedRows: [""],
      foldedPageText: "p1234567",
      expectedFoldedEmail,
      expectedFoldedPassport,
      exactSearchReadbackVerified: false,
    }),
    -1,
    "passport alone is insufficient",
  );

  assert.equal(
    chooseAltinbasApplicantGridRow({
      foldedRows: ["", ""],
      foldedPageText: "student@example.com p1234567",
      expectedFoldedEmail,
      expectedFoldedPassport,
      exactSearchReadbackVerified: true,
    }),
    -1,
    "page-wide proof cannot choose between multiple radio candidates",
  );

  assert.equal(
    chooseAltinbasApplicantGridRow({
      foldedRows: [""],
      foldedPageText: "",
      expectedFoldedEmail,
      expectedFoldedPassport,
      exactSearchReadbackVerified: true,
    }),
    0,
    "one candidate is deterministic after exact Basic Information readback",
  );

  assert.equal(
    chooseAltinbasApplicantGridRow({
      foldedRows: [""],
      foldedPageText: "",
      expectedFoldedEmail,
      expectedFoldedPassport,
      exactSearchReadbackVerified: false,
    }),
    -1,
    "one candidate without either identity proof remains fail-closed",
  );
});

test("AW26: Signed-Up lookup retries only an absent row after program commit", () => {
  assert.equal(
    decideAltinbasSignedUpLookup({
      completeButtonCount: 0,
      chosenIndex: -1,
      attempt: 0,
      maxAttempts: 4,
    }),
    "retry",
  );
  assert.equal(
    decideAltinbasSignedUpLookup({
      completeButtonCount: 0,
      chosenIndex: -1,
      attempt: 3,
      maxAttempts: 4,
    }),
    "missing",
  );
  assert.equal(
    decideAltinbasSignedUpLookup({
      completeButtonCount: 2,
      chosenIndex: -1,
      attempt: 0,
      maxAttempts: 4,
    }),
    "ambiguous",
  );
  assert.equal(
    decideAltinbasSignedUpLookup({
      completeButtonCount: 1,
      chosenIndex: 0,
      attempt: 0,
      maxAttempts: 4,
    }),
    "open",
  );
});

test("AW27: application-row core program normalizes English and Turkish legacy titles", () => {
  assert.equal(
    altinbasApplicationCoreProgram(
      "Associate of Oral and Dental Health (Turkish)",
    ),
    "oral and dental health",
  );
  assert.equal(
    altinbasApplicationCoreProgram(
      "Bachelor of Software Engineering (English)",
    ),
    "software engineering",
  );
  assert.equal(
    chooseAltinbasApplicationRow(
      [
        "victor maina oral and dental health",
        "another applicant oral and dental health",
        "victor maina operating room services",
      ],
      ["victor maina"],
      [altinbasApplicationCoreProgram("Associate of Oral and Dental Health (Turkish)")],
    ),
    0,
    "the Turkish legacy suffix no longer hides a unique name+program row",
  );
});

test("AW28: passport values are normalized only within Altınbaş's proven format", () => {
  assert.equal(normalizeAltinbasPassportNumber("ab1234567"), "AB1234567");
  assert.equal(
    normalizeAltinbasPassportNumber(" ab-12 34 "),
    "AB1234",
    "case and harmless human formatting are normalized",
  );
  assert.equal(normalizeAltinbasPassportNumber("AB/1234"), null);
  assert.equal(normalizeAltinbasPassportNumber("A".repeat(21)), null);
  assert.equal(normalizeAltinbasPassportNumber("  "), null);
});

test("AW29: exact hidden Salesforce passport conflict is classified", () => {
  assert.equal(
    classifyAltinbasHiddenFlowValidation(
      JSON.stringify({
        component: "CheckDuplicateValidation",
        errorMessage:
          "An application with this passport number already exists. You cannot submit a new application using the same passport number.",
      }),
    ),
    "duplicate_passport",
  );
});

test("AW30: generic or partial duplicate text cannot move an application", () => {
  assert.equal(
    classifyAltinbasHiddenFlowValidation("An application already exists."),
    "none",
  );
  assert.equal(
    classifyAltinbasHiddenFlowValidation(
      "You cannot submit a new application using the same passport number.",
    ),
    "none",
  );
  assert.equal(classifyAltinbasHiddenFlowValidation(undefined), "none");
});

test("AW31: only a duplicate response newer than the exact Next is actionable", () => {
  assert.equal(
    isAltinbasPostNextDuplicate({
      flowVersionBeforeNext: 7,
      duplicatePassportVersion: 8,
    }),
    true,
  );
  assert.equal(
    isAltinbasPostNextDuplicate({
      flowVersionBeforeNext: 7,
      duplicatePassportVersion: 7,
    }),
    false,
  );
  assert.equal(
    isAltinbasPostNextDuplicate({
      flowVersionBeforeNext: 7,
      duplicatePassportVersion: 2,
    }),
    false,
  );
});
