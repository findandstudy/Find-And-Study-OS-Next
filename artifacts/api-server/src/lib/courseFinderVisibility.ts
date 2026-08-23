export type CourseFinderProgramVisibility = {
  contacts: boolean;
  internalFees: boolean;
  serviceFee: boolean;
};

/**
 * Course Finder list rows must never inline the stored university logo.
 * Some legacy records keep a base64 data URL in the database; repeating that
 * payload for every program can turn a 24-row response into multiple megabytes.
 * The dedicated logo route streams or redirects the source once and lets the
 * browser cache it across every card for the same university.
 */
export function courseFinderUniversityLogoUrl(
  universityId: number,
  hasLogo: boolean,
): string | null {
  return hasLogo ? `/api/universities/${universityId}/logo` : null;
}

const CONTACT_FIELDS = [
  "universityContactName",
  "universityContactPhone",
  "universityContactEmail",
] as const;

const INTERNAL_FEE_FIELDS = [
  "commissionRate",
  "applicationFee",
] as const;

/**
 * Removes private Course Finder fields before the response leaves the API.
 * The UI also applies role-based visibility, but this server-side boundary is
 * what prevents students and anonymous visitors from reading values directly.
 */
export function sanitizeCourseFinderProgram<T extends object>(
  row: T,
  visibility: CourseFinderProgramVisibility,
): Partial<T> {
  const result = { ...row } as Record<string, unknown>;
  if (!visibility.contacts) {
    for (const field of CONTACT_FIELDS) delete result[field];
  }
  if (!visibility.internalFees) {
    for (const field of INTERNAL_FEE_FIELDS) delete result[field];
  }
  if (!visibility.serviceFee) {
    delete result.serviceFeeAmount;
  }
  return result as Partial<T>;
}
