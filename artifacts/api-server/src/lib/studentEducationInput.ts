export const STUDENT_EDUCATION_LEVELS = [
  "high_school",
  "bachelor",
  "master",
] as const;

export type CleanStudentEducationRecord = {
  level: (typeof STUDENT_EDUCATION_LEVELS)[number];
  institution: string | null;
  program: string | null;
  country: string | null;
  graduationYear: number | null;
  gpa: string | null;
  gpaRaw: string | null;
  gpaScale: number | null;
  languageScore: string | null;
  sortOrder: number;
};

type CleanResult =
  | { ok: true; records: CleanStudentEducationRecord[] }
  | { ok: false; error: string };

function stringOrNull(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim().slice(0, max);
  return cleaned || null;
}

function integerOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function validGpa(value: string | null, scale: number | null): boolean {
  if (!value) return true;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) return false;
  return scale === null || parsed <= scale;
}

export function cleanStudentEducationRecords(input: unknown): CleanResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: "educationRecords must be an array" };
  }
  if (input.length > STUDENT_EDUCATION_LEVELS.length) {
    return { ok: false, error: "educationRecords supports at most 3 records" };
  }

  const seen = new Set<string>();
  const records: CleanStudentEducationRecord[] = [];
  for (let index = 0; index < input.length; index++) {
    const raw = input[index] && typeof input[index] === "object"
      ? input[index] as Record<string, unknown>
      : {};
    const level = String(raw.level || "");
    if (!(STUDENT_EDUCATION_LEVELS as readonly string[]).includes(level)) {
      return {
        ok: false,
        error: `educationRecords[${index}].level must be one of: ${STUDENT_EDUCATION_LEVELS.join(", ")}`,
      };
    }
    if (seen.has(level)) {
      return {
        ok: false,
        error: `Duplicate education level "${level}" is not allowed`,
      };
    }
    seen.add(level);

    if (raw.graduationYear !== undefined && raw.graduationYear !== null && raw.graduationYear !== "" && !/^\d+$/.test(String(raw.graduationYear).trim())) {
      return {
        ok: false,
        error: `educationRecords[${index}].graduationYear is invalid`,
      };
    }
    const graduationYear = integerOrNull(raw.graduationYear);
    if (
      graduationYear !== null &&
      (graduationYear < 1900 || graduationYear > new Date().getUTCFullYear() + 1)
    ) {
      return {
        ok: false,
        error: `educationRecords[${index}].graduationYear is invalid`,
      };
    }

    if (raw.gpaScale !== undefined && raw.gpaScale !== null && raw.gpaScale !== "" && !/^\d+$/.test(String(raw.gpaScale).trim())) {
      return {
        ok: false,
        error: `educationRecords[${index}].gpaScale is invalid`,
      };
    }
    const gpaScale = integerOrNull(raw.gpaScale);
    if (gpaScale !== null && (gpaScale <= 0 || gpaScale > 100)) {
      return {
        ok: false,
        error: `educationRecords[${index}].gpaScale is invalid`,
      };
    }

    const gpa = stringOrNull(raw.gpa, 20);
    if (!validGpa(gpa, gpaScale)) {
      return {
        ok: false,
        error: `educationRecords[${index}].gpa is invalid or exceeds its scale`,
      };
    }

    records.push({
      level: level as CleanStudentEducationRecord["level"],
      institution: stringOrNull(raw.institution, 300),
      program: level === "high_school" ? null : stringOrNull(raw.program, 300),
      country: stringOrNull(raw.country, 100),
      graduationYear,
      gpa,
      gpaRaw: stringOrNull(raw.gpaRaw, 50),
      gpaScale,
      languageScore: stringOrNull(raw.languageScore, 50),
      sortOrder: index,
    });
  }
  return { ok: true, records };
}

export function toLegacyEducationRecord(
  studentId: number,
  record: CleanStudentEducationRecord,
) {
  return {
    studentId,
    level: record.level,
    schoolName: record.institution,
    country: record.country,
    fieldOfStudy: record.program,
    endYear: record.graduationYear,
    languageScore: record.languageScore,
    gpa: record.gpa,
    gpaType:
      record.gpaScale === 100
        ? "percentage"
        : record.gpaScale
          ? `${record.gpaScale}.0`
          : null,
    source: "manual" as const,
  };
}
