type ApiErrorShape = {
  error?: string;
  code?: string;
  missingFields?: string[];
  missingFieldLabels?: string[];
  incompatibleFieldLabels?: string[];
  missingDocuments?: string[];
  missingDocumentLabels?: string[];
  missingDocTypes?: string[];
  missingDocLabels?: string[];
};

function parseBody(value: unknown): ApiErrorShape | null {
  if (value && typeof value === "object") return value as ApiErrorShape;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as ApiErrorShape : null;
  } catch {
    return null;
  }
}

function list(values: unknown): string[] {
  return Array.isArray(values)
    ? values.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
}

/**
 * Normalizes fetch, generated-client and plain Error responses so every
 * application entry point explains exactly what staff must complete.
 */
export function applicationCreationErrorMessage(
  error: unknown,
  fallback = "Failed to create application.",
): string {
  const candidate = error as {
    data?: unknown;
    body?: unknown;
    message?: unknown;
  } | null;
  const rawMessage = typeof candidate?.message === "string"
    ? candidate.message
    : "";
  const body = parseBody(candidate?.data)
    ?? parseBody(candidate?.body)
    ?? parseBody(rawMessage);
  if (!body) return rawMessage || fallback;

  if (body.code === "PORTAL_PREFLIGHT_NOT_READY") {
    const unresolved = [
      ...list(body.missingFieldLabels),
      ...list(body.incompatibleFieldLabels).map((label) => `${label} (invalid)`),
      ...list(body.missingDocumentLabels),
    ];
    if (unresolved.length > 0) {
      return `Complete these items before portal submission: ${unresolved.join(", ")}.`;
    }
  }

  const docLabels = list(body.missingDocLabels);
  if (docLabels.length > 0) {
    return `Missing required documents: ${docLabels.join(", ")}.`;
  }
  const missingFields = list(body.missingFields);
  if (missingFields.length > 0) {
    return `Student is missing required fields: ${missingFields.join(", ")}.`;
  }
  return body.error || rawMessage || fallback;
}
