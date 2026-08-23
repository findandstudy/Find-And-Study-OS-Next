function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function getLeadSourceLabel(source?: string | null, sourcePageUrl?: string | null): string {
  const normalizedSource = source?.trim();
  if (normalizedSource?.toLowerCase().startsWith("embed:")) {
    return titleCase(normalizedSource.slice("embed:".length)) || "Widget";
  }

  if (normalizedSource) return titleCase(normalizedSource);

  if (sourcePageUrl) {
    try {
      return new URL(sourcePageUrl).hostname.replace(/^www\./i, "");
    } catch {
      return "Widget";
    }
  }

  return "Widget";
}
