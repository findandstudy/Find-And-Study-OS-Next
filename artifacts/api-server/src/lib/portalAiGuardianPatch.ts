import { parseAdapterSpec } from "@workspace/portal-adapters/declarative/schema";
import type { PortalDiagnosis } from "./portalAiGuardianContract";

type JsonRecord = Record<string, unknown>;

export interface GuardianPatchOperation {
  op: "add" | "replace" | "remove";
  path: string;
  value?: unknown;
  rationale: string;
  evidence: string;
}

export type GuardianPatchDecision =
  | {
      accepted: true;
      patchedSpec: JsonRecord;
      operations: GuardianPatchOperation[];
    }
  | {
      accepted: false;
      reason: string;
    };

const SAFE_SELECTOR_LEAF =
  /^\/(?:steps\/\d+|workflow\/states\/\d+\/steps\/\d+)\/(?:selector|name|ariaLabel)$/;
const SAFE_DETECTOR_LEAF =
  /^\/(?:workflow\/states\/\d+\/(?:detect|transitions\/\d+)\/conditions\/\d+|outcomes\/\d+\/detect\/conditions\/\d+)\/(?:selector|value)$/;
const SAFE_SUCCESS_LEAF =
  /^\/success\/(?:successSelector|successText|alreadyExistsText|programMissingText)$/;
const UNSAFE_VALUE_RE =
  /(?:javascript:|data:text\/html|<script|<\/script|\beval\s*\(|\bFunction\s*\(|\{\{(?:vars|captured|profile)\.)/i;

function isJsonRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodePointerPart(value: string): string {
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function cloneJsonRecord(value: unknown): JsonRecord | null {
  if (!isJsonRecord(value)) return null;
  try {
    const clone = JSON.parse(JSON.stringify(value));
    return isJsonRecord(clone) ? clone : null;
  } catch {
    return null;
  }
}

function operationIsStructurallySafe(
  operation: GuardianPatchOperation,
): boolean {
  if (operation.op !== "add" && operation.op !== "replace") return false;
  if (
    !SAFE_SELECTOR_LEAF.test(operation.path) &&
    !SAFE_DETECTOR_LEAF.test(operation.path) &&
    !SAFE_SUCCESS_LEAF.test(operation.path)
  ) {
    return false;
  }
  if (
    typeof operation.value !== "string" ||
    operation.value.length < 1 ||
    operation.value.length > 1_000 ||
    UNSAFE_VALUE_RE.test(operation.value)
  ) {
    return false;
  }
  return true;
}

function setJsonPointer(
  root: JsonRecord,
  operation: GuardianPatchOperation,
): boolean {
  const parts = operation.path
    .split("/")
    .slice(1)
    .map(decodePointerPart);
  if (parts.length < 2) return false;
  let cursor: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      const index = Number(part);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index >= cursor.length
      ) {
        return false;
      }
      cursor = cursor[index];
      continue;
    }
    if (!isJsonRecord(cursor) || !(part in cursor)) return false;
    cursor = cursor[part];
  }
  const leaf = parts.at(-1)!;
  if (Array.isArray(cursor)) return false;
  if (!isJsonRecord(cursor)) return false;
  if (operation.op === "replace" && !(leaf in cursor)) return false;
  cursor[leaf] = operation.value;
  return true;
}

/**
 * Guardian may only draft selector/detector/result-proof edits. Authentication,
 * URLs, profile defaults, documents, program choice and final-submit semantics
 * remain outside the automatic patch boundary.
 */
export function applyGuardianSpecPatch(
  baseSpec: unknown,
  diagnosis: PortalDiagnosis,
): GuardianPatchDecision {
  if (
    diagnosis.classification !== "selector_changed" &&
    diagnosis.classification !== "portal_changed"
  ) {
    return { accepted: false, reason: "CLASSIFICATION_NOT_PATCHABLE" };
  }
  if (
    diagnosis.risk !== "low" ||
    diagnosis.confidence < 0.85 ||
    diagnosis.proposedSpecPatch.length === 0 ||
    diagnosis.proposedSpecPatch.length > 12
  ) {
    return { accepted: false, reason: "CONFIDENCE_OR_RISK_GATE" };
  }
  const operations = diagnosis.proposedSpecPatch as GuardianPatchOperation[];
  if (!operations.every(operationIsStructurallySafe)) {
    return { accepted: false, reason: "PATCH_OUTSIDE_SAFE_BOUNDARY" };
  }
  const patchedSpec = cloneJsonRecord(baseSpec);
  if (!patchedSpec) return { accepted: false, reason: "BASE_SPEC_INVALID" };
  for (const operation of operations) {
    if (!setJsonPointer(patchedSpec, operation)) {
      return { accepted: false, reason: "PATCH_PATH_NOT_FOUND" };
    }
  }
  const parsed = parseAdapterSpec(patchedSpec);
  if (!parsed.ok) {
    return { accepted: false, reason: "PATCHED_SPEC_SCHEMA_INVALID" };
  }
  return {
    accepted: true,
    patchedSpec,
    operations,
  };
}
