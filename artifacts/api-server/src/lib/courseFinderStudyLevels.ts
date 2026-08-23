/** Collapse spelling variants that represent the same academic level. */
export function canonicalCourseFinderStudyLevel(value: string): string {
  const trimmed = value.trim();
  const compact = trimmed.toLowerCase().replace(/[.\s_-]+/g, "");
  if (compact === "phd") return "PhD";
  return trimmed;
}

/** Expand the canonical PhD filter so legacy dotted values remain searchable. */
export function courseFinderStudyLevelSearchValues(values: string[]): string[] {
  const expanded = values.flatMap((value) =>
    canonicalCourseFinderStudyLevel(value) === "PhD"
      ? ["PhD", "Ph.D", "Ph.D."]
      : [value.trim()],
  );
  return Array.from(new Set(expanded.filter(Boolean)));
}

export function canonicalCourseFinderStudyLevels(values: string[]): string[] {
  return Array.from(
    new Set(values.map(canonicalCourseFinderStudyLevel).filter(Boolean)),
  );
}
