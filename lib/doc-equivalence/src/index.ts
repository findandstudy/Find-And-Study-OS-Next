export type DocEquivalenceGroupId =
  | "passport"
  | "photo"
  | "hs_certificate"
  | "hs_transcript"
  | "bachelors_certificate"
  | "bachelors_transcript"
  | "masters_certificate"
  | "masters_transcript"
  | "language_proof"
  | "cv"
  | "sop"
  | "equivalency_letter"
  | "diploma_certificate"
  | "diploma_transcript"
  | "ssc_marks_sheet"
  | "lor"
  | "essay"
  | "experience_letters"
  | "other_certificates_documents";

export interface DocEquivalenceGroup {
  id: DocEquivalenceGroupId;
  applyKeys: string[];
  canonicalTypes: string[];
}

export const DOC_EQUIVALENCE_GROUPS: DocEquivalenceGroup[] = [
  {
    id: "passport",
    applyKeys: ["passport"],
    canonicalTypes: ["passport"],
  },
  {
    id: "photo",
    applyKeys: ["photo", "photograph"],
    canonicalTypes: ["photo"],
  },
  {
    id: "hs_certificate",
    applyKeys: ["hs_diploma"],
    canonicalTypes: [
      "class_12th_hsc_certificate",
      "high_school_diploma_translation",
      "diploma_certificate",
    ],
  },
  {
    id: "hs_transcript",
    applyKeys: ["hs_transcript"],
    canonicalTypes: ["class_12th_hsc_marks_sheet", "diploma_transcript"],
  },
  {
    id: "ssc_marks_sheet",
    applyKeys: [],
    canonicalTypes: ["class_10th_ssc_marks_sheet"],
  },
  {
    id: "bachelors_certificate",
    applyKeys: ["bachelor_diploma"],
    canonicalTypes: [
      "bachelors_certificate",
      "bachelors_provisional_certificate",
    ],
  },
  {
    id: "bachelors_transcript",
    applyKeys: ["bachelor_transcript"],
    canonicalTypes: [
      "bachelors_transcript",
      "bachelors_transcript_all_semesters",
    ],
  },
  {
    id: "masters_certificate",
    applyKeys: ["master_diploma"],
    canonicalTypes: ["masters_certificate", "masters_provisional_certificate"],
  },
  {
    id: "masters_transcript",
    applyKeys: ["master_transcript"],
    canonicalTypes: ["masters_transcript", "masters_transcript_all_semesters"],
  },
  {
    id: "language_proof",
    applyKeys: ["language_proof"],
    canonicalTypes: ["ielts_pte_gre_gmat_toefl_duolingo"],
  },
  {
    id: "cv",
    applyKeys: ["cv"],
    canonicalTypes: ["cv"],
  },
  {
    id: "sop",
    applyKeys: ["sop"],
    canonicalTypes: ["sop"],
  },
  {
    id: "equivalency_letter",
    applyKeys: ["equivalency_letter"],
    canonicalTypes: ["diploma_recognition"],
  },
  {
    id: "lor",
    applyKeys: [],
    canonicalTypes: ["lor"],
  },
  {
    id: "essay",
    applyKeys: [],
    canonicalTypes: ["essay"],
  },
  {
    id: "experience_letters",
    applyKeys: [],
    canonicalTypes: ["experience_letters"],
  },
  {
    id: "other_certificates_documents",
    applyKeys: [],
    canonicalTypes: ["other_certificates_documents"],
  },
];

const TYPE_TO_GROUP: Map<string, DocEquivalenceGroupId> = (() => {
  const m = new Map<string, DocEquivalenceGroupId>();
  for (const group of DOC_EQUIVALENCE_GROUPS) {
    for (const k of group.applyKeys) m.set(k.toLowerCase(), group.id);
    for (const c of group.canonicalTypes) m.set(c.toLowerCase(), group.id);
  }
  return m;
})();

/**
 * Returns the equivalence group for any document type string (apply key or
 * canonical type), or null if the type isn't part of any known group.
 *
 * Comparison is case-insensitive.
 */
export function getDocEquivalenceGroup(
  type: string | null | undefined,
): DocEquivalenceGroupId | null {
  if (!type) return null;
  return TYPE_TO_GROUP.get(String(type).toLowerCase()) ?? null;
}

/**
 * True iff the two document type strings refer to the same logical document.
 * E.g. "hs_diploma" (apply key) ≡ "class_12th_hsc_certificate" (canonical).
 */
export function areEquivalentDocTypes(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ga = getDocEquivalenceGroup(a);
  if (!ga) return false;
  return ga === getDocEquivalenceGroup(b);
}

/**
 * Returns all canonical document types (the values stored in
 * `documentRequirements.documentType` / `documents.type` for student-library
 * uploads) that are equivalent to the given type. Returns the input type
 * itself if it doesn't belong to any known group.
 */
export function getEquivalentCanonicalTypes(type: string): string[] {
  const g = getDocEquivalenceGroup(type);
  if (!g) return [type.toLowerCase()];
  const group = DOC_EQUIVALENCE_GROUPS.find((x) => x.id === g)!;
  return [...group.canonicalTypes];
}

/**
 * Returns all known type strings (apply keys + canonical types) equivalent to
 * the input. Returns just the input itself if no group matches.
 */
export function getAllEquivalentTypes(type: string): string[] {
  const g = getDocEquivalenceGroup(type);
  if (!g) return [type.toLowerCase()];
  const group = DOC_EQUIVALENCE_GROUPS.find((x) => x.id === g)!;
  return Array.from(
    new Set(
      [...group.applyKeys, ...group.canonicalTypes].map((s) => s.toLowerCase()),
    ),
  );
}

export interface ExistingDocLike {
  type: string | null | undefined;
}

/**
 * From a list of student documents, find the most recent one whose type is
 * equivalent to `applyKey`. Returns null if none match.
 *
 * `pickLatest` is used to break ties when multiple equivalent docs exist.
 */
export function findEquivalentDoc<T extends ExistingDocLike>(
  applyKey: string,
  docs: ReadonlyArray<T>,
  pickLatest: (a: T, b: T) => T = (a, _b) => a,
): T | null {
  const targetGroup = getDocEquivalenceGroup(applyKey);
  if (!targetGroup) return null;
  let best: T | null = null;
  for (const d of docs) {
    if (getDocEquivalenceGroup(d.type) === targetGroup) {
      best = best ? pickLatest(d, best) : d;
    }
  }
  return best;
}

/**
 * Equivalence groups the apply form expects per study level. Mirrors the
 * client-side `DEGREE_DOC_MAP` in `Programs.tsx` so the server-side auto-link
 * logic knows which of the student's existing docs are relevant for a new
 * application at a given level — independent of the (sparser) staff-portal
 * `documentRequirementsTable`.
 *
 * Keys here are normalized study-level ids (the same values
 * `normalizeStudyLevel` in `applications.ts` returns):
 *   "pre_bachelors", "bachelors", "masters", "phd", "others"
 *
 * Keep this in sync with `DEGREE_DOC_MAP` in
 * `artifacts/edcons/src/pages/public/Programs.tsx`.
 */
export const APPLY_FORM_GROUPS_BY_LEVEL: Record<
  string,
  DocEquivalenceGroupId[]
> = {
  pre_bachelors: [
    "passport",
    "photo",
    "hs_certificate",
    "hs_transcript",
    "language_proof",
  ],
  bachelors: [
    "passport",
    "photo",
    "hs_certificate",
    "hs_transcript",
    "language_proof",
  ],
  masters: [
    "passport",
    "photo",
    "bachelors_certificate",
    "bachelors_transcript",
    "equivalency_letter",
    "cv",
    "sop",
    "language_proof",
  ],
  phd: [
    "passport",
    "photo",
    "bachelors_certificate",
    "bachelors_transcript",
    "masters_certificate",
    "masters_transcript",
    "equivalency_letter",
    "cv",
    "sop",
    "language_proof",
  ],
  others: [
    "passport",
    "photo",
    "hs_certificate",
    "hs_transcript",
    "language_proof",
  ],
};

/**
 * Returns the set of equivalence groups that are relevant for a new
 * application at the given normalized level. Combines the apply form's
 * per-level expectations with any extra canonical doc types from the
 * staff-portal requirement rows the caller already loaded.
 *
 * Returns null when the level is unknown — callers should treat that as
 * "permissive: link any doc the student has".
 */
export function getRelevantGroupsForLevel(
  normalizedLevel: string | null | undefined,
  extraCanonicalTypes: ReadonlyArray<string> = [],
): Set<DocEquivalenceGroupId> | null {
  if (!normalizedLevel) return null;
  const base = APPLY_FORM_GROUPS_BY_LEVEL[normalizedLevel];
  if (!base) return null;
  const out = new Set<DocEquivalenceGroupId>(base);
  for (const t of extraCanonicalTypes) {
    const g = getDocEquivalenceGroup(t);
    if (g) out.add(g);
  }
  return out;
}

/**
 * Given an array of canonical mandatory document types and a set of types
 * the student already has on file (any kind of type string), returns the
 * subset of mandatory types NOT yet covered (using equivalence).
 */
export function findMissingMandatoryTypes(
  mandatoryCanonicalTypes: ReadonlyArray<string>,
  uploadedTypes: ReadonlySet<string>,
): string[] {
  const uploadedGroups = new Set<DocEquivalenceGroupId>();
  uploadedTypes.forEach((t) => {
    const g = getDocEquivalenceGroup(t);
    if (g) uploadedGroups.add(g);
  });
  const missing: string[] = [];
  for (const m of mandatoryCanonicalTypes) {
    const g = getDocEquivalenceGroup(m);
    if (!g) {
      if (!uploadedTypes.has(m.toLowerCase())) missing.push(m);
      continue;
    }
    if (!uploadedGroups.has(g)) missing.push(m);
  }
  return missing;
}
