import type { Page } from "playwright-core";

// ---------------------------------------------------------------------------
// Session returned by adapter.login()
// ---------------------------------------------------------------------------
export interface AdapterSession {
  page: Page;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared portal <option> shape (used by both openPrograms and availablePrograms)
// ---------------------------------------------------------------------------
/**
 * A single portal programme <option>. `enabled` is true for selectable (open)
 * programmes and false for full/disabled ones. This is the common shape written
 * to `portal_submissions.meta.openPrograms` (quota-full) and
 * `portal_submissions.meta.availablePrograms` (program not in dropdown).
 */
export interface PortalProgramOption {
  value: string;
  name: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Result returned by adapter.submit()
// ---------------------------------------------------------------------------
export interface SubmitResult {
  alreadyExists: boolean;
  submitted: boolean;
  programMissing: boolean;
  /** Human-readable explanation for skips and failures (e.g. program not found detail). */
  detail?: string;
  /**
   * Local /tmp file paths of screenshots taken during the submission flow.
   * The runner uploads these to Object Storage and replaces them with
   * persistent /objects/... references in portal_submissions.screenshotUrls.
   * Optional — adapters that do not capture screenshots omit this field.
   */
  screenshots?: string[];
  /**
   * External reference assigned by the portal (e.g. application UUID from the
   * confirmation page). Optional — not all portals expose this.
   */
  externalRef?: string;
  /**
   * Adapter-specific metadata: programMismatch (Part B resume) and other
   * structured diagnostics that don't fit into the flat SubmitResult fields.
   */
  meta?: Record<string, unknown>;
  /**
   * Document type slots that were required but not supplied to the adapter
   * (e.g. ["passport", "transcript"]). Optional — set by adapters when they
   * detect missing uploads.
   */
  missingDocuments?: string[];
  /**
   * Document slots the adapter attached to the portal form AND positively
   * verified (e.g. the file input reports a selected file). Persisted into
   * portal_submissions.result_json so reconcile reports can detect
   * submissions that went through without document uploads. Optional —
   * currently set by upload-verifying adapters (Topkapı).
   */
  uploadedSlots?: string[];
  /**
   * True when the matched programme exists in the portal but its quota is full
   * ("Kontenjan Dolu"). The submission did NOT proceed. Defaults to false/absent.
   * Set together with requestedProgram + openPrograms so downstream
   * orchestration can supersede the full programme structurally.
   */
  programFull?: boolean;
  /**
   * The CRM-resolved programme that the portal reports as full. Set together
   * with programFull. `value` is the portal <option> value when known.
   */
  requestedProgram?: { value?: string; name: string };
  /**
   * The full Step-4 programme list captured from the portal dropdown. `enabled`
   * is true for selectable (open) programmes and false for full ones. Set
   * together with programFull.
   */
  openPrograms?: PortalProgramOption[];
  /**
   * The full portal dropdown option list captured when the requested programme
   * was NOT found in the dropdown but the dropdown WAS reached. Same shape as
   * openPrograms. Set together with programMissing + resolution="not_in_dropdown"
   * so the orchestrator can supersede to a configured backup programme. MUST be
   * omitted when the dropdown was never reached (login/level/mapping failure) —
   * absence signals "alternatives unknown" and suppresses fallback.
   */
  availablePrograms?: PortalProgramOption[];
  /**
   * Why a programMissing result occurred. "not_in_dropdown" means the dropdown
   * was reached and its options are known (see availablePrograms) — eligible for
   * fallback. Absent for other programMissing causes.
   */
  resolution?: "not_in_dropdown";
  /**
   * True when the application is blocked for the student's nationality — it must
   * go through a specific agency ("exclusive region") instead of the portal.
   * Set either preventively by the runner (portal_university_exclusions lookup,
   * portal never run) or reactively by an adapter that detects an exclusive
   * response. Permanent skip — no retry.
   */
  exclusiveRegion?: boolean;
  /** The agency the application must go through, when known. */
  exclusiveAgency?: string;
  /**
   * True when the target university is NOT a real SIT member for FAS (see
   * isSitMember). The SIT portal was skipped ENTIRELY (no login, no student, no
   * application created) and the application should be handled through the
   * DIRECT channel (its own university panel). Permanent skip — no retry. Set
   * preventively by the runner when SIT_ENFORCE_MEMBERSHIP is on.
   */
  skippedNotMember?: boolean;
  /** Where a skipped submission should be routed instead (e.g. "direct"). */
  routeTo?: "direct";
}

// ---------------------------------------------------------------------------
// Applicant profile — CRM-agnostic flat structure
// ---------------------------------------------------------------------------
export interface SubmitProfile {
  email: string;
  passportNumber: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string; // ISO-8601 date, e.g. "1999-04-15"
  gender: string;
  fatherName: string;
  motherName: string;
  nationality: string;
  address: string;
  phone: string; // local format, no country code where required
  transferStudent?: boolean;
  hasTcId?: boolean;
  hasBlueCard?: boolean;
  level: string;
  programName: string;
  programId: string;
  universityName?: string;
  /**
   * High-confidence identity read directly from the student's passport
   * document. When available, SIT requires it to match before any real portal
   * mutation. When extraction is temporarily unavailable, deterministic
   * identity validation and the required passport document remain mandatory.
   */
  passportIdentityProof?: {
    firstName: string;
    lastName: string;
    passportNumber: string;
    confidence: "high";
    documentId?: number;
  };
  /**
   * External reference already stored on the portal submission currently
   * being retried. Adapters may use this only as scoped dedup/repair evidence;
   * it is not proof that the requested target was submitted successfully.
   */
  portalSubmissionExternalRef?: string;
  schoolName?: string;
  gpa?: number;
  graduationYear?: number;
  languageScore?: number;
  // Passport validity dates (ISO-8601 "YYYY-MM-DD"). Optional — only portals
  // that require them (e.g. Medipol) use these. Sourced from the CRM student record.
  passportIssueDate?: string;
  passportExpiryDate?: string;
  // ---------------------------------------------------------------------------
  // Additive fields — Altınbaş Faz-B (21 → 35). All optional strings.
  // Derived by the profile builder from student/application records.
  // ---------------------------------------------------------------------------
  /** City of birth from the dedicated CRM student field; never address-derived. */
  cityOfBirth?: string;
  /** Explicit street/address line from CRM; never a nationality fallback. */
  addressStreet?: string;
  /** Dedicated current/residence city from CRM; never parsed from free text. */
  addressCity?: string;
  /** Dedicated postal/zip code from CRM. */
  addressZip?: string;
  /** Country name derived from the E.164 phone dial code; falls back to nationality. */
  phoneCountry?: string;
  /** Education degree type of the student's completed education ("Bachelor", "Master", etc.). */
  eduDegree?: string;
  /** Field of study of the completed education (when available in the CRM). */
  eduField?: string;
  /** Month the education programme started, English full name ("September"). */
  eduStartMonth?: string;
  /** 4-digit year the education programme started. */
  eduStartYear?: string;
  /** Month the education programme ended / graduation month, English full name. */
  eduEndMonth?: string;
  /** 4-digit graduation year (from student.graduationYear). */
  eduEndYear?: string;
  /** GPA type hint ("percentage" for 0-100 scale, "4.0" for 0-4 scale, "letter" otherwise). */
  eduGpaType?: string;
  /** Explicit CRM answer to the Altınbaş visa-support question ("Yes" / "No"). */
  visaSupport?: string;
  /** Application intake term (e.g. "Fall 2026", "Spring 2026"). */
  intakeTerm?: string;
  /**
   * Education history from education_records, loaded by the profile builder.
   * Used by Altınbaş Educational modal (FIX-15C) and missing-record gate.
   */
  educationRecords?: Array<{
    level: string;
    schoolName?: string | null;
    country?: string | null;
    city?: string | null;
    fieldOfStudy?: string | null;
    startMonth?: string | null;
    startYear?: number | null;
    endMonth?: string | null;
    endYear?: number | null;
    gpa?: string | null;
    gpaType?: string | null;
    languageScore?: string | null;
  }>;
  /**
   * Legacy student-table education values that predate education_records.
   * Altınbaş uses these only to complete missing fields in historical rows;
   * other adapters may ignore this additive compatibility payload.
   */
  legacyEducation?: {
    highSchool?: string;
    bachelorSchool?: string;
    masterSchool?: string;
    rawGpa?: string;
  };
  // ---------------------------------------------------------------------------
  // Panel-managed mapping data (sourced from portal_program_mapping by the
  // runner, keyed by universityKey). All optional — when absent the adapter
  // falls back to its built-in code defaults (zero behaviour change). When
  // present, these EXTEND/OVERRIDE the built-ins (DB wins). See programMatch.ts.
  // ---------------------------------------------------------------------------
  /**
   * { portal option label → CRM program name } — panel-managed Program Mappings,
   * UNIVERSITY tier. Name-based; consulted by the matcher BEFORE the General tier
   * and BEFORE fuzzy matching. Replaces the removed CRM-programId override path.
   */
  programNameMap?: Record<string, string>;
  /**
   * { portal option label → CRM program name } — GENERAL (all-schools default)
   * tier, already shadowed by any same-label university entry. The matcher
   * consults it only after `programNameMap` yields no hit (University > General).
   */
  programNameMapGeneral?: Record<string, string>;
  /** EN↔TR synonym groups (folded single tokens). Extends built-in synonyms. */
  programSynonyms?: string[][];
  /** Country name/adjective (lowercase) → portal label. Merged over country maps. */
  countryOverrides?: Record<string, string>;
  /**
   * CRM `applications.id` (the portal_submissions.application_id FK). Populated
   * by buildStudentProfile() and used by adapters that need to query their own
   * prior portal_submissions (e.g. Altınbaş pre-flight dangling-record check).
   * Optional — absent in the dry-test CLI path (buildProfileFromApplication).
   */
  applicationDbId?: number;
  /**
   * { CRM programId (string) → portal program id } — explicit ADMIN override.
   * Unlike programNameMap, this targets a catalog entry by raw id and is
   * consulted BEFORE any language filter or fuzzy matching — a deliberate
   * admin decision to route a specific CRM program to a specific portal
   * program regardless of language mismatch (e.g. routing an English-applied
   * student to a Turkish-medium program when no English option exists).
   */
  programIdOverrides?: Record<string, string>;
  // ---------------------------------------------------------------------------
  // Document URLs — for portals whose CREATE step is a webhook that fetches
  // files by URL (e.g. SIT), rather than uploading local files. Populated by
  // the profile builder (which has DB access) from the CRM `documents` rows.
  // File-upload portals ignore these and use SubmitFiles local paths instead.
  // ---------------------------------------------------------------------------
  /**
   * Fetchable URL of the student's photo (CRM `documents` row of type
   * photo/photograph — fileUrl, else fileKey). Absent when there is no photo or
   * only a non-fetchable object-storage key.
   */
  photoUrl?: string;
  /**
   * The student's non-deleted CRM documents as fetchable URLs (fileUrl, else
   * fileKey) with their raw type/name/size/mime. The photo is excluded (carried
   * by `photoUrl`). Empty/absent when the student has no URL-bearing documents.
   */
  studentDocuments?: StudentDocumentRef[];
  // ---------------------------------------------------------------------------
  // Aggregator dynamic membership (multi-portal accounts: United/SIT). Sourced
  // by the runner from portal_account_universities (DB "Members" list) for the
  // routed aggregator, keyed by the account's own university_key. Optional —
  // when the runner didn't route through an aggregator (or the query failed),
  // this is undefined and the adapter falls back to its static allowlist.
  // ---------------------------------------------------------------------------
  memberUniversities?: string[];
}

/**
 * A single student document exposed to URL-fetching create webhooks (e.g. SIT).
 * `url` is the CRM `documents.fileUrl` (preferred) or `fileKey` fallback.
 */
export interface StudentDocumentRef {
  /** Raw CRM document type/label (e.g. "passport", "transcript", "diploma"). */
  type: string;
  /** Original document / file name, when known. */
  name?: string;
  /** Fetchable URL (documents.fileUrl, else fileKey). */
  url: string;
  /** File size in bytes, when known. */
  size?: number;
  /** MIME type, when known. */
  mime?: string;
}

// ---------------------------------------------------------------------------
// A single LIVE portal program option (dropdown value + visible text).
// Returned by adapter.listPrograms() for the admin "Program Eşleme" editor.
// ---------------------------------------------------------------------------
export interface ProgramOption {
  /** The portal <option> value attribute. */
  v: string;
  /** The portal <option> visible text/label. */
  t: string;
}

// ---------------------------------------------------------------------------
// Document file paths (absolute or resolvable by the calling worker)
// ---------------------------------------------------------------------------
export interface SubmitFiles {
  photo?: string;
  passport?: string;
  transcript?: string;
  diploma?: string;
  english?: string;
  motivation?: string;
  recommendation?: string;
}

// ---------------------------------------------------------------------------
// Login credentials (injected by the worker from DB / env)
// ---------------------------------------------------------------------------
export interface AdapterCredentials {
  user: string;
  password: string;
  /**
   * Optional encrypted portal-specific settings resolved by the worker.
   * Adapters must read only documented keys and must never log this object.
   */
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Login options
// ---------------------------------------------------------------------------
export interface LoginOpts {
  headless?: boolean;
  /**
   * Portal credentials.  The worker resolves these from the DB-backed
   * portal_credentials table (or process.env via portalCreds() fallback) and
   * passes them here.  Adapters MUST NOT hard-code credentials.
   */
  credentials?: AdapterCredentials;
}

// ---------------------------------------------------------------------------
// Adapter interface — one implementation per portal family
// ---------------------------------------------------------------------------
export interface UniversityAdapter {
  key: string;
  label: string;

  /**
   * Canonical public login/start URL for this adapter. This is operational
   * metadata, never a credential. The management UI may display it read-only
   * so operators do not create a second, conflicting URL source.
   */
  portalUrl?: string;

  /**
   * Optional human-readable list of university names handled by this adapter.
   * Returned by adapterMetadata() for UI / API display.
   */
  allowlist?: string[];

  /** Returns true when this adapter handles the given university name. */
  matches(name: string): boolean;

  /**
   * Opens a browser session authenticated to the portal.
   *
   * Credentials are resolved (in priority order):
   *   1. opts.credentials  — injected by the worker from DB
   *   2. portalCreds(key)  — reads from process.env (legacy / dev fallback)
   */
  login(opts?: LoginOpts): Promise<AdapterSession>;

  /**
   * Fills and (optionally) submits the application form.
   *
   * @param doSubmit  true (default) = click the final submit button.
   *                  false = fill all steps but stop before submitting —
   *                  useful for dry-run smoke tests of the form flow.
   */
  submit(
    session: AdapterSession,
    profile: SubmitProfile,
    files: SubmitFiles,
    doSubmit?: boolean,
  ): Promise<SubmitResult>;

  /**
   * Optional — poll the live portal for the current status of a submitted
   * application. Used by the periodic status-sync sweep.
   *
   * @param externalRef  The value stored in portal_submissions.external_ref
   *                     (adapter-defined format, e.g. "studentId:applicationId").
   * @returns { status: string } with the raw portal status, or null if not found.
   */
  checkStatus?(
    session: AdapterSession,
    externalRef: string,
  ): Promise<{ status: string } | null>;

  /**
   * Optional — fetch the portal's LIVE program option list (value + text) for
   * a given education level WITHOUT submitting an application. Used by the
   * admin "Program Eşleme" editor to populate mapping dropdowns.
   *
   * The caller owns the session lifecycle (login + creds override + close),
   * mirroring submit(). Adapters that cannot enumerate programs omit this.
   *
   * @param level  CRM education level (e.g. "Bachelor", "Masters (Thesis)").
   *               Adapters map it to their own portal value; absent = default.
   */
  listPrograms?(
    session: AdapterSession,
    level?: string,
  ): Promise<ProgramOption[]>;
}
