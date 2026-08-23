import type { PortalProgramOption } from "../../types.js";
import { fold, matchProgram } from "../../programMatch.js";

export interface AltinbasProgramSelection {
  record: Record<string, unknown> | null;
  option: PortalProgramOption | null;
  candidates: PortalProgramOption[];
  confidence: number | null;
}

const PROGRAM_NAME_KEYS = [
  "eduhub__Program_Name__c",
  "Name",
  "label",
  "MasterLabel",
] as const;

/**
 * Program Availability rows use an internal `Name` such as `PE-01904`.
 * The human-readable programme is carried by `eduhub__Program_Name__c`.
 */
export function altinbasProgramName(
  record: Record<string, unknown>,
  fallback = "",
): string {
  for (const key of PROGRAM_NAME_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

/**
 * Fail-closed in the safe direction: only an explicit true value is proof that
 * the programme is full. Missing/unknown values are not silently promoted to
 * quota-full because older Salesforce payloads may omit the field entirely.
 */
export function isAltinbasQuotaFull(
  record: Record<string, unknown>,
): boolean {
  const value = record["eduhub__Quota_Full__c"];
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return /^(true|1|yes)$/i.test(value.trim());
}

function isAvailabilityRecord(
  id: string,
  record: Record<string, unknown>,
): boolean {
  return (
    id.startsWith("a0A") ||
    typeof record["eduhub__Program__c"] === "string" ||
    Object.prototype.hasOwnProperty.call(record, "eduhub__Quota_Full__c")
  );
}

/**
 * Older CRM records contain labels such as `Bachelor of Software Engineering
 * (English)`, while the current degree-scoped Salesforce availability option
 * is simply `Software Engineering`. This intentionally narrow key is used
 * only for those legacy degree-prefixed CRM labels. It removes the redundant
 * degree and English-medium tokens; every other programme still uses the
 * normal matcher.
 */
function legacyDegreeScopedProgramKey(value: string): string | null {
  const folded = fold(value);
  if (!/^(associate|bachelor|master|doctorate|phd) of\b/.test(folded)) {
    return null;
  }
  return folded
    .replace(/^(associate|bachelor|master|doctorate|phd) of\s+/, "")
    .replace(/\b(?:in )?english\b/g, "")
    .replace(/\s+/g, " ")
    .trim() || null;
}

/**
 * Union of the Bachelor options observed live for Fall 2026-2027 across
 * independent applicants. Salesforce removes a programme from one
 * applicant's availability list after that applicant has already applied,
 * while the same programme remains visible for another applicant. Therefore
 * a requested programme in this catalog but absent from the verified
 * applicant-scoped availability is dedup evidence, not a renamed/removed
 * programme eligible for fallback.
 */
const ALTINBAS_FALL_2026_BACHELOR_CATALOG = [
  "Business Administration (in English)",
  "Economics (in English)",
  "Gastronomy",
  "International Logistics Management (in English)",
  "International Relations (in English)",
  "International Trade (in English)",
  "Jewelry Design",
  "Law",
  "Radio, Television and Cinema",
  "Sociology",
  "Computer Engineering (in English)",
  "Dentistry",
  "Electrical and Electronics Engineering (in English)",
  "Health Management",
  "Industrial Engineering (in English)",
  "Interior Architecture and Environmental Design",
  "Interior Architecture and Environmental Design (in English)",
  "Management Information Systems",
  "Mechanical Engineering (in English)",
  "Pharmacy (in English)",
  "Psychology (in English)",
  "Public Relations and Advertising",
  "Turkish – German Law (Altinbas University & University of Cologne)",
  "Marketing",
  "Political Science and Public Administration",
  "Architecture",
  "Civil Engineering",
  "Software Engineering",
  "Medicine",
] as const;

const ALTINBAS_FALL_2026_BACHELOR_KEYS = new Set(
  ALTINBAS_FALL_2026_BACHELOR_CATALOG
    .map((name) => legacyDegreeScopedProgramKey(`Bachelor of ${name}`))
    .filter((key): key is string => Boolean(key)),
);

export function isAltinbasKnownLiveBachelorProgram(
  requestedName: string,
): boolean {
  if (!/^bachelor of\b/.test(fold(requestedName))) return false;
  const key = legacyDegreeScopedProgramKey(requestedName);
  return Boolean(key && ALTINBAS_FALL_2026_BACHELOR_KEYS.has(key));
}

/**
 * Select the requested programme from the current Term+Degree availability
 * records. Availability rows take precedence over base Program (`a0B`) rows
 * because only the former carry the live quota flag.
 */
export function selectAltinbasProgram(
  records: ReadonlyArray<readonly [string, Record<string, unknown>]>,
  requestedName: string,
): AltinbasProgramSelection {
  const availability = records.filter(([id, record]) =>
    isAvailabilityRecord(id, record),
  );
  const basePrograms = records.filter(([id]) => id.startsWith("a0B"));
  const source = availability.length > 0 ? availability : basePrograms;

  const byId = new Map(source);
  const candidates: PortalProgramOption[] = source.map(([id, record]) => ({
    value: id,
    name: altinbasProgramName(record, id),
    enabled: !isAltinbasQuotaFull(record),
  }));

  const legacyKey = legacyDegreeScopedProgramKey(requestedName);
  if (legacyKey) {
    const legacyMatches = candidates.filter(
      (candidate) =>
        legacyDegreeScopedProgramKey(`Bachelor of ${candidate.name}`) ===
        legacyKey,
    );
    if (legacyMatches.length === 1) {
      const option = legacyMatches[0];
      return {
        record: byId.get(option.value) ?? null,
        option,
        candidates,
        confidence: 1,
      };
    }
    // The current portal must have one unambiguous degree-scoped option. Do
    // not let a fuzzy match choose between renamed/duplicated programmes.
    if (legacyMatches.length > 1) {
      return {
        record: null,
        option: null,
        candidates,
        confidence: null,
      };
    }
  }

  const matched = matchProgram(
    requestedName,
    candidates.map((candidate) => ({
      id: candidate.value,
      name: candidate.name,
    })),
  );
  if (!matched) {
    return {
      record: null,
      option: null,
      candidates,
      confidence: null,
    };
  }

  const option =
    candidates.find((candidate) => candidate.value === matched.match.id) ??
    null;
  const record = byId.get(matched.match.id) ?? null;
  if (!option || !record) {
    return {
      record: null,
      option: null,
      candidates,
      confidence: null,
    };
  }

  return {
    record,
    option,
    candidates,
    confidence: matched.conf,
  };
}
