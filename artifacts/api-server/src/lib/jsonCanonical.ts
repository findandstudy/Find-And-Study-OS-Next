/**
 * Produces a deterministic JSON representation independent of object-key
 * ordering. PostgreSQL jsonb normalizes key order, so plain JSON.stringify()
 * is not suitable for comparing a database value with a file-parsed value.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalJson(item)}`,
    )
    .join(",")}}`;
}
