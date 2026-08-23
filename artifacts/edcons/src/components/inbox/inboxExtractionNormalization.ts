export function normalizeInboxGender(value: unknown): "" | "male" | "female" {
  const normalized = String(value ?? "")
    .trim()
    .toLocaleLowerCase("en-US");
  if (["m", "male", "man", "erkek"].includes(normalized)) return "male";
  if (["f", "female", "woman", "kadın", "kadin"].includes(normalized))
    return "female";
  return "";
}

export function normalizeInboxGpaForForm(
  value: unknown,
  reportedScale?: unknown,
): { gpa: string; gradingSystem: "4" | "5" | "10" | "20" | "100" } {
  const raw = String(value ?? "").trim();
  if (!raw) return { gpa: "", gradingSystem: "100" };

  const fraction = raw.match(/^(-?\d+(?:[.,]\d+)?)\s*\/\s*(\d+(?:[.,]\d+)?)$/);
  if (fraction) {
    const numerator = Number(fraction[1].replace(",", "."));
    const denominator = Number(fraction[2].replace(",", "."));
    if (
      Number.isFinite(numerator) &&
      Number.isFinite(denominator) &&
      numerator >= 0 &&
      denominator > 0 &&
      numerator <= denominator
    ) {
      return {
        gpa: String(Math.round((numerator / denominator) * 100)),
        gradingSystem: "100",
      };
    }
    return { gpa: "", gradingSystem: "100" };
  }

  const numeric = Number(raw.replace("%", "").replace(",", "."));
  if (!Number.isFinite(numeric) || numeric < 0) {
    return { gpa: "", gradingSystem: "100" };
  }

  if (Number(reportedScale) === 100 || raw.includes("%")) {
    return numeric <= 100
      ? { gpa: String(Math.round(numeric)), gradingSystem: "100" }
      : { gpa: "", gradingSystem: "100" };
  }

  // Legacy extractors sometimes return a bare GPA. Keep plausible native
  // scales, but never accept a numerator such as 955 without a denominator.
  if (numeric <= 4) return { gpa: raw, gradingSystem: "4" };
  if (numeric <= 5) return { gpa: raw, gradingSystem: "5" };
  if (numeric <= 10) return { gpa: raw, gradingSystem: "10" };
  if (numeric <= 20) return { gpa: raw, gradingSystem: "20" };
  if (numeric <= 100) return { gpa: raw, gradingSystem: "100" };
  return { gpa: "", gradingSystem: "100" };
}
