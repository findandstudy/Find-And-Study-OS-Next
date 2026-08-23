export interface LeadInterest {
  country: string;
  university: string;
  program: string;
}

function normalizeInterest(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");
}

export function readLeadInterest(detail: unknown): LeadInterest {
  const lead = (detail as { lead?: Record<string, unknown> | null } | null)
    ?.lead;
  const read = (value: unknown) =>
    typeof value === "string" ? value.trim() : "";

  return {
    country: read(lead?.interestedCountry),
    university: read(lead?.interestedUniversity),
    program: read(lead?.interestedProgram),
  };
}

export function uniqueExactInterestMatch<T>(
  rows: readonly T[],
  wanted: unknown,
  getName: (row: T) => unknown,
): T | null {
  const target = normalizeInterest(wanted);
  if (!target) return null;

  const matches = rows.filter(
    (row) => normalizeInterest(getName(row)) === target,
  );
  return matches.length === 1 ? matches[0] : null;
}
