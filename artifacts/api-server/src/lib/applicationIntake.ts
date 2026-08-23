function cleanIntake(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned || null;
}

/**
 * Preserve an explicitly selected application intake; otherwise snapshot the
 * programme's current intake value when the application is created.
 */
export function resolveApplicationIntakeSnapshot(
  requestedIntake: unknown,
  programIntakes: unknown,
): string | null {
  return cleanIntake(requestedIntake) ?? cleanIntake(programIntakes);
}
