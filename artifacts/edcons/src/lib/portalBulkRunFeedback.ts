const PREFLIGHT_FIELD_LABELS: Record<string, string> = {
  firstName: "First name (passport)",
  lastName: "Last name (passport)",
  passportNumber: "Passport number",
  passportIssueDate: "Passport issue date",
  passportExpiryDate: "Passport expiry date",
  passportIdentityProof: "Valid passport identity",
  dateOfBirth: "Date of birth",
  addressCity: "Residence city",
  schoolName: "High school",
  gpa: "GPA",
  graduationYear: "Graduation year",
};

function readableFallback(field: string): string {
  return field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (value) => value.toUpperCase());
}

/**
 * Convert all API preflight issues into readable, non-empty UI feedback.
 * Incompatible passport fields used to be omitted, producing the misleading
 * "—" message even though the API had returned the exact blocker.
 */
export function collectPortalPreflightIssueLabels(rows: unknown[]): string[] {
  const labels = new Set<string>();

  for (const raw of rows) {
    const row = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    if (Array.isArray(row.missingFields)) {
      for (const field of row.missingFields) {
        if (typeof field !== "string" || !field.trim()) continue;
        const key = field.trim();
        labels.add(PREFLIGHT_FIELD_LABELS[key] ?? readableFallback(key));
      }
    }
    if (Array.isArray(row.incompatibleFields)) {
      for (const issue of row.incompatibleFields) {
        if (!issue || typeof issue !== "object") continue;
        const field = (issue as Record<string, unknown>).field;
        const reason = (issue as Record<string, unknown>).reason;
        if (typeof field !== "string" || !field.trim()) continue;
        const key = field.trim();
        if (key === "passportIdentityProof" && reason === "verification_unavailable") {
          labels.add("Passport verification temporarily unavailable — retry shortly");
        } else {
          labels.add(PREFLIGHT_FIELD_LABELS[key] ?? readableFallback(key));
        }
      }
    }
  }

  if (labels.size === 0) {
    return ["Passport or required profile information could not be verified"];
  }
  return Array.from(labels);
}
