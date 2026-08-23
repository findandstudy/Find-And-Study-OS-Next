/**
 * declarativeAdapter.ts — generic UniversityAdapter factory driven by a
 * JSON-serialisable config object.
 *
 * A declarative adapter handles the login + step-based form-fill for any
 * portal that follows a predictable "fill-fields → click-submit" pattern,
 * without requiring a hand-written TypeScript adapter file.
 *
 * Usage
 * -----
 *   import { createDeclarativeAdapter } from "./declarativeAdapter.js";
 *
 *   const adapter = createDeclarativeAdapter({
 *     key:   "uskudar",
 *     label: "Üsküdar Üniversitesi",
 *     matches: ["uskudar", "üsküdar"],
 *     loginUrl: "https://apply.uskudar.edu.tr/login",
 *     credentials: {
 *       userSelector:   "#email",
 *       passSelector:   "#password",
 *       submitSelector: "button[type=submit]",
 *       afterSelector:  ".dashboard",   // optional — wait for this after login
 *     },
 *     steps: [
 *       { type: "navigate", url: "https://apply.uskudar.edu.tr/new" },
 *       { type: "fill",   selector: "#firstName", field: "firstName" },
 *       { type: "fill",   selector: "#lastName",  field: "lastName"  },
 *       { type: "fill",   selector: "#dob",       field: "dateOfBirth" },
 *       { type: "select", selector: "#gender",    field: "gender"    },
 *       { type: "upload", selector: "#passport",  fileField: "passport" },
 *       { type: "click",  selector: "#submitBtn" },
 *     ],
 *     submitCheck: {
 *       successText:        "başvurunuz alınmıştır",
 *       alreadyExistsText:  "kayıtlı öğrenci",
 *       programMissingText: "program bulunamadı",
 *     },
 *   });
 */

import type {
  UniversityAdapter,
  AdapterSession,
  SubmitProfile,
  SubmitFiles,
  SubmitResult,
  LoginOpts,
} from "./types.js";
import { launchPortal, logger } from "./browser.js";
import { portalCreds } from "./portalCreds.js";
import { fold } from "./programMatch.js";

// ---------------------------------------------------------------------------
// Step types
// ---------------------------------------------------------------------------

/** Profile fields that a step can read from. */
export type ProfileField = keyof SubmitProfile;

/** Document file-path fields that a step can read from. */
export type FileField = keyof SubmitFiles;

/**
 * A single automation step executed against the browser page.
 *
 * - navigate  → page.goto(url)
 * - fill      → page.fill(selector, profile[field] | value)
 * - select    → page.selectOption(selector, profile[field])
 * - click     → page.click(selector)
 * - upload    → page.setInputFiles(selector, files[fileField])
 * - wait      → page.waitForSelector(selector)
 * - screenshot → no-op in dry mode; captures PNG in real mode
 */
export type DeclarativeStep =
  // --- existing variants stay unchanged ---
  | { type: "navigate";   url: string }
  | { type: "fill";       selector: string; field: ProfileField; value?: never }
  | { type: "fill";       selector: string; value: string;       field?: never }
  | { type: "select";     selector: string; field: ProfileField }
  | { type: "click";      selector: string; final?: boolean }
  | { type: "upload";     selector: string; fileField: FileField }
  | { type: "wait";       selector: string }
  | { type: "screenshot" }
  // --- NEW variants ---
  /** Ensure a checkbox matches `value` (default true). Clicks only if state differs. */
  | { type: "check";      selector: string; value?: boolean }
  /** Pick a radio by profile field. `map` keys are normalized (lowercased) profile
   *  values → radio input CSS selectors. `fallback` is clicked if no key matches. */
  | { type: "radio";      field: ProfileField; map: Record<string, string>; fallback?: string }
  /** <select> by visible OPTION LABEL (not value) — for country lists etc. */
  | { type: "selectLabel"; selector: string; field: ProfileField }
  /** intl-tel-input style phone: fills the visible input AND sets the hidden
   *  full-number input so portal validation passes. */
  | { type: "phone";      selector: string; field: ProfileField; hiddenSelector?: string };

// ---------------------------------------------------------------------------
// Declarative config
// ---------------------------------------------------------------------------

export interface DeclarativeCredentials {
  /** CSS selector for the username / e-mail input. */
  userSelector: string;
  /** CSS selector for the password input. */
  passSelector: string;
  /** CSS selector for the login submit button. */
  submitSelector: string;
  /**
   * Optional selector to wait for after clicking submit to confirm the
   * session is authenticated (e.g. ".dashboard", "#mainMenu").
   */
  afterSelector?: string;
}

export interface SubmitCheck {
  /** CSS selector that must exist in the DOM for a "submitted" outcome. */
  successSelector?: string;
  /** Case-insensitive substring that must appear in page HTML for "submitted". */
  successText?: string;
  /** Case-insensitive substring indicating the student is already registered. */
  alreadyExistsText?: string;
  /** Case-insensitive substring indicating the programme was not found. */
  programMissingText?: string;
}

export interface DeclarativeConfig {
  /** Unique adapter key (snake_case). Must match the env-var prefix used by portalCreds(). */
  key: string;
  /** Human-readable adapter label (displayed in UI / logs). */
  label: string;
  /**
   * Lowercase patterns checked against the case-folded university name.
   * The adapter matches when ANY pattern is found as a substring.
   */
  matches: string[];
  /** Full URL of the portal login page. */
  loginUrl: string;
  /** Login form selectors + credentials. */
  credentials: DeclarativeCredentials;
  /**
   * Ordered list of steps executed after a successful login.
   * Steps run sequentially; any step failure aborts the submission.
   */
  steps: DeclarativeStep[];
  /** Heuristics used to classify the post-submit page state. */
  submitCheck: SubmitCheck;
}

// ---------------------------------------------------------------------------
// Minimal page interface — subset of Playwright Page used by this engine.
// Using a structural interface makes it easy to inject mock pages in tests.
// ---------------------------------------------------------------------------

export interface MinimalPage {
  goto(url: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  selectOption(selector: string, value: string | { label?: string; value?: string }): Promise<unknown>;
  setInputFiles(selector: string, path: string): Promise<void>;
  waitForSelector(selector: string): Promise<unknown>;
  content(): Promise<string>;
  $(selector: string): Promise<unknown | null>;
  evaluate(expression: string): Promise<unknown>;
  isChecked?(selector: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// executeStep — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Executes a single declarative step against the given page.
 *
 * Exported so tests can drive it with a mock page (no real browser needed).
 */
export async function executeStep(
  page: MinimalPage,
  step: DeclarativeStep,
  profile: SubmitProfile,
  files: SubmitFiles,
): Promise<void> {
  switch (step.type) {
    case "navigate":
      await page.goto(step.url);
      break;

    case "fill": {
      const value =
        step.field != null
          ? String(profile[step.field] ?? "")
          : (step.value ?? "");
      await page.fill(step.selector, value);
      break;
    }

    case "select": {
      const value = String(profile[step.field] ?? "");
      await page.selectOption(step.selector, value);
      break;
    }

    case "click":
      await page.click(step.selector);
      break;

    case "upload": {
      const filePath = files[step.fileField];
      if (filePath) {
        await page.setInputFiles(step.selector, filePath);
      } else {
        logger.warn(`[declarative] upload step skipped — no file for "${step.fileField}"`);
      }
      break;
    }

    case "wait":
      await page.waitForSelector(step.selector);
      break;

    case "screenshot":
      // No-op at this layer; the worker captures screenshots separately.
      break;

    case "check": {
      const want = step.value ?? true;
      // Read current state; click only on mismatch. Fallback: click if we can't read.
      let current = false;
      try {
        current = step.selector && page.isChecked ? await page.isChecked(step.selector) : false;
      } catch {
        current = false;
      }
      if (current !== want) await page.click(step.selector);
      break;
    }

    case "radio": {
      const raw = String(profile[step.field] ?? "").trim().toLowerCase();
      let sel: string | undefined =
        step.map[raw] ??
        Object.entries(step.map).find(([k]) => raw && (raw === k || raw.startsWith(k) || raw.includes(k)))?.[1];
      sel = sel ?? step.fallback;
      if (sel) await page.click(sel);
      else logger.warn(`[declarative] radio step: no match for "${raw}" on field "${step.field}"`);
      break;
    }

    case "selectLabel": {
      const label = String(profile[step.field] ?? "");
      if (label) await page.selectOption(step.selector, { label });
      break;
    }

    case "phone": {
      const value = String(profile[step.field] ?? "");
      if (value) {
        await page.fill(step.selector, value);
        if (step.hiddenSelector) {
          const sel = JSON.stringify(step.hiddenSelector);
          const val = JSON.stringify(value);
          await page.evaluate(
            `(() => { const el = document.querySelector(${sel}); if (el) { el.value = ${val}; el.dispatchEvent(new Event("input",{bubbles:true})); el.dispatchEvent(new Event("change",{bubbles:true})); } })()`,
          );
        }
      }
      break;
    }

    default:
      logger.warn("[declarative] Unknown step type:", (step as { type: string }).type);
  }
}

// ---------------------------------------------------------------------------
// runSteps — exported for unit testing
// ---------------------------------------------------------------------------

/**
 * Executes all declarative steps in order.
 * On any step error the function throws (aborting the submission).
 */
export async function runSteps(
  page: MinimalPage,
  steps: DeclarativeStep[],
  profile: SubmitProfile,
  files: SubmitFiles,
  skipFinal = false,
): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (skipFinal && step.type === "click" && (step as { final?: boolean }).final) {
      logger.warn(`[declarative] DRY: skipping final step #${i + 1}`);
      continue;
    }
    try {
      await executeStep(page, step, profile, files);
    } catch (err) {
      throw new Error(
        `[declarative] Step #${i + 1} (type="${step.type}") failed: ${String(err)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// checkResult — classify the post-submit page state
// ---------------------------------------------------------------------------

export async function checkResult(
  page: MinimalPage,
  check: SubmitCheck,
): Promise<SubmitResult> {
  const html = (await page.content()).toLowerCase();

  // Priority: alreadyExists > programMissing > submitted > default-false
  if (check.alreadyExistsText && html.includes(check.alreadyExistsText.toLowerCase())) {
    return { submitted: false, alreadyExists: true, programMissing: false };
  }

  if (check.programMissingText && html.includes(check.programMissingText.toLowerCase())) {
    return { submitted: false, alreadyExists: false, programMissing: true };
  }

  if (check.successText && html.includes(check.successText.toLowerCase())) {
    return { submitted: true, alreadyExists: false, programMissing: false };
  }

  if (check.successSelector) {
    const el = await page.$(check.successSelector);
    if (el !== null) {
      return { submitted: true, alreadyExists: false, programMissing: false };
    }
  }

  // Nothing matched — conservative: not submitted
  return { submitted: false, alreadyExists: false, programMissing: false };
}

// ---------------------------------------------------------------------------
// createDeclarativeAdapter — factory function
// ---------------------------------------------------------------------------

/**
 * Creates a fully functional UniversityAdapter from a declarative config.
 * The login() and submit() methods open a real browser; they are never
 * invoked during unit tests (the step helpers are tested in isolation).
 */
export function createDeclarativeAdapter(
  config: DeclarativeConfig,
): UniversityAdapter {
  return {
    key:   config.key,
    label: config.label,
    portalUrl: config.loginUrl,

    matches(name: string): boolean {
      const f = fold(name);
      return config.matches.some((pattern) => f.includes(fold(pattern)));
    },

    async login(opts?: LoginOpts): Promise<AdapterSession> {
      const { user, password } = opts?.credentials ?? portalCreds(config.key);
      const session = await launchPortal({ headless: opts?.headless ?? true });
      const page = session.page as unknown as MinimalPage;

      logger.info(`[${config.key}] login — navigating to ${config.loginUrl}`);
      await page.goto(config.loginUrl);
      await page.fill(config.credentials.userSelector, user);
      await page.fill(config.credentials.passSelector, password);
      await page.click(config.credentials.submitSelector);

      if (config.credentials.afterSelector) {
        await page.waitForSelector(config.credentials.afterSelector);
      }

      logger.info(`[${config.key}] login — authenticated`);
      return session;
    },

    async submit(
      session: AdapterSession,
      profile: SubmitProfile,
      files: SubmitFiles,
      doSubmit = true,
    ): Promise<SubmitResult> {
      logger.info(`[${config.key}] submit — program: ${profile.programName}`);
      const page = session.page as unknown as MinimalPage;
      const dry = doSubmit === false || process.env.PORTAL_DRYRUN === "1";

      await runSteps(page, config.steps, profile, files, dry);
      if (dry) {
        logger.warn(`[${config.key}] DRY: final steps skipped — no application created`);
        return { submitted: false, alreadyExists: false, programMissing: false };
      }
      const result = await checkResult(page, config.submitCheck);

      logger.info(
        `[${config.key}] submit done —` +
        ` submitted=${result.submitted}` +
        ` alreadyExists=${result.alreadyExists}` +
        ` programMissing=${result.programMissing}`,
      );

      return result;
    },
  };
}
