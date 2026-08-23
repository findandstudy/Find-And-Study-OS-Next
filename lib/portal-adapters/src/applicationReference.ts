export const UNIVERSITY_APPLICATION_ID_MAX_LENGTH = 128;

export type UniversityApplicationIdParseResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string };

/** Shared validation for manual application edits and portal writeback. */
export function parseUniversityApplicationId(
  value: unknown,
): UniversityApplicationIdParseResult {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: "University application ID must be a string or null" };
  }

  const normalized = value.trim();
  if (!normalized) return { ok: true, value: null };
  if (normalized.length > UNIVERSITY_APPLICATION_ID_MAX_LENGTH) {
    return {
      ok: false,
      error: `University application ID must be at most ${UNIVERSITY_APPLICATION_ID_MAX_LENGTH} characters`,
    };
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    return { ok: false, error: "University application ID contains invalid control characters" };
  }
  return { ok: true, value: normalized };
}

export type UniversityApplicationIdSyncPlan =
  | { action: "skip" }
  | { action: "set"; value: string }
  | { action: "conflict"; current: string; incoming: string };

/** Never replaces a different value entered by staff or another confirmed run. */
export function planUniversityApplicationIdSync(
  currentValue: string | null | undefined,
  externalRef: unknown,
): UniversityApplicationIdSyncPlan {
  const parsed = parseUniversityApplicationId(externalRef);
  if (!parsed.ok || !parsed.value) return { action: "skip" };

  const current = parseUniversityApplicationId(currentValue);
  if (!current.ok || !current.value) return { action: "set", value: parsed.value };
  if (current.value === parsed.value) return { action: "skip" };
  return { action: "conflict", current: current.value, incoming: parsed.value };
}
