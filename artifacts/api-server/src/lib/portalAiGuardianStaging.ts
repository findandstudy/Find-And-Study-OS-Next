import { createHash } from "node:crypto";
import {
  parseAdapterSpec,
  specIsPrivileged,
} from "@workspace/portal-adapters/declarative/schema";
import type { GuardianPatchOperation } from "./portalAiGuardianPatch";

type JsonRecord = Record<string, unknown>;

export type GuardianStagingCheck = {
  key: string;
  passed: boolean;
  detail: string;
};

export type GuardianStagingReport = {
  status: "passed" | "failed";
  mode: "offline_structural";
  testedAt: string;
  baseSpecHash: string;
  patchedSpecHash: string;
  patchHash: string;
  reportHash: string;
  changedPaths: string[];
  checks: GuardianStagingCheck[];
  canaryRequired: true;
  limitations: string[];
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function pointerPart(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function diffJsonPaths(
  before: unknown,
  after: unknown,
  path = "",
  result: string[] = [],
): string[] {
  if (Object.is(before, after)) return result;
  if (Array.isArray(before) && Array.isArray(after)) {
    const max = Math.max(before.length, after.length);
    for (let index = 0; index < max; index += 1) {
      const next = `${path}/${index}`;
      if (index >= before.length || index >= after.length) result.push(next);
      else diffJsonPaths(before[index], after[index], next, result);
    }
    return result;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const next = `${path}/${pointerPart(key)}`;
      if (!(key in before) || !(key in after)) result.push(next);
      else diffJsonPaths(before[key], after[key], next, result);
    }
    return result;
  }
  result.push(path || "/");
  return result;
}

function actionInventory(spec: unknown): Array<{ path: string; action: string }> {
  const result: Array<{ path: string; action: string }> = [];
  const scan = (steps: unknown, path: string) => {
    if (!Array.isArray(steps)) return;
    steps.forEach((step, index) => {
      if (!isRecord(step)) return;
      result.push({ path: `${path}/${index}`, action: String(step.action ?? "") });
    });
  };
  if (!isRecord(spec)) return result;
  scan(spec.steps, "/steps");
  if (isRecord(spec.auth)) scan(spec.auth.loginSteps, "/auth/loginSteps");
  if (isRecord(spec.workflow) && Array.isArray(spec.workflow.states)) {
    spec.workflow.states.forEach((state, index) => {
      if (isRecord(state)) scan(state.steps, `/workflow/states/${index}/steps`);
    });
  }
  return result;
}

function protectedSurface(spec: unknown): unknown {
  if (!isRecord(spec)) return null;
  return {
    meta: spec.meta,
    auth: spec.auth,
    documents: spec.documents,
    programSelection: spec.programSelection,
    profilePolicy: spec.profilePolicy,
    failures: spec.failures,
    actionInventory: actionInventory(spec),
  };
}

function effectiveDryRunPolicy(spec: unknown): string {
  if (!isRecord(spec) || !isRecord(spec.meta)) return "legacy";
  if (typeof spec.meta.dryRunPolicy === "string") {
    return spec.meta.dryRunPolicy;
  }
  return spec.specVersion === 2 ? "strict" : "legacy";
}

export function validateGuardianStagingPatch(input: {
  baseSpec: unknown;
  patchedSpec: unknown;
  operations: GuardianPatchOperation[];
  testedAt?: string;
}): GuardianStagingReport {
  const testedAt = input.testedAt ?? new Date().toISOString();
  const changedPaths = [...new Set(diffJsonPaths(input.baseSpec, input.patchedSpec))]
    .sort();
  const declaredPaths = input.operations.map((operation) => operation.path).sort();
  const uniqueDeclaredPaths = [...new Set(declaredPaths)];
  const parsed = parseAdapterSpec(input.patchedSpec);
  const protectedUnchanged =
    hashJson(protectedSurface(input.baseSpec)) ===
    hashJson(protectedSurface(input.patchedSpec));
  const checks: GuardianStagingCheck[] = [
    {
      key: "schema_valid",
      passed: parsed.ok,
      detail: parsed.ok ? "AdapterSpec schema is valid." : parsed.error,
    },
    {
      key: "strict_dry_run_policy",
      passed: effectiveDryRunPolicy(input.patchedSpec) === "strict",
      detail: `Effective dry-run policy: ${effectiveDryRunPolicy(input.patchedSpec)}.`,
    },
    {
      key: "declared_paths_unique",
      passed: uniqueDeclaredPaths.length === declaredPaths.length,
      detail: `${uniqueDeclaredPaths.length}/${declaredPaths.length} declared paths are unique.`,
    },
    {
      key: "changed_paths_exact",
      passed:
        JSON.stringify(changedPaths) === JSON.stringify(uniqueDeclaredPaths.sort()),
      detail: `Changed: ${changedPaths.join(", ") || "none"}.`,
    },
    {
      key: "protected_surfaces_unchanged",
      passed: protectedUnchanged,
      detail:
        "Authentication, base metadata, documents, program selection, profile policy, failures and action inventory must remain unchanged.",
    },
    {
      key: "privilege_surface_not_expanded",
      passed:
        !specIsPrivileged(input.patchedSpec) || specIsPrivileged(input.baseSpec),
      detail: `Privileged before=${specIsPrivileged(input.baseSpec)} after=${specIsPrivileged(input.patchedSpec)}.`,
    },
  ];
  const baseSpecHash = hashJson(input.baseSpec);
  const patchedSpecHash = hashJson(input.patchedSpec);
  const patchHash = hashJson(input.operations);
  const limitations = [
    "No portal network request, login, upload, save, submit or retry was executed.",
    "Selector uniqueness and live DOM behavior require a fresh read-only probe and an explicitly authorized canary before deployment.",
  ];
  const reportCore = {
    status: checks.every((check) => check.passed) ? "passed" : "failed",
    mode: "offline_structural",
    baseSpecHash,
    patchedSpecHash,
    patchHash,
    changedPaths,
    checks,
    canaryRequired: true,
    limitations,
  } as const;
  return {
    ...reportCore,
    testedAt,
    reportHash: hashJson(reportCore),
  };
}

export function stagingReportsMatch(
  stored: unknown,
  regenerated: GuardianStagingReport,
): boolean {
  if (!isRecord(stored)) return false;
  return (
    stored.status === "passed" &&
    stored.mode === "offline_structural" &&
    stored.baseSpecHash === regenerated.baseSpecHash &&
    stored.patchedSpecHash === regenerated.patchedSpecHash &&
    stored.patchHash === regenerated.patchHash &&
    stored.reportHash === regenerated.reportHash
  );
}
