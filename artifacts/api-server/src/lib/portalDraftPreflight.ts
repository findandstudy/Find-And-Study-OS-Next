import {
  evaluatePortalPreflight,
  type PortalPreflightResult,
} from "@workspace/portal-adapters";
import {
  buildDraftApplicationPreflightSnapshot,
  type DraftApplicationPreflightInput,
} from "@workspace/portal-runner";
import { runEducationExtraction } from "./educationAutoExtract.js";
import { autoFillMissingAddressCity } from "./portalAddressAutoExtract.js";
import { autoFillMissingProfileFromPassport } from "./portalProfileAutoExtract.js";
import { logAudit } from "./auth.js";
import {
  resolvePortalRouting,
  resolveStudentPortalRouting,
} from "./portalAutoTrigger.js";

export interface PreparedPortalDraftPreflight extends PortalPreflightResult {
  studentId: number;
  autoFilledFields: string[];
  enrichmentWarnings: string[];
}

export interface RoutedPortalDraftPreflight {
  universityKey: string;
  adapterKey: string;
  preflight: PreparedPortalDraftPreflight;
}

const ACADEMIC_FIELDS = new Set(["schoolName", "gpa", "graduationYear"]);
const FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  passportNumber: "Passport number",
  email: "Email",
  dateOfBirth: "Date of birth",
  gender: "Gender",
  nationality: "Nationality",
  phone: "Phone",
  level: "Study level",
  programName: "Program",
  universityName: "University",
  fatherName: "Father's name",
  motherName: "Mother's name",
  address: "Address",
  addressCity: "Residence city",
  schoolName: "School name",
  gpa: "GPA",
  graduationYear: "Graduation year",
  passportIssueDate: "Passport issue date",
  passportExpiryDate: "Passport expiry date",
};
const DOCUMENT_LABELS: Record<string, string> = {
  photo: "Photograph",
  passport: "Passport",
  diploma: "Diploma",
  transcript: "Transcript",
};

export interface PortalDraftPreflightErrorBody {
  error: string;
  code: "PORTAL_PREFLIGHT_NOT_READY";
  universityKey: string;
  adapterKey: string;
  missingFields: string[];
  incompatibleFields: PortalPreflightResult["incompatibleFields"];
  missingDocuments: string[];
  missingFieldLabels: string[];
  incompatibleFieldLabels: string[];
  missingDocumentLabels: string[];
  preflight: PreparedPortalDraftPreflight;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * One response contract for every application-creation UI. Keep machine keys
 * for remediation while also returning labels that staff can act on without
 * knowing adapter field names.
 */
export function buildPortalDraftPreflightError(
  routed: RoutedPortalDraftPreflight,
): PortalDraftPreflightErrorBody {
  const missingFieldLabels = unique(
    routed.preflight.missingFields.map((field) => FIELD_LABELS[field] ?? field),
  );
  const incompatibleFieldLabels = unique(
    routed.preflight.incompatibleFields.map(
      (issue) => FIELD_LABELS[issue.field] ?? issue.field,
    ),
  );
  const missingDocumentLabels = unique(
    routed.preflight.missingDocuments.map(
      (document) => DOCUMENT_LABELS[document] ?? document,
    ),
  );
  const unresolved = [
    ...missingFieldLabels,
    ...incompatibleFieldLabels.map((label) => `${label} (invalid)`),
    ...missingDocumentLabels,
  ];
  return {
    error: unresolved.length > 0
      ? `Complete these items before portal submission: ${unresolved.join(", ")}.`
      : "Application is not ready for the destination portal.",
    code: "PORTAL_PREFLIGHT_NOT_READY",
    universityKey: routed.universityKey,
    adapterKey: routed.adapterKey,
    missingFields: routed.preflight.missingFields,
    incompatibleFields: routed.preflight.incompatibleFields,
    missingDocuments: routed.preflight.missingDocuments,
    missingFieldLabels,
    incompatibleFieldLabels,
    missingDocumentLabels,
    preflight: routed.preflight,
  };
}

export async function preparePortalDraftPreflight(opts: {
  adapterKey: string;
  draft: DraftApplicationPreflightInput;
  actorUserId: number | null;
  ip?: string;
  autoEnrich?: boolean;
}): Promise<PreparedPortalDraftPreflight> {
  const load = () => buildDraftApplicationPreflightSnapshot(
    opts.draft,
    { adapterKey: opts.adapterKey },
  );
  let snapshot = await load();
  let result = evaluatePortalPreflight({
    adapterKey: opts.adapterKey,
    profile: snapshot.profile,
    documentTypes: snapshot.documentTypes,
  });
  const autoFilledFields: string[] = [];
  const enrichmentWarnings: string[] = [];

  if (opts.autoEnrich !== false && result.supported && !result.ready) {
    const identity = await autoFillMissingProfileFromPassport({
      studentId: opts.draft.studentId,
      actorUserId: opts.actorUserId,
      ip: opts.ip,
      requiredFields: result.missingFields,
    });
    autoFilledFields.push(...identity.fields);
    if (identity.status === "low_confidence" || identity.status === "ai_unavailable") {
      enrichmentWarnings.push(`identity:${identity.status}`);
    }

    if (result.missingFields.includes("addressCity")) {
      const addressCity = await autoFillMissingAddressCity({
        studentId: opts.draft.studentId,
        actorUserId: opts.actorUserId,
        ip: opts.ip,
        requiredFields: result.missingFields,
      });
      autoFilledFields.push(...addressCity.fields);
      if (
        addressCity.status === "low_confidence" ||
        addressCity.status === "unreadable" ||
        addressCity.status === "ai_unavailable"
      ) {
        enrichmentWarnings.push(`addressCity:${addressCity.status}`);
      }
    }

    if (result.missingFields.some((field) => ACADEMIC_FIELDS.has(field))) {
      const education = await runEducationExtraction({
        studentId: opts.draft.studentId,
        actorUserId: opts.actorUserId,
        ip: opts.ip,
        skipIfFilled: false,
        mergeMissingOnly: true,
        auditAction: "portal_draft_auto_fill_education",
      });
      if (education.status === "ok") {
        if (education.upserted > 0) autoFilledFields.push("educationRecords");
        enrichmentWarnings.push(...education.warnings);
      } else if (
        education.status === "ai_failed" ||
        education.status === "ai_unavailable"
      ) {
        enrichmentWarnings.push(`education:${education.status}`);
      }
    }

    snapshot = await load();
    result = evaluatePortalPreflight({
      adapterKey: opts.adapterKey,
      profile: snapshot.profile,
      documentTypes: snapshot.documentTypes,
    });
  }

  const prepared: PreparedPortalDraftPreflight = {
    ...result,
    studentId: opts.draft.studentId,
    autoFilledFields: [...new Set(autoFilledFields)],
    enrichmentWarnings: [...new Set(enrichmentWarnings)],
  };
  await logAudit(
    opts.actorUserId,
    "portal_draft_preflight",
    "student",
    opts.draft.studentId,
    {
      adapterKey: opts.adapterKey,
      ready: prepared.ready,
      missingFields: prepared.missingFields,
      incompatibleFields: prepared.incompatibleFields,
      missingDocuments: prepared.missingDocuments,
      autoFilledFields: prepared.autoFilledFields,
      enrichmentWarnings: prepared.enrichmentWarnings,
    },
    opts.ip,
  );
  return prepared;
}

/**
 * Resolves standalone/aggregator/exclusive-nationality routing first, then
 * evaluates the destination adapter's real requirements. Non-portal
 * universities return null and keep the normal CRM application flow.
 */
export async function prepareRoutedPortalDraftPreflight(opts: {
  universityId: number | null;
  universityName: string | null;
  draft: DraftApplicationPreflightInput;
  actorUserId: number | null;
  ip?: string;
  autoEnrich?: boolean;
}): Promise<RoutedPortalDraftPreflight | null> {
  const routing = await resolvePortalRouting({
    universityId: opts.universityId,
    universityName: opts.universityName,
  });
  if (!routing) return null;
  const studentRouting = await resolveStudentPortalRouting({
    routing,
    studentId: opts.draft.studentId,
  });
  if (!studentRouting) return null;
  const adapterKey = studentRouting.portalUni.adapterKey;
  const preflight = await preparePortalDraftPreflight({
    adapterKey,
    draft: opts.draft,
    actorUserId: opts.actorUserId,
    ip: opts.ip,
    autoEnrich: opts.autoEnrich,
  });
  return {
    universityKey: studentRouting.portalUni.universityKey,
    adapterKey,
    preflight,
  };
}
