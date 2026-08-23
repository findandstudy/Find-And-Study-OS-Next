/**
 * portalFieldSpec — pure, dependency-free portal compatibility matrix:
 * per-portal required fields, formats, and value rules.
 *
 * SIT (Study in Turkey / Zoho) is fully specified from production evidence.
 * Altınbaş Personal + required Documents are specified from the live SLDS
 * wizard; later-stage rules remain fail-closed in its adapter until each live
 * control contract has been proven.
 *
 * Imported by both backend and frontend via @workspace/db.
 */

import type { EducationLevel } from "../academicLevels";

export type PortalKey =
  | "sit"
  | "united"
  | "multico"
  | "topkapi"
  | "altinbas"
  | "emu"
  | "okan"
  | (string & {});

export type FieldRuleType =
  | "integer"
  | "text"
  | "date"
  | "enum"
  | "country"
  | "city"
  | "email"
  | "phone"
  | "document";

export interface FieldRule {
  key: string;
  required: boolean;
  type: FieldRuleType;
  min?: number;
  max?: number;
  /** allowed values for enum rules */
  values?: readonly string[];
  note?: string;
}

const SIT_PERSONAL: FieldRule[] = [
  { key: "dob", required: true, type: "date" },
  { key: "gender", required: true, type: "enum", values: ["male", "female"] },
  { key: "nationality", required: true, type: "country" },
  { key: "passportNo", required: true, type: "text" },
  { key: "passportIssueDate", required: true, type: "date" },
  { key: "passportExpiryDate", required: true, type: "date", note: "must be in the future" },
  { key: "email", required: true, type: "email" },
  { key: "mobile", required: true, type: "phone" },
];

const SIT_RESIDENCE: FieldRule[] = [
  { key: "countryOfResidence", required: true, type: "country", note: "must match SIT dropdown (canonical country name)" },
  { key: "city", required: true, type: "city", note: "real city name, never an address fragment" },
];

const SIT_FAMILY: FieldRule[] = [
  { key: "fatherName", required: true, type: "text" },
  { key: "fatherJob", required: true, type: "text" },
  { key: "motherName", required: true, type: "text" },
  { key: "motherJob", required: true, type: "text" },
];

const SIT_TOGGLES: FieldRule[] = [
  { key: "transferStudent", required: true, type: "enum", values: ["yes", "no"] },
  { key: "hasTcId", required: true, type: "enum", values: ["yes", "no"] },
  { key: "hasBlueCard", required: true, type: "enum", values: ["yes", "no"] },
];

const SIT_DOCUMENTS: FieldRule[] = [
  { key: "photo", required: true, type: "document" },
  { key: "passport", required: true, type: "document" },
  { key: "transcript", required: true, type: "document" },
  { key: "diploma", required: true, type: "document" },
];

const SIT_LANGUAGE: FieldRule[] = [
  { key: "languageScore", required: false, type: "text", note: 'free text, e.g. "IELTS 7.0"' },
];

const ALTINBAS_PERSONAL: FieldRule[] = [
  { key: "dob", required: true, type: "date" },
  { key: "gender", required: true, type: "enum", values: ["male", "female"] },
  { key: "nationality", required: true, type: "country" },
  { key: "passportNo", required: true, type: "text" },
  { key: "passportIssueDate", required: true, type: "date" },
  { key: "passportExpiryDate", required: true, type: "date", note: "must be in the future" },
  { key: "email", required: true, type: "email" },
  { key: "address", required: true, type: "text", note: "explicit street/address line" },
  { key: "addressCity", required: true, type: "city", note: "dedicated CRM city" },
  { key: "postalCode", required: true, type: "text", note: "dedicated CRM postal code" },
  { key: "needsVisaSupport", required: true, type: "enum", values: ["yes", "no"] },
];

const ALTINBAS_DOCUMENTS: FieldRule[] = [
  { key: "photo", required: true, type: "document" },
  { key: "passport", required: true, type: "document" },
  { key: "transcript", required: true, type: "document" },
  { key: "diploma", required: true, type: "document" },
];

const GPA_NOTE = "integer 0–100 (SIT/Zoho rejects decimals)";

function altinbasAcademic(level: EducationLevel): FieldRule[] {
  const record = (prefix: "hs" | "bachelor" | "master"): FieldRule[] => [
    { key: `${prefix}Country`, required: true, type: "country" },
    {
      key: prefix === "hs" ? "hsName" : `${prefix}School`,
      required: true,
      type: "text",
    },
    { key: `${prefix}EndYear`, required: true, type: "integer", min: 1950, max: 2100 },
    { key: `${prefix}Gpa`, required: true, type: "text" },
    {
      key: `${prefix}GpaType`,
      required: true,
      type: "enum",
      values: [
        "4", "4.0", "5", "10", "12", "20", "100", "percentage",
        "grading system out of 4", "grading system out of 5",
        "grading system out of 10", "grading system out of 12",
        "grading system out of 20", "grading system out of 100",
      ],
    },
  ];
  if (level === "high_school") return record("hs");
  if (level === "bachelor") return record("bachelor");
  return [...record("bachelor"), ...record("master")];
}

function sitAcademic(level: EducationLevel): FieldRule[] {
  const hs: FieldRule[] = [
    { key: "hsCountry", required: true, type: "country" },
    { key: "hsName", required: true, type: "text" },
    { key: "hsGpa", required: true, type: "integer", min: 0, max: 100, note: GPA_NOTE },
  ];
  const bachelor: FieldRule[] = [
    { key: "bachelorCountry", required: true, type: "country" },
    { key: "bachelorSchool", required: true, type: "text" },
    { key: "bachelorGpa", required: true, type: "integer", min: 0, max: 100, note: GPA_NOTE },
  ];
  const master: FieldRule[] = [
    { key: "masterCountry", required: true, type: "country" },
    { key: "masterSchool", required: true, type: "text" },
    { key: "masterGpa", required: true, type: "integer", min: 0, max: 100, note: GPA_NOTE },
  ];
  // level = the applicant's TARGET study level:
  // high_school-based applicant (bachelor target group A) → prior = high school
  if (level === "high_school") return hs;
  if (level === "bachelor") return bachelor;
  return [...bachelor, ...master];
}

/**
 * Return the required-field matrix for a portal and the applicant's prior
 * education level requirement ("high_school" = bachelor applicant,
 * "bachelor" = master applicant, "master" = PhD applicant needs bachelor+master).
 *
 * Other portals currently return [] (skeleton — TODO extend per portal using
 * SIT as the reference schema).
 */
export function portalRequirements(portalKey: PortalKey, level: EducationLevel): FieldRule[] {
  if (portalKey === "sit") {
    return [
      ...SIT_PERSONAL,
      ...SIT_RESIDENCE,
      ...SIT_FAMILY,
      ...sitAcademic(level),
      ...SIT_LANGUAGE,
      ...SIT_TOGGLES,
      ...SIT_DOCUMENTS,
    ];
  }
  if (portalKey === "altinbas") {
    return [
      ...ALTINBAS_PERSONAL,
      ...altinbasAcademic(level),
      ...ALTINBAS_DOCUMENTS,
    ];
  }
  // TODO: united / multico / topkapi / emu / okan — fill with the
  // same schema once their portal rules are consolidated (SIT is reference).
  return [];
}
