export type InboxEducationRecordInput = {
  level: "high_school" | "bachelor" | "master";
  institution: string | null;
  program: string | null;
  country: string | null;
  graduationYear: number | null;
  gpa: string | null;
  gpaRaw: string | null;
  gpaScale: number | null;
  languageScore: string | null;
};

type InboxEducationFormInput = {
  selectedLevel: string;
  school1: string;
  school2: string;
  educationProgram: string;
  educationCountry: string;
  graduationYear: string;
  gpa: string;
  gradingSystem: string;
  languageScore: string;
};

export type InboxEducationPayload = {
  highSchool: string | null;
  universityBachelor: string | null;
  universityMaster: string | null;
  graduationYear: number | null;
  gpa: string | null;
  languageScore: string | null;
  educationRecords: InboxEducationRecordInput[];
};

function clean(value: string): string | null {
  const result = value.trim();
  return result || null;
}

function parseYear(value: string): number | null {
  const year = Number.parseInt(value.trim(), 10);
  return Number.isInteger(year) && year >= 1900 && year <= 2200 ? year : null;
}

function parseScale(value: string): number | null {
  const scale = Number.parseInt(value.trim(), 10);
  return Number.isInteger(scale) && scale > 0 ? scale : null;
}

function applicationGroup(level: string): "high_school" | "master" | "phd" {
  const normalized = level.toLowerCase().replace(/[\s._'-]+/g, "");
  if (normalized.includes("phd") || normalized.includes("doctor")) return "phd";
  if (normalized.includes("master") || normalized.includes("mba")) return "master";
  return "high_school";
}

export function findMissingInboxAcademicFields(
  input: Pick<
    InboxEducationFormInput,
    "selectedLevel" | "school1" | "school2" | "graduationYear" | "gpa"
  >,
): string[] {
  const group = applicationGroup(input.selectedLevel);
  return [
    !clean(input.school1)
      ? (group === "high_school" ? "High school" : "Bachelor university")
      : null,
    group === "phd" && !clean(input.school2) ? "Master university" : null,
    !parseYear(input.graduationYear) ? "Graduation year" : null,
    !clean(input.gpa) ? "GPA" : null,
  ].filter((value): value is string => Boolean(value));
}

/**
 * Maps the Inbox form's application level to the applicant's required prior
 * education. In particular, a Master's applicant's university must never be
 * persisted as a high-school record.
 */
export function buildInboxEducationPayload(
  input: InboxEducationFormInput,
): InboxEducationPayload {
  const group = applicationGroup(input.selectedLevel);
  const school1 = clean(input.school1);
  const school2 = clean(input.school2);
  const program = clean(input.educationProgram);
  const country = clean(input.educationCountry);
  const graduationYear = parseYear(input.graduationYear);
  const gpaValue = clean(input.gpa);
  const gpaScale = gpaValue ? parseScale(input.gradingSystem) : null;
  const gpaRaw = gpaValue && gpaScale ? `${gpaValue} / ${gpaScale}` : gpaValue;
  const languageScore = clean(input.languageScore);

  const common = {
    program,
    country,
    graduationYear,
    gpa: gpaValue,
    gpaRaw,
    gpaScale,
    languageScore,
  };

  if (group === "phd") {
    const records: InboxEducationRecordInput[] = [];
    if (school1) {
      records.push({
        level: "bachelor",
        institution: school1,
        program: null,
        country: null,
        graduationYear: null,
        gpa: null,
        gpaRaw: null,
        gpaScale: null,
        languageScore: null,
      });
    }
    if (school2) {
      records.push({ level: "master", institution: school2, ...common });
    }
    return {
      highSchool: null,
      universityBachelor: school1,
      universityMaster: school2,
      graduationYear,
      gpa: gpaRaw,
      languageScore,
      educationRecords: records,
    };
  }

  if (group === "master") {
    return {
      highSchool: null,
      universityBachelor: school1,
      universityMaster: null,
      graduationYear,
      gpa: gpaRaw,
      languageScore,
      educationRecords: school1
        ? [{ level: "bachelor", institution: school1, ...common }]
        : [],
    };
  }

  return {
    highSchool: school1,
    universityBachelor: null,
    universityMaster: null,
    graduationYear,
    gpa: gpaRaw,
    languageScore,
    educationRecords: school1
      ? [{
          level: "high_school",
          institution: school1,
          ...common,
          program: null,
        }]
      : [],
  };
}
