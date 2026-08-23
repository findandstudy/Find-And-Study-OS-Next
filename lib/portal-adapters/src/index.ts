// ---------------------------------------------------------------------------
// @workspace/portal-adapters — public API
// ---------------------------------------------------------------------------

// Core types (PortalCredentials removed — credentials live in .env)
export type {
  AdapterSession,
  SubmitResult,
  SubmitProfile,
  SubmitFiles,
  StudentDocumentRef,
  UniversityAdapter,
} from "./types.js";

// Credential helper — reads from process.env (or injected override)
export {
  portalCreds,
  setCredsOverride,
  clearCredsOverride,
  type ResolvedCreds,
} from "./portalCreds.js";

// Reactive exclusive-region detection (portal response safety net)
export { detectExclusiveRegion } from "./exclusiveRegion.js";

// Browser utilities
export {
  launchPortal,
  saveState,
  closePortal,
  logger,
  type LaunchOpts,
} from "./browser.js";

// Program matching
export {
  fold,
  matchProgram,
  parseTrack,
  levelGroup,
  type ProgramCandidate,
  type MatchResult,
} from "./programMatch.js";

// Signed, auth-free student-photo URLs (external create webhooks)
export {
  buildSignedStudentPhotoPath,
  buildStableSignedStudentPhotoPath,
  buildStableSignedStudentPhotoThumbnailPath,
  verifyStudentPhotoSignature,
} from "./studentPhotoSigning.js";

export {
  buildSignedDocumentPath,
  verifyDocumentSignature,
} from "./documentSigning.js";

// Profile helpers
export {
  mapDocType,
  buildProfile,
  normalizeGpaRange,
  REQUIRED_DOCS,
  extractStudentDocumentRefs,
  selectPriorSchoolName,
  docFetchUrl,
  type DocType,
  type RawDocumentRow,
} from "./profile.js";

// SIT membership guard (used by the runner to skip non-member universities)
export {
  isSitExcludedUniversity,
  isSitMember,
} from "./universities/sit/helpers.js";

// Multico — Central Asian nationality guard (used by the enqueue hook)
export {
  MULTICO_NATIONALITIES,
  isMulticoNationality,
  shouldRouteTopkapiToMultico,
  type MulticoNationality,
} from "./universities/multico/adapter.js";

// Registry
export {
  adapters,
  adapterForUniversity,
  adapterByKey,
  allAdapterKeys,
  adapterMetadata,
  declarativeAdapterKeys,
  isExperimentalAdapterKey,
  isSitFamilyKey,
  GRADUATION_THRESHOLD,
} from "./registry.js";

// Declarative adapter engine
export {
  createDeclarativeAdapter,
  executeStep,
  runSteps,
  checkResult,
  type DeclarativeConfig,
  type DeclarativeStep,
  type DeclarativeCredentials,
  type SubmitCheck,
  type MinimalPage,
  type ProfileField,
  type FileField,
} from "./declarativeAdapter.js";

// DB declarative adapter loader (validates + merges DB-defined adapters)
export {
  declarativeConfigSchema,
  parseDeclarativeConfig,
  isSafePortalUrl,
  rowToRawConfig,
  staticAdapterKeys,
  buildDeclarativeAdaptersFromRows,
  loadDeclarativeAdaptersFromDb,
  invalidateDeclarativeAdapterCache,
  resolveAdapterByKey,
  resolveAdapterForUniversity,
  type ParseResult,
  type DeclarativeAdapterRow,
} from "./dbLoader.js";

// Declarative SPEC engine (richer, versioned, opt-in parallel system)
export {
  adapterSpecSchema,
  parseAdapterSpec,
  specHasJsHook,
  specIsPrivileged,
  type AdapterSpec,
  type SpecStep,
  type SpecParseResult,
  type SpecIssue,
  type SpecCondition,
  type WorkflowState,
  type SpecWorkflow,
  type ProfilePolicy,
  type OutcomeRule,
} from "./declarative/schema.js";

export {
  createSpecAdapter,
  resolveProfileValue,
  applyTransform,
  resolveProgramValue,
  enumerateProgramOptions,
  enumerateProgramCatalog,
  classifyResult,
  evaluateCondition,
  isMutatingSpecStep,
  detectStableWorkflowState,
  runSpecWorkflow,
  applyProfilePolicy,
  classifyOutcomeRules,
  type ProfilePolicyResult,
  type SpecPage,
} from "./declarative/interpreter.js";

export {
  loadSpecAdaptersFromDb,
  invalidateSpecAdapterCache,
  resolveSpecAdapterByKey,
  resolveSpecAdapterForUniversity,
  resolveOverrideSpecAdapterByKey,
  resolveOverrideSpecAdapterForUniversity,
  buildSpecAdapterFromRow,
  buildSpecAdaptersFromRows,
  specRowAllowsJsHook,
  specRowAllowsOverride,
  listSpecVersions,
  maxSpecVersion,
  enabledSpecVersion,
} from "./specLoader.js";
export {
  validatePassportNumber,
  validatePersonName,
  validateDateConsistency,
  validateIdentityFields,
  formatIdentityErrors,
  parseFlexibleDate,
  isPassportExpired,
  type IdentityErrorCode,
  type IdentityValidationError,
  type IdentityFieldsInput,
  type DateConsistencyInput,
} from "./identityValidation.js";
export {
  evaluateSitIdentity,
  evaluateSitSubmissionIdentityGate,
  normalizeSitPassport,
  sitPassportIdentityProofFromDocument,
  type SitIdentityEvaluation,
  type SitIdentityField,
  type SitSubmissionIdentityGate,
} from "./universities/sit/helpers.js";

export {
  portalPreflightManifest,
  evaluatePortalPreflight,
  type PortalPreflightDocument,
  type PortalPreflightField,
  type PortalPreflightIssue,
  type PortalPreflightManifest,
  type PortalPreflightResult,
} from "./preflight.js";
export * from "./applicationReference.js";
