import { fold } from "../../programMatch.js";

const PROGRAM_LEVEL_PREFIXES = [
  /^(?:bachelor(?:'s)?(?:\s+degree)?|undergraduate)\s+(?:of|in)\s+/i,
  /^(?:associate(?:'s)?(?:\s+degree)?)\s+(?:of|in)\s+/i,
  /^(?:master(?:'s)?(?:\s+degree)?|graduate)\s+(?:of|in)\s+/i,
  /^(?:ph\.?d\.?|doctorate|doctoral)\s+(?:of|in)\s+/i,
];

/**
 * Üsküdar and the related Salesforce portals show the degree level outside
 * the programme label. CRM names commonly include it as a prefix.
 */
export function salesforcePortalProgramName(crmProgramName: string): string {
  let value = crmProgramName.replace(/\s+/g, " ").trim();
  for (const prefix of PROGRAM_LEVEL_PREFIXES) {
    value = value.replace(prefix, "");
  }
  return value.trim();
}

export interface SalesforceProgramTarget {
  label: string;
  source: "university" | "general" | "normalized";
  ambiguous: boolean;
}

/**
 * Salesforce schools do not use one consistent language suffix:
 * some expose "Programme (English)", while Beykent currently exposes
 * "Programme - English". Explicit admin mappings remain authoritative and
 * are never expanded; only the deterministic CRM-name fallback gets the
 * equivalent spelling candidates.
 */
export function salesforcePortalProgramCandidates(
  target: SalesforceProgramTarget,
): string[] {
  const label = target.label.replace(/\s+/g, " ").trim();
  if (!label || target.ambiguous) return [];
  if (target.source !== "normalized") return [label];

  const languageSuffix = label.match(
    /^(.*?)\s*\((English|Turkish)\)\s*$/i,
  );
  if (!languageSuffix) return [label];

  const programme = languageSuffix[1].trim();
  const language =
    languageSuffix[2].slice(0, 1).toUpperCase() +
    languageSuffix[2].slice(1).toLowerCase();
  return [...new Set([`${programme} - ${language}`, label])];
}

/**
 * Salesforce programme cards render the programme name across nested shadow
 * DOM nodes. Accessible exact-text lookup can therefore miss a visible card
 * even though its nearest list item has an unambiguous "Select <programme>"
 * text readback. Keep this fallback exact and fail-closed.
 */
export function salesforceProgramCardMatchesCandidate(
  cardText: string | null | undefined,
  candidate: string | null | undefined,
): boolean {
  const expected = fold(candidate ?? "");
  if (!expected) return false;
  const actual = fold(cardText ?? "").replace(/^select\s+/, "").trim();
  return actual === expected;
}

export interface SalesforceAppliedProgramRow {
  applicationNumber: string;
  programName: string;
}

export interface SalesforceAppliedProgramMatch {
  externalRef: string;
  portalProgram: string;
}

/**
 * Haliç renders durable application references in the Applicant Detail
 * "Applied Programs" table. The table may omit the language suffix that was
 * shown during programme selection, so compare both the exact portal label and
 * its exact base label. More than one matching row is ambiguous and therefore
 * never counts as completion proof.
 */
export function findSalesforceAppliedProgramMatch(
  rows: SalesforceAppliedProgramRow[],
  expectedCandidates: string[],
): SalesforceAppliedProgramMatch | null {
  const expected = new Set<string>();
  for (const candidate of expectedCandidates) {
    const exact = fold(candidate);
    if (!exact) continue;
    expected.add(exact);
    const withoutLanguage = fold(
      candidate.replace(
        /\s*(?:-\s*|\(\s*)(?:English|Turkish)\s*\)?\s*$/i,
        "",
      ),
    );
    if (withoutLanguage) expected.add(withoutLanguage);
  }
  if (expected.size === 0) return null;

  const matches = rows.filter((row) => {
    const applicationNumber = row.applicationNumber.trim();
    return (
      /^AP\d{6,}$/i.test(applicationNumber) &&
      expected.has(fold(row.programName))
    );
  });
  if (matches.length !== 1) return null;
  return {
    externalRef: matches[0].applicationNumber.trim(),
    portalProgram: matches[0].programName.replace(/\s+/g, " ").trim(),
  };
}

/**
 * Resolve the live portal label without relying on the CRM catalogue id.
 *
 * Portal mappings are stored as { portal label -> CRM programme name }. A
 * university-specific mapping wins over the general tier. More than one label
 * mapped to the same CRM programme is ambiguous and must never be guessed.
 */
export function resolveSalesforceProgramTarget(
  crmProgramName: string,
  universityMap?: Record<string, string>,
  generalMap?: Record<string, string>,
): SalesforceProgramTarget {
  const requested = fold(crmProgramName);
  const mappedLabels = (mapping?: Record<string, string>): string[] => {
    if (!requested || !mapping) return [];
    return [
      ...new Set(
        Object.entries(mapping)
          .filter(([, crmName]) => fold(crmName) === requested)
          .map(([portalLabel]) => portalLabel.replace(/\s+/g, " ").trim())
          .filter(Boolean),
      ),
    ];
  };

  const universityLabels = mappedLabels(universityMap);
  if (universityLabels.length > 0) {
    return {
      label: universityLabels.length === 1 ? universityLabels[0] : "",
      source: "university",
      ambiguous: universityLabels.length !== 1,
    };
  }

  const generalLabels = mappedLabels(generalMap);
  if (generalLabels.length > 0) {
    return {
      label: generalLabels.length === 1 ? generalLabels[0] : "",
      source: "general",
      ambiguous: generalLabels.length !== 1,
    };
  }

  return {
    label: salesforcePortalProgramName(crmProgramName),
    source: "normalized",
    ambiguous: false,
  };
}

export interface SalesforceApplicantReadback {
  firstName: string;
  lastName: string;
  passportNumber: string;
  email: string;
  invalidFields?: string[];
}

export type SalesforceDuplicateDisposition =
  | "continue"
  | "resume"
  | "already_exists"
  | "blocked";

/**
 * A duplicate toast is applicant-level evidence, not proof that an
 * application was submitted. It can be ignored when the wizard demonstrably
 * advanced, or resumed when an owned incomplete application was found.
 */
export function salesforceDuplicateDisposition(input: {
  activeStage: SalesforceStage;
  ownedApplicant: boolean;
  completionProved: boolean;
}): SalesforceDuplicateDisposition {
  if (input.completionProved) return "already_exists";
  if (input.activeStage) return "continue";
  if (input.ownedApplicant) return "resume";
  return "blocked";
}

/**
 * Fail-closed proof for the Salesforce "create student" screen. The portal's
 * email control is often type=text with a dynamic "<name>'s Email" label, so
 * the adapter verifies the native values instead of trusting selector/fill
 * success alone.
 */
export function salesforceApplicantReadbackFailures(
  expected: SalesforceApplicantReadback,
  actual: SalesforceApplicantReadback,
): string[] {
  const invalid = new Set(actual.invalidFields ?? []);
  const failures: string[] = [];
  const exact = (
    field: keyof Omit<SalesforceApplicantReadback, "invalidFields">,
    caseInsensitive = false,
  ): void => {
    const expectedValue = String(expected[field] ?? "").trim();
    const actualValue = String(actual[field] ?? "").trim();
    const matches = caseInsensitive
      ? actualValue.toLowerCase() === expectedValue.toLowerCase()
      : actualValue === expectedValue;
    if (!expectedValue || !matches || invalid.has(field)) failures.push(field);
  };

  exact("firstName");
  exact("lastName");
  exact("passportNumber");
  exact("email", true);
  return failures;
}

export type SalesforceStage =
  | "Program Selection"
  | "Personal Information"
  | "Educational Information"
  | "Documents"
  | "Review and Submit"
  | "Completed"
  | null;

export function parseSalesforceStageMarker(
  value: string | null | undefined,
): SalesforceStage {
  return normalizeSalesforceStage(
    String(value ?? "").replace(/^\s*stage\s*:\s*/i, ""),
  );
}

export type SalesforceDocumentSlot =
  | "diploma"
  | "transcript"
  | "passport"
  | "photo"
  | "english"
  | null;

export function inferSalesforceDocumentSlot(
  metadata: string | null | undefined,
): SalesforceDocumentSlot {
  const value = fold(metadata ?? "");
  if (!value) return null;
  if (/\b(passport|pasaport)\b/.test(value)) return "passport";
  if (/\b(transcript|marks sheet|not dokumu|transkript)\b/.test(value)) {
    return "transcript";
  }
  if (
    /\b(diploma|diploma certificate|graduation certificate|mezuniyet belgesi)\b/.test(
      value,
    )
  ) {
    return "diploma";
  }
  if (/\b(photo|photograph|fotograf)\b/.test(value)) return "photo";
  if (/\b(english|toefl|ielts|language proficiency)\b/.test(value)) {
    return "english";
  }
  return null;
}

export interface SalesforceUploadEvidence {
  localPath: string;
  inputValue: string;
  containerText: string;
  ariaInvalid?: string | null;
}

function uploadBaseName(value: string): string {
  return value.split(/[\\/]/).pop()?.trim().toLowerCase() ?? "";
}

/**
 * A native file input value only proves that Playwright selected a local file;
 * it does not prove that the Salesforce component accepted the upload. Require
 * the exact selected basename plus portal-visible filename/success evidence.
 */
export function hasSalesforceUploadProof(
  evidence: SalesforceUploadEvidence,
): boolean {
  if (evidence.ariaInvalid === "true") return false;
  const expected = uploadBaseName(evidence.localPath);
  const selected = uploadBaseName(evidence.inputValue);
  if (!expected || selected !== expected) return false;

  const container = evidence.containerText.replace(/\s+/g, " ").toLowerCase();
  return (
    container.includes(expected) ||
    /\b(uploaded|upload complete|successfully uploaded|upload successful)\b/i.test(
      container,
    )
  );
}

export function normalizeSalesforceStage(
  value: string | null | undefined,
): SalesforceStage {
  const normalized = fold(value ?? "");
  if (!normalized) return null;
  if (normalized === "program selection") return "Program Selection";
  if (normalized === "personal information") return "Personal Information";
  if (normalized === "educational information") {
    return "Educational Information";
  }
  if (normalized === "documents") return "Documents";
  if (normalized === "review and submit") return "Review and Submit";
  if (normalized === "completed") return "Completed";
  return null;
}

export interface SalesforceCompletionEvidence {
  activeStage?: string | null;
  applicationStatus?: string | null;
  trackStage?: string | null;
  externalRef?: string | null;
}

/**
 * A future step label in the wizard is never success. Success is either the
 * active Completed step, or a durable Track Applications row with an external
 * reference and an explicit submitted/completed status.
 */
export function hasSalesforceCompletionProof(
  evidence: SalesforceCompletionEvidence,
): boolean {
  if (normalizeSalesforceStage(evidence.activeStage) === "Completed") {
    return true;
  }

  const externalRef = (evidence.externalRef ?? "").trim();
  if (!externalRef) return false;

  const durableState = fold(
    `${evidence.applicationStatus ?? ""} ${evidence.trackStage ?? ""}`,
  );
  return /\b(submitted|completed|received)\b/.test(durableState);
}

export function isOwnedSalesforceApplicant(input: {
  firstName: string;
  lastName: string;
  email: string;
  rowName: string;
  rowEmail: string;
}): boolean {
  const expectedNames = new Set([
    fold(`${input.firstName} ${input.lastName}`),
    fold(`${input.lastName} ${input.firstName}`),
  ]);
  const rowName = fold(input.rowName);
  const rowEmail = input.rowEmail.trim().toLowerCase();
  const email = input.email.trim().toLowerCase();
  return (
    [...expectedNames].some(
      (name) => rowName === name || rowName.includes(name),
    ) &&
    (rowEmail === email ||
      rowEmail === `mailto:${email}` ||
      rowEmail.includes(email))
  );
}

export interface SalesforceBinaryCandidate {
  index: number;
  value?: string | null;
  dataValue?: string | null;
  ariaLabel?: string | null;
  label?: string | null;
  text?: string | null;
}

/**
 * Salesforce/LWC radio controls are not consistent across builds: some expose
 * value=Yes/No, some only data-value, and some keep the answer solely in an
 * associated label while the native input lives in shadow-style markup.
 * Resolve from control-local metadata and refuse ambiguous matches.
 */
export function chooseSalesforceBinaryCandidate(
  candidates: SalesforceBinaryCandidate[],
  answer: "Yes" | "No",
): number | null {
  const wanted = answer === "Yes"
    ? new Set(["yes", "evet", "true", "1"])
    : new Set(["no", "hayir", "false", "0"]);
  const matches = candidates.filter((candidate) => {
    const values = [
      candidate.value,
      candidate.dataValue,
      candidate.ariaLabel,
      candidate.label,
      candidate.text,
    ]
      .map((value) => fold(value ?? ""))
      .filter(Boolean);
    return values.some((value) => wanted.has(value));
  });
  return matches.length === 1 ? matches[0].index : null;
}
