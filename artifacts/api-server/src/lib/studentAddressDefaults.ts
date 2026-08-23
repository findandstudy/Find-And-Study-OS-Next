const COUNTRY_NAMES = new Set([
  "afghanistan", "albania", "algeria", "azerbaijan", "bangladesh",
  "china", "egypt", "ethiopia", "georgia", "ghana", "india", "iran",
  "iraq", "jordan", "kazakhstan", "kenya", "kyrgyzstan", "lebanon",
  "libya", "mongolia", "morocco", "nepal", "nigeria", "pakistan",
  "palestine", "russia", "somalia", "sudan", "syria", "tajikistan",
  "turkey", "turkiye", "turkmenistan", "uganda", "ukraine",
  "united arab emirates", "uzbekistan", "yemen",
]);

function clean(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function normalized(value: unknown): string {
  return String(value || "")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[.,;]+$/g, "");
}

function isCountry(value: string, nationality: string | null): boolean {
  const key = normalized(value);
  return Boolean(
    key &&
    (COUNTRY_NAMES.has(key) || (nationality && key === normalized(nationality))),
  );
}

function extractPostalCode(address: string | null): string | null {
  if (!address) return null;
  const labelled = address.match(
    /(?:postal\s*code|postcode|zip\s*code|zip|posta\s*kodu)\s*[:#-]?\s*([A-Z0-9][A-Z0-9 -]{2,10})/i,
  );
  if (labelled?.[1]) return labelled[1].trim().replace(/\s+/g, " ");

  const numeric = address.match(/(?:^|[\s,;])(\d{5,10})(?=$|[\s,;])/);
  return numeric?.[1] || null;
}

function extractCity(
  address: string | null,
  nationality: string | null,
): string | null {
  if (!address) return null;
  const labelled = address.match(
    /(?:residence\s*city|city|district|şehir|ilçe)\s*[:#-]?\s*([^,;\n|]+)/i,
  );
  if (labelled?.[1]) {
    const candidate = labelled[1].trim();
    if (
      candidate &&
      !isCountry(candidate, nationality) &&
      /[A-Za-zÀ-ž]/.test(candidate)
    ) {
      return candidate.slice(0, 100);
    }
  }

  const parts = address
    .split(/[\n,;|]+/)
    .map((part) =>
      part
        .replace(
          /(?:postal\s*code|postcode|zip\s*code|zip|posta\s*kodu)\s*[:#-]?\s*[A-Z0-9][A-Z0-9 -]{2,10}/gi,
          "",
        )
        .replace(/\b\d{5,10}\b/g, "")
        .trim(),
    )
    .filter(Boolean);

  // A single free-form segment is usually a street/district, not reliable
  // evidence of a city. Prefer the product fallback over inventing one.
  if (parts.length < 2) return null;

  for (let index = parts.length - 1; index >= 0; index--) {
    const candidate = parts[index];
    if (!isCountry(candidate, nationality) && /[A-Za-zÀ-ž]/.test(candidate)) {
      return candidate.slice(0, 100);
    }
  }
  return null;
}

export interface ResidenceAddressInput {
  address?: unknown;
  addressCity?: unknown;
  postalCode?: unknown;
  nationality?: unknown;
}

/**
 * Guarantees the two residence fields required by partner portals.
 * Explicit values win unless the city is actually the student's country.
 * The final fallback values are the product rule requested for legacy data.
 */
export function resolveResidenceAddress(input: ResidenceAddressInput): {
  addressCity: string;
  postalCode: string;
} {
  const address = clean(input.address);
  const nationality = clean(input.nationality);
  const explicitCity = clean(input.addressCity);
  const explicitPostal = clean(input.postalCode);
  const validExplicitCity =
    explicitCity && !isCountry(explicitCity, nationality) ? explicitCity : null;

  return {
    addressCity: validExplicitCity || extractCity(address, nationality) || "city",
    postalCode: explicitPostal || extractPostalCode(address) || "10000",
  };
}
