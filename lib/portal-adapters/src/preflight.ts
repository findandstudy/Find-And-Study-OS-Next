import { mapDocType } from "./profile.js";
import { validateIdentityFields } from "./identityValidation.js";
import type { SubmitFiles, SubmitProfile } from "./types.js";

export type PortalPreflightField = keyof SubmitProfile;
export type PortalPreflightDocument = keyof SubmitFiles;

export interface PortalPreflightManifest {
  adapterKey: string;
  profileFields: PortalPreflightField[];
  documents: PortalPreflightDocument[];
}

export interface PortalPreflightIssue {
  field: string;
  reason: "missing" | "invalid" | "verification_unavailable";
}

export interface PortalPreflightResult {
  ready: boolean;
  supported: boolean;
  adapterKey: string;
  missingFields: string[];
  incompatibleFields: PortalPreflightIssue[];
  missingDocuments: PortalPreflightDocument[];
}

const CORE_IDENTITY: PortalPreflightField[] = [
  "firstName",
  "lastName",
  "passportNumber",
  "email",
  "dateOfBirth",
  "gender",
  "nationality",
  "phone",
  "level",
  "programName",
  "universityName",
];

const ACADEMIC: PortalPreflightField[] = [
  "schoolName",
  "gpa",
  "graduationYear",
];

const THREE_CORE_DOCUMENTS: PortalPreflightDocument[] = [
  "passport",
  "diploma",
  "transcript",
];

const FOUR_CORE_DOCUMENTS: PortalPreflightDocument[] = [
  "photo",
  ...THREE_CORE_DOCUMENTS,
];

const salesforceKeys = [
  "uskudar",
  "aydin",
  "bau",
  "atlas",
  "dogus",
  "ozyegin",
  "pirireis",
  "sabanci",
  "yeditepe",
  "beykent",
  "isik",
] as const;

const manifests = new Map<string, PortalPreflightManifest>();

function register(
  adapterKey: string,
  profileFields: PortalPreflightField[],
  documents: PortalPreflightDocument[],
): void {
  manifests.set(adapterKey, {
    adapterKey,
    profileFields: [...new Set(profileFields)],
    documents: [...new Set(documents)],
  });
}

register(
  "united",
  [
    ...CORE_IDENTITY,
    "fatherName",
    "motherName",
    "schoolName",
  ],
  THREE_CORE_DOCUMENTS,
);

register(
  "sit",
  [
    ...CORE_IDENTITY,
    "fatherName",
    "motherName",
    "address",
    "addressCity",
    "schoolName",
    "gpa",
    "passportIssueDate",
    "passportExpiryDate",
  ],
  FOUR_CORE_DOCUMENTS,
);

register(
  "topkapi",
  [...CORE_IDENTITY, ...ACADEMIC],
  FOUR_CORE_DOCUMENTS,
);

register(
  "multico",
  [
    ...CORE_IDENTITY,
    ...ACADEMIC,
    "fatherName",
    "motherName",
    "address",
  ],
  THREE_CORE_DOCUMENTS,
);

register(
  "okan",
  [
    ...CORE_IDENTITY,
    "address",
    "addressCity",
    "cityOfBirth",
    "schoolName",
    "graduationYear",
  ],
  ["passport", "transcript"],
);

register(
  "altinbas",
  [
    ...CORE_IDENTITY,
    "address",
    "addressCity",
    "addressZip",
    "schoolName",
    "gpa",
    "graduationYear",
    "passportIssueDate",
    "passportExpiryDate",
  ],
  FOUR_CORE_DOCUMENTS,
);

register(
  "medipol",
  [
    "email",
    "firstName",
    "lastName",
    "passportNumber",
    "passportIssueDate",
    "passportExpiryDate",
    "phone",
    "gender",
    "nationality",
    "dateOfBirth",
    "fatherName",
    "motherName",
    "level",
    "schoolName",
    "gpa",
    "programName",
  ],
  FOUR_CORE_DOCUMENTS,
);

register(
  "emu",
  [...CORE_IDENTITY, ...ACADEMIC],
  FOUR_CORE_DOCUMENTS,
);

for (const key of salesforceKeys) {
  register(
    key,
    [
      ...CORE_IDENTITY,
      "address",
      "addressCity",
      "schoolName",
      "gpa",
    ],
    THREE_CORE_DOCUMENTS,
  );
}

const PLACEHOLDER_RE =
  /^(?:-|--|n\/?a|none|null|undefined|unknown|not available|not applicable)$/i;

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  const text = String(value).trim();
  return text.length > 0 && !PLACEHOLDER_RE.test(text);
}

function isDocumentPresent(
  slot: PortalPreflightDocument,
  profile: SubmitProfile,
  files: SubmitFiles,
  documentTypes: readonly string[],
): boolean {
  if (isPresent(files[slot])) return true;
  if (slot === "photo" && isPresent(profile.photoUrl)) return true;

  for (const document of profile.studentDocuments ?? []) {
    if (mapDocType(`${document.type} ${document.name ?? ""}`) === slot) {
      return true;
    }
  }
  return documentTypes.some((type) => mapDocType(type) === slot);
}

function validateField(
  field: PortalPreflightField,
  value: unknown,
): PortalPreflightIssue | null {
  if (!isPresent(value)) return { field, reason: "missing" };

  if (field === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim())) {
    return { field, reason: "invalid" };
  }
  if (
    field === "gender" &&
    !/^(?:male|female|m|f|erkek|kad[ıi]n)$/i.test(String(value).trim())
  ) {
    return { field, reason: "invalid" };
  }
  if (
    field === "phone" &&
    String(value).replace(/\D/g, "").length < 7
  ) {
    return { field, reason: "invalid" };
  }
  if (
    (field === "gpa" || field === "graduationYear") &&
    !Number.isFinite(Number(value))
  ) {
    return { field, reason: "invalid" };
  }
  return null;
}

export function portalPreflightManifest(
  adapterKey: string,
): PortalPreflightManifest | null {
  return manifests.get(adapterKey.trim().toLowerCase()) ?? null;
}

/**
 * Pure, browser-free final readiness gate shared by API and worker.
 *
 * An unknown/declarative adapter is reported as unsupported and is not blocked
 * here: its own profilePolicy remains the authoritative fail-closed gate.
 */
export function evaluatePortalPreflight(input: {
  adapterKey: string;
  profile: SubmitProfile;
  files?: SubmitFiles;
  documentTypes?: readonly string[];
}): PortalPreflightResult {
  const adapterKey = input.adapterKey.trim().toLowerCase();
  const manifest = portalPreflightManifest(adapterKey);
  if (!manifest) {
    return {
      ready: true,
      supported: false,
      adapterKey,
      missingFields: [],
      incompatibleFields: [],
      missingDocuments: [],
    };
  }

  const missingFields: string[] = [];
  const incompatibleFields: PortalPreflightIssue[] = [];
  for (const field of manifest.profileFields) {
    const issue = validateField(field, input.profile[field]);
    if (!issue) continue;
    if (issue.reason === "missing") missingFields.push(issue.field);
    else incompatibleFields.push(issue);
  }
  const missingSet = new Set(missingFields);
  const incompatibleSet = new Set(incompatibleFields.map((issue) => issue.field));
  for (const error of validateIdentityFields({
    passportNumber: input.profile.passportNumber,
    firstName: input.profile.firstName,
    lastName: input.profile.lastName,
    dateOfBirth: input.profile.dateOfBirth,
    passportIssueDate: input.profile.passportIssueDate,
    passportExpiryDate: input.profile.passportExpiryDate,
  })) {
    if (
      manifest.profileFields.includes(error.field as PortalPreflightField) &&
      !missingSet.has(error.field) &&
      !incompatibleSet.has(error.field)
    ) {
      incompatibleFields.push({ field: error.field, reason: "invalid" });
      incompatibleSet.add(error.field);
    }
  }

  const files = input.files ?? {};
  const documentTypes = input.documentTypes ?? [];
  const missingDocuments = manifest.documents.filter(
    (slot) => !isDocumentPresent(slot, input.profile, files, documentTypes),
  );

  return {
    ready:
      missingFields.length === 0 &&
      incompatibleFields.length === 0 &&
      missingDocuments.length === 0,
    supported: true,
    adapterKey,
    missingFields,
    incompatibleFields,
    missingDocuments,
  };
}
