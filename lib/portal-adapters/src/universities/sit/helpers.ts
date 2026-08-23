// ---------------------------------------------------------------------------
// SIT portal — pure helpers (no browser, fully unit-testable)
//
//   normalizeGpa        — coerce CRM GPA (decimal or Cambridge letter) → integer
//   mapEducationLevel   — CRM level → canonical SIT degree label
//   formatSitDate       — ISO-8601 → DD/MM/YYYY
//   matchAllowedUniversity — allowlist-guarded university resolver (IDOR-safe)
//   isLanguageCompatible   — program language-of-instruction compatibility
// ---------------------------------------------------------------------------

import { expandProgramTokens, fold } from "../../programMatch.js";
import { validatePassportNumber } from "../../identityValidation.js";
import type { SubmitProfile } from "../../types.js";

export type SitIdentityField = "firstName" | "lastName" | "passportNumber";

export interface SitIdentityEvaluation {
  matched: boolean;
  missingFields: SitIdentityField[];
  mismatchedFields: SitIdentityField[];
}

export interface SitSubmissionIdentityGate {
  allowed: boolean;
  verification: "unavailable" | "matched" | "conflict";
  fields: SitIdentityField[];
}

/** Normalize only for equality checks; never log or persist this value. */
export function normalizeSitPassport(value: string | null | undefined): string {
  return String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normalizedNameTokens(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string[] {
  return fold(`${firstName ?? ""} ${lastName ?? ""}`)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort();
}

/**
 * Compare CRM identity with an independently extracted passport identity.
 * Names are token-order agnostic (passport surname/given-name order differs
 * by country), but the complete token multiset and passport number must match.
 */
export function evaluateSitIdentity(
  expected: Pick<SubmitProfile, "firstName" | "lastName" | "passportNumber">,
  proof: SubmitProfile["passportIdentityProof"] | null | undefined,
): SitIdentityEvaluation {
  const missingFields: SitIdentityField[] = [];
  const mismatchedFields: SitIdentityField[] = [];

  if (!proof) {
    return {
      matched: false,
      missingFields: ["firstName", "lastName", "passportNumber"],
      mismatchedFields,
    };
  }
  if (!proof?.firstName?.trim()) missingFields.push("firstName");
  if (!proof?.lastName?.trim()) missingFields.push("lastName");
  if (!proof?.passportNumber?.trim()) missingFields.push("passportNumber");
  if (missingFields.length > 0) {
    return { matched: false, missingFields, mismatchedFields };
  }

  const expectedPassport = normalizeSitPassport(expected.passportNumber);
  const proofPassport = normalizeSitPassport(proof.passportNumber);
  if (!expectedPassport || expectedPassport !== proofPassport) {
    mismatchedFields.push("passportNumber");
  }

  const expectedName = normalizedNameTokens(
    expected.firstName,
    expected.lastName,
  );
  const proofName = normalizedNameTokens(proof.firstName, proof.lastName);
  if (
    expectedName.length === 0 ||
    expectedName.length !== proofName.length ||
    expectedName.some((token, index) => token !== proofName[index])
  ) {
    // Keep first/last together: the proof intentionally permits their order to
    // differ, so a combined-name mismatch cannot safely identify one side.
    mismatchedFields.push("firstName", "lastName");
  }

  return {
    matched: missingFields.length === 0 && mismatchedFields.length === 0,
    missingFields,
    mismatchedFields,
  };
}

/**
 * Runner-level SIT identity decision after deterministic profile validation and
 * required-document preflight have already passed. A missing independent AI
 * read is observable but must not turn a provider outage into a false identity
 * mismatch. When proof exists, every mismatch still fails closed.
 */
export function evaluateSitSubmissionIdentityGate(
  expected: Pick<SubmitProfile, "firstName" | "lastName" | "passportNumber">,
  proof: SubmitProfile["passportIdentityProof"] | null | undefined,
): SitSubmissionIdentityGate {
  if (!proof) {
    return {
      allowed: true,
      verification: "unavailable",
      fields: [],
    };
  }

  const identity = evaluateSitIdentity(expected, proof);
  const fields = [
    ...new Set([...identity.missingFields, ...identity.mismatchedFields]),
  ];
  return {
    allowed: identity.matched,
    verification: identity.matched ? "matched" : "conflict",
    fields,
  };
}

const readExtractedText = (
  extracted: Record<string, unknown>,
  aliases: readonly string[],
): string => {
  for (const key of aliases) {
    const value = extracted[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
};

/** Build a proof only from complete, high-confidence document extraction. */
export function sitPassportIdentityProofFromDocument(input: {
  extractedData: string | Record<string, unknown> | null | undefined;
  confidenceScore?: number | null;
  documentId?: number;
}): NonNullable<SubmitProfile["passportIdentityProof"]> | null {
  let extracted: Record<string, unknown> | null = null;
  if (typeof input.extractedData === "string") {
    try {
      extracted = JSON.parse(input.extractedData) as Record<string, unknown>;
    } catch {
      return null;
    }
  } else if (input.extractedData && typeof input.extractedData === "object") {
    extracted = input.extractedData;
  }
  if (!extracted) return null;

  const identityConfidence = String(
    extracted.identityConfidence ?? "",
  ).toLowerCase();
  const confidence = String(extracted.confidence ?? "").toLowerCase();
  const highConfidence = identityConfidence
    ? identityConfidence === "high"
    : confidence === "high" || (input.confidenceScore ?? 0) >= 0.9;
  if (!highConfidence) return null;

  const firstName = readExtractedText(extracted, [
    "firstName",
    "givenNames",
    "givenName",
  ]);
  const lastName = readExtractedText(extracted, [
    "lastName",
    "surname",
    "familyName",
  ]);
  const passportNumber = readExtractedText(extracted, [
    "passportNumber",
    "passportNo",
  ]);
  if (
    !firstName ||
    !lastName ||
    !normalizeSitPassport(passportNumber) ||
    validatePassportNumber(passportNumber)
  )
    return null;

  return {
    firstName,
    lastName,
    passportNumber,
    confidence: "high",
    ...(input.documentId != null ? { documentId: input.documentId } : {}),
  };
}

/**
 * Build the structured, fail-closed context consumed by the runner's configured
 * program-fallback engine. The caller must pass only candidates that already
 * passed university, level and language scoping; this helper never broadens the
 * candidate set or chooses an alternative by itself.
 */
export function buildSitProgramMissingContext(
  requestedProgram: string,
  candidates: readonly { id: string; name: string }[],
): {
  requestedProgram: { name: string };
  availablePrograms: Array<{ value: string; name: string; enabled: true }>;
  resolution: "not_in_dropdown";
} {
  const seen = new Set<string>();
  const availablePrograms = candidates.flatMap((candidate) => {
    const value = candidate.id.trim();
    const name = candidate.name.trim();
    if (!value || !name || seen.has(value)) return [];
    seen.add(value);
    return [{ value, name, enabled: true as const }];
  });

  return {
    requestedProgram: { name: requestedProgram.trim() },
    availablePrograms,
    resolution: "not_in_dropdown",
  };
}

/**
 * Resolve formatting-only drift in SIT program labels without fuzzy guessing.
 *
 * The live catalog occasionally joins the language suffix to the subject
 * (for example `DesignEnglish`) while CRM stores `(English)`. Removing only
 * non-alphanumeric spacing makes those labels identical, but still keeps the
 * degree, subject, thesis mode and language in the comparison. A match is
 * accepted only when exactly one candidate has the same compact identity.
 */
export function matchSitProgramExactFormatting<T extends { name: string }>(
  requestedProgram: string,
  candidates: readonly T[],
): T | null {
  const compactIdentity = (value: string): string =>
    fold(value).replace(/[^a-z0-9]+/g, "");
  const requestedIdentity = compactIdentity(requestedProgram);
  if (!requestedIdentity) return null;

  const matches = candidates.filter(
    (candidate) => compactIdentity(candidate.name) === requestedIdentity,
  );
  return matches.length === 1 ? matches[0] : null;
}

// ---------------------------------------------------------------------------
// SIT allowlist — EXACTLY 11 universities (do not add/remove without sign-off).
//
// Agreed list. Note vs. the old stub:
//   + Beykoz Üniversitesi          (ADDED)
//   - İstanbul Yeni Yüzyıl Ünv.    (REMOVED)
//   - Haliç Üniversitesi            (DIRECT Salesforce portal)
//
// Exact-name guards (handled by token-subset matching below):
//   - "İstanbul Aydın" must NOT match "Kıbrıs/Cyprus Aydın".
//   - "İstanbul Kent" must NOT match "Beykent".
//   - "Ankara Medipol" must NOT match "İstanbul Medipol".
// ---------------------------------------------------------------------------
export const SIT_ALLOWLIST: readonly string[] = [
  "İstanbul Atlas Üniversitesi",
  "Ankara Medipol Üniversitesi",
  "Galata Üniversitesi",
  "Beykoz Üniversitesi",
  "İstinye Üniversitesi",
  "İstanbul Aydın Üniversitesi",
  "İstanbul Kent Üniversitesi",
  "Fenerbahçe Üniversitesi",
  "İstanbul Kültür Üniversitesi",
  "İstanbul Gelişim Üniversitesi",
  "TED Üniversitesi",
] as const;

// Direct-portal universities are an explicit denylist at the SIT membership
// boundary. This prevents stale panel membership or an environment extension
// from routing Haliç back through SIT after its dedicated adapter is enabled.
const SIT_EXCLUDED_UNIVERSITIES: readonly string[] = [
  "Haliç Üniversitesi",
  "Istanbul Arel University",
  "İstanbul Arel Üniversitesi",
] as const;

export function isSitExcludedUniversity(
  universityNameOrId: string | null | undefined,
): boolean {
  if (universityNameOrId == null) return false;
  const nameTokens = distinctiveTokenKey(
    distinctiveTokens(String(universityNameOrId).trim()),
  );
  if (nameTokens === "") return false;
  return SIT_EXCLUDED_UNIVERSITIES.some(
    (entry) =>
      distinctiveTokenKey(distinctiveTokens(entry)) === nameTokens,
  );
}

// ---------------------------------------------------------------------------
// Cambridge / A-Level letter grade → integer (SIT GPA field is an integer).
// ---------------------------------------------------------------------------
const CAMBRIDGE_GRADE: Readonly<Record<string, number>> = {
  "A*": 90,
  A: 80,
  B: 70,
  C: 60,
  D: 50,
  E: 40,
};

/**
 * Normalize a CRM GPA value to the integer SIT expects.
 *
 *   - number            → rounded to nearest integer
 *   - "3.6" / "3,6"     → 4   (decimal, comma or dot)
 *   - "A*"/"A".."E"     → Cambridge table (case-insensitive)
 *   - undefined / "" / unparseable → undefined (caller decides default)
 */
export function normalizeGpa(
  value: number | string | undefined | null,
): number | undefined {
  if (value === undefined || value === null) return undefined;

  // Zoho'nun GPA alanları TAM SAYI ve 0-100 aralığı bekler (ondalık değerler
  // "INVALID_DATA: High_School_GPA" ile reddediliyor) — yuvarla VE sıkıştır.
  const clamp = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

  if (typeof value === "number") {
    return Number.isFinite(value) ? clamp(value) : undefined;
  }

  const trimmed = value.trim();
  if (trimmed === "") return undefined;

  const letter = trimmed.toUpperCase();
  if (Object.prototype.hasOwnProperty.call(CAMBRIDGE_GRADE, letter)) {
    return CAMBRIDGE_GRADE[letter];
  }

  const num = Number(trimmed.replace(",", "."));
  return Number.isFinite(num) ? clamp(num) : undefined;
}

// ---------------------------------------------------------------------------
// CRM degree level → canonical SIT degree label.
// The combobox matcher fuzzy-matches this against the live option text.
// ---------------------------------------------------------------------------
export function mapEducationLevel(
  level: string | undefined | null,
): string | null {
  const f = fold(level ?? "");
  // fold("Ph.D") is "ph d", so accept both the joined and punctuation-folded
  // spellings. CRM degree labels legitimately contain both variants.
  if (/doktora|ph\s*d|doctora|doctoral/.test(f)) return "PhD";
  if (/yukseklisans|yuksek lisans|master|graduate/.test(f)) return "Master";
  if (/onlisans|on lisans|associate/.test(f)) return "Associate";
  if (/lisans|bachelor|undergraduate/.test(f)) return "Bachelor";
  return null;
}

const SIT_PROGRAM_GENERIC_TOKENS = new Set([
  "associate",
  "bachelor",
  "master",
  "phd",
  "ph",
  "doctorate",
  "doctoral",
  "degree",
  "program",
  "programme",
  "english",
  "ingilizce",
  "turkish",
  "turkce",
  "thesis",
  "non",
  "tezli",
  "tezsiz",
  "and",
  "the",
  "of",
  "in",
  // These broad faculty words must not make two unrelated subjects look like
  // the same programme (for example Data Science vs Sport Sciences).
  "science",
  "sciences",
  "bilim",
  "bilimi",
  "engineering",
  "muhendislik",
  "muhendisligi",
  "management",
  "administration",
  "yonetim",
  "studies",
]);

function sitProgramSubjectTokens(name: string): Set<string> {
  return new Set(
    fold(name)
      .split(" ")
      .filter(
        (token) => token.length > 1 && !SIT_PROGRAM_GENERIC_TOKENS.has(token),
      ),
  );
}

/**
 * Additional fail-closed guard for SIT's large live catalogue. The shared
 * fuzzy matcher also considers degree/language and broad synonym tokens; those
 * must never be enough to turn two unrelated subjects into a match.
 */
export function hasSitProgramSubjectAnchor(
  desiredName: string,
  candidateName: string,
  extraSynonyms?: readonly (readonly string[])[],
): boolean {
  if (fold(desiredName) === fold(candidateName)) return true;

  const desired = sitProgramSubjectTokens(desiredName);
  const candidate = sitProgramSubjectTokens(candidateName);
  if (desired.size === 0 || candidate.size === 0) return false;

  const desiredExpanded = expandProgramTokens(desired, extraSynonyms);
  const candidateExpanded = expandProgramTokens(candidate, extraSynonyms);
  for (const token of desiredExpanded) {
    if (
      !SIT_PROGRAM_GENERIC_TOKENS.has(token) &&
      candidateExpanded.has(token)
    ) {
      return true;
    }
  }
  return false;
}

export type SitAcademicHistoryLevel = "high_school" | "bachelor" | "master";

/** Match SIT's school-name label without producing "High School School Name". */
export function sitAcademicSchoolNameLabelPattern(
  level: SitAcademicHistoryLevel,
): RegExp {
  if (level === "high_school") return /^\s*High School(?:\s+School)?\s+Name\b/i;
  const prefix = level === "bachelor" ? "Bachelor" : "Master";
  return new RegExp(`^\\s*${prefix}\\s+School Name\\b`, "i");
}

export interface SitAcademicHistoryInput {
  educationRecords?: Array<{
    level: string;
    schoolName?: string | null;
    country?: string | null;
    gpa?: string | null;
  }>;
  legacyEducation?: {
    highSchool?: string;
    bachelorSchool?: string;
    masterSchool?: string;
    rawGpa?: string;
  };
  highSchool?: string;
  universityBachelor?: string;
  universityMaster?: string;
  schoolName?: string;
  gpa?: string | number;
  nationality?: string;
  highSchoolCountry?: string;
  schoolCountry?: string;
}

/**
 * Resolve which completed-education record a live SIT country question asks
 * for. SIT changes the label by application level:
 *   Bachelor/Associate applicant -> "High School Country"
 *   Master applicant             -> "Bachelor Country"
 *   PhD applicant                -> "Master Country"
 */
export function sitAcademicHistoryLevelFromCountryLabel(
  label: string | undefined | null,
): SitAcademicHistoryLevel | null {
  const f = fold(label ?? "");
  if (!/\bcountry\b/.test(f)) return null;
  if (/\b(high school|secondary school)\b/.test(f)) return "high_school";
  if (/\bbachelor\b/.test(f)) return "bachelor";
  if (/\bmaster\b/.test(f)) return "master";
  return null;
}

/**
 * Pick the matching structured education row for SIT. Explicit
 * education_records always win. Legacy student columns remain a compatibility
 * fallback for historical students; nationality is used only as the final
 * country fallback because the old CRM had no education-country column.
 */
export function resolveSitAcademicHistory(
  profile: SitAcademicHistoryInput,
  requiredLevel: SitAcademicHistoryLevel,
): { country: string; schoolName: string; gpa: string } {
  const levelMatches = (raw: string): boolean => {
    const f = fold(raw);
    if (requiredLevel === "high_school") {
      return /\b(high school|secondary|lise)\b/.test(f);
    }
    if (requiredLevel === "bachelor") {
      return /\b(bachelor|undergraduate|lisans)\b/.test(f);
    }
    return /\b(master|graduate|yuksek lisans)\b/.test(f);
  };
  const row = profile.educationRecords?.find((record) =>
    levelMatches(record.level),
  );

  const legacySchool =
    requiredLevel === "high_school"
      ? profile.legacyEducation?.highSchool || profile.highSchool
      : requiredLevel === "bachelor"
        ? profile.legacyEducation?.bachelorSchool || profile.universityBachelor
        : profile.legacyEducation?.masterSchool || profile.universityMaster;

  const country =
    row?.country?.trim() ||
    (requiredLevel === "high_school"
      ? profile.highSchoolCountry?.trim() || profile.schoolCountry?.trim()
      : "") ||
    profile.nationality?.trim() ||
    "";

  return {
    country: toEnglishCountryName(country),
    schoolName:
      row?.schoolName?.trim() ||
      legacySchool?.trim() ||
      profile.schoolName?.trim() ||
      "",
    gpa:
      row?.gpa?.trim() ||
      profile.legacyEducation?.rawGpa?.trim() ||
      String(profile.gpa ?? "").trim() ||
      "",
  };
}

/**
 * Identify SIT's Contact & Location screen from its visible labels. A bare
 * phone input is insufficient because the Family screen also has father/mother
 * mobile controls. This guard prevents the student's phone from being written
 * into a parent's mobile field when the wizard refills every step.
 */
export function isSitContactStepLabels(
  labels: Array<string | undefined | null>,
): boolean {
  const folded = labels.map((label) => fold(label ?? ""));
  if (folded.some((label) => /\bcountry of residence\b/.test(label)))
    return true;
  const hasEmail = folded.some((label) => /\be-?mail\b/.test(label));
  const hasLocation = folded.some((label) =>
    /\b(address|city|district|residence)\b/.test(label),
  );
  return hasEmail && hasLocation;
}

export function isSitDocumentsStep(
  heading: string | undefined | null,
  uploadAffordanceCount: number,
  hasHeadinglessDocumentsSignature = false,
): boolean {
  return (
    Number.isFinite(uploadAffordanceCount) &&
    uploadAffordanceCount > 0 &&
    (/\b(documents?|uploads?|belgeler?|dosyalar?)\b/i.test(heading ?? "") ||
      hasHeadinglessDocumentsSignature)
  );
}

// ---------------------------------------------------------------------------
// ISO-8601 date (YYYY-MM-DD) → DD/MM/YYYY. Returns "" for unparseable input.
// ---------------------------------------------------------------------------
export function formatSitDate(iso: string | undefined | null): string {
  const m = String(iso ?? "").match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  return `${m[3]}/${m[2]}/${m[1]}`;
}

// ---------------------------------------------------------------------------
// Turkish → English nationality/country name.
//
// The CRM stores nationality in Turkish ("Özbekistan"), but the SIT wizard's
// Nationality <select> carries ONLY English option text ("Uzbekistan", …).
// Matching the Turkish name against the English options fails and the required
// field stays unset, so the step is rejected. Translate to English right before
// matching; the raw name is kept as a same-call fallback candidate in case an
// option ever reverts to Turkish.
// ---------------------------------------------------------------------------
function foldTr(s: string): string {
  return s
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .replace(/ı/g, "i")
    .replace(/Ş/g, "s")
    .replace(/ş/g, "s")
    .replace(/Ğ/g, "g")
    .replace(/ğ/g, "g")
    .replace(/Ü/g, "u")
    .replace(/ü/g, "u")
    .replace(/Ö/g, "o")
    .replace(/ö/g, "o")
    .replace(/Ç/g, "c")
    .replace(/ç/g, "c")
    .toLowerCase()
    .trim();
}

const TR_TO_EN_COUNTRY: Readonly<Record<string, string>> = {
  turkiye: "Turkey",
  afganistan: "Afghanistan",
  kazakistan: "Kazakhstan",
  ozbekistan: "Uzbekistan",
  turkmenistan: "Turkmenistan",
  azerbaycan: "Azerbaijan",
  nijerya: "Nigeria",
  misir: "Egypt",
  suriye: "Syria",
  irak: "Iraq",
  iran: "Iran",
  urdun: "Jordan",
  filistin: "Palestine",
  fas: "Morocco",
  cezayir: "Algeria",
  tunus: "Tunisia",
  libya: "Libya",
  sudan: "Sudan",
  somali: "Somalia",
  etiyopya: "Ethiopia",
  kenya: "Kenya",
  gana: "Ghana",
  kamerun: "Cameroon",
  kirgizistan: "Kyrgyzstan",
  tacikistan: "Tajikistan",
  hindistan: "India",
  bangladesh: "Bangladesh",
  endonezya: "Indonesia",
  malezya: "Malaysia",
  filipinler: "Philippines",
  pakistan: "Pakistan",
  yemen: "Yemen",
  rusya: "Russia",
  ukrayna: "Ukraine",
  almanya: "Germany",
  fransa: "France",
  ingiltere: "United Kingdom",
  cin: "China",
  "guney afrika": "South Africa",
  mogolistan: "Mongolia",
  nepal: "Nepal",
  arnavutluk: "Albania",
  kosova: "Kosovo",
  bahreyn: "Bahrain",
  "birlesik krallik": "United Kingdom",
  "amerika birlesik devletleri": "United States",
  "birlesik arap emirlikleri": "United Arab Emirates",
  kuveyt: "Kuwait",
  lubnan: "Lebanon",
  umman: "Oman",
  katar: "Qatar",
  "suudi arabistan": "Saudi Arabia",
  tanzanya: "Tanzania",
};

/**
 * Translate a (possibly Turkish) nationality/country name to English. Returns
 * the original name unchanged when no mapping exists, so a name that is already
 * English (or unmapped) still falls through to the caller's own matching.
 */
export function toEnglishCountryName(name: string | undefined | null): string {
  const raw = String(name ?? "").trim();
  if (!raw) return "";
  return TR_TO_EN_COUNTRY[foldTr(raw)] ?? raw;
}

// ---------------------------------------------------------------------------
// Allowlist matching — exact token-set equality, IDOR-safe.
//
// An allowlist entry matches a query iff their DISTINCTIVE token sets are
// equal (order-independent). Generic tokens ("üniversitesi", "university")
// are stripped first so they never affect the decision.
//
// Exact-set equality (not mere subset) is required for safety: a subset rule
// would let a single-token entry like "Beykoz" match a DIFFERENT institution
// such as "Beykoz Lojistik MYO" (which merely contains the token "beykoz").
// It also still correctly rejects look-alikes — "Beykent" ({beykent}) never
// equals "Kent" ({kent}); "İstanbul Medipol" ({istanbul,medipol}) never
// equals "Ankara Medipol" ({ankara,medipol}).
// ---------------------------------------------------------------------------
const GENERIC_TOKENS: ReadonlySet<string> = new Set([
  "universitesi",
  "university",
  "univ",
]);

/**
 * The Turkish-folded distinctive tokens of a university name (generic tokens
 * like "university"/"üniversitesi" removed). Exported so the adapter can match
 * SIT's live combobox option text against the same folded token basis.
 */
export function distinctiveTokens(name: string): string[] {
  return fold(name)
    .split(" ")
    .filter((t) => t.length > 1 && !GENERIC_TOKENS.has(t));
}

const SIT_ALLOWLIST_TOKENS: ReadonlyArray<{ name: string; tokens: string[] }> =
  SIT_ALLOWLIST.map((name) => ({ name, tokens: distinctiveTokens(name) }));

function distinctiveTokenKey(tokens: readonly string[]): string {
  return [...tokens].sort().join("\u0000");
}

// Explicit catalog/CRM aliases only. Keep this exact-token map narrow instead
// of weakening the allowlist subset guard: extra tokens must still fail closed.
const SIT_UNIVERSITY_ALIASES: ReadonlyMap<string, string> = new Map([
  [
    distinctiveTokenKey(distinctiveTokens("Istanbul Galata University")),
    "Galata Üniversitesi",
  ],
]);

/**
 * Resolve a free-form university name to its canonical allowlist entry, or
 * null when the name is not one of the 11 agreed universities.
 *
 * Two tiers, both operating on Turkish-folded distinctive tokens:
 *
 *   Tier 1 — EXACT token-set equality (highest confidence). Full catalog names
 *   ("İstanbul Aydın Üniversitesi" → {istanbul, aydin}) match their allowlist
 *   entry outright.
 *
 *   Tier 2 — FLEXIBLE subset: the query's tokens are a subset of exactly ONE
 *   allowlist entry's tokens. This resolves short portal names ("Aydin
 *   University" → {aydin}) to their full catalog entry ("İstanbul Aydın
 *   Üniversitesi" → {istanbul, aydin}) WITHOUT the IDOR risk of the reverse
 *   direction: we never let a query carrying EXTRA tokens (e.g. "Beykoz
 *   Lojistik MYO" → {beykoz, lojistik, myo}) match a shorter entry ("Beykoz" →
 *   {beykoz}). Requiring a UNIQUE containing entry also rejects ambiguous bare
 *   tokens shared by several entries (e.g. {istanbul} alone → 3 entries → no
 *   match), while look-alikes stay rejected ({cyprus, aydin} ⊄ {istanbul,
 *   aydin}; {beykent} ⊄ {istanbul, kent}; {istanbul, medipol} ⊄ {ankara,
 *   medipol}).
 */
export function matchAllowedUniversity(name: string): string | null {
  const rawQueryTokens = distinctiveTokens(name);
  const explicitAlias = SIT_UNIVERSITY_ALIASES.get(
    distinctiveTokenKey(rawQueryTokens),
  );
  if (explicitAlias) return explicitAlias;

  const queryTokens = new Set(rawQueryTokens);
  if (queryTokens.size === 0) return null;

  // Tier 1 — exact token-set equality: same size AND every entry token present.
  for (const entry of SIT_ALLOWLIST_TOKENS) {
    if (entry.tokens.length === 0) continue;
    if (
      entry.tokens.length === queryTokens.size &&
      entry.tokens.every((t) => queryTokens.has(t))
    ) {
      return entry.name;
    }
  }

  // Tier 2 — flexible subset: every query token appears in the entry, and this
  // holds for exactly one allowlist entry (unambiguous short-name resolution).
  const subsetMatches = SIT_ALLOWLIST_TOKENS.filter(
    (entry) =>
      entry.tokens.length > 0 &&
      [...queryTokens].every((t) => entry.tokens.includes(t)),
  );
  if (subsetMatches.length === 1) {
    return subsetMatches[0].name;
  }

  return null;
}

/** True when `name` is one of the 11 allowed SIT universities. */
export function isAllowedUniversity(name: string): boolean {
  return matchAllowedUniversity(name) !== null;
}

// ---------------------------------------------------------------------------
// SIT membership (FAS) — authoritative "should this go through SIT?" check.
//
// Being present in the SIT CATALOG (zoho_universities / zoho_programs) is NOT
// membership. Membership = the universities FAS actually applies to VIA the SIT
// channel — the agreed SIT_ALLOWLIST above (derived from FAS's routing matrix).
// Direct-access universities that FAS applies to through their OWN panels
// (e.g. Altınbaş / İstanbul Okan / Üsküdar) are intentionally ABSENT and must
// never be pushed into SIT.
//
// An optional env var SIT_MEMBER_UNIVERSITIES (comma / semicolon / newline
// separated university names) EXTENDS — never shrinks — this set without a code
// change, except for explicit direct-portal exclusions which always win.
//
// TODO(Dr. Namazcı): confirm the definitive SIT member university list.
// ---------------------------------------------------------------------------
export function isSitMember(
  universityNameOrId: string | null | undefined,
  dynamicMembers?: readonly string[],
): boolean {
  if (universityNameOrId == null) return false;
  const name = String(universityNameOrId).trim();
  if (name === "") return false;

  if (isSitExcludedUniversity(name)) return false;

  // Authoritative agreed list (token-set matched, IDOR-safe).
  if (isAllowedUniversity(name)) return true;

  // Dynamic DB "Members" list (portal_account_universities, panel-managed) —
  // matched the same token-set way so a university added via the panel is
  // recognized without a code change. UNION with the agreed list — never
  // removes a member the agreed list already grants (see module doc).
  if (dynamicMembers && dynamicMembers.length > 0) {
    const queryTokens = new Set(distinctiveTokens(name));
    for (const entry of dynamicMembers) {
      if (fold(entry) === fold(name)) return true;
      const entryTokens = distinctiveTokens(entry);
      if (
        entryTokens.length > 0 &&
        entryTokens.length === queryTokens.size &&
        entryTokens.every((t) => queryTokens.has(t))
      ) {
        return true;
      }
    }
  }

  // Optional env extension — kept a UNION with the agreed list so it can only
  // ADD members, never remove one.
  const extra = (process.env.SIT_MEMBER_UNIVERSITIES ?? "")
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (extra.length === 0) return false;

  const folded = fold(name);
  const queryTokens = new Set(distinctiveTokens(name));
  for (const entry of extra) {
    if (fold(entry) === folded) return true;
    const entryTokens = distinctiveTokens(entry);
    if (
      entryTokens.length > 0 &&
      entryTokens.length === queryTokens.size &&
      entryTokens.every((t) => queryTokens.has(t))
    ) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Program language-of-instruction compatibility.
//
// SIT program names commonly carry the language ("... (English)" / "İngilizce"
// / "Türkçe"). When the desired program names a language, an option is only
// compatible if it names the same language (or names none — open-world). This
// prevents picking a Turkish-medium program for an English request and vice
// versa, on top of programMatch's own English hard filter.
// ---------------------------------------------------------------------------
type Lang = "en" | "tr" | "other" | null;

function detectLang(folded: string): Lang {
  if (/\b(ingilizce|english)\b/.test(folded)) return "en";
  if (/\b(turkce|turkish)\b/.test(folded)) return "tr";
  if (
    /\b(almanca|german|fransizca|french|arapca|arabic|rusca|russian)\b/.test(
      folded,
    )
  ) {
    return "other";
  }
  return null;
}

/**
 * True when `candidateName`'s language is compatible with `desiredName`'s.
 * Compatible when: the desired program names no language, OR the candidate
 * names no language, OR both name the same language.
 */
export function isLanguageCompatible(
  desiredName: string,
  candidateName: string,
): boolean {
  const want = detectLang(fold(desiredName));
  if (want === null) return true;
  const have = detectLang(fold(candidateName));
  if (have === null) return true;
  return want === have;
}
