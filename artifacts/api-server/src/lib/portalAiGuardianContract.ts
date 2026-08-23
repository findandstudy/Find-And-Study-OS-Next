import { createHash } from "node:crypto";
import { z } from "zod";
import { redactString } from "./piiRedaction";

const DIAGNOSABLE_STATUSES = [
  "failed",
  "program_missing",
  "program_full",
] as const;

const specPatchOperationSchema = z.object({
  op: z.enum(["add", "replace", "remove"]),
  path: z.string().min(1).max(500),
  value: z.unknown().optional(),
  rationale: z.string().min(1).max(2_000),
  evidence: z.string().min(1).max(2_000),
});

const selectorCandidateSchema = z.object({
  field: z.string().min(1).max(200),
  current: z.string().max(1_000).optional(),
  proposed: z.string().min(1).max(1_000),
  evidence: z.string().min(1).max(2_000),
});

export const portalDiagnosisSchema = z.object({
  classification: z.enum([
    "selector_changed",
    "validation_error",
    "data_missing",
    "program_mapping",
    "document_upload",
    "authentication",
    "session_expired",
    "duplicate_or_existing",
    "quota_full",
    "portal_changed",
    "network_or_timeout",
    "unknown",
  ]),
  confidence: z.number().min(0).max(1),
  risk: z.enum(["low", "medium", "high"]),
  retrySafe: z.boolean(),
  requiresCodeChange: z.boolean(),
  summary: z.string().min(1).max(4_000),
  evidence: z.array(z.string().min(1).max(2_000)).max(12).default([]),
  recommendedAction: z.string().min(1).max(4_000),
  missingDataFields: z.array(z.string().min(1).max(200)).max(30).default([]),
  selectorCandidates: z.array(selectorCandidateSchema).max(30).default([]),
  proposedSpecPatch: z.array(specPatchOperationSchema).max(50).default([]),
});

export type PortalDiagnosis = z.infer<typeof portalDiagnosisSchema>;

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

const SENSITIVE_KEY_RE =
  /^(?:value|default)$|(?:address|passport|email|phone|mobile|name|birth|token|secret|password|credential|cookie|authorization|storage.?state|signed.?url)/i;

function sanitizeFreeformText(value: string): string {
  return redactString(value)
    .replace(
      /(\b(?:actual|readback|entered|received|inputValue|fieldValue)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^,;\n]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/gi, "$1?[REDACTED]")
    .slice(0, 4_000);
}

/**
 * Keep portal structure useful for diagnosis without forwarding credentials or
 * student attributes. This is intentionally stricter than the generic PII
 * redactor because adapter specs can contain auth/storage configuration.
 */
export function sanitizePortalEvidence(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]";
  if (
    value == null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (typeof value === "string") return sanitizeFreeformText(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((item) => sanitizePortalEvidence(item, depth + 1));
  }
  if (typeof value === "object") {
    const result: JsonRecord = {};
    for (const [key, item] of Object.entries(value as JsonRecord).slice(
      0,
      100,
    )) {
      result[key] = SENSITIVE_KEY_RE.test(key)
        ? "[REDACTED]"
        : sanitizePortalEvidence(item, depth + 1);
    }
    return result;
  }
  return String(value).slice(0, 500);
}

function extractJsonObject(raw: string): string | null {
  const withoutFence = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  return start >= 0 && end > start ? withoutFence.slice(start, end + 1) : null;
}

export function parsePortalDiagnosis(raw: string): {
  diagnosis: PortalDiagnosis;
  parseError: boolean;
} {
  const json = extractJsonObject(raw);
  if (json) {
    try {
      const parsed = portalDiagnosisSchema.safeParse(JSON.parse(json));
      if (parsed.success) return { diagnosis: parsed.data, parseError: false };
    } catch {
      // Fall through to the fail-closed diagnosis below.
    }
  }

  return {
    parseError: true,
    diagnosis: {
      classification: "unknown",
      confidence: 0,
      risk: "high",
      retrySafe: false,
      requiresCodeChange: false,
      summary:
        "AI output could not be validated as a structured portal diagnosis.",
      evidence: [],
      recommendedAction:
        "Manual engineering review is required. Do not retry automatically.",
      missingDataFields: [],
      selectorCandidates: [],
      proposedSpecPatch: [],
    },
  };
}

export function portalFailureFingerprint(input: {
  id: number;
  adapterKey: string | null;
  status: string;
  error: string | null;
  attempts: number;
  resultJson: unknown;
}): string {
  const result = asRecord(input.resultJson);
  const adapterResult = asRecord(result.result);
  const stableEvidence = {
    id: input.id,
    adapterKey: input.adapterKey,
    status: input.status,
    error: redactString(input.error ?? ""),
    attempts: input.attempts,
    result: sanitizePortalEvidence({
      error: result.error ?? adapterResult.error,
      detail: result.detail ?? adapterResult.detail,
      reason: result.reason ?? adapterResult.reason,
      missingSlots: result.missingSlots,
      missingDataFields: result.missingDataFields,
      validation: result.validation,
      stage: result.stage ?? adapterResult.stage,
      portalEvidence: result.portalEvidence,
    }),
  };
  return createHash("sha256")
    .update(JSON.stringify(stableEvidence))
    .digest("hex");
}

export function isDiagnosablePortalStatus(status: string): boolean {
  return (DIAGNOSABLE_STATUSES as readonly string[]).includes(status);
}
