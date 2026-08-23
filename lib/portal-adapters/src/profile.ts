import { fold } from "./programMatch.js";
import { buildSignedDocumentPath } from "./documentSigning.js";
import { logger } from "./browser.js";
import type { SubmitProfile, SubmitFiles, StudentDocumentRef } from "./types.js";

// ---------------------------------------------------------------------------
// Document-type mapping
// ---------------------------------------------------------------------------
export type DocType = keyof SubmitFiles;

/**
 * Maps a free-form document label (from CRM, file name, etc.) to one of the
 * four canonical SubmitFiles keys, or null when unrecognised.
 *
 * transcript also matches: marks, marksheet, result, grade
 */
export function mapDocType(raw: string): DocType | null {
  const f = fold(raw);
  if (/photo|resim|fotograf|foto\b/.test(f))                                          return "photo";
  if (/passport|pasaport/.test(f))                                                    return "passport";
  // transcript: includes hsc (Higher Secondary Certificate) mark/result documents
  if (/transcript|marks|marksheet|result|grade|hsc/.test(f))                         return "transcript";
  // diploma: includes generic certificate types and translated copies of diplomas
  if (/diploma|degree|mezuniyet|certificate|translation/.test(f))                    return "diploma";
  if (/ielts|toefl|yds|yokdil|english|language|proficiency|dil belge|dil yeterlilik/.test(f)) return "english";
  if (/motivation|niyet|statement of purpose|\bsop\b|cover letter|onyazi/.test(f)) return "motivation";
  if (/recommendation|reference|tavsiye|referans/.test(f)) return "recommendation";
  return null;
}

// ---------------------------------------------------------------------------
// Required document types — used by workers to validate files before submit
// ---------------------------------------------------------------------------
export const REQUIRED_DOCS: DocType[] = ["photo", "passport", "transcript", "diploma"];

// ---------------------------------------------------------------------------
// Document URL extraction — for portals whose CREATE step is a URL-fetching
// webhook (e.g. SIT). Kept here (shared by both profile builders) so the two
// builders never drift on how photo_url / documents[] are derived.
// ---------------------------------------------------------------------------

/** A raw CRM `documents` row as read by the profile builders. */
export interface RawDocumentRow {
  /** Document row id — required to build a signed URL for base64-only rows. */
  id?: number | null;
  type: string | null;
  name?: string | null;
  fileUrl?: string | null;
  fileKey?: string | null;
  fileData?: string | null;
  sizeBytes?: number | null;
  mimeType?: string | null;
}

/** True for the CRM photo document types (mirrors the /students/:id/photo query). */
function isPhotoType(type: string): boolean {
  return /^(photo|photograph)$/i.test(type.trim());
}

/**
 * The "prior education" institution to report, keyed by the APPLIED level: a
 * Master applicant's completed education is their Bachelor school, a PhD
 * applicant's is their Master school, and everyone else (Bachelor/Associate)
 * reports a high school. Falls back down the chain when the level-specific field
 * is empty so we never report an empty prior school when SOME school is known.
 */
export function selectPriorSchoolName(
  level: string | null | undefined,
  schools: {
    highSchool?: string | null;
    universityBachelor?: string | null;
    universityMaster?: string | null;
  },
): string | undefined {
  const f = fold(level ?? "");
  const hs = schools.highSchool?.trim() || undefined;
  const ba = schools.universityBachelor?.trim() || undefined;
  const ma = schools.universityMaster?.trim() || undefined;
  if (/doktora|phd|doctora|doctoral/.test(f)) return ma || ba || hs;
  if (/yukseklisans|yuksek lisans|master|graduate/.test(f)) return ba || hs;
  return hs;
}

/**
 * True when `u`'s path is one of OUR OWN session-gated asset routes
 * (`/api/documents/:id/file`, `/api/students/:id/photo`) with no signature —
 * i.e. it looks like an absolute/relative URL but an external, session-less
 * fetcher (an n8n create webhook) would get a 401/403 from it. A handful of
 * legacy rows store exactly this kind of self-referential path in `fileUrl`
 * (it's a perfectly good URL for an authenticated browser, just not for an
 * external system), so it must never be handed to an external webhook as-is.
 */
function isSelfReferentialAssetPath(u: string): boolean {
  try {
    const path = new URL(u, "http://internal").pathname;
    return /^\/api\/(documents\/\d+\/file|students\/\d+\/photo)\/?$/.test(path);
  } catch {
    return false;
  }
}

/**
 * A row's genuinely PUBLIC, externally-fetchable url — i.e. an absolute
 * http(s) URL that is NOT one of our own session-gated asset routes.
 *
 * `fileKey` is deliberately excluded: it is an object-storage KEY (e.g.
 * "documents/abc123.pdf"), not a fetchable URL, so treating it as one used to
 * silently hand external webhooks a broken/unreachable link.
 */
function publicDocUrl(r: RawDocumentRow): string | undefined {
  const u = r.fileUrl?.trim();
  if (!u || !/^https?:\/\//i.test(u) || isSelfReferentialAssetPath(u)) return undefined;
  return u;
}

/**
 * A row's fetchable URL for a URL-fetching create webhook.
 *
 * Order: genuine public fileUrl (see `publicDocUrl`) → for any row that has
 * content but no genuine public URL (object-storage `fileKey`, base64
 * `fileData`, or a self-referential/relative `fileUrl`), a signed, auth-free
 * document-endpoint path (`/api/documents/:id/file?exp=&sig=`) the external
 * webhook can fetch — the signed endpoint serves ALL storage backends
 * uniformly, so this single fallback covers fileKey and fileData alike.
 * Returns undefined only for empty stubs, or when signing has no id / no
 * signing secret configured — the caller then skips the row (best-effort).
 */
export function docFetchUrl(r: RawDocumentRow): string | undefined {
  const direct = publicDocUrl(r);
  if (direct) return direct;
  const hasContent = !!(r.fileKey?.trim() || r.fileData?.trim() || r.fileUrl?.trim());
  if (hasContent && r.id != null) {
    const signed = buildSignedDocumentPath(r.id);
    if (signed) return signed;
  }
  return undefined;
}

/**
 * Extracts a student's photo URL + document URLs from their raw CRM `documents`
 * rows, for portals whose create webhook fetches files by URL (e.g. SIT).
 *
 * - `photoUrl`: the FIRST content-bearing photo/photograph row that has a
 *   GENUINE public url (an absolute http(s) URL that is not one of our own
 *   session-gated asset routes — see `publicDocUrl`). Rows without one
 *   (base64-only, object-storage `fileKey`-only, or a self-referential
 *   `fileUrl`) have no public url, so `hasPhotoDoc` is set instead and the
 *   caller falls back to a signed student-photo endpoint URL. The photo is
 *   excluded from `documents`.
 * - `documents`: every other non-deleted row that has a fetchable URL —
 *   genuine public `fileUrl`, OR (for `fileKey`/`fileData`/self-referential
 *   `fileUrl` rows) a signed, auth-free document-endpoint URL the external
 *   webhook can fetch.
 *
 * Only empty stubs (no content in any field) are skipped. URLs are passed
 * through as stored (not validated here); the consuming adapter logs any
 * non-http(s) URL. Never throws.
 */
export function extractStudentDocumentRefs(rows: RawDocumentRow[]): {
  photoUrl?: string;
  hasPhotoDoc: boolean;
  documents: StudentDocumentRef[];
} {
  let photoUrl: string | undefined;
  let hasPhotoDoc = false;
  const documents: StudentDocumentRef[] = [];
  // One document per type: callers pass rows ordered newest-first
  // (created_at DESC), so the FIRST fetchable row per type wins — duplicate
  // older uploads of the same type are skipped instead of all being sent.
  const seenTypes = new Set<string>();

  for (const r of rows) {
    const type = (r.type ?? "").trim();
    if (!type) continue;

    if (isPhotoType(type)) {
      // A photo row exists even when it has no fetchable URL (base64 fileData
      // only). Callers use hasPhotoDoc to fall back to a signed photo-endpoint
      // URL. Empty stubs (no content in any field) don't count.
      if (r.fileData || r.fileKey || r.fileUrl) hasPhotoDoc = true;
      const purl = publicDocUrl(r);
      if (purl && !photoUrl) photoUrl = purl; // first content-bearing photo wins
      continue;
    }

    const typeKey = type.toLowerCase();
    if (seenTypes.has(typeKey)) continue;
    const url = docFetchUrl(r);
    if (!url) continue;
    seenTypes.add(typeKey);
    documents.push({
      type,
      name: r.name ?? undefined,
      url,
      size: r.sizeBytes ?? undefined,
      mime: r.mimeType ?? undefined,
    });
  }

  return { photoUrl, hasPhotoDoc, documents };
}

// ---------------------------------------------------------------------------
// Additive pure helpers — Altınbaş Faz-B (derive new profile fields)
// ---------------------------------------------------------------------------

/**
 * Best-effort legacy address split used by existing non-Altınbaş adapters.
 *
 * Rules (additive, non-breaking):
 *   - `street` = the entire raw address string (trimmed)
 *   - `city` = text before the first comma, or the whole value without comma
 *   - `zip` remains empty
 *
 * Altınbaş never treats this derived city as authoritative: buildProfile maps
 * its `addressCity` only from the dedicated CRM field.
 *
 * Edge cases: blank / undefined address → all three parts are `""`.
 */
export function deriveAddressParts(address: string | undefined): {
  street: string;
  city: string;
  zip: string;
} {
  const raw = address?.trim() ?? "";
  if (!raw) return { street: "", city: "", zip: "" };
  const commaIdx = raw.indexOf(",");
  const city = commaIdx !== -1 ? raw.slice(0, commaIdx).trim() : raw;
  return { street: raw, city, zip: "" };
}

/**
 * Minimal E.164 dial-code → country-name lookup table (covers the nationalities
 * most commonly seen in EduConsult CRM data). Sorted longest-prefix first so
 * the first match is always the most specific.
 */
const DIAL_CODE_MAP: [string, string][] = [
  ["+355", "Albania"],       ["+213", "Algeria"],      ["+376", "Andorra"],
  ["+244", "Angola"],        ["+374", "Armenia"],       ["+994", "Azerbaijan"],
  ["+973", "Bahrain"],       ["+880", "Bangladesh"],    ["+375", "Belarus"],
  ["+501", "Belize"],        ["+229", "Benin"],         ["+975", "Bhutan"],
  ["+591", "Bolivia"],       ["+387", "Bosnia and Herzegovina"],
  ["+267", "Botswana"],      ["+55", "Brazil"],         ["+673", "Brunei"],
  ["+359", "Bulgaria"],      ["+226", "Burkina Faso"],  ["+257", "Burundi"],
  ["+855", "Cambodia"],      ["+237", "Cameroon"],      ["+1", "Canada"],
  ["+236", "Central African Republic"],
  ["+235", "Chad"],          ["+56", "Chile"],          ["+86", "China"],
  ["+57", "Colombia"],       ["+242", "Congo"],         ["+506", "Costa Rica"],
  ["+385", "Croatia"],       ["+53", "Cuba"],           ["+357", "Cyprus"],
  ["+420", "Czech Republic"],
  ["+45", "Denmark"],        ["+253", "Djibouti"],      ["+593", "Ecuador"],
  ["+20", "Egypt"],          ["+503", "El Salvador"],   ["+240", "Equatorial Guinea"],
  ["+291", "Eritrea"],       ["+372", "Estonia"],       ["+251", "Ethiopia"],
  ["+358", "Finland"],       ["+33", "France"],         ["+241", "Gabon"],
  ["+220", "Gambia"],        ["+995", "Georgia"],       ["+49", "Germany"],
  ["+233", "Ghana"],         ["+30", "Greece"],         ["+502", "Guatemala"],
  ["+224", "Guinea"],        ["+245", "Guinea-Bissau"], ["+592", "Guyana"],
  ["+509", "Haiti"],         ["+504", "Honduras"],      ["+36", "Hungary"],
  ["+354", "Iceland"],       ["+91", "India"],          ["+62", "Indonesia"],
  ["+98", "Iran"],           ["+964", "Iraq"],          ["+353", "Ireland"],
  ["+972", "Israel"],        ["+39", "Italy"],          ["+225", "Ivory Coast"],
  ["+1876", "Jamaica"],      ["+81", "Japan"],          ["+962", "Jordan"],
  ["+7", "Kazakhstan"],      ["+254", "Kenya"],         ["+965", "Kuwait"],
  ["+996", "Kyrgyzstan"],    ["+856", "Laos"],          ["+371", "Latvia"],
  ["+961", "Lebanon"],       ["+266", "Lesotho"],       ["+231", "Liberia"],
  ["+218", "Libya"],         ["+370", "Lithuania"],     ["+352", "Luxembourg"],
  ["+261", "Madagascar"],    ["+265", "Malawi"],        ["+60", "Malaysia"],
  ["+960", "Maldives"],      ["+223", "Mali"],          ["+356", "Malta"],
  ["+222", "Mauritania"],    ["+230", "Mauritius"],     ["+52", "Mexico"],
  ["+373", "Moldova"],       ["+976", "Mongolia"],      ["+382", "Montenegro"],
  ["+212", "Morocco"],       ["+258", "Mozambique"],    ["+95", "Myanmar"],
  ["+264", "Namibia"],       ["+977", "Nepal"],         ["+31", "Netherlands"],
  ["+64", "New Zealand"],    ["+505", "Nicaragua"],     ["+227", "Niger"],
  ["+234", "Nigeria"],       ["+850", "North Korea"],   ["+47", "Norway"],
  ["+968", "Oman"],          ["+92", "Pakistan"],       ["+507", "Panama"],
  ["+675", "Papua New Guinea"],
  ["+595", "Paraguay"],      ["+51", "Peru"],           ["+63", "Philippines"],
  ["+48", "Poland"],         ["+351", "Portugal"],      ["+974", "Qatar"],
  ["+40", "Romania"],        ["+7", "Russia"],          ["+250", "Rwanda"],
  ["+966", "Saudi Arabia"],  ["+221", "Senegal"],       ["+381", "Serbia"],
  ["+232", "Sierra Leone"],  ["+65", "Singapore"],      ["+421", "Slovakia"],
  ["+386", "Slovenia"],      ["+252", "Somalia"],       ["+27", "South Africa"],
  ["+82", "South Korea"],    ["+211", "South Sudan"],   ["+34", "Spain"],
  ["+94", "Sri Lanka"],      ["+249", "Sudan"],         ["+597", "Suriname"],
  ["+268", "Swaziland"],     ["+46", "Sweden"],         ["+41", "Switzerland"],
  ["+963", "Syria"],         ["+886", "Taiwan"],        ["+992", "Tajikistan"],
  ["+255", "Tanzania"],      ["+66", "Thailand"],       ["+228", "Togo"],
  ["+216", "Tunisia"],       ["+90", "Turkey"],         ["+993", "Turkmenistan"],
  ["+256", "Uganda"],        ["+380", "Ukraine"],       ["+971", "United Arab Emirates"],
  ["+44", "United Kingdom"], ["+1", "United States"],   ["+598", "Uruguay"],
  ["+998", "Uzbekistan"],    ["+58", "Venezuela"],      ["+84", "Vietnam"],
  ["+967", "Yemen"],         ["+260", "Zambia"],        ["+263", "Zimbabwe"],
  ["+93", "Afghanistan"],
];

/** Longest-prefix-first sorted copy (built once). */
const DIAL_MAP_SORTED = [...DIAL_CODE_MAP].sort((a, b) => b[0].length - a[0].length);

/**
 * Derives the country name from an E.164 phone number.
 *
 * Tries each dial code longest-prefix-first so "+1876" matches Jamaica before "+1"
 * matches Canada/US. Returns `undefined` when the phone has no recognisable dial
 * code; falls back to `nationality` when the phone is absent or unrecognised.
 *
 * Edge cases: blank phone or no nationality → `undefined`.
 */
export function derivePhoneCountry(
  phone: string | undefined,
  nationality: string | undefined,
): string | undefined {
  const p = phone?.trim();
  if (p && p.startsWith("+")) {
    for (const [code, country] of DIAL_MAP_SORTED) {
      if (p.startsWith(code)) return country;
    }
  }
  const nat = nationality?.trim();
  return nat || undefined;
}

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Classifies a GPA numeric value as "percentage" (>10), "4.0" (≤4), or
 * "letter" (4–10, ambiguous but closest to a 4-scale variant). Returns
 * `undefined` when gpa is absent.
 */
function classifyGpaType(gpa: string | number | null | undefined): string | undefined {
  if (gpa == null) return undefined;
  const n = typeof gpa === "number" ? gpa : parseFloat(String(gpa).replace(",", "."));
  if (!Number.isFinite(n)) return undefined;
  if (n > 10) return "percentage";
  if (n <= 4) return "4.0";
  return "letter";
}

/**
 * Derives education fields from a student-like plain record (Bachelor priority).
 *
 * Field derivation rules:
 *   - `eduDegree`:    "Bachelor" when `universityBachelor` present; "Master" when
 *                     `universityMaster` present; "High School" when `highSchool`
 *                     present; `undefined` otherwise.
 *   - `eduField`:     not available in the current CRM student schema → `undefined`.
 *   - `eduStartMonth/Year`: not stored in the CRM → `undefined`.
 *   - `eduEndMonth`:  not stored (graduation month absent) → `undefined`.
 *   - `eduEndYear`:   from `graduationYear` (4-digit string); `undefined` if absent.
 *   - `eduGpaType`:   "percentage" / "4.0" / "letter" derived from gpa scale.
 *
 * Accepts `unknown` so callers can pass the raw DB row without casting.
 * Never throws.
 */
export function deriveEducation(student: unknown): {
  eduDegree: string | undefined;
  eduField: string | undefined;
  eduStartMonth: string | undefined;
  eduStartYear: string | undefined;
  eduEndMonth: string | undefined;
  eduEndYear: string | undefined;
  eduGpaType: string | undefined;
} {
  const s = (student != null && typeof student === "object") ? student as Record<string, unknown> : {};

  const hasBachelor = typeof s.universityBachelor === "string" && s.universityBachelor.trim().length > 0;
  const hasMaster   = typeof s.universityMaster   === "string" && s.universityMaster.trim().length > 0;
  const hasHS       = typeof s.highSchool         === "string" && s.highSchool.trim().length > 0;

  let eduDegree: string | undefined;
  if (hasBachelor)   eduDegree = "Bachelor";
  else if (hasMaster) eduDegree = "Master";
  else if (hasHS)    eduDegree = "High School";

  const rawYear = s.graduationYear;
  let eduEndYear: string | undefined;
  if (rawYear != null) {
    const n = Number(rawYear);
    if (Number.isFinite(n) && n > 1900 && n < 2100) eduEndYear = String(n);
  }

  const gpaType = classifyGpaType(s.gpa as string | number | null | undefined);

  return {
    eduDegree,
    eduField:     undefined,
    eduStartMonth: undefined,
    eduStartYear:  undefined,
    eduEndMonth:   undefined,
    eduEndYear,
    eduGpaType:    gpaType,
  };
}

// ---------------------------------------------------------------------------
// buildProfile — construct a SubmitProfile from a plain CRM-agnostic record
// ---------------------------------------------------------------------------
// HARD_REQUIRED fields have no reasonable fallback — a portal submission is
// meaningless without them, so a missing one still throws (with a clear,
// actionable message) and the whole build fails.
const HARD_REQUIRED_FIELDS = [
  "email", "passportNumber", "firstName", "lastName",
  "dateOfBirth", "nationality", "level", "programName", "programId",
] as const;

// SOFT fields are commonly blank in real CRM data (address/phone/parent
// names/gender) and must NEVER crash the whole build — a missing one degrades
// to a logged, reasonable fallback instead (same philosophy as GPA/graduation
// year below: a soft field's absence reports as a portal-side gap, not a
// dropped submission).
const SOFT_FIELDS = ["gender", "fatherName", "motherName", "address", "phone"] as const;

const REQUIRED_FIELDS = [...HARD_REQUIRED_FIELDS, ...SOFT_FIELDS] as const;

type RequiredField = (typeof REQUIRED_FIELDS)[number];

/**
 * Normalizes a raw CRM GPA value into a single numeric GPA.
 *
 * CRM GPA is free-form text and may arrive as:
 *   - a single value: "80.6", "3.5"                → passed through as-is
 *   - a range:        "2.8-3.0", "2,8 – 3,0", "3 to 3.5" → resolved to the
 *                     UPPER bound (the portal accepts a single number only)
 *   - decimal comma:  "2,8"                         → converted to "2.8"
 *   - noisy / suffixed: "91%", "%91", "3.5/4", "GPA 3.2" → FIRST numeric token
 *
 * Empty / null / undefined → undefined (legitimately missing; the adapter's
 * fail-visible Step-3 gate reports it). A non-empty value with NO numeric
 * content ("abc") also returns undefined — GPA is OPTIONAL and must NEVER block
 * a submission. (This used to throw "unparseable GPA", which dropped the whole
 * run for a harmless value like "91%".) NaN is never returned.
 */
export function normalizeGpaRange(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;

  const trimmed = String(raw).trim();
  if (trimmed === "") return undefined;

  // Decimal comma → dot (Turkish-locale CRM entries) before any parsing.
  const norm = trimmed.replace(/,/g, ".");

  // Range "a-b" / "a–b" / "a—b" / "a to b" → upper bound.
  const range = norm.match(
    /^(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)$/i,
  );
  if (range) {
    const upper = Number(range[2]);
    if (Number.isFinite(upper)) return upper;
  }

  // Otherwise take the FIRST numeric token so noisy CRM entries still parse:
  //   "91%" → 91 · "%91" → 91 · "3.5/4" → 3.5 · "GPA 3.2" → 3.2
  const token = norm.match(/\d+(?:\.\d+)?/);
  if (token) {
    const n = Number(token[0]);
    if (Number.isFinite(n)) return n;
  }

  // No numeric content at all → undefined (never throw; GPA is optional).
  return undefined;
}

/**
 * Parse the first finite number from a free-form value, returning undefined
 * instead of NaN/throwing. Used for optional numeric profile fields
 * (graduationYear, languageScore) so a noisy CRM value ("2025-06", "IELTS 6.5")
 * degrades gracefully to "missing" rather than crashing the whole profile build.
 */
function firstFiniteNumber(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  const m = String(raw).replace(/,/g, ".").match(/-?\d+(?:\.\d+)?/);
  if (!m) return undefined;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : undefined;
}

function isBlank(v: unknown): boolean {
  return v == null || v === "";
}

export interface BuildProfileOptions {
  /**
   * Aggregator portals such as United resolve programmes by an exact live
   * university+programme label and do not consume the mutable catalog row id.
   * Keep the global default strict; only an explicitly scoped caller may allow
   * a missing legacy programId.
   */
  allowMissingProgramId?: boolean;
  /**
   * Readiness inspection only. Build an incomplete shape with empty strings so
   * the central preflight can report every missing field in one response.
   * Normal callers remain strict, and a known adapter's fail-closed preflight
   * must run before any browser mutation.
   */
  allowIncompleteProfile?: boolean;
}

export function buildProfile(
  data: Record<string, unknown>,
  options: BuildProfileOptions = {},
): SubmitProfile {
  for (const key of HARD_REQUIRED_FIELDS) {
    if (options.allowIncompleteProfile) continue;
    if (key === "programId" && options.allowMissingProgramId) continue;
    if (isBlank(data[key])) {
      throw new Error(
        `buildProfile: eksik veri: ${key} — profili tamamlayın (missing required field "${key}")`,
      );
    }
  }

  const str = (k: RequiredField) =>
    isBlank(data[k]) ? "" : String(data[k]);

  // SOFT fallbacks — never throw. Each substitution is logged so the gap is
  // visible without killing the whole build (mirrors the GPA/graduation-year
  // degrade-gracefully philosophy above).
  const gender = isBlank(data.gender) ? "" : str("gender");
  if (isBlank(data.gender)) logger.warn('buildProfile: gender boş — "" ile devam');

  const fatherName = isBlank(data.fatherName) ? "" : str("fatherName");
  if (isBlank(data.fatherName)) logger.warn('buildProfile: fatherName boş — "" ile devam');

  const motherName = isBlank(data.motherName) ? "" : str("motherName");
  if (isBlank(data.motherName)) logger.warn('buildProfile: motherName boş — "" ile devam');

  const phone = isBlank(data.phone) ? "" : str("phone");
  if (isBlank(data.phone)) logger.warn('buildProfile: phone boş — "" ile devam');

  const addressWasMissing = isBlank(data.address);
  let address = addressWasMissing ? "" : str("address");
  if (addressWasMissing) {
    const fallback = !isBlank(data.nationality) ? str("nationality") : "-";
    address = fallback;
    logger.warn(
      `buildProfile: address boş — ${fallback === "-" ? "placeholder" : "nationality"} fallback kullanıldı`,
    );
  }

  const nationality = str("nationality");
  const addrParts = deriveAddressParts(addressWasMissing ? undefined : address);
  const edu = deriveEducation(data);

  const cityOfBirthRaw = data.cityOfBirth != null ? String(data.cityOfBirth).trim() : "";
  // Never fabricate a birth city from the current address. The live Altınbaş
  // form marks it optional, but an explicit CRM value can still be submitted.
  const cityOfBirth = cityOfBirthRaw || undefined;
  const explicitStreet =
    data.addressStreet != null ? String(data.addressStreet).trim() : "";
  const explicitCity =
    data.addressCity != null ? String(data.addressCity).trim() : "";
  const explicitZip =
    data.addressZip != null ? String(data.addressZip).trim() :
    data.postalCode != null ? String(data.postalCode).trim() :
    "";

  const visaSupportRaw =
    data.visaSupport != null ? String(data.visaSupport).trim() : "";
  const visaSupport =
    /^(yes|no)$/i.test(visaSupportRaw)
      ? (/^yes$/i.test(visaSupportRaw) ? "Yes" : "No")
      : undefined;

  const intakeTerm =
    data.intakeTerm != null ? String(data.intakeTerm) :
    data.term       != null ? String(data.term)       :
    undefined;

  return {
    email:          str("email"),
    passportNumber: str("passportNumber"),
    firstName:      str("firstName"),
    lastName:       str("lastName"),
    dateOfBirth:    str("dateOfBirth"),
    gender,
    fatherName,
    motherName,
    nationality,
    address,
    phone,
    transferStudent:
      typeof data.transferStudent === "boolean" ? data.transferStudent : undefined,
    hasTcId: typeof data.hasTcId === "boolean" ? data.hasTcId : undefined,
    hasBlueCard:
      typeof data.hasBlueCard === "boolean" ? data.hasBlueCard : undefined,
    level:          str("level"),
    programName:    str("programName"),
    programId:      str("programId"),

    universityName:  data.universityName  != null ? String(data.universityName)  : undefined,
    schoolName:      data.schoolName      != null ? String(data.schoolName)      : undefined,
    gpa:             normalizeGpaRange(data.gpa),
    graduationYear:  firstFiniteNumber(data.graduationYear),
    languageScore:   firstFiniteNumber(data.languageScore),
    passportIssueDate:  data.passportIssueDate  != null ? String(data.passportIssueDate)  : undefined,
    passportExpiryDate: data.passportExpiryDate != null ? String(data.passportExpiryDate) : undefined,

    // Additive — Altınbaş Faz-B
    cityOfBirth,
    addressStreet: explicitStreet || addrParts.street || undefined,
    addressCity:   explicitCity || undefined,
    addressZip:    explicitZip || undefined,
    phoneCountry:  derivePhoneCountry(phone || undefined, nationality || undefined),
    ...edu,
    visaSupport,
    intakeTerm,
  };
}
