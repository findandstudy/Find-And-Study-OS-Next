export type PublicCatalogCountryRules = Record<string, string[]>;

export type PublicCatalogPolicy = {
  // Legacy allow-list retained for a backwards-compatible read of settings
  // saved before country-specific rules existed. New saves clear this field.
  allowedCountries: string[];
  // Default rule for countries without an explicit countryRules entry.
  allowedUniversityTypes: string[];
  // Missing key = inherit default, [] = hidden, non-empty = explicit types.
  countryRules: PublicCatalogCountryRules;
};

export function normaliseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

export function normaliseCountryRules(value: unknown): PublicCatalogCountryRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .map(([country, universityTypes]) => [
      country.trim(),
      normaliseStringList(universityTypes),
    ] as const)
    .filter(([country]) => Boolean(country))
    .sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(entries);
}

export function universityTypesForPublicCountry(
  policy: PublicCatalogPolicy,
  country: string,
): string[] {
  if (Object.prototype.hasOwnProperty.call(policy.countryRules, country)) {
    return policy.countryRules[country] || [];
  }
  if (
    policy.allowedCountries.length > 0
    && !policy.allowedCountries.includes(country)
  ) {
    return [];
  }
  return policy.allowedUniversityTypes.length > 0
    ? policy.allowedUniversityTypes
    : ["Private"];
}

export function isPublicUniversityVisible(
  policy: PublicCatalogPolicy,
  country: string,
  universityType: string,
): boolean {
  return universityTypesForPublicCountry(policy, country)
    .some((value) => value.toLocaleLowerCase() === universityType.trim().toLocaleLowerCase());
}

export function publicCatalogPolicyCacheKey(policy: PublicCatalogPolicy): string {
  const rules = Object.entries(policy.countryRules)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([country, types]) => `${country}=${[...types].sort().join(",")}`)
    .join(";");
  return [
    policy.allowedCountries.join("|"),
    policy.allowedUniversityTypes.join("|"),
    rules,
  ].join(":");
}
