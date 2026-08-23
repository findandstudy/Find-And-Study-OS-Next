import {
  requiredEducationLevels,
  type EducationLevel,
} from "@workspace/db";
import type { CleanStudentEducationRecord } from "./studentEducationInput";

export interface LegacyStudentAcademicFields {
  highSchool?: unknown;
  universityBachelor?: unknown;
  universityMaster?: unknown;
  graduationYear?: unknown;
  gpa?: unknown;
  languageScore?: unknown;
}

export interface HydratableEducationRecord {
  level: string;
  institution?: string | null;
  program?: string | null;
  country?: string | null;
  graduationYear?: number | null;
  gpa?: string | null;
  gpaRaw?: string | null;
  gpaScale?: number | null;
  languageScore?: string | null;
  sortOrder?: number;
  [key: string]: unknown;
}

function text(value: unknown, max = 300): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim().slice(0, max);
  return trimmed || null;
}

function year(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const match = String(value).match(/\b(19|20|21)\d{2}\b/);
  return match ? Number(match[0]) : null;
}

function gpaParts(value: unknown): {
  gpa: string | null;
  gpaRaw: string | null;
  gpaScale: number | null;
} {
  const raw = text(value, 50);
  if (!raw) return { gpa: null, gpaRaw: null, gpaScale: null };
  const ratio = raw.match(
    /^\s*(-?\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)\s*$/,
  );
  if (!ratio) return { gpa: raw, gpaRaw: raw, gpaScale: null };
  const numerator = ratio[1].replace(",", ".");
  const scale = Number(ratio[2].replace(",", "."));
  return {
    gpa: numerator,
    gpaRaw: raw,
    gpaScale: Number.isInteger(scale) && scale > 0 ? scale : null,
  };
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function recordHasData(record: HydratableEducationRecord | undefined): boolean {
  return Boolean(
    record &&
    [
      record.institution,
      record.program,
      record.graduationYear,
      record.gpa,
      record.gpaRaw,
      record.languageScore,
    ].some(hasValue),
  );
}

function looksLikeTertiaryInstitution(value: unknown): boolean {
  const normalized = String(value || "")
    .toLocaleLowerCase("en-US")
    .replace(/[._-]+/g, " ");
  return [
    "university",
    "universitesi",
    "universität",
    "universite",
    "universidad",
    "université",
    "polytechnic",
    "higher education",
  ].some((token) => normalized.includes(token));
}

function legacyInstitutionFor(
  level: EducationLevel,
  legacy: LegacyStudentAcademicFields,
): string | null {
  if (level === "master") return text(legacy.universityMaster);
  if (level === "bachelor") return text(legacy.universityBachelor);
  return text(legacy.highSchool);
}

function compatibleSourceForLevel<T extends HydratableEducationRecord>(
  level: EducationLevel,
  records: T[],
): T | undefined {
  const exact = records.find(
    (record) => record.level === level && recordHasData(record),
  );
  if (exact) return exact;

  // Some historic Inbox records stored a university degree as high_school
  // before the application level was known. Reclassify only when the
  // institution itself provides strong tertiary evidence; never clone an
  // ordinary school into a Bachelor/Master record.
  if (level === "bachelor") {
    return records.find(
      (record) =>
        record.level === "high_school" &&
        looksLikeTertiaryInstitution(record.institution),
    );
  }
  return undefined;
}

/**
 * Bridges the historic flat student columns and the level-based academic
 * records. It never overwrites a populated structured cell; it only fills
 * gaps and synthesizes the level required by the student's current
 * application when older data was classified under a former level.
 */
export function hydrateStudentEducationRecords<T extends HydratableEducationRecord>(
  levelKey: string,
  legacy: LegacyStudentAcademicFields,
  records: T[],
): Array<T | HydratableEducationRecord> {
  const required = requiredEducationLevels(levelKey);
  const byLevel = new Map(records.map((record) => [record.level, record]));
  const legacyGpa = gpaParts(legacy.gpa);
  const output: Array<T | HydratableEducationRecord> = [...records];

  for (let index = 0; index < required.length; index++) {
    const level = required[index];
    const current = byLevel.get(level);
    const source = current || compatibleSourceForLevel(level, records);
    const useLegacyAcademicDetails =
      required.length === 1 || level === required[required.length - 1];
    const hydrated: HydratableEducationRecord = {
      ...(current || {}),
      level,
      institution:
        text(current?.institution) ||
        legacyInstitutionFor(level, legacy) ||
        text(source?.institution),
      program:
        level === "high_school"
          ? null
          : text(current?.program) || text(source?.program),
      country: text(current?.country, 100) || text(source?.country, 100),
      graduationYear:
        current?.graduationYear ??
        (useLegacyAcademicDetails ? year(legacy.graduationYear) : null) ??
        source?.graduationYear ??
        null,
      gpa:
        text(current?.gpa, 20) ||
        (useLegacyAcademicDetails ? legacyGpa.gpa : null) ||
        text(source?.gpa, 20),
      gpaRaw:
        text(current?.gpaRaw, 50) ||
        (useLegacyAcademicDetails ? legacyGpa.gpaRaw : null) ||
        text(source?.gpaRaw, 50),
      gpaScale:
        current?.gpaScale ??
        (useLegacyAcademicDetails ? legacyGpa.gpaScale : null) ??
        source?.gpaScale ??
        null,
      languageScore:
        text(current?.languageScore, 50) ||
        (useLegacyAcademicDetails
          ? text(legacy.languageScore, 50)
          : null) ||
        text(source?.languageScore, 50),
      sortOrder: current?.sortOrder ?? index,
    };

    if (current) {
      const outputIndex = output.indexOf(current);
      output[outputIndex] = hydrated as T;
    } else if (text(hydrated.institution) && recordHasData(hydrated)) {
      output.push(hydrated);
    }
  }

  return output;
}

export function buildStudentEducationRecordsFromLegacy(
  levelKey: string,
  legacy: LegacyStudentAcademicFields,
  existing: CleanStudentEducationRecord[] = [],
): CleanStudentEducationRecord[] {
  return hydrateStudentEducationRecords(levelKey, legacy, existing)
    .filter(recordHasData)
    .map((record, index) => ({
      level: record.level as CleanStudentEducationRecord["level"],
      institution: text(record.institution),
      program: record.level === "high_school" ? null : text(record.program),
      country: text(record.country, 100),
      graduationYear: year(record.graduationYear),
      gpa: text(record.gpa, 20),
      gpaRaw: text(record.gpaRaw, 50),
      gpaScale:
        typeof record.gpaScale === "number" && record.gpaScale > 0
          ? record.gpaScale
          : null,
      languageScore: text(record.languageScore, 50),
      sortOrder: index,
    }));
}
