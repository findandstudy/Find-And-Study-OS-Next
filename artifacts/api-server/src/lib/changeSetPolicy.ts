import crypto from "node:crypto";
import { canonicalJson } from "./jsonCanonical";

export const R1_CHANGE_TYPES = [
  "BRAND",
  "LOCALE",
  "NOTIFICATION_TEMPLATE",
  "FEATURE_FLAG",
  "MAINTENANCE_BANNER",
] as const;

export type R1ChangeType = (typeof R1_CHANGE_TYPES)[number];
export type R1DataClass = "PUBLIC" | "INTERNAL";
export type ChangeSetState =
  | "DRAFT"
  | "VALIDATED"
  | "SIMULATED"
  | "IN_REVIEW"
  | "APPROVED"
  | "SCHEDULED"
  | "CANARY"
  | "PUBLISHED"
  | "OBSERVING"
  | "EFFECTIVE"
  | "RETURNED"
  | "REJECTED"
  | "FAILED"
  | "ROLLED_BACK"
  | "REVOKED";

const CHANGE_SET_STATES: readonly ChangeSetState[] = [
  "DRAFT",
  "VALIDATED",
  "SIMULATED",
  "IN_REVIEW",
  "APPROVED",
  "SCHEDULED",
  "CANARY",
  "PUBLISHED",
  "OBSERVING",
  "EFFECTIVE",
  "RETURNED",
  "REJECTED",
  "FAILED",
  "ROLLED_BACK",
  "REVOKED",
];

export type ChangeSetScope =
  | { type: "TENANT"; organizationId: null; legacyBranchId: null }
  | { type: "ORGANIZATION"; organizationId: string; legacyBranchId: null }
  | { type: "LEGACY_BRANCH"; organizationId: string; legacyBranchId: number };

export type R1ChangeSetDraft = {
  tenantId: string;
  changeType: R1ChangeType;
  title: string;
  purpose: string;
  ownerPrincipalId: string;
  makerPrincipalId: string;
  targetScope: ChangeSetScope;
  baseVersion: number;
  proposedVersion: number;
  baseHash: string;
  proposedHash: string;
  baseConfig: Record<string, unknown>;
  proposedConfig: Record<string, unknown>;
  semanticDiff: {
    changedKeys: string[];
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  };
  riskTier: "R1";
  dataClass: R1DataClass;
  affectedTenantCount: 1;
  affectedBranchCount: 0 | 1;
  affectedPrincipalCount: 0;
  affectedCaseCount: 0;
  affectedIntegrationCount: 0;
  dependencyVersions: { changeSetPolicy: "v1" };
  compatibilityRange: "change-set-policy-v1";
  approvalPolicyVersion: string;
  rolloutStrategy: {
    kind: "PREVIEW_THEN_SINGLE_TENANT";
    canaryRequired: true;
  };
  canaryScope: {
    kind: "SERVER_SELECTED_SAFE_COHORT";
    targetScope: ChangeSetScope;
  };
  abortConditions: [
    { metric: "policy_violation_count"; operator: ">"; threshold: 0 },
    { metric: "slo_violation_count"; operator: ">"; threshold: 0 },
  ];
  observationWindowSeconds: 3600;
  rollbackStrategy: {
    kind: "RESTORE_BASE_VERSION";
    version: number;
    hash: string;
  };
  status: "DRAFT";
  reviewRound: 0;
  version: 1;
};

export type CreateR1ChangeSetResult =
  | { ok: true; draft: R1ChangeSetDraft }
  | {
      ok: false;
      reason:
        | "unsupported_change_type"
        | "invalid_identity"
        | "invalid_scope"
        | "invalid_metadata"
        | "invalid_version_window"
        | "invalid_config_shape"
        | "sensitive_material_forbidden"
        | "no_semantic_change";
    };

const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const LOCALE_RE = /^[a-z]{2}(?:-[A-Z]{2})?$/;
const TIMEZONE_RE = /^(?:UTC|[A-Za-z_]+\/[A-Za-z0-9_+.-]+)$/;
const FORBIDDEN_KEY_RE =
  /(?:secret|password|passphrase|token|credential|private.?key|api.?key|client.?secret|raw.?sql|shell|script|ddl|bypassrls)/i;
const SECRET_VALUE_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:^|\s)Bearer\s+[A-Za-z0-9._-]{16,}|(?:^|[^a-z])sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./i;

const CONFIG_KEYS: Record<
  R1ChangeType,
  { required: string[]; allowed: string[] }
> = {
  BRAND: {
    required: ["brandName", "primaryColor"],
    allowed: [
      "brandName",
      "primaryColor",
      "secondaryColor",
      "logoObjectRef",
      "fontFamily",
    ],
  },
  LOCALE: {
    required: [
      "defaultLocale",
      "supportedLocales",
      "timezone",
      "reportingCurrency",
    ],
    allowed: [
      "defaultLocale",
      "supportedLocales",
      "timezone",
      "reportingCurrency",
    ],
  },
  NOTIFICATION_TEMPLATE: {
    required: ["templateKey", "locale", "subject", "body", "variableKeys"],
    allowed: ["templateKey", "locale", "subject", "body", "variableKeys"],
  },
  FEATURE_FLAG: {
    required: ["flagKey", "enabled", "cohortPercent", "reason"],
    allowed: ["flagKey", "enabled", "cohortPercent", "reason"],
  },
  MAINTENANCE_BANNER: {
    required: [
      "enabled",
      "severity",
      "locale",
      "message",
      "startsAt",
      "endsAt",
    ],
    allowed: ["enabled", "severity", "locale", "message", "startsAt", "endsAt"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuidV7(value: unknown): value is string {
  return typeof value === "string" && UUID_V7_RE.test(value);
}

function isChangeSetState(value: unknown): value is ChangeSetState {
  return (
    typeof value === "string" &&
    CHANGE_SET_STATES.includes(value as ChangeSetState)
  );
}

function isChangeSetScope(value: unknown): value is ChangeSetScope {
  if (!isRecord(value)) return false;
  if (value.type === "TENANT") {
    return value.organizationId === null && value.legacyBranchId === null;
  }
  if (value.type === "ORGANIZATION") {
    return isUuidV7(value.organizationId) && value.legacyBranchId === null;
  }
  if (value.type === "LEGACY_BRANCH") {
    return (
      isUuidV7(value.organizationId) &&
      Number.isSafeInteger(value.legacyBranchId) &&
      Number(value.legacyBranchId) > 0
    );
  }
  return false;
}

function hasBoundedText(
  value: unknown,
  min: number,
  max: number,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length >= min &&
    value.length <= max
  );
}

function hasSensitiveMaterial(value: unknown): boolean {
  if (typeof value === "string") return SECRET_VALUE_RE.test(value);
  if (Array.isArray(value)) return value.some(hasSensitiveMaterial);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) => FORBIDDEN_KEY_RE.test(key) || hasSensitiveMaterial(item),
  );
}

function hasExactAllowedKeys(
  type: R1ChangeType,
  value: Record<string, unknown>,
): boolean {
  const { required, allowed } = CONFIG_KEYS[type];
  const keys = Object.keys(value);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => allowed.includes(key))
  );
}

function isSafePlainText(
  value: unknown,
  min: number,
  max: number,
): value is string {
  return (
    hasBoundedText(value, min, max) &&
    !/<\/?(?:script|style)|\bon\w+\s*=|javascript:/i.test(value)
  );
}

function isIsoDate(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function validateTypedConfig(
  type: R1ChangeType,
  value: unknown,
): value is Record<string, unknown> {
  if (
    !isRecord(value) ||
    !hasExactAllowedKeys(type, value) ||
    hasSensitiveMaterial(value)
  ) {
    return false;
  }
  if (type === "BRAND") {
    return (
      hasBoundedText(value.brandName, 1, 120) &&
      typeof value.primaryColor === "string" &&
      /^#[0-9a-f]{6}$/i.test(value.primaryColor) &&
      (value.secondaryColor === undefined ||
        (typeof value.secondaryColor === "string" &&
          /^#[0-9a-f]{6}$/i.test(value.secondaryColor))) &&
      (value.logoObjectRef === undefined ||
        (typeof value.logoObjectRef === "string" &&
          /^[a-z0-9][a-z0-9/_-]{2,255}$/i.test(value.logoObjectRef))) &&
      (value.fontFamily === undefined ||
        hasBoundedText(value.fontFamily, 1, 80))
    );
  }
  if (type === "LOCALE") {
    return (
      typeof value.defaultLocale === "string" &&
      LOCALE_RE.test(value.defaultLocale) &&
      Array.isArray(value.supportedLocales) &&
      value.supportedLocales.length >= 1 &&
      value.supportedLocales.length <= 30 &&
      value.supportedLocales.every(
        (locale) => typeof locale === "string" && LOCALE_RE.test(locale),
      ) &&
      new Set(value.supportedLocales).size === value.supportedLocales.length &&
      value.supportedLocales.includes(value.defaultLocale) &&
      typeof value.timezone === "string" &&
      TIMEZONE_RE.test(value.timezone) &&
      typeof value.reportingCurrency === "string" &&
      /^[A-Z]{3}$/.test(value.reportingCurrency)
    );
  }
  if (type === "NOTIFICATION_TEMPLATE") {
    const subject = value.subject;
    const body = value.body;
    const variableKeys = value.variableKeys;
    if (
      typeof value.templateKey !== "string" ||
      !/^[a-z][a-z0-9_.-]{2,79}$/.test(value.templateKey) ||
      typeof value.locale !== "string" ||
      !LOCALE_RE.test(value.locale) ||
      !isSafePlainText(subject, 1, 200) ||
      !isSafePlainText(body, 1, 10_000) ||
      !Array.isArray(variableKeys) ||
      variableKeys.length > 30 ||
      !variableKeys.every(
        (key) =>
          typeof key === "string" &&
          /^[a-z][a-z0-9_.]{0,63}$/.test(key) &&
          !/(?:password|secret|token|passport|national_id|ssn)/i.test(key),
      ) ||
      new Set(variableKeys).size !== variableKeys.length
    )
      return false;
    const referenced = [
      ...subject.matchAll(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g),
      ...body.matchAll(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/g),
    ].map((match) => match[1]);
    return referenced.every((key) => variableKeys.includes(key));
  }
  if (type === "FEATURE_FLAG") {
    return (
      typeof value.flagKey === "string" &&
      /^[a-z][a-z0-9_.-]{2,79}$/.test(value.flagKey) &&
      typeof value.enabled === "boolean" &&
      Number.isInteger(value.cohortPercent) &&
      Number(value.cohortPercent) >= 0 &&
      Number(value.cohortPercent) <= 100 &&
      hasBoundedText(value.reason, 3, 500)
    );
  }
  if (
    typeof value.enabled !== "boolean" ||
    !["INFO", "WARNING", "CRITICAL"].includes(String(value.severity)) ||
    typeof value.locale !== "string" ||
    !LOCALE_RE.test(value.locale) ||
    !isSafePlainText(value.message, 1, 1_000) ||
    !isIsoDate(value.startsAt) ||
    !isIsoDate(value.endsAt)
  )
    return false;
  const startsAt = Date.parse(value.startsAt);
  const endsAt = Date.parse(value.endsAt);
  return endsAt > startsAt && endsAt - startsAt <= 7 * 24 * 60 * 60 * 1000;
}

function hashJson(value: unknown): string {
  return crypto
    .createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

export function createR1ChangeSetDraft(input: {
  tenantId: string;
  changeType: string;
  title: string;
  purpose: string;
  ownerPrincipalId: string;
  makerPrincipalId: string;
  targetScope: ChangeSetScope;
  baseVersion: number;
  proposedVersion: number;
  baseConfig: unknown;
  proposedConfig: unknown;
  dataClass: R1DataClass;
  approvalPolicyVersion: string;
}): CreateR1ChangeSetResult {
  if (!R1_CHANGE_TYPES.includes(input.changeType as R1ChangeType)) {
    return { ok: false, reason: "unsupported_change_type" };
  }
  const type = input.changeType as R1ChangeType;
  if (
    !isUuidV7(input.tenantId) ||
    !isUuidV7(input.ownerPrincipalId) ||
    !isUuidV7(input.makerPrincipalId)
  )
    return { ok: false, reason: "invalid_identity" };
  if (!isChangeSetScope(input.targetScope)) {
    return { ok: false, reason: "invalid_scope" };
  }
  if (
    !hasBoundedText(input.title, 3, 160) ||
    !hasBoundedText(input.purpose, 10, 1_000) ||
    !hasBoundedText(input.approvalPolicyVersion, 1, 120) ||
    !["PUBLIC", "INTERNAL"].includes(input.dataClass)
  )
    return { ok: false, reason: "invalid_metadata" };
  if (
    !Number.isSafeInteger(input.baseVersion) ||
    input.baseVersion < 0 ||
    input.proposedVersion !== input.baseVersion + 1
  )
    return { ok: false, reason: "invalid_version_window" };
  const baseConfig = input.baseConfig;
  const proposedConfig = input.proposedConfig;
  if (
    hasSensitiveMaterial(baseConfig) ||
    hasSensitiveMaterial(proposedConfig)
  ) {
    return { ok: false, reason: "sensitive_material_forbidden" };
  }
  if (
    !validateTypedConfig(type, baseConfig) ||
    !validateTypedConfig(type, proposedConfig)
  ) {
    return { ok: false, reason: "invalid_config_shape" };
  }
  const baseHash = hashJson(baseConfig);
  const proposedHash = hashJson(proposedConfig);
  if (baseHash === proposedHash)
    return { ok: false, reason: "no_semantic_change" };
  const changedKeys = [
    ...new Set([...Object.keys(baseConfig), ...Object.keys(proposedConfig)]),
  ]
    .filter(
      (key) =>
        canonicalJson(baseConfig[key]) !== canonicalJson(proposedConfig[key]),
    )
    .sort();
  return {
    ok: true,
    draft: {
      tenantId: input.tenantId.toLowerCase(),
      changeType: type,
      title: input.title.trim(),
      purpose: input.purpose.trim(),
      ownerPrincipalId: input.ownerPrincipalId.toLowerCase(),
      makerPrincipalId: input.makerPrincipalId.toLowerCase(),
      targetScope: input.targetScope,
      baseVersion: input.baseVersion,
      proposedVersion: input.proposedVersion,
      baseHash,
      proposedHash,
      baseConfig,
      proposedConfig,
      semanticDiff: {
        changedKeys,
        before: Object.fromEntries(
          changedKeys.map((key) => [key, baseConfig[key]]),
        ),
        after: Object.fromEntries(
          changedKeys.map((key) => [key, proposedConfig[key]]),
        ),
      },
      riskTier: "R1",
      dataClass: input.dataClass,
      affectedTenantCount: 1,
      affectedBranchCount: input.targetScope.type === "LEGACY_BRANCH" ? 1 : 0,
      affectedPrincipalCount: 0,
      affectedCaseCount: 0,
      affectedIntegrationCount: 0,
      dependencyVersions: { changeSetPolicy: "v1" },
      compatibilityRange: "change-set-policy-v1",
      approvalPolicyVersion: input.approvalPolicyVersion,
      rolloutStrategy: {
        kind: "PREVIEW_THEN_SINGLE_TENANT",
        canaryRequired: true,
      },
      canaryScope: {
        kind: "SERVER_SELECTED_SAFE_COHORT",
        targetScope: input.targetScope,
      },
      abortConditions: [
        { metric: "policy_violation_count", operator: ">", threshold: 0 },
        { metric: "slo_violation_count", operator: ">", threshold: 0 },
      ],
      observationWindowSeconds: 3600,
      rollbackStrategy: {
        kind: "RESTORE_BASE_VERSION",
        version: input.baseVersion,
        hash: baseHash,
      },
      status: "DRAFT",
      reviewRound: 0,
      version: 1,
    },
  };
}

export type ChangeSetSnapshot = {
  id: string;
  tenantId: string;
  makerPrincipalId: string;
  status: ChangeSetState;
  version: number;
  reviewRound: number;
  riskTier: "R1";
  approvalPolicyVersion: string;
  observationWindowSeconds: number;
  scheduledAt: number | null;
  publishedAt: number | null;
  observationStartedAt: number | null;
};

export type ChangeSetActor = {
  tenantId: string;
  principalId: string;
  capabilities: string[];
  stepUpReceiptId: string | null;
  impersonating: boolean;
};

export type ChangeSetTransitionReason =
  | "allowed"
  | "invalid_identity"
  | "invalid_snapshot"
  | "tenant_mismatch"
  | "impersonation_forbidden"
  | "stale_version"
  | "invalid_transition"
  | "capability_missing"
  | "reason_required"
  | "evidence_invalid"
  | "policy_version_mismatch"
  | "validation_failed"
  | "simulation_failed"
  | "review_evidence_incomplete"
  | "review_round_mismatch"
  | "maker_checker_conflict"
  | "step_up_required"
  | "approval_receipt_required"
  | "schedule_invalid"
  | "schedule_not_reached"
  | "canary_failed"
  | "publish_receipt_required"
  | "observation_baseline_missing"
  | "observation_window_incomplete"
  | "observation_guardrail_failed"
  | "rollback_evidence_required"
  | "failure_evidence_required"
  | "revocation_evidence_required";

export type ChangeSetTransitionResult =
  | { allowed: false; reason: ChangeSetTransitionReason }
  | {
      allowed: true;
      reason: "allowed";
      next: {
        status: ChangeSetState;
        version: number;
        reviewRound?: number;
        checkerPrincipalId?: string | null;
        scheduledAt?: number;
        publishedAt?: number;
        observationStartedAt?: number;
        effectiveAt?: number;
        closedAt?: number;
      };
      receipt: {
        tenantId: string;
        changeSetId: string;
        sequence: number;
        actorPrincipalId: string;
        fromState: ChangeSetState;
        toState: ChangeSetState;
        reasonCode: string;
        policyVersion: string;
        evidence: Record<string, unknown>;
        evidenceHash: string;
        previousHash: string | null;
        receiptHash: string;
        occurredAt: number;
      };
    };

const TRANSITIONS: Record<ChangeSetState, ChangeSetState[]> = {
  DRAFT: ["VALIDATED"],
  VALIDATED: ["SIMULATED", "FAILED"],
  SIMULATED: ["IN_REVIEW", "FAILED"],
  IN_REVIEW: ["APPROVED", "RETURNED", "REJECTED", "FAILED"],
  RETURNED: ["DRAFT"],
  APPROVED: ["SCHEDULED", "REVOKED", "FAILED"],
  SCHEDULED: ["CANARY", "REVOKED", "FAILED"],
  CANARY: ["PUBLISHED", "ROLLED_BACK", "FAILED"],
  PUBLISHED: ["OBSERVING", "ROLLED_BACK", "FAILED"],
  OBSERVING: ["EFFECTIVE", "ROLLED_BACK", "FAILED"],
  EFFECTIVE: ["ROLLED_BACK", "REVOKED"],
  REJECTED: [],
  FAILED: [],
  ROLLED_BACK: [],
  REVOKED: [],
};

const CAPABILITY_BY_TARGET: Record<ChangeSetState, string> = {
  DRAFT: "control_plane.change.return",
  VALIDATED: "control_plane.change.validate",
  SIMULATED: "control_plane.change.simulate",
  IN_REVIEW: "control_plane.change.submit_review",
  APPROVED: "control_plane.change.approve",
  SCHEDULED: "control_plane.change.schedule",
  CANARY: "control_plane.change.publish",
  PUBLISHED: "control_plane.change.publish",
  OBSERVING: "control_plane.change.observe",
  EFFECTIVE: "control_plane.change.observe",
  RETURNED: "control_plane.change.review",
  REJECTED: "control_plane.change.review",
  FAILED: "control_plane.change.fail",
  ROLLED_BACK: "control_plane.change.rollback",
  REVOKED: "control_plane.change.revoke",
};

const STATES_REQUIRING_REVIEW_ROUND: readonly ChangeSetState[] = [
  "IN_REVIEW",
  "APPROVED",
  "SCHEDULED",
  "CANARY",
  "PUBLISHED",
  "OBSERVING",
  "EFFECTIVE",
  "RETURNED",
  "REJECTED",
  "ROLLED_BACK",
  "REVOKED",
];

function evidenceBoolean(
  evidence: Record<string, unknown>,
  key: string,
): boolean {
  return evidence[key] === true;
}

function evidenceNumber(
  evidence: Record<string, unknown>,
  key: string,
): number | null {
  const value = evidence[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function evidenceUuid(
  evidence: Record<string, unknown>,
  key: string,
): string | null {
  const value = evidence[key];
  return isUuidV7(value) ? value.toLowerCase() : null;
}

function transitionNeedsStepUp(toState: ChangeSetState): boolean {
  return [
    "APPROVED",
    "SCHEDULED",
    "CANARY",
    "PUBLISHED",
    "OBSERVING",
    "EFFECTIVE",
    "RETURNED",
    "REJECTED",
    "FAILED",
    "ROLLED_BACK",
    "REVOKED",
  ].includes(toState);
}

export function evaluateR1ChangeSetTransition(input: {
  changeSet: ChangeSetSnapshot;
  actor: ChangeSetActor;
  expectedVersion: number;
  toState: ChangeSetState;
  reasonCode: string;
  policyVersion: string;
  evidence: Record<string, unknown>;
  previousReceiptHash?: string | null;
  now?: number;
}): ChangeSetTransitionResult {
  const { changeSet, actor, evidence, toState } = input;
  const now = input.now ?? Date.now();
  if (
    !isUuidV7(changeSet.id) ||
    !isUuidV7(changeSet.tenantId) ||
    !isUuidV7(changeSet.makerPrincipalId) ||
    !isUuidV7(actor.tenantId) ||
    !isUuidV7(actor.principalId)
  )
    return { allowed: false, reason: "invalid_identity" };
  if (
    !isChangeSetState(changeSet.status) ||
    !isChangeSetState(toState) ||
    changeSet.riskTier !== "R1" ||
    !Number.isSafeInteger(changeSet.version) ||
    changeSet.version < 1 ||
    !Number.isSafeInteger(changeSet.reviewRound) ||
    changeSet.reviewRound < 0 ||
    (STATES_REQUIRING_REVIEW_ROUND.includes(changeSet.status) &&
      changeSet.reviewRound < 1) ||
    !Number.isSafeInteger(changeSet.observationWindowSeconds) ||
    changeSet.observationWindowSeconds < 3600 ||
    ![
      changeSet.scheduledAt,
      changeSet.publishedAt,
      changeSet.observationStartedAt,
    ].every(
      (value) => value === null || (Number.isSafeInteger(value) && value >= 0),
    ) ||
    !Array.isArray(actor.capabilities) ||
    !actor.capabilities.every((capability) => typeof capability === "string") ||
    typeof actor.impersonating !== "boolean" ||
    !Number.isSafeInteger(input.expectedVersion) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    return { allowed: false, reason: "invalid_snapshot" };
  if (actor.tenantId !== changeSet.tenantId) {
    return { allowed: false, reason: "tenant_mismatch" };
  }
  if (actor.impersonating !== false) {
    return { allowed: false, reason: "impersonation_forbidden" };
  }
  if (input.expectedVersion !== changeSet.version) {
    return { allowed: false, reason: "stale_version" };
  }
  if (!TRANSITIONS[changeSet.status].includes(toState)) {
    return { allowed: false, reason: "invalid_transition" };
  }
  if (!actor.capabilities.includes(CAPABILITY_BY_TARGET[toState])) {
    return { allowed: false, reason: "capability_missing" };
  }
  if (!hasBoundedText(input.reasonCode, 3, 120)) {
    return { allowed: false, reason: "reason_required" };
  }
  if (
    !isRecord(evidence) ||
    hasSensitiveMaterial(evidence) ||
    canonicalJson(evidence).length > 16_384 ||
    !hasBoundedText(input.policyVersion, 1, 120) ||
    (input.previousReceiptHash != null &&
      !SHA256_RE.test(input.previousReceiptHash))
  )
    return { allowed: false, reason: "evidence_invalid" };
  if (
    input.policyVersion !== changeSet.approvalPolicyVersion ||
    !hasBoundedText(changeSet.approvalPolicyVersion, 1, 120)
  )
    return { allowed: false, reason: "policy_version_mismatch" };
  if (transitionNeedsStepUp(toState) && !isUuidV7(actor.stepUpReceiptId)) {
    return { allowed: false, reason: "step_up_required" };
  }

  const next: Extract<ChangeSetTransitionResult, { allowed: true }>["next"] = {
    status: toState,
    version: changeSet.version + 1,
  };
  if (
    toState === "VALIDATED" &&
    !evidenceBoolean(evidence, "validationPassed")
  ) {
    return { allowed: false, reason: "validation_failed" };
  }
  if (
    toState === "SIMULATED" &&
    !evidenceBoolean(evidence, "simulationPassed")
  ) {
    return { allowed: false, reason: "simulation_failed" };
  }
  if (
    toState === "IN_REVIEW" &&
    (!evidenceBoolean(evidence, "rollbackReady") ||
      !evidenceBoolean(evidence, "canaryPrepared") ||
      (evidenceNumber(evidence, "testEvidenceCount") ?? 0) < 1)
  )
    return { allowed: false, reason: "review_evidence_incomplete" };
  if (toState === "IN_REVIEW") {
    next.reviewRound = changeSet.reviewRound + 1;
    next.checkerPrincipalId = null;
  }
  if (["APPROVED", "RETURNED", "REJECTED"].includes(toState)) {
    if (actor.principalId === changeSet.makerPrincipalId) {
      return { allowed: false, reason: "maker_checker_conflict" };
    }
    if (
      changeSet.reviewRound < 1 ||
      evidenceNumber(evidence, "reviewRound") !== changeSet.reviewRound
    )
      return { allowed: false, reason: "review_round_mismatch" };
    if (
      evidence.decision !== toState ||
      evidenceUuid(evidence, "approvalReceiptId") === null ||
      evidenceUuid(evidence, "stepUpReceiptId") !== actor.stepUpReceiptId
    )
      return { allowed: false, reason: "approval_receipt_required" };
    next.checkerPrincipalId = actor.principalId;
  }
  if (toState === "SCHEDULED") {
    const scheduledAt = evidenceNumber(evidence, "scheduledAt");
    if (
      scheduledAt === null ||
      !Number.isSafeInteger(scheduledAt) ||
      scheduledAt < now
    ) {
      return { allowed: false, reason: "schedule_invalid" };
    }
    next.scheduledAt = scheduledAt;
  }
  if (toState === "CANARY") {
    if (changeSet.scheduledAt === null || now < changeSet.scheduledAt) {
      return { allowed: false, reason: "schedule_not_reached" };
    }
    if (evidenceUuid(evidence, "mutationReceiptId") === null) {
      return { allowed: false, reason: "publish_receipt_required" };
    }
  }
  if (toState === "PUBLISHED") {
    if (!evidenceBoolean(evidence, "canaryPassed")) {
      return { allowed: false, reason: "canary_failed" };
    }
    if (evidenceUuid(evidence, "mutationReceiptId") === null) {
      return { allowed: false, reason: "publish_receipt_required" };
    }
    next.publishedAt = now;
  }
  if (toState === "OBSERVING") {
    if (!evidenceBoolean(evidence, "guardrailBaselineFrozen")) {
      return { allowed: false, reason: "observation_baseline_missing" };
    }
    next.observationStartedAt = now;
  }
  if (toState === "EFFECTIVE") {
    const minimumWindow =
      Math.max(3600, changeSet.observationWindowSeconds) * 1000;
    if (
      changeSet.observationStartedAt === null ||
      now - changeSet.observationStartedAt < minimumWindow
    )
      return { allowed: false, reason: "observation_window_incomplete" };
    if (
      !evidenceBoolean(evidence, "guardrailsPassed") ||
      evidenceNumber(evidence, "sloViolationCount") !== 0
    )
      return { allowed: false, reason: "observation_guardrail_failed" };
    next.effectiveAt = now;
    next.closedAt = now;
  }
  if (toState === "ROLLED_BACK") {
    if (
      !evidenceBoolean(evidence, "rollbackApplied") ||
      evidenceUuid(evidence, "rollbackReceiptId") === null
    )
      return { allowed: false, reason: "rollback_evidence_required" };
    next.closedAt = now;
  }
  if (
    toState === "FAILED" &&
    (!evidenceBoolean(evidence, "failureRecorded") ||
      evidenceUuid(evidence, "failureReceiptId") === null)
  )
    return { allowed: false, reason: "failure_evidence_required" };
  if (
    toState === "REVOKED" &&
    (!evidenceBoolean(evidence, "revocationRecorded") ||
      evidenceUuid(evidence, "revocationReceiptId") === null)
  )
    return { allowed: false, reason: "revocation_evidence_required" };
  if (["REJECTED", "FAILED", "REVOKED"].includes(toState)) next.closedAt = now;

  const evidenceHash = hashJson(evidence);
  const previousHash = input.previousReceiptHash ?? null;
  const receiptCore = {
    tenantId: changeSet.tenantId,
    changeSetId: changeSet.id,
    sequence: changeSet.version + 1,
    actorPrincipalId: actor.principalId,
    fromState: changeSet.status,
    toState,
    reasonCode: input.reasonCode,
    policyVersion: input.policyVersion,
    evidenceHash,
    previousHash,
    occurredAt: now,
  };
  return {
    allowed: true,
    reason: "allowed",
    next,
    receipt: {
      ...receiptCore,
      evidence,
      receiptHash: hashJson(receiptCore),
    },
  };
}
