export type EmbedUniversityScope = {
  mode: "all" | "selected";
  universityIds: number[];
};

export type EmbedPresetScopeFilters = {
  country?: string;
  city?: string;
  universityType?: string;
  level?: string;
  language?: string;
  field?: string;
};

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function resolveEmbedUniversityScope(presetFilters: unknown): EmbedUniversityScope {
  if (!presetFilters || typeof presetFilters !== "object" || Array.isArray(presetFilters)) {
    return { mode: "all", universityIds: [] };
  }

  const filters = presetFilters as Record<string, unknown>;
  if (filters.universityScope === "all") {
    return { mode: "all", universityIds: [] };
  }

  const universityIds = Array.isArray(filters.universityIds)
    ? [...new Set(filters.universityIds.map(positiveInteger).filter((id): id is number => id !== null))]
    : [];
  const legacyUniversityId = positiveInteger(filters.universityId);

  if (universityIds.length > 0) {
    return { mode: "selected", universityIds };
  }
  if (legacyUniversityId !== null) {
    return { mode: "selected", universityIds: [legacyUniversityId] };
  }
  if (filters.universityScope === "selected") {
    return { mode: "selected", universityIds: [] };
  }
  return { mode: "all", universityIds: [] };
}

/**
 * Returns the university that should be selected only on the widget's first
 * render. Unlike `universityId`, this value never narrows the widget's hard
 * university scope and is intentionally ignored for selected-scope widgets.
 */
export function resolveEmbedDefaultUniversityId(presetFilters: unknown): number | null {
  if (!presetFilters || typeof presetFilters !== "object" || Array.isArray(presetFilters)) {
    return null;
  }

  const filters = presetFilters as Record<string, unknown>;
  if (filters.universityScope !== "all") return null;
  return positiveInteger(filters.defaultUniversityId);
}

export function resolveEmbedPresetScopeFilters(
  presetFilters: unknown,
): EmbedPresetScopeFilters {
  if (!presetFilters || typeof presetFilters !== "object" || Array.isArray(presetFilters)) {
    return {};
  }

  const filters = presetFilters as Record<string, unknown>;
  const clean = (key: keyof EmbedPresetScopeFilters) => {
    const value = filters[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return {
    country: clean("country"),
    city: clean("city"),
    universityType: clean("universityType"),
    level: clean("level"),
    language: clean("language"),
    field: clean("field"),
  };
}

export function isValidEmbedUniversityScope(presetFilters: unknown): boolean {
  const scope = resolveEmbedUniversityScope(presetFilters);
  return scope.mode === "all" || scope.universityIds.length > 0;
}
