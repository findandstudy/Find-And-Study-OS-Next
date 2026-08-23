/**
 * academicLevels — frontend copy of the pure helpers in
 * lib/db/src/academicLevels.ts (the db package cannot be imported by the
 * browser bundle). Keep the two files in sync when levels/groups change.
 *
 * Group A (high-school based): Foundation / Language / Pathway / Associate /
 *   Bachelor. Group B: Master. Group C: PhD/Doctorate.
 * Unknown levels fail-safe to group "A".
 */

export type AcademicGroup = "A" | "B" | "C";
export type EducationLevel = "high_school" | "bachelor" | "master";
export type AcademicField = "institution" | "program" | "graduationYear" | "gpa" | "languageScore";

function normalizeLevelKey(levelKey: string): string {
  return String(levelKey || "")
    .toLowerCase()
    .replace(/[\s.\-'’_]/g, "");
}

const GROUP_B_SUBSTRINGS = ["master", "yükseklisans", "yukseklisans"];
const GROUP_B_EXACT = ["msc", "ma", "graduate"];
const GROUP_C_TOKENS = ["phd", "doctorate", "doctoral", "doktora"];
const GROUP_A_TOKENS = [
  "undergraduate",
  "foundation",
  "languagecourse",
  "language",
  "pathway",
  "associate",
  "önlisans",
  "onlisans",
  "bachelor",
  "lisans",
];

export function academicGroupForLevel(levelKey: string): AcademicGroup {
  const k = normalizeLevelKey(levelKey);
  if (!k) return "A";
  if (GROUP_C_TOKENS.some((t) => k.includes(t))) return "C";
  if (k.includes("undergraduate")) return "A";
  if (GROUP_B_EXACT.includes(k)) return "B";
  if (GROUP_B_SUBSTRINGS.some((t) => k.includes(t))) return "B";
  if (GROUP_A_TOKENS.some((t) => k.includes(t))) return "A";
  return "A";
}

export function requiredEducationLevels(levelKey: string): EducationLevel[] {
  switch (academicGroupForLevel(levelKey)) {
    case "B":
      return ["bachelor"];
    case "C":
      return ["bachelor", "master"];
    case "A":
    default:
      return ["high_school"];
  }
}

export function academicFieldsForLevel(edLevel: EducationLevel): AcademicField[] {
  if (edLevel === "high_school") {
    return ["institution", "graduationYear", "gpa", "languageScore"];
  }
  return ["institution", "program", "graduationYear", "gpa", "languageScore"];
}
