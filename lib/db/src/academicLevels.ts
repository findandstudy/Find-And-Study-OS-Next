/**
 * academicLevels — pure, dependency-free helpers mapping a study-level key
 * (from catalog "degree" entries or students.interestedLevel free text) to
 * an academic group, and each group to the education records it requires.
 *
 * Group A (high-school based): Foundation / Language Course / Pathway /
 *   Associate / Bachelor — applicant's prior education is high school.
 * Group B (bachelor based): Master — prior education is a bachelor degree.
 * Group C (bachelor+master based): PhD / Doctorate.
 *
 * Unknown levels fail-safe to group "A" (high-school based).
 *
 * Imported by both backend and frontend via @workspace/db.
 */

export type AcademicGroup = "A" | "B" | "C";
export type EducationLevel = "high_school" | "bachelor" | "master";
export type AcademicField = "institution" | "program" | "graduationYear" | "gpa" | "languageScore";

/** lowercase + strip whitespace, dots, dashes, apostrophes for robust matching */
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
  // "undergraduate" contains "graduate": resolve A before the B substring pass.
  if (k.includes("undergraduate")) return "A";
  // Short/ambiguous B tokens ("ma", "msc", "graduate") match only exactly.
  if (GROUP_B_EXACT.includes(k)) return "B";
  // Order matters: "yükseklisans" contains "lisans"; check B before A.
  if (GROUP_B_SUBSTRINGS.some((t) => k.includes(t))) return "B";
  if (GROUP_A_TOKENS.some((t) => k.includes(t))) return "A";
  return "A"; // fail-safe: high-school based
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
    // High school has no "program" field
    return ["institution", "graduationYear", "gpa", "languageScore"];
  }
  return ["institution", "program", "graduationYear", "gpa", "languageScore"];
}
