/**
 * canonicalCountries — pure, dependency-free canonical country list + matcher.
 *
 * The canonical names are the English country names as they appear in the
 * SIT (Study in Turkey / Zoho) "Country of Residence" / "Nationality"
 * dropdowns. `canonicalCountry()` maps free-text input (case/spacing
 * variants, common aliases) onto a canonical name, or returns null when
 * there is no confident match — it NEVER invents a country.
 *
 * Imported by both backend and frontend via @workspace/db.
 */

export const CANONICAL_COUNTRIES: readonly string[] = [
  "Afghanistan",
  "Albania",
  "Algeria",
  "Azerbaijan",
  "Bangladesh",
  "Cameroon",
  "Chad",
  "China",
  "Congo",
  "Djibouti",
  "Egypt",
  "Ethiopia",
  "France",
  "Georgia",
  "Germany",
  "Ghana",
  "India",
  "Indonesia",
  "Iran",
  "Iraq",
  "Jordan",
  "Kazakhstan",
  "Kenya",
  "Kuwait",
  "Kyrgyzstan",
  "Lebanon",
  "Libya",
  "Malaysia",
  "Mali",
  "Mauritania",
  "Morocco",
  "Niger",
  "Nigeria",
  "Oman",
  "Pakistan",
  "Palestine",
  "Qatar",
  "Russia",
  "Saudi Arabia",
  "Senegal",
  "Somalia",
  "South Africa",
  "Sri Lanka",
  "Sudan",
  "Syria",
  "Tajikistan",
  "Tanzania",
  "Tunisia",
  "Turkey",
  "Turkmenistan",
  "Uganda",
  "Ukraine",
  "United Arab Emirates",
  "United Kingdom",
  "United States",
  "Uzbekistan",
  "Yemen",
] as const;

/** lowercase, trim, collapse whitespace, strip dots/apostrophes */
function foldCountry(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Common aliases / local spellings → canonical name (keys are folded). */
const COUNTRY_ALIASES: Record<string, string> = {
  "türkiye": "Turkey",
  "turkiye": "Turkey",
  "republic of turkey": "Turkey",
  "republic of türkiye": "Turkey",
  "uae": "United Arab Emirates",
  "u a e": "United Arab Emirates",
  "emirates": "United Arab Emirates",
  "usa": "United States",
  "u s a": "United States",
  "united states of america": "United States",
  "america": "United States",
  "uk": "United Kingdom",
  "great britain": "United Kingdom",
  "england": "United Kingdom",
  "ksa": "Saudi Arabia",
  "kingdom of saudi arabia": "Saudi Arabia",
  "saudi": "Saudi Arabia",
  "syrian arab republic": "Syria",
  "syrian": "Syria",
  "islamic republic of iran": "Iran",
  "islamic republic of pakistan": "Pakistan",
  "islamic republic of afghanistan": "Afghanistan",
  "arab republic of egypt": "Egypt",
  "misr": "Egypt",
  "russian federation": "Russia",
  "palestinian territories": "Palestine",
  "state of palestine": "Palestine",
  "republic of the congo": "Congo",
  "democratic republic of the congo": "Congo",
  "drc": "Congo",
  "tanzania united republic of": "Tanzania",
  "united republic of tanzania": "Tanzania",
  "federal republic of nigeria": "Nigeria",
  "peoples republic of china": "China",
  "prc": "China",
};

const FOLDED_CANONICAL = new Map<string, string>(
  CANONICAL_COUNTRIES.map((c) => [foldCountry(c), c]),
);

/**
 * Map free-text country input onto the canonical dropdown value.
 * Returns null when there is no confident match (never guesses).
 */
export function canonicalCountry(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const folded = foldCountry(raw);
  if (!folded) return null;
  const exact = FOLDED_CANONICAL.get(folded);
  if (exact) return exact;
  const alias = COUNTRY_ALIASES[folded];
  if (alias) return alias;
  return null;
}
