const DAY_MS = 24 * 60 * 60 * 1000;

function parseIsoDate(value: string | null | undefined): Date | null {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
  ));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  )
    ? date
    : null;
}

function addUtcYears(date: Date, years: number): Date {
  const next = new Date(date.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export interface AltinbasPassportDatePolicyResult {
  issueDate: string;
  expiryDate: string;
  fallbackFields: Array<"passportIssueDate" | "passportExpiryDate">;
}

/**
 * Altınbaş-only compatibility policy for historical CRM rows collected before
 * the portal required both passport dates. It never changes valid source data
 * and never writes the synthesized values back to the CRM.
 */
export function resolveAltinbasPassportDates(input: {
  dateOfBirth?: string | null;
  passportIssueDate?: string | null;
  passportExpiryDate?: string | null;
  now?: Date;
}): AltinbasPassportDatePolicyResult {
  const now = input.now ?? new Date();
  const today = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const yesterday = new Date(today.getTime() - DAY_MS);
  const dob = parseIsoDate(input.dateOfBirth);
  const sourceIssue = parseIsoDate(input.passportIssueDate);
  const sourceExpiry = parseIsoDate(input.passportExpiryDate);
  const fallbackFields: AltinbasPassportDatePolicyResult["fallbackFields"] = [];

  let issue = sourceIssue;
  if (
    !issue ||
    issue.getTime() > today.getTime() ||
    (dob && issue.getTime() <= dob.getTime())
  ) {
    fallbackFields.push("passportIssueDate");
    const expiryBased = sourceExpiry
      ? addUtcYears(sourceExpiry, -5)
      : addUtcYears(yesterday, -1);
    issue = expiryBased.getTime() <= yesterday.getTime()
      ? expiryBased
      : yesterday;
    if (dob && issue.getTime() <= dob.getTime()) {
      const ageSixteen = addUtcYears(dob, 16);
      issue = ageSixteen.getTime() <= yesterday.getTime()
        ? ageSixteen
        : yesterday;
    }
  }

  let expiry = sourceExpiry;
  if (!expiry || expiry.getTime() <= issue.getTime()) {
    fallbackFields.push("passportExpiryDate");
    expiry = addUtcYears(issue, 5);
  }

  return {
    issueDate: iso(issue),
    expiryDate: iso(expiry),
    fallbackFields,
  };
}

/** Deterministic first-wins selection after caller sorts newest/content first. */
export function selectFirstDocumentPerMappedSlot<T>(
  docs: readonly T[],
  mapSlot: (doc: T) => string | null | undefined,
): T[] {
  const seen = new Set<string>();
  const selected: T[] = [];
  for (const doc of docs) {
    const slot = mapSlot(doc);
    if (!slot || seen.has(slot)) continue;
    seen.add(slot);
    selected.push(doc);
  }
  return selected;
}

const DUPLICATE_SAFE_PORTAL_KEYS = new Set([
  "beykent_university",
  "isik_university",
  "multico",
  "okan_university",
  "sit",
  "study_in_turkey",
  "united_education",
  "uskudar_university",
]);

/**
 * Portals allowed to recover a dedicated city value from historical
 * "City, street" address rows.
 *
 * SIT is intentionally included here under both its worker routing key and
 * adapter key, so legacy applications that pre-date `students.address_city`
 * can still pass SIT's required City / District field.
 */
const LEGACY_CITY_PORTAL_KEYS = new Set([
  ...DUPLICATE_SAFE_PORTAL_KEYS,
  "study_in_turkey",
  // API preflight works with adapter keys while the worker has university
  // routing keys. Accept both representations so the same compatibility rule
  // is evaluated before enqueue and before portal login.
  "sit",
  "beykent",
  "isik",
  "okan",
  "united",
  "uskudar",
]);

const ADDRESS_LIKE_TOKEN_RE =
  /\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|house|plot|apartment|building|floor|block|village|district|province|region|state|mahallesi|mahalle|sokak|cadde|caddesi)\b/iu;

function conservativeLegacyCityCandidate(value: string): string | undefined {
  const candidate = value.trim();
  if (
    candidate.length < 2 ||
    candidate.length > 80 ||
    /\d/u.test(candidate) ||
    !/\p{L}/u.test(candidate) ||
    ADDRESS_LIKE_TOKEN_RE.test(candidate) ||
    candidate.split(/\s+/).length > 5
  ) {
    return undefined;
  }
  return candidate;
}

/**
 * Limits concurrent document normalization to one writer per logical slot.
 * Historical CRM imports can contain duplicate
 * rows for the same file; processing those duplicates in parallel writes to
 * the same temp path and can crash native PDF/image tooling with SIGBUS.
 *
 * Altınbaş keeps its existing policy. SIT is included after a live duplicate
 * document set reproduced exactly that SIGBUS failure. Topkapı remains
 * unchanged.
 */
export function shouldDeduplicateDocumentSlots(universityKey: string): boolean {
  return /altinbas/i.test(universityKey) ||
    DUPLICATE_SAFE_PORTAL_KEYS.has(universityKey);
}

/**
 * Controlled compatibility rule for legacy rows stored as "City, street".
 * It is intentionally scoped to the six new portals and requires an explicit
 * comma boundary. A comma-less address is never reused as a city, and a value
 * equal to nationality is rejected.
 */
export function resolveLegacyAddressCity(input: {
  universityKey: string;
  addressCity?: string | null;
  address?: string | null;
  nationality?: string | null;
}): string | undefined {
  const explicit = input.addressCity?.trim();
  if (explicit) return explicit;
  if (!LEGACY_CITY_PORTAL_KEYS.has(input.universityKey)) return undefined;

  const raw = input.address?.trim() ?? "";
  const comma = raw.indexOf(",");
  if (comma <= 0) return undefined;

  const candidate = conservativeLegacyCityCandidate(raw.slice(0, comma));
  if (!candidate) return undefined;
  const nationality = input.nationality?.trim() ?? "";
  if (
    nationality &&
    candidate.localeCompare(nationality, undefined, { sensitivity: "base" }) === 0
  ) {
    return undefined;
  }
  return candidate;
}

/**
 * Final portal-facing guarantee for residence fields. New records should
 * already carry structured values; this keeps historical rows runnable
 * without writing guessed values back to the CRM.
 */
export function resolvePortalResidenceDefaults(input: {
  universityKey: string;
  addressCity?: string | null;
  postalCode?: string | null;
  address?: string | null;
  nationality?: string | null;
}): { addressCity: string; postalCode: string } {
  const explicitPostal = input.postalCode?.trim();
  const address = input.address?.trim() ?? "";
  const nationality = input.nationality?.trim() ?? "";
  const legacyCity = resolveLegacyAddressCity(input);

  const labelledCity = address.match(
    /(?:residence\s*city|city|district|şehir|ilçe)\s*[:#-]?\s*([^,;\n|]+)/i,
  )?.[1]?.trim();
  const parts = address
    .split(/[\n,;|]+/)
    .map((part) =>
      part
        .replace(/\b\d{5,10}\b/g, "")
        .trim(),
    )
    .filter(Boolean);
  const structuredCity =
    parts.length >= 2
      ? [...parts].reverse().find((candidate) => {
          if (!/[A-Za-zÀ-ž]/.test(candidate)) return false;
          return !nationality ||
            candidate.localeCompare(nationality, undefined, {
              sensitivity: "base",
            }) !== 0;
        })
      : undefined;
  const validLabelledCity =
    labelledCity &&
    (!nationality ||
      labelledCity.localeCompare(nationality, undefined, {
        sensitivity: "base",
      }) !== 0)
      ? labelledCity
      : undefined;
  const postalFromAddress =
    address.match(
      /(?:postal\s*code|postcode|zip\s*code|zip|posta\s*kodu)\s*[:#-]?\s*([A-Z0-9][A-Z0-9 -]{2,10})/i,
    )?.[1]?.trim() ||
    address.match(/(?:^|[\s,;])(\d{5,10})(?=$|[\s,;])/)?.[1];

  return {
    addressCity:
      input.addressCity?.trim() ||
      legacyCity ||
      validLabelledCity ||
      structuredCity ||
      "city",
    postalCode: explicitPostal || postalFromAddress || "10000",
  };
}
