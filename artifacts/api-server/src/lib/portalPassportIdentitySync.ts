export const PASSPORT_IDENTITY_FIELDS = [
  "firstName",
  "lastName",
  "passportNumber",
] as const;

export type PassportIdentityField =
  (typeof PASSPORT_IDENTITY_FIELDS)[number];

export interface PassportIdentityValues {
  firstName: string | null | undefined;
  lastName: string | null | undefined;
  passportNumber: string | null | undefined;
}

export interface PassportIdentitySyncDecision {
  status:
    | "updated"
    | "already_matches"
    | "manual_override"
    | "passport_conflict";
  patch: Partial<Record<PassportIdentityField, string>>;
  mismatchedFields: PassportIdentityField[];
  lockedFields: PassportIdentityField[];
}

const normalizeName = (value: unknown): string =>
  String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const normalizePassport = (value: unknown): string =>
  String(value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

const sameIdentityField = (
  field: PassportIdentityField,
  left: unknown,
  right: unknown,
): boolean => field === "passportNumber"
  ? normalizePassport(left) === normalizePassport(right)
  : normalizeName(left) === normalizeName(right);

/**
 * Decide which passport identity values may replace the current profile.
 * Human-edited fields are immutable to automation. A duplicate passport
 * number also fails closed instead of moving one person's identity onto
 * another CRM record.
 */
export function buildPassportIdentitySyncDecision(input: {
  student: PassportIdentityValues;
  proof: PassportIdentityValues;
  lockedFields?: Iterable<PassportIdentityField>;
  passportConflict?: boolean;
}): PassportIdentitySyncDecision {
  const locked = new Set(input.lockedFields ?? []);
  const mismatchedFields = PASSPORT_IDENTITY_FIELDS.filter((field) =>
    !sameIdentityField(field, input.student[field], input.proof[field])
  );
  const lockedFields = mismatchedFields.filter((field) => locked.has(field));

  // A passport number that belongs to another CRM student is never safe to
  // accept, even when the current profile already contains that same number
  // or a later human edit locked the field. Identity ownership must remain
  // unique and is verified before any automatic update is considered.
  if (input.passportConflict) {
    return {
      status: "passport_conflict",
      patch: {},
      mismatchedFields,
      lockedFields,
    };
  }

  if (mismatchedFields.length === 0) {
    return {
      status: "already_matches",
      patch: {},
      mismatchedFields: [],
      lockedFields: [],
    };
  }

  const patch: Partial<Record<PassportIdentityField, string>> = {};
  for (const field of mismatchedFields) {
    if (locked.has(field)) continue;
    const value = String(input.proof[field] ?? "").trim();
    if (value) patch[field] = value;
  }

  if (Object.keys(patch).length === 0) {
    return {
      status: "manual_override",
      patch,
      mismatchedFields,
      lockedFields,
    };
  }

  return {
    status: "updated",
    patch,
    mismatchedFields,
    lockedFields,
  };
}
