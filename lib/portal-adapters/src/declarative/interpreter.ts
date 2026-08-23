/**
 * declarative/interpreter.ts — executes an AdapterSpec against a Playwright
 * page and exposes it as a standard UniversityAdapter.
 *
 * The interpreter is deliberately split into PURE helpers (value resolution,
 * transform application, program selection, result classification) that take
 * plain data and can be unit-tested without a browser, plus the thin
 * `createSpecAdapter` factory that wires them to a live page.
 *
 * Security: `jsHook` steps run arbitrary `page.evaluate()` expressions. They
 * are executed ONLY when the adapter is built with `{ allowJsHook: true }`,
 * which the loader/endpoints set exclusively for trusted specs (builtin source
 * or a super_admin-approved upload). For untrusted specs jsHook steps are
 * skipped with a warning — the engine never silently runs unapproved script.
 */

import { basename } from "node:path";
import type {
  UniversityAdapter,
  AdapterSession,
  SubmitProfile,
  SubmitFiles,
  SubmitResult,
  LoginOpts,
  ProgramOption,
  PortalProgramOption,
} from "../types.js";
import type { MinimalPage } from "../declarativeAdapter.js";
import { launchPortal, logger } from "../browser.js";
import { portalCreds } from "../portalCreds.js";
import { fold, matchProgram } from "../programMatch.js";
import type {
  AdapterSpec,
  SpecStep,
  Transform,
  SuccessSpec,
  FailureSpec,
  ProgramSelection,
  SpecCondition,
  SpecWorkflow,
  WorkflowState,
  ProfilePolicy,
  OutcomeRule,
} from "./schema.js";
import type { InterpolateCtx } from "./interpolate.js";
import { interpolate } from "./interpolate.js";
import { executeHttpLikeStep } from "./httpRunner.js";

// ---------------------------------------------------------------------------
// Page interface — MinimalPage plus the optional capabilities a spec may use.
// All additions are optional so existing mock pages keep compiling.
// ---------------------------------------------------------------------------

export interface SpecPage extends MinimalPage {
  /** Current page URL (used for success/redirect detection). */
  url?(): string;
  /** Playwright-compatible wait overload with a bounded timeout. */
  waitForSelector(
    selector: string,
    opts?: { timeout?: number },
  ): Promise<unknown>;
  /** Read-only selector helpers used by v2 conditions and exact readback. */
  textContent?(selector: string): Promise<string | null>;
  inputValue?(selector: string): Promise<string>;
  getAttribute?(selector: string, name: string): Promise<string | null>;
  isVisible?(selector: string): Promise<boolean>;
  /** Playwright timing primitive used only between stable detector reads. */
  waitForTimeout?(ms: number): Promise<void>;
  /** Response waiter used to prove that an upload reached the portal server. */
  waitForResponse?(
    predicate: (response: { url(): string }) => boolean,
    opts?: { timeout?: number },
  ): Promise<{
    url(): string;
    status(): number;
    text(): Promise<string>;
  }>;
  /** Playwright Page.$$eval subset used for live <option> enumeration. */
  $$eval?<T>(
    selector: string,
    fn: (elements: Element[]) => T,
  ): Promise<T>;
  /**
   * Playwright `getByRole` — used by `lookup` and `phone` steps for blur-race-
   * free option selection. Optional so existing mock pages compile unchanged.
   * Returns a Locator-like object; only `click()` and `fill()` are consumed.
   */
  getByRole?(
    role: string,
    opts?: { name?: string | RegExp; exact?: boolean },
  ): {
    click(): Promise<void>;
    fill?(value: string): Promise<void>;
    count?(): Promise<number>;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Resolves a "profile.<field>" path to a string value. */
export function resolveProfileValue(profile: SubmitProfile, path: string): string {
  const field = path.startsWith("profile.") ? path.slice("profile.".length) : path;
  const v = (profile as unknown as Record<string, unknown>)[field];
  return v == null ? "" : String(v);
}

/**
 * Applies a step-level value transform. `override`/`map` are deterministic
 * table lookups (keep the original value when no mapping exists). `fuzzy` is a
 * passthrough here — fuzzy matching only makes sense against live option lists
 * and is handled in {@link resolveProgramValue}. `toDMY` converts an ISO date
 * string "YYYY-MM-DD" to "DD.MM.YYYY" (passes non-matching strings through).
 */
export function applyTransform(value: string, transform?: Transform): string {
  if (!transform) return value;
  switch (transform.type) {
    case "override":
    case "map":
      return transform.table?.[value] ?? value;
    case "fuzzy":
      return value;
    case "toDMY": {
      const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      return m ? `${m[3]}.${m[2]}.${m[1]}` : value;
    }
    default:
      return value;
  }
}

/**
 * Resolves the portal option value for the applicant's program. Priority:
 *   1. exact option match (by value, then by folded label)
 *   2. name mapping + fuzzy match via matchProgram() (fully name-based)
 * Returns null when nothing meets the threshold. Matching is fully NAME-based —
 * CRM program IDs are never consulted (neither the removed DB override column
 * nor a spec-authored programId override).
 */
export function resolveProgramValue(
  options: ProgramOption[],
  profile: SubmitProfile,
  ps?: ProgramSelection,
): { value: string; conf: number } | null {
  const programName = profile.programName ?? "";

  // Exact match on option value, then on folded label.
  const byValue = options.find((o) => o.v === programName);
  if (byValue) return { value: byValue.v, conf: 1 };
  const foldedName = fold(programName);
  const byLabel = options.find((o) => fold(o.t) === foldedName);
  if (byLabel) return { value: byLabel.v, conf: 1 };

  // Name mapping + fuzzy fallback.
  const candidates = options.map((o) => ({ id: o.v, name: o.t }));
  const res = matchProgram(programName, candidates, {
    nameMap: profile.programNameMap,
    nameMapGeneral: profile.programNameMapGeneral,
    synonyms: profile.programSynonyms,
  });
  if (!res) return null;
  const threshold = ps?.fuzzyThreshold ?? 0;
  if (threshold > 0 && res.conf < threshold) return null;
  return { value: res.match.id, conf: res.conf };
}

/** Enumerates program options from the authored static catalog or live select. */
export async function enumerateProgramCatalog(
  page: SpecPage,
  selection: ProgramSelection,
  selectorOverride?: string,
): Promise<PortalProgramOption[]> {
  if (selection.source === "static") {
    return (selection.options ?? []).map((option) => ({
      value: option.value,
      name: option.label,
      enabled: option.enabled,
    }));
  }
  const selector = selectorOverride ?? selection.selector;
  if (!selector) throw new Error("programSelection selector is missing");
  if (typeof page.$$eval !== "function") {
    throw new Error("live program enumeration is unavailable on this page");
  }
  return page.$$eval(selector, (elements) => {
    const select = elements[0] as HTMLSelectElement | undefined;
    if (!select) return [];
    return Array.from(select.options)
      .filter((option) => option.value)
      .map((option) => ({
        value: option.value,
        name: option.textContent?.trim() || option.label,
        enabled: !option.disabled,
      }));
  });
}

export async function enumerateProgramOptions(
  page: SpecPage,
  selection: ProgramSelection,
  selectorOverride?: string,
): Promise<ProgramOption[]> {
  const catalog = await enumerateProgramCatalog(
    page,
    selection,
    selectorOverride,
  );
  return catalog
    .filter((option) => option.enabled)
    .map((option) => ({ v: option.value, t: option.name }));
}

class SpecProgramMissingError extends Error {
  constructor(
    readonly profile: SubmitProfile,
    readonly catalog: PortalProgramOption[],
  ) {
    super(`program_missing: no proved option for "${profile.programName}"`);
  }
}

class SpecProgramFullError extends Error {
  constructor(
    readonly profile: SubmitProfile,
    readonly matched: PortalProgramOption,
    readonly catalog: PortalProgramOption[],
  ) {
    super(`program_full: matched option is disabled for "${profile.programName}"`);
  }
}

/**
 * Classifies the post-submit page state from the success/failure spec.
 * Reads the page HTML (and URL when available). Captures an externalRef from
 * the success.redirectPattern regex (first capture group) when present.
 */
export async function classifyResult(
  page: SpecPage,
  success: SuccessSpec,
  failure?: FailureSpec,
): Promise<SubmitResult> {
  const html = (await page.content()).toLowerCase();
  const currentUrl = typeof page.url === "function" ? page.url() : "";

  if (success.alreadyExistsText && html.includes(success.alreadyExistsText.toLowerCase())) {
    return { submitted: false, alreadyExists: true, programMissing: false };
  }
  if (success.programMissingText && html.includes(success.programMissingText.toLowerCase())) {
    return { submitted: false, alreadyExists: false, programMissing: true };
  }
  if (failure?.failureText && html.includes(failure.failureText.toLowerCase())) {
    return {
      submitted: false,
      alreadyExists: false,
      programMissing: false,
      detail: "failureText matched",
    };
  }

  let submitted = false;
  if (success.successText && html.includes(success.successText.toLowerCase())) submitted = true;
  if (!submitted && success.responseUrlIncludes && currentUrl.includes(success.responseUrlIncludes)) {
    submitted = true;
  }
  if (!submitted && success.successSelector) {
    const el = await page.$(success.successSelector);
    if (el !== null) submitted = true;
  }

  let externalRef: string | undefined;
  if (success.redirectPattern && currentUrl) {
    try {
      const m = currentUrl.match(new RegExp(success.redirectPattern));
      if (m) {
        externalRef = m[1] ?? m[0];
        submitted = true;
      }
    } catch (err) {
      logger.warn(`[spec] invalid redirectPattern regex: ${String(err)}`);
    }
  }

  const result: SubmitResult = {
    submitted,
    alreadyExists: false,
    programMissing: false,
  };
  if (externalRef) result.externalRef = externalRef;
  return result;
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

export interface StepContext {
  profile: SubmitProfile;
  files: SubmitFiles;
  documentSlots?: AdapterSpec["documents"];
  programSelection?: AdapterSpec["programSelection"];
  /** Whether jsHook steps may execute (trusted specs only). */
  allowJsHook: boolean;
  /** Mutable interpolation context — updated in place by http/graphql/capture/setVar steps. */
  vars: Record<string, unknown>;
  captured: Record<string, unknown>;
  /** Origins allowed for http/graphql steps (from spec.meta.allowedOrigins). */
  allowedOrigins: string[];
  /** Whether we are in dry-run mode (mutation steps are skipped). */
  dryRun: boolean;
  /** v2 strict mode skips every DOM/network mutation action, not only submit. */
  dryRunPolicy?: "legacy" | "strict";
  /** Document slots that passed all authored upload proofs. */
  uploadedSlots?: Set<string>;
}

/**
 * Resolves the effective CSS selector for a step that supports the
 * `name`/`ariaLabel` locator hints. Priority: `name` → `ariaLabel` → `selector`.
 * Converting name/ariaLabel to CSS attribute selectors lets Playwright pierce
 * open shadow DOM automatically (Chromium pierces for attribute selectors).
 */
function resolveStepSelector(step: {
  selector?: string;
  name?: string;
  ariaLabel?: string;
}): string {
  if (step.name) return `[name="${step.name}"]`;
  if (step.ariaLabel) return `[aria-label="${step.ariaLabel}"]`;
  if (step.selector) return step.selector;
  throw new Error("step requires at least one locator: selector, name, or ariaLabel");
}

/**
 * Clicks a ARIA option element by name, using `getByRole("option", {name})`
 * when the page supports it (Playwright Locator API), or falling back to a
 * `:has-text()` CSS click so mock pages and simple wrappers still work.
 */
async function clickOption(page: SpecPage, label: string): Promise<void> {
  if (typeof page.getByRole === "function") {
    await page.getByRole("option", { name: label }).click();
  } else {
    await page.click(`[role="option"]:has-text("${label}")`);
  }
}

async function verifyControlReadback(
  page: SpecPage,
  selector: string,
  expected: string,
  readback: {
    source: "value" | "selectedLabel";
    comparison: "exact" | "trimmed" | "folded";
    rejectAriaInvalid: boolean;
  },
): Promise<void> {
  let actual: string;
  if (readback.source === "selectedLabel") {
    if (typeof page.$$eval !== "function") {
      throw new Error("selectedLabel readback is unavailable on this page");
    }
    actual = await page.$$eval(selector, (elements) => {
      if (elements.length !== 1) return "";
      const select = elements[0] as HTMLSelectElement;
      return select.selectedOptions.item(0)?.textContent?.trim() ?? "";
    });
  } else {
    if (typeof page.inputValue !== "function") {
      throw new Error("value readback is unavailable on this page");
    }
    actual = await page.inputValue(selector);
  }

  const normalize = (value: string): string => {
    if (readback.comparison === "exact") return value;
    if (readback.comparison === "folded") return fold(value);
    return value.trim();
  };
  if (normalize(actual) !== normalize(expected)) {
    throw new Error("control readback did not match the authored value");
  }
  if (
    readback.rejectAriaInvalid &&
    typeof page.getAttribute === "function" &&
    (await page.getAttribute(selector, "aria-invalid")) === "true"
  ) {
    throw new Error("control readback reports aria-invalid=true");
  }
}

/** Resolves an upload step's slot to a concrete file path. */
function resolveSlotFile(slot: string, ctx: StepContext): string | undefined {
  const slotDef = ctx.documentSlots?.slots?.[slot];
  const field = (slotDef?.fileField ?? slot) as keyof SubmitFiles;
  return ctx.files[field];
}

/** Builds an InterpolateCtx from the mutable StepContext fields. */
function toInterpolateCtx(ctx: StepContext): InterpolateCtx {
  return {
    profile: ctx.profile as unknown as Record<string, unknown>,
    vars: ctx.vars,
    captured: ctx.captured,
  };
}

function bagValue(
  bag: Record<string, unknown>,
  path: string | undefined,
): unknown {
  if (!path) return undefined;
  const parts = path.split(".");
  let current: unknown = bag;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function compareConditionValue(
  actualRaw: unknown,
  condition: SpecCondition,
  expectedRaw: string,
): boolean {
  const exists = actualRaw !== undefined && actualRaw !== null;
  const actualBase = exists ? String(actualRaw) : "";
  const actual = condition.caseInsensitive ? actualBase.toLocaleLowerCase("en") : actualBase;
  const expected = condition.caseInsensitive
    ? expectedRaw.toLocaleLowerCase("en")
    : expectedRaw;

  switch (condition.operator) {
    case "exists":
      return exists && (typeof actualRaw !== "boolean" || actualRaw);
    case "notExists":
      return !exists || actualRaw === false;
    case "empty":
      return !exists || actual.trim() === "";
    case "notEmpty":
      return exists && actual.trim() !== "";
    case "equals":
      return actual === expected;
    case "notEquals":
      return actual !== expected;
    case "contains":
      return actual.includes(expected);
    case "matches": {
      try {
        return new RegExp(expected, condition.caseInsensitive ? "i" : undefined).test(actualBase);
      } catch {
        throw new Error(`invalid condition regex "${expectedRaw}"`);
      }
    }
    default: {
      const _exhaustive: never = condition.operator;
      return _exhaustive;
    }
  }
}

/**
 * Evaluates one v2 condition without mutating the page. Missing selector
 * capabilities fail closed rather than treating an unreadable field as proof.
 */
export async function evaluateCondition(
  page: SpecPage,
  condition: SpecCondition,
  ctx: StepContext,
): Promise<boolean> {
  let actual: unknown;
  switch (condition.source) {
    case "profile":
      actual = bagValue(
        ctx.profile as unknown as Record<string, unknown>,
        condition.path,
      );
      break;
    case "vars":
      actual = bagValue(ctx.vars, condition.path);
      break;
    case "captured":
      actual = bagValue(ctx.captured, condition.path);
      break;
    case "url":
      actual = typeof page.url === "function" ? page.url() : undefined;
      break;
    case "selectorExists":
      actual = condition.selector
        ? (await page.$(condition.selector)) !== null
        : undefined;
      break;
    case "selectorVisible":
      if (!condition.selector) {
        actual = undefined;
      } else if (typeof page.isVisible === "function") {
        actual = await page.isVisible(condition.selector);
      } else {
        actual = (await page.$(condition.selector)) !== null;
      }
      break;
    case "selectorText":
      actual =
        condition.selector && typeof page.textContent === "function"
          ? await page.textContent(condition.selector)
          : undefined;
      break;
    case "selectorValue":
      actual =
        condition.selector && typeof page.inputValue === "function"
          ? await page.inputValue(condition.selector)
          : undefined;
      break;
    default: {
      const _exhaustive: never = condition.source;
      actual = _exhaustive;
    }
  }
  const expected = interpolate(condition.value ?? "", toInterpolateCtx(ctx));
  return compareConditionValue(actual, condition, expected);
}

export interface ProfilePolicyResult {
  profile: SubmitProfile;
  defaultsApplied: Array<{ field: string; reason: string }>;
  missing: Array<{ field: string; message: string }>;
}

function profileConditionMatches(
  profile: SubmitProfile,
  condition: SpecCondition | undefined,
): boolean {
  if (!condition) return true;
  if (condition.source !== "profile") {
    throw new Error("profile policy condition must use source=profile");
  }
  const bag = profile as unknown as Record<string, unknown>;
  const actual = bagValue(bag, condition.path);
  const expected = interpolate(condition.value ?? "", {
    profile: bag,
    vars: {},
    captured: {},
  });
  return compareConditionValue(actual, condition, expected);
}

/**
 * Applies explicit, auditable defaults to a copy of the profile and checks
 * required fields. It never invents a value unless the uploaded spec names the
 * value/source and records a business-policy reason.
 */
export function applyProfilePolicy(
  input: SubmitProfile,
  policy?: ProfilePolicy,
): ProfilePolicyResult {
  const profile = { ...input };
  const bag = profile as unknown as Record<string, unknown>;
  const defaultsApplied: Array<{ field: string; reason: string }> = [];

  for (const rule of policy?.defaults ?? []) {
    const current = bag[rule.field];
    if (current != null && String(current).trim() !== "") continue;
    if (!profileConditionMatches(profile, rule.when)) continue;
    const raw =
      rule.valueFrom != null
        ? resolveProfileValue(profile, rule.valueFrom)
        : (rule.value ?? "");
    const value = applyTransform(raw, rule.transform);
    if (!value.trim()) continue;
    bag[rule.field] = value;
    defaultsApplied.push({ field: rule.field, reason: rule.reason });
  }

  const missing: Array<{ field: string; message: string }> = [];
  for (const rule of policy?.required ?? []) {
    if (!profileConditionMatches(profile, rule.when)) continue;
    const value = bag[rule.field];
    if (value == null || String(value).trim() === "") {
      missing.push({
        field: rule.field,
        message: rule.message ?? `${rule.field} is required`,
      });
    }
  }
  return { profile, defaultsApplied, missing };
}

async function evaluateConditionSet(
  page: SpecPage,
  set: { conditions: SpecCondition[]; match: "all" | "any" },
  ctx: StepContext,
): Promise<boolean> {
  if (set.match === "any") {
    for (const condition of set.conditions) {
      if (await evaluateCondition(page, condition, ctx)) return true;
    }
    return false;
  }
  for (const condition of set.conditions) {
    if (!(await evaluateCondition(page, condition, ctx))) return false;
  }
  return true;
}

/** Applies ordered v2 outcome rules; no match is an explicit failed result. */
export async function classifyOutcomeRules(
  page: SpecPage,
  rules: OutcomeRule[],
  ctx: StepContext,
): Promise<SubmitResult> {
  for (const rule of rules) {
    if (!(await evaluateConditionSet(page, rule.detect, ctx))) continue;
    const externalBag =
      rule.externalRefFrom?.source === "captured"
        ? ctx.captured
        : ctx.vars;
    const externalRef = rule.externalRefFrom
      ? bagValue(externalBag, rule.externalRefFrom.path)
      : undefined;
    const base: SubmitResult = {
      submitted: false,
      alreadyExists: false,
      programMissing: false,
      ...(rule.detail ? { detail: rule.detail } : {}),
      ...(externalRef != null && String(externalRef).trim()
        ? { externalRef: String(externalRef) }
        : {}),
    };
    switch (rule.outcome) {
      case "submitted":
        return { ...base, submitted: true };
      case "alreadyExists":
        return { ...base, alreadyExists: true };
      case "programMissing":
        return { ...base, programMissing: true };
      case "programFull":
        return { ...base, programFull: true };
      case "failure":
        return base;
      default: {
        const _exhaustive: never = rule.outcome;
        return _exhaustive;
      }
    }
  }
  return {
    submitted: false,
    alreadyExists: false,
    programMissing: false,
    detail: "spec_outcome_unproved: no authored outcome rule matched",
  };
}

/** True when an action can change portal/page state or upload applicant data. */
export function isMutatingSpecStep(step: SpecStep): boolean {
  switch (step.action) {
    case "navigate":
    case "waitFor":
    case "ajaxWait":
    case "capture":
    case "setVar":
    case "assert":
      return false;
    case "http":
      return step.mutation === true || step.method !== "GET";
    case "graphql":
      // Strict dry-run treats every GraphQL POST as potentially mutating.
      // The author-supplied mutation flag is not a sufficient safety boundary.
      return true;
    case "fill":
    case "select":
    case "click":
    case "upload":
    case "check":
    case "radio":
    case "jsHook":
    case "lookup":
    case "selectLabel":
    case "clickCardByText":
    case "phone":
    case "clickRole":
    case "selectProgram":
      return true;
    default: {
      const _exhaustive: never = step;
      return _exhaustive;
    }
  }
}

/** Executes a single spec step. Honors `optional` (errors are warned, not thrown). */
export async function executeSpecStep(
  page: SpecPage,
  step: SpecStep,
  ctx: StepContext,
): Promise<void> {
  try {
    if (step.when && !(await evaluateCondition(page, step.when, ctx))) {
      logger.info(`[spec] condition false — skipping "${step.action}"`);
      return;
    }

    switch (step.action) {
      case "navigate":
        await page.goto(step.url);
        break;

      case "fill": {
        const sel = resolveStepSelector(step);
        const base = step.valueFrom != null
          ? resolveProfileValue(ctx.profile, step.valueFrom)
          : (step.value ?? "");
        const value = applyTransform(base, step.transform);
        await page.fill(sel, value);
        if (step.readback) {
          await verifyControlReadback(page, sel, value, step.readback);
        }
        break;
      }

      case "select": {
        const sel = resolveStepSelector(step);
        const base = resolveProfileValue(ctx.profile, step.valueFrom);
        const value = applyTransform(base, step.transform);
        if (step.byLabel) await page.selectOption(sel, { label: value });
        else await page.selectOption(sel, value);
        if (step.readback) {
          await verifyControlReadback(page, sel, value, step.readback);
        }
        break;
      }

      case "click": {
        const selector = resolveStepSelector(step);
        if (step.requireUnique) {
          if (typeof page.$$eval !== "function") {
            throw new Error("unique click proof is unavailable on this page");
          }
          const count = await page.$$eval(selector, (elements) => elements.length);
          if (count !== 1) {
            throw new Error(`click target is not unique (count=${count})`);
          }
        }
        await page.click(selector);
        break;
      }

      case "upload": {
        const sel = resolveStepSelector(step);
        const filePath = resolveSlotFile(step.slot, ctx);
        const slotDef = ctx.documentSlots?.slots?.[step.slot];
        const required = slotDef?.required ?? !step.optional;
        if (!filePath) {
          if (required) {
            throw new Error(`data_missing: required document slot "${step.slot}"`);
          }
          logger.warn(`[spec] upload skipped — no file for optional slot "${step.slot}"`);
          break;
        }

        const proof = step.proof;
        let responsePromise:
          | ReturnType<NonNullable<SpecPage["waitForResponse"]>>
          | undefined;
        if (proof?.responseUrlContains) {
          if (typeof page.waitForResponse !== "function") {
            throw new Error("upload response proof is unavailable on this page");
          }
          responsePromise = page.waitForResponse(
            (response) => response.url().includes(proof.responseUrlContains!),
            { timeout: proof.timeoutMs },
          );
        }

        await page.setInputFiles(sel, filePath);

        const response = responsePromise ? await responsePromise : undefined;

        if (proof?.localFileName) {
          if (typeof page.inputValue !== "function") {
            throw new Error("upload filename readback is unavailable on this page");
          }
          const reportedName = basename(
            (await page.inputValue(sel)).replaceAll("\\", "/"),
          );
          if (reportedName !== basename(filePath)) {
            throw new Error(
              `upload filename readback mismatch for slot "${step.slot}"`,
            );
          }
        }

        if (response) {
          const status = response.status();
          if (status < 200 || status >= 300) {
            throw new Error(
              `upload response failed for slot "${step.slot}" (status=${status})`,
            );
          }
          if (proof?.responseTextIncludes) {
            const responseText = await response.text();
            if (!responseText.includes(proof.responseTextIncludes)) {
              throw new Error(
                `upload response proof text missing for slot "${step.slot}"`,
              );
            }
          }
        }

        if (proof?.successSelector) {
          await page.waitForSelector(proof.successSelector, {
            timeout: proof.timeoutMs,
          });
          if (proof.successText) {
            if (typeof page.textContent !== "function") {
              throw new Error("upload success text proof is unavailable on this page");
            }
            const successText = await page.textContent(proof.successSelector);
            if (!successText?.includes(proof.successText)) {
              throw new Error(
                `upload success text missing for slot "${step.slot}"`,
              );
            }
          }
        }

        ctx.uploadedSlots?.add(step.slot);
        break;
      }

      case "check": {
        const sel = resolveStepSelector(step);
        const want = step.value ?? true;
        let current = false;
        try {
          current = page.isChecked ? await page.isChecked(sel) : false;
        } catch {
          current = false;
        }
        if (current !== want) await page.click(sel);
        break;
      }

      case "radio": {
        const raw = resolveProfileValue(ctx.profile, step.valueFrom).trim().toLowerCase();
        const sel =
          step.map[raw] ??
          Object.entries(step.map).find(
            ([k]) => raw && (raw === k || raw.startsWith(k) || raw.includes(k)),
          )?.[1] ??
          step.fallback;
        if (sel) await page.click(sel);
        else logger.warn(`[spec] radio: no match for "${raw}"`);
        break;
      }

      case "waitFor":
        await page.waitForSelector(resolveStepSelector(step));
        break;

      case "lookup": {
        const sel = resolveStepSelector(step);
        const typed = resolveProfileValue(ctx.profile, step.valueFrom);
        await page.fill(sel, typed);
        await clickOption(page, step.optionText ?? typed);
        break;
      }

      case "selectLabel": {
        const sel = resolveStepSelector(step);
        const raw = resolveProfileValue(ctx.profile, step.valueFrom);
        const label = step.map ? (step.map[raw] ?? raw) : raw;
        await page.selectOption(sel, { label });
        if (step.readback) {
          await verifyControlReadback(page, sel, label, step.readback);
        }
        break;
      }

      case "clickCardByText": {
        const text = step.textFrom != null
          ? resolveProfileValue(ctx.profile, step.textFrom)
          : (step.text ?? "");
        const cssSel = step.containerHint
          ? `${step.containerHint} :has-text("${text}")`
          : `:is(button,li,[role="option"],[role="button"]):has-text("${text}")`;
        await page.click(cssSel);
        break;
      }

      case "phone": {
        const country = resolveProfileValue(ctx.profile, step.countryFrom);
        const number = resolveProfileValue(ctx.profile, step.numberFrom);
        const countrySel = step.countrySelector ?? '[aria-label*="ountry" i],[name*="ountry" i]';
        const numberSel = step.numberSelector ?? '[aria-label*="hone" i],[name*="hone" i]';
        await page.fill(countrySel, country);
        await clickOption(page, country);
        await page.fill(numberSel, number);
        break;
      }

      case "clickRole": {
        if (typeof page.getByRole !== "function") {
          throw new Error("clickRole is unavailable on this page");
        }
        const locator = page.getByRole(step.role, {
          name: step.name,
          exact: step.exact,
        });
        if (typeof locator.count !== "function") {
          throw new Error("clickRole uniqueness proof is unavailable on this page");
        }
        const count = await locator.count();
        if (count !== 1) {
          throw new Error(`clickRole target is not unique (count=${count})`);
        }
        await locator.click();
        break;
      }

      case "selectProgram": {
        const selection = ctx.programSelection;
        if (!selection) {
          throw new Error("selectProgram requires top-level programSelection");
        }
        const selector = step.selector ?? selection.selector;
        if (!selector) {
          throw new Error("selectProgram requires a select selector");
        }

        const level = (ctx.profile.level ?? "").trim().toLocaleLowerCase("en");
        const levelRule = selection.levelRules?.find((rule) =>
          level.includes(rule.when.trim().toLocaleLowerCase("en")),
        );
        if (levelRule) await page.click(levelRule.radio);

        const catalog = await enumerateProgramCatalog(page, selection, selector);
        const allOptions = catalog.map((option) => ({
          v: option.value,
          t: option.name,
        }));
        const matched = resolveProgramValue(allOptions, ctx.profile, selection);
        if (!matched) {
          throw new SpecProgramMissingError(ctx.profile, catalog);
        }
        const matchedCatalog = catalog.find(
          (option) => option.value === matched.value,
        );
        if (!matchedCatalog?.enabled) {
          throw new SpecProgramFullError(
            ctx.profile,
            matchedCatalog ?? {
              value: matched.value,
              name: ctx.profile.programName,
              enabled: false,
            },
            catalog,
          );
        }
        await page.selectOption(selector, matched.value);
        ctx.captured["selectedProgramValue"] = matched.value;
        ctx.captured["selectedProgramConfidence"] = matched.conf;
        ctx.captured["selectedProgramLabel"] =
          matchedCatalog.name;
        break;
      }

      case "ajaxWait": {
        // Best-effort: MinimalPage has no response API. If the page exposes a
        // waitForResponse capability, the live wrapper handles it; otherwise we
        // fall back to a short selector-less settle and continue.
        const maybe = page as unknown as {
          waitForResponse?: (pred: (r: { url(): string }) => boolean, opts?: { timeout?: number }) => Promise<unknown>;
        };
        if (typeof maybe.waitForResponse === "function") {
          await maybe.waitForResponse(
            (r) => r.url().includes(step.urlContains),
            step.timeoutMs ? { timeout: step.timeoutMs } : undefined,
          );
        } else {
          logger.warn(`[spec] ajaxWait("${step.urlContains}") — page has no response API; continuing`);
        }
        break;
      }

      case "jsHook": {
        if (!ctx.allowJsHook) {
          logger.warn("[spec] jsHook skipped — spec is not trusted (allowJsHook=false)");
          break;
        }
        await page.evaluate(step.script);
        break;
      }

      case "http":
      case "graphql":
      case "capture":
      case "setVar": {
        await executeHttpLikeStep(
          step,
          toInterpolateCtx(ctx),
          page as unknown as Parameters<typeof executeHttpLikeStep>[2],
          { dryRun: ctx.dryRun, allowedOrigins: ctx.allowedOrigins },
        );
        break;
      }

      case "assert": {
        if (!(await evaluateCondition(page, step.condition, ctx))) {
          throw new Error(step.message);
        }
        break;
      }

      default: {
        const _exhaustive: never = step;
        logger.warn(`[spec] unknown step: ${JSON.stringify(_exhaustive)}`);
      }
    }
  } catch (err) {
    if (step.action !== "jsHook" && "optional" in step && step.optional) {
      logger.warn(`[spec] optional step "${step.action}" failed (ignored): ${String(err)}`);
      return;
    }
    throw err;
  }
}

/** Runs a list of spec steps. In dry mode, terminal `click {final:true}` steps are skipped. */
export async function runSpecSteps(
  page: SpecPage,
  steps: SpecStep[],
  ctx: StepContext,
  skipFinal = false,
): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (
      ctx.dryRun &&
      ctx.dryRunPolicy === "strict" &&
      isMutatingSpecStep(step)
    ) {
      logger.info(
        `[spec] STRICT DRY: skipping mutation step #${i + 1} (${step.action})`,
      );
      continue;
    }
    if (
      skipFinal &&
      (step.action === "click" || step.action === "clickRole") &&
      step.final
    ) {
      logger.warn(`[spec] DRY: skipping final step #${i + 1}`);
      continue;
    }
    // http/graphql mutation steps are also skipped in dry-run (handled inside
    // executeHttpLikeStep via ctx.dryRun, but log here for tracing).
    try {
      await executeSpecStep(page, step, ctx);
    } catch (err) {
      if (
        err instanceof SpecProgramMissingError ||
        err instanceof SpecProgramFullError
      ) {
        throw err;
      }
      throw new Error(`[spec] step #${i + 1} (action="${step.action}") failed: ${String(err)}`);
    }
  }
}

async function detectWorkflowState(
  page: SpecPage,
  states: WorkflowState[],
  ctx: StepContext,
): Promise<WorkflowState | null> {
  const matches: WorkflowState[] = [];
  for (const state of states) {
    if (await evaluateConditionSet(page, state.detect, ctx)) matches.push(state);
  }
  if (matches.length > 1) {
    throw new Error(
      `[spec-v2] ambiguous workflow state: ${matches.map((state) => state.id).join(", ")}`,
    );
  }
  return matches[0] ?? null;
}

async function waitBetweenDetectorReads(page: SpecPage, ms: number): Promise<void> {
  if (ms <= 0) return;
  if (typeof page.waitForTimeout === "function") {
    await page.waitForTimeout(ms);
    return;
  }
  // Mock/minimal pages need no wall-clock wait. Live Playwright pages always
  // expose waitForTimeout, so this branch does not weaken production stability.
}

/**
 * Accepts a state only after consecutive identical detector reads. A transient
 * blank or conflicting state is never promoted to the logical current state.
 */
export async function detectStableWorkflowState(
  page: SpecPage,
  workflow: SpecWorkflow,
  ctx: StepContext,
): Promise<WorkflowState | null> {
  let accepted: WorkflowState | null = null;
  for (let i = 0; i < workflow.stableReads; i++) {
    const observed = await detectWorkflowState(page, workflow.states, ctx);
    if (i === 0) {
      accepted = observed;
    } else if (observed?.id !== accepted?.id) {
      return null;
    }
    if (i + 1 < workflow.stableReads) {
      await waitBetweenDetectorReads(page, workflow.settleMs);
    }
  }
  return accepted;
}

/**
 * Executes a resumable v2 workflow. The logical state changes only after:
 *  1. a stable detector proves a different state, and
 *  2. an authored transition from the previous state allows that target.
 *
 * Validation that leaves the same state active consumes a bounded retry.
 */
export async function runSpecWorkflow(
  page: SpecPage,
  workflow: SpecWorkflow,
  ctx: StepContext,
): Promise<string> {
  let current = await detectStableWorkflowState(page, workflow, ctx);
  if (!current) {
    throw new Error("[spec-v2] active workflow state could not be proven");
  }

  if (ctx.dryRun && ctx.dryRunPolicy === "strict") {
    logger.info(`[spec-v2] STRICT DRY: active state="${current.id}", no workflow mutation executed`);
    return current.id;
  }

  const retries = new Map<string, number>();
  for (let transitionCount = 0; transitionCount < workflow.maxTransitions; transitionCount++) {
    logger.info(`[spec-v2] state="${current.id}" attempt=${(retries.get(current.id) ?? 0) + 1}`);
    if (current.terminal) return current.id;

    await runSpecSteps(page, current.steps, ctx, false);

    const observed = await detectStableWorkflowState(page, workflow, ctx);
    if (!observed) {
      throw new Error(`[spec-v2] state after "${current.id}" could not be proven`);
    }

    if (observed.id === current.id) {
      const nextRetry = (retries.get(current.id) ?? 0) + 1;
      retries.set(current.id, nextRetry);
      if (nextRetry > current.maxRetries) {
        throw new Error(
          `[spec-v2] state "${current.id}" did not advance after ${nextRetry} attempt(s)`,
        );
      }
      continue;
    }

    let allowed = false;
    for (const transition of current.transitions) {
      if (transition.to !== observed.id) continue;
      if (await evaluateConditionSet(page, transition, ctx)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      throw new Error(
        `[spec-v2] unapproved transition "${current.id}" → "${observed.id}"`,
      );
    }

    retries.delete(current.id);
    current = observed;
  }

  throw new Error(
    `[spec-v2] workflow exceeded maxTransitions=${workflow.maxTransitions}`,
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SpecAdapterOpts {
  /** Allow jsHook steps to execute. Set only for trusted specs. */
  allowJsHook?: boolean;
}

/**
 * Builds a UniversityAdapter from a validated AdapterSpec. The login() and
 * submit() methods open a real browser; the pure helpers above are exercised
 * directly by unit tests with mock pages.
 */
export function createSpecAdapter(
  spec: AdapterSpec,
  opts: SpecAdapterOpts = {},
): UniversityAdapter {
  const allowJsHook = opts.allowJsHook ?? false;

  return {
    key: spec.meta.key,
    label: spec.meta.name,
    portalUrl: spec.auth.loginUrl,

    matches(name: string): boolean {
      const f = fold(name);
      return spec.meta.matches.some((p) => f.includes(fold(p)));
    },

    async login(loginOpts?: LoginOpts): Promise<AdapterSession> {
      const { user, password } = loginOpts?.credentials ?? portalCreds(spec.meta.key);
      const session = await launchPortal({ headless: loginOpts?.headless ?? true });
      const page = session.page as unknown as SpecPage;

      logger.info(`[${spec.meta.key}] login — ${spec.auth.loginUrl}`);
      await page.goto(spec.auth.loginUrl);
      // The login steps reference credentials via a synthetic profile so the
      // same step machinery (fill/click/waitFor) drives the login form.
      const credProfile = { ...emptyProfile(), email: user, passportNumber: password } as SubmitProfile;
      const loginVars: Record<string, unknown> = {};
      const loginCaptured: Record<string, unknown> = {};
      await runSpecSteps(
        page,
        spec.auth.loginSteps,
        {
          profile: credProfile,
          files: {},
          allowJsHook,
          vars: loginVars,
          captured: loginCaptured,
          allowedOrigins: spec.meta.allowedOrigins ?? [],
          dryRun: false,
        },
        false,
      );
      if (spec.auth.successUrlContains && typeof page.url === "function") {
        const u = page.url();
        if (!u.includes(spec.auth.successUrlContains)) {
          logger.warn(`[${spec.meta.key}] login — successUrlContains not found in "${u}"`);
        }
      }
      logger.info(`[${spec.meta.key}] login — done`);
      return session;
    },

    async submit(
      session: AdapterSession,
      profile: SubmitProfile,
      files: SubmitFiles,
      doSubmit = true,
    ): Promise<SubmitResult> {
      const page = session.page as unknown as SpecPage;
      const dry = doSubmit === false || process.env.PORTAL_DRYRUN === "1";
      const policyResult = applyProfilePolicy(profile, spec.profilePolicy);
      if (policyResult.missing.length > 0) {
        throw new Error(
          `[spec-v2] data_missing — ${policyResult.missing
            .map((item) => `${item.field}:${item.message}`)
            .join(", ")}`,
        );
      }
      for (const applied of policyResult.defaultsApplied) {
        logger.info(
          `[${spec.meta.key}] profile default applied` +
          ` (field=${applied.field}, policy=${applied.reason})`,
        );
      }
      const effectiveProfile = policyResult.profile;
      logger.info(
        `[${spec.meta.key}] submit — program: ${effectiveProfile.programName} (dry=${dry})`,
      );

      const submitVars: Record<string, unknown> = {};
      const submitCaptured: Record<string, unknown> = {};
      const dryRunPolicy =
        spec.meta.dryRunPolicy ?? (spec.specVersion === 2 ? "strict" : "legacy");
      const submitCtx: StepContext = {
        profile: effectiveProfile,
        files,
        documentSlots: spec.documents,
        programSelection: spec.programSelection,
        allowJsHook,
        vars: submitVars,
        captured: submitCaptured,
        allowedOrigins: spec.meta.allowedOrigins ?? [],
        dryRun: dry,
        dryRunPolicy,
        uploadedSlots: new Set<string>(),
      };
      try {
        await runSpecSteps(
          page,
          spec.steps,
          submitCtx,
          dry,
        );
        if (spec.workflow) {
          await runSpecWorkflow(page, spec.workflow, submitCtx);
        }
      } catch (error) {
        if (error instanceof SpecProgramFullError) {
          return {
            submitted: false,
            alreadyExists: false,
            programMissing: false,
            programFull: true,
            requestedProgram: {
              value: error.matched.value,
              name: error.matched.name,
            },
            openPrograms: error.catalog,
            uploadedSlots: [...(submitCtx.uploadedSlots ?? [])],
            detail: "program_full: matched portal option is disabled",
          };
        }
        if (error instanceof SpecProgramMissingError) {
          return {
            submitted: false,
            alreadyExists: false,
            programMissing: true,
            requestedProgram: { name: error.profile.programName },
            availablePrograms: error.catalog,
            resolution: "not_in_dropdown",
            uploadedSlots: [...(submitCtx.uploadedSlots ?? [])],
            detail: "program_missing: requested programme is not in the live portal catalog",
          };
        }
        throw error;
      }

      if (dry) {
        logger.warn(
          `[${spec.meta.key}] DRY(${dryRunPolicy}): no terminal application submit executed`,
        );
        return { submitted: false, alreadyExists: false, programMissing: false };
      }

      const result = spec.outcomes
        ? await classifyOutcomeRules(page, spec.outcomes, submitCtx)
        : await classifyResult(page, spec.success, spec.failure);
      result.uploadedSlots = [...(submitCtx.uploadedSlots ?? [])];
      logger.info(
        `[${spec.meta.key}] submit done — submitted=${result.submitted}` +
        ` alreadyExists=${result.alreadyExists} programMissing=${result.programMissing}`,
      );
      return result;
    },

    ...(spec.programSelection
      ? {
          async listPrograms(
            session: AdapterSession,
            level?: string,
          ): Promise<ProgramOption[]> {
            const page = session.page as unknown as SpecPage;
            const normalizedLevel = (level ?? "").trim().toLocaleLowerCase("en");
            const levelRule = spec.programSelection?.levelRules?.find((rule) =>
              normalizedLevel.includes(
                rule.when.trim().toLocaleLowerCase("en"),
              ),
            );
            if (levelRule) await page.click(levelRule.radio);
            return enumerateProgramOptions(page, spec.programSelection!);
          },
        }
      : {}),
  };
}

/** A zero-value SubmitProfile used to drive the login step machinery. */
function emptyProfile(): SubmitProfile {
  return {
    email: "", passportNumber: "", firstName: "", lastName: "", dateOfBirth: "",
    gender: "", fatherName: "", motherName: "", nationality: "", address: "",
    phone: "", level: "", programName: "", programId: "",
  };
}
