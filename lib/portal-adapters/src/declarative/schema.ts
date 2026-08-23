/**
 * declarative/schema.ts — Zod schema + types for the DB-backed declarative
 * adapter SPEC format (the richer successor to the flat DeclarativeConfig).
 *
 * A "spec" describes an entire portal application flow — login, form steps,
 * document slots, program selection and success/failure detection — as a
 * single JSON-serialisable object that the interpreter (`interpreter.ts`)
 * executes against a Playwright page. Specs are stored in the
 * `portal_adapter_specs` table and uploaded/validated/versioned from the
 * Adapters tab. The existing flat `DeclarativeConfig` (portal_adapters table)
 * stays untouched — this is an opt-in parallel system.
 *
 * Design notes
 * ------------
 * - TS types are DERIVED from the zod schemas (`z.infer`) so the validator and
 *   the compile-time types can never drift.
 * - URL fields reuse the api-server SSRF guard (`isSafePortalUrl`): https only,
 *   no loopback/private/link-local/metadata hosts.
 * - Profile references use a `profile.<field>` path validated against the
 *   canonical `PROFILE_FIELDS` list (single source shared with dbLoader).
 * - `jsHook` steps are accepted by the schema but only EXECUTED for trusted
 *   specs (builtin source, or super_admin-approved). The schema is not the
 *   security boundary — the interpreter + endpoints are. See interpreter.ts.
 */

import { z } from "zod";
import { isSafePortalUrl, PROFILE_FIELDS, FILE_FIELDS } from "../shared.js";

// ---------------------------------------------------------------------------
// Shared leaf schemas
// ---------------------------------------------------------------------------

const safeUrlSchema = z
  .string()
  .url()
  .refine(isSafePortalUrl, {
    message:
      "URL must be https and must not target a private/loopback/link-local/metadata host",
  });

const profileFieldSchema = z.enum(PROFILE_FIELDS);
const fileFieldSchema = z.enum(FILE_FIELDS);

/** A `profile.<field>` reference, e.g. "profile.email". The field part must be
 *  a known SubmitProfile key. */
export const profilePathSchema = z
  .string()
  .regex(/^profile\.[a-zA-Z]+$/, {
    message: 'valueFrom must be of the form "profile.<field>"',
  })
  .refine(
    (s) => (PROFILE_FIELDS as readonly string[]).includes(s.slice("profile.".length)),
    { message: `unknown profile field (expected one of: ${PROFILE_FIELDS.join(", ")})` },
  );

/**
 * Value transform applied to a resolved profile value before it is typed into
 * the portal.
 *  - override : table[value] ?? value   (keep original when no mapping exists)
 *  - map      : table[value] ?? value   (alias of override; explicit intent)
 *  - fuzzy    : fuzzy-match against live <option> labels (only meaningful in
 *               programSelection, where candidate options exist). Elsewhere a
 *               fuzzy transform is a no-op passthrough.
 *  - toDMY    : converts an ISO date "YYYY-MM-DD" to the "DD.MM.YYYY" format
 *               expected by many Turkish portals. Non-matching strings pass through.
 */
export const transformSchema = z.object({
  type: z.enum(["override", "map", "fuzzy", "toDMY"]),
  table: z.record(z.string(), z.string()).optional(),
  threshold: z.number().min(0).max(1).optional(),
});

// ---------------------------------------------------------------------------
// Spec v2 conditions
// ---------------------------------------------------------------------------

/**
 * A side-effect-free predicate used by v2 step guards, state detection and
 * transition guards. Conditions intentionally expose only read operations;
 * arbitrary logic remains behind the separately-approved jsHook boundary.
 */
export const conditionSchema = z.object({
  source: z.enum([
    "profile",
    "vars",
    "captured",
    "url",
    "selectorExists",
    "selectorVisible",
    "selectorText",
    "selectorValue",
  ]),
  /** Bag key for profile/vars/captured sources. */
  path: z.string().min(1).optional(),
  /** CSS selector for selector* sources. Chromium CSS pierces open shadow DOM. */
  selector: z.string().min(1).optional(),
  operator: z.enum([
    "exists",
    "notExists",
    "empty",
    "notEmpty",
    "equals",
    "notEquals",
    "contains",
    "matches",
  ]),
  /**
   * Expected value. Supports {{profile.x}}, {{vars.x}} and {{captured.x}}
   * interpolation at runtime.
   */
  value: z.string().optional(),
  /** Case-insensitive string comparison for equals/contains/matches. */
  caseInsensitive: z.boolean().optional(),
});

const stepControlFields = {
  /** Execute the step only when this side-effect-free condition is true. */
  when: conditionSchema.optional(),
};

// ---------------------------------------------------------------------------
// Step schemas (discriminated by `action`)
// ---------------------------------------------------------------------------

const navigateStep = z.object({
  action: z.literal("navigate"),
  url: safeUrlSchema,
  ...stepControlFields,
  optional: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Shared selector-hint fields
// ---------------------------------------------------------------------------

/**
 * Optional shadow-DOM / name-attribute / aria-label locator hints. When
 * present on any step the interpreter converts them to CSS attribute
 * selectors (`[name="X"]` / `[aria-label="X"]`) and prefers them over
 * the plain `selector` field. All three are optional — at least one
 * locator source must be present for the step to execute.
 */
const selectorHints = {
  /** HTML `name` attribute value — resolved to `[name="X"]`. */
  name: z.string().min(1).optional(),
  /** HTML `aria-label` attribute value — resolved to `[aria-label="X"]`. */
  ariaLabel: z.string().min(1).optional(),
};

const readbackSchema = z.object({
  source: z.enum(["value", "selectedLabel"]).default("value"),
  comparison: z.enum(["exact", "trimmed", "folded"]).default("trimmed"),
  /** Reject controls that report aria-invalid="true" after the write. */
  rejectAriaInvalid: z.boolean().default(true),
});

// NOTE: the "exactly one of value/valueFrom" rule is enforced in the
// top-level superRefine (below) rather than via `.refine()` here, because
// discriminatedUnion members must be plain ZodObjects (a ZodEffects from
// `.refine()` is rejected by z.discriminatedUnion).
const fillStep = z.object({
  action: z.literal("fill"),
  selector: z.string().min(1),
  ...selectorHints,
  ...stepControlFields,
  value: z.string().optional(),
  valueFrom: profilePathSchema.optional(),
  transform: transformSchema.optional(),
  readback: readbackSchema.optional(),
  optional: z.boolean().optional(),
});

const selectStep = z.object({
  action: z.literal("select"),
  selector: z.string().min(1),
  ...selectorHints,
  ...stepControlFields,
  valueFrom: profilePathSchema,
  /** Select by visible option label instead of value attribute. */
  byLabel: z.boolean().optional(),
  transform: transformSchema.optional(),
  readback: readbackSchema.optional(),
  optional: z.boolean().optional(),
});

const clickStep = z.object({
  action: z.literal("click"),
  selector: z.string().min(1),
  ...selectorHints,
  ...stepControlFields,
  /** Marks the terminal submit click — skipped in dry-run. */
  final: z.boolean().optional(),
  /** Fail closed unless the CSS selector resolves to exactly one element. */
  requireUnique: z.boolean().optional(),
  optional: z.boolean().optional(),
});

const uploadStep = z.object({
  action: z.literal("upload"),
  selector: z.string().min(1),
  ...selectorHints,
  ...stepControlFields,
  /** Document slot key (see documents.slots) or a SubmitFiles field. */
  slot: z.string().min(1),
  proof: z
    .object({
      /** Verify that the local file input reports the exact selected basename. */
      localFileName: z.boolean().default(true),
      /** Start waiting before setInputFiles; require one successful response. */
      responseUrlContains: z.string().min(1).optional(),
      responseTextIncludes: z.string().min(1).optional(),
      /** Portal selector that must appear after the upload finishes. */
      successSelector: z.string().min(1).optional(),
      /** Optional text required inside successSelector. */
      successText: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().max(120000).default(60000),
    })
    .superRefine((proof, ctx) => {
      if (proof.responseTextIncludes && !proof.responseUrlContains) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["responseUrlContains"],
          message: "responseTextIncludes requires responseUrlContains",
        });
      }
      if (proof.successText && !proof.successSelector) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["successSelector"],
          message: "successText requires successSelector",
        });
      }
    })
    .optional(),
  optional: z.boolean().optional(),
});

const checkStep = z.object({
  action: z.literal("check"),
  selector: z.string().min(1),
  ...selectorHints,
  ...stepControlFields,
  value: z.boolean().optional(),
  optional: z.boolean().optional(),
});

const radioStep = z.object({
  action: z.literal("radio"),
  ...stepControlFields,
  valueFrom: profilePathSchema,
  map: z.record(z.string().min(1), z.string().min(1)),
  fallback: z.string().min(1).optional(),
  optional: z.boolean().optional(),
});

const waitForStep = z.object({
  action: z.literal("waitFor"),
  selector: z.string().min(1),
  ...selectorHints,
  ...stepControlFields,
  optional: z.boolean().optional(),
});

const ajaxWaitStep = z.object({
  action: z.literal("ajaxWait"),
  ...stepControlFields,
  /** Substring of the XHR/fetch URL to await (best-effort; needs page support). */
  urlContains: z.string().min(1),
  timeoutMs: z.number().int().positive().max(120000).optional(),
  optional: z.boolean().optional(),
});

const jsHookStep = z.object({
  action: z.literal("jsHook"),
  ...stepControlFields,
  /** Arbitrary page.evaluate() expression. Executed ONLY for trusted specs. */
  script: z.string().min(1),
  optional: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// New UI step schemas — lookup / selectLabel / clickCardByText / phone
// ---------------------------------------------------------------------------

/**
 * `lookup` — fills an autocomplete input with a profile value, waits for the
 * dropdown option list to appear, and clicks the matching option.
 * Playwright's `getByRole("option", {name})` is used when available; falls
 * back to a `[role="option"]:has-text(...)` CSS click otherwise.
 * Use `optionText` when the displayed option label differs from the typed value.
 */
const lookupStep = z.object({
  action: z.literal("lookup"),
  selector: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  ariaLabel: z.string().min(1).optional(),
  ...stepControlFields,
  valueFrom: profilePathSchema,
  /** Option label to click; defaults to the resolved valueFrom value. */
  optionText: z.string().min(1).optional(),
  optional: z.boolean().optional(),
});

/**
 * `selectLabel` — selects a `<select>` option by its visible label text rather
 * than by value attribute. Supports an optional `map` that translates the raw
 * profile value to the displayed label before calling selectOption.
 */
const selectLabelStep = z.object({
  action: z.literal("selectLabel"),
  selector: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  ariaLabel: z.string().min(1).optional(),
  ...stepControlFields,
  valueFrom: profilePathSchema,
  /** Optional value-to-label mapping (applied before selectOption). */
  map: z.record(z.string(), z.string()).optional(),
  readback: readbackSchema.optional(),
  optional: z.boolean().optional(),
});

/**
 * `clickCardByText` — clicks a card/button/list-item element that contains a
 * specific text string. Useful for Salesforce Lightning / LWC card grids where
 * there is no stable CSS selector. Provide `containerHint` to scope the
 * `:has-text()` search to a specific parent selector.
 */
const clickCardByTextStep = z.object({
  action: z.literal("clickCardByText"),
  ...stepControlFields,
  /** Literal text to match (use textFrom for profile-derived text). */
  text: z.string().min(1).optional(),
  /** Profile path whose value is used as the match text. */
  textFrom: profilePathSchema.optional(),
  /**
   * CSS selector for the element that wraps the cards (e.g. ".card-list").
   * When present, the interpreter generates `{containerHint} :has-text(...)`;
   * otherwise it uses `:is(button,li,[role="option"],[role="button"])`.
   */
  containerHint: z.string().min(1).optional(),
  optional: z.boolean().optional(),
});

/**
 * `phone` — fills a two-part phone field: first types the country name into a
 * combobox and clicks the matching option, then fills the phone number input.
 * Accepts optional `countrySelector`/`numberSelector` to override the default
 * aria-label heuristics.
 */
const phoneStep = z.object({
  action: z.literal("phone"),
  ...stepControlFields,
  /** Profile path for the country name typed into the country combobox. */
  countryFrom: profilePathSchema,
  /** Profile path for the full phone number (including country code). */
  numberFrom: profilePathSchema,
  /** CSS selector for the country combobox input (defaults to aria-label heuristic). */
  countrySelector: z.string().min(1).optional(),
  /** CSS selector for the phone number input (defaults to aria-label heuristic). */
  numberSelector: z.string().min(1).optional(),
  optional: z.boolean().optional(),
});

/** Accessible-role click with optional exact name and mandatory uniqueness. */
const clickRoleStep = z.object({
  action: z.literal("clickRole"),
  role: z.string().min(1),
  name: z.string().min(1),
  exact: z.boolean().default(true),
  final: z.boolean().optional(),
  ...stepControlFields,
  optional: z.boolean().optional(),
});

/**
 * `selectProgram` — enumerates the live portal options (or uses authored
 * static options), applies the shared exact/mapping/fuzzy matcher, then selects
 * the proved portal value. No CRM program id is silently treated as a portal id.
 */
const selectProgramStep = z.object({
  action: z.literal("selectProgram"),
  /** Overrides programSelection.selector for this step. */
  selector: z.string().min(1).optional(),
  ...stepControlFields,
  optional: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// New step schemas — http / graphql / capture / setVar
// ---------------------------------------------------------------------------

/**
 * `http` — makes an out-of-band HTTP request via `page.request` (shares the
 * Playwright session cookie jar). The URL must appear in `meta.allowedOrigins`.
 * `mutation:true` steps are skipped in dry-run. Result text is stored in
 * `captured[saveAs]` when `saveAs` is provided.
 * NOTE: URL is NOT validated by safeUrlSchema here — the runtime SSRF guard
 * (allowedOrigins exact-origin match in httpRunner.ts) is the security boundary.
 */
const httpStep = z.object({
  action: z.literal("http"),
  ...stepControlFields,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  json: z.record(z.unknown()).optional(),
  saveAs: z.string().min(1).optional(),
  mutation: z.boolean().optional(),
  optional: z.boolean().optional(),
});

/**
 * `graphql` — POSTs a GraphQL query to `url` via `page.request`.
 * Same allowedOrigins + mutation-skip semantics as `http`.
 */
const graphqlStep = z.object({
  action: z.literal("graphql"),
  ...stepControlFields,
  url: z.string().min(1),
  query: z.string().min(1),
  variables: z.record(z.unknown()).optional(),
  saveAs: z.string().min(1).optional(),
  mutation: z.boolean().optional(),
  optional: z.boolean().optional(),
});

/**
 * `capture` — reads a value from the current page state and stores it in
 * `captured[name]`. Sources: lastResponse (the most recent http/graphql
 * response body), cookie, localStorage, selectorText, or url.
 */
const captureStep = z.object({
  action: z.literal("capture"),
  ...stepControlFields,
  from: z.enum(["lastResponse", "cookie", "localStorage", "selectorText", "url"]),
  /** JSON dotpath into lastResponse, or cookie/localStorage key name. */
  path: z.string().min(1).optional(),
  name: z.string().min(1),
});

/**
 * `setVar` — evaluates a (possibly interpolated) value and stores it in
 * `vars[name]`, making it available to subsequent steps via `{{vars.name}}`.
 */
const setVarStep = z.object({
  action: z.literal("setVar"),
  ...stepControlFields,
  name: z.string().min(1),
  value: z.string(),
});

const assertStep = z.object({
  action: z.literal("assert"),
  condition: conditionSchema,
  /** PII-free failure reason surfaced by the runner. */
  message: z.string().min(1),
  ...stepControlFields,
  optional: z.boolean().optional(),
});

export const specStepSchema = z.discriminatedUnion("action", [
  navigateStep,
  fillStep,
  selectStep,
  clickStep,
  uploadStep,
  checkStep,
  radioStep,
  waitForStep,
  ajaxWaitStep,
  jsHookStep,
  httpStep,
  graphqlStep,
  captureStep,
  setVarStep,
  lookupStep,
  selectLabelStep,
  clickCardByTextStep,
  phoneStep,
  clickRoleStep,
  selectProgramStep,
  assertStep,
]);

// ---------------------------------------------------------------------------
// Spec v2 deterministic state machine
// ---------------------------------------------------------------------------

const conditionSetSchema = z.object({
  conditions: z.array(conditionSchema).min(1),
  match: z.enum(["all", "any"]).default("all"),
});

export const stateTransitionSchema = conditionSetSchema.extend({
  /** Target state id. The target's own detector must also verify after action. */
  to: z.string().min(1),
});

export const workflowStateSchema = z.object({
  id: z.string().min(1),
  /** Stable, read-only evidence that this state is currently active. */
  detect: conditionSetSchema,
  /** Actions for one attempt of this logical state. */
  steps: z.array(specStepSchema).default([]),
  /** Allowed post-action target states. Empty is valid only for terminal states. */
  transitions: z.array(stateTransitionSchema).default([]),
  terminal: z.boolean().optional(),
  /** Bounded retries while the same verified state remains active. */
  maxRetries: z.number().int().min(0).max(10).default(2),
});

export const workflowSchema = z.object({
  states: z.array(workflowStateSchema).min(1),
  /** Hard loop bound independent of per-state retry limits. */
  maxTransitions: z.number().int().positive().max(100).default(25),
  /** Consecutive identical detector reads required before accepting a state. */
  stableReads: z.number().int().min(1).max(5).default(2),
  /** Delay between detector reads. */
  settleMs: z.number().int().min(0).max(10000).default(150),
});

export const outcomeRuleSchema = z.object({
  outcome: z.enum([
    "submitted",
    "alreadyExists",
    "programMissing",
    "programFull",
    "failure",
  ]),
  detect: conditionSetSchema,
  /** PII-free operator-facing classification reason. */
  detail: z.string().min(1).optional(),
  /** Optional captured/vars key copied into SubmitResult.externalRef. */
  externalRefFrom: z
    .object({
      source: z.enum(["captured", "vars"]),
      path: z.string().min(1),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Spec v2 profile preflight/default policy
// ---------------------------------------------------------------------------

const profileDefaultSchema = z.object({
  field: profileFieldSchema,
  value: z.string().optional(),
  valueFrom: profilePathSchema.optional(),
  transform: transformSchema.optional(),
  /** Auditable business-policy identifier; values themselves are never logged. */
  reason: z.string().min(1),
  /** Profile-only predicate. Selector/network conditions are rejected below. */
  when: conditionSchema.optional(),
});

const requiredProfileFieldSchema = z.object({
  field: profileFieldSchema,
  /** Profile-only predicate, e.g. education field required only for Master. */
  when: conditionSchema.optional(),
  /** PII-free operator-facing reason. */
  message: z.string().min(1).optional(),
});

export const profilePolicySchema = z.object({
  defaults: z.array(profileDefaultSchema).default([]),
  required: z.array(requiredProfileFieldSchema).default([]),
});

// ---------------------------------------------------------------------------
// Top-level blocks
// ---------------------------------------------------------------------------

export const metaSchema = z.object({
  key: z.string().min(1).regex(/^[a-z0-9_-]+$/, {
    message: "key must be lowercase letters, digits, underscores or hyphens",
  }),
  name: z.string().min(1),
  baseUrl: safeUrlSchema,
  panelUrl: safeUrlSchema.optional(),
  /** Lowercase substrings matched against the case-folded university name. */
  matches: z.array(z.string().min(1)).min(1),
  experimental: z.boolean().optional(),
  /**
   * fallback (default): code and legacy declarative adapters keep priority.
   * override: this enabled spec may replace a same-key code adapter, but only
   * after the stored version receives explicit super-admin privileged approval.
   */
  resolution: z.enum(["fallback", "override"]).default("fallback"),
  /**
   * v1 keeps historical "fill but skip final submit" dry-run behaviour.
   * v2 defaults to strict: DOM/network mutation actions are not executed.
   */
  dryRunPolicy: z.enum(["legacy", "strict"]).optional(),
  /**
   * Allowed URL origins for http/graphql steps (e.g. "https://api.example.com").
   * Required when any step uses action "http" or "graphql". The runtime SSRF
   * guard in httpRunner.ts performs an exact origin match at execution time.
   */
  allowedOrigins: z.array(z.string().url()).optional(),
});

export const authSchema = z.object({
  loginUrl: safeUrlSchema,
  /** Login form steps (fill credentials, click submit, wait). */
  loginSteps: z.array(specStepSchema).min(1),
  /** Optional storageState key for session reuse (engine-managed). */
  sessionStorageKey: z.string().min(1).optional(),
  /** Substring expected in the post-login URL to confirm authentication. */
  successUrlContains: z.string().min(1).optional(),
});

const docSlotSchema = z.object({
  /** SubmitFiles field this slot maps to (photo/passport/transcript/diploma). */
  fileField: fileFieldSchema,
  /** Desired output format. Conversion is performed upstream (worker), not in
   *  the interpreter — this is a declaration of intent for the pipeline. */
  target: z.enum(["jpg", "pdf", "png"]).optional(),
  maxKB: z.number().int().positive().optional(),
  normalize: z.boolean().optional(),
  required: z.boolean().default(true),
});

export const documentsSchema = z.object({
  slots: z.record(z.string().min(1), docSlotSchema),
});

const levelRuleSchema = z.object({
  /** Matched (case-insensitive substring) against profile.level. */
  when: z.string().min(1),
  /** Radio/selector clicked when the rule matches. */
  radio: z.string().min(1),
});

export const programSelectionSchema = z.object({
  /** How portal options are sourced. "ajaxOptions" = live dropdown enumeration. */
  source: z.enum(["ajaxOptions", "static"]).default("ajaxOptions"),
  /** Selector of the <select> whose options hold the program list. */
  selector: z.string().min(1).optional(),
  /** Required when source="static"; portal value + visible label pairs. */
  options: z
    .array(
      z.object({
        value: z.string().min(1),
        label: z.string().min(1),
        enabled: z.boolean().default(true),
      }),
    )
    .optional(),
  /** Education-level → radio selector rules (thesis / non-thesis, etc.). */
  levelRules: z.array(levelRuleSchema).optional(),
  /** Fuzzy match acceptance threshold (0..1). */
  fuzzyThreshold: z.number().min(0).max(1).optional(),
}).superRefine((selection, ctx) => {
  if (selection.source === "static" && !selection.options?.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["options"],
      message: 'programSelection.options is required when source="static"',
    });
  }
  if (selection.source === "ajaxOptions" && !selection.selector) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["selector"],
      message: 'programSelection.selector is required when source="ajaxOptions"',
    });
  }
});

export const successSchema = z.object({
  /** Substring expected in the final URL on success. */
  responseUrlIncludes: z.string().min(1).optional(),
  /** "field=value" assertion against a JSON response body. */
  okJsonField: z.string().min(1).optional(),
  /** Regex (as string) the success URL must match, e.g. capturing a UUID. */
  redirectPattern: z.string().min(1).optional(),
  /** Where to read the external reference from ("redirectUuid" or a regex group). */
  captureRefFrom: z.string().min(1).optional(),
  /** Substring expected in the page HTML on success. */
  successText: z.string().min(1).optional(),
  /** Selector that must exist on success. */
  successSelector: z.string().min(1).optional(),
  /** Substring indicating the applicant already exists. */
  alreadyExistsText: z.string().min(1).optional(),
  /** Substring indicating the programme was not found. */
  programMissingText: z.string().min(1).optional(),
});

export const failureSchema = z.object({
  /** JSON field holding a generic error message on failure. */
  genericBodyField: z.string().min(1).optional(),
  /** Substring in page HTML indicating a hard failure. */
  failureText: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Whole spec
// ---------------------------------------------------------------------------

export const adapterSpecSchema = z
  .object({
    /** v1 = linear legacy flow; v2 = guarded steps + deterministic workflow. */
    specVersion: z.union([z.literal(1), z.literal(2)]).default(1),
    meta: metaSchema,
    auth: authSchema,
    /** Optional v2 preamble. v1 still requires at least one linear step. */
    steps: z.array(specStepSchema).default([]),
    workflow: workflowSchema.optional(),
    /** Ordered, fail-closed post-run result rules. First matching rule wins. */
    outcomes: z.array(outcomeRuleSchema).min(1).optional(),
    /** Applied before the first submit mutation; v2 only. */
    profilePolicy: profilePolicySchema.optional(),
    documents: documentsSchema.optional(),
    programSelection: programSelectionSchema.optional(),
    success: successSchema.default({}),
    failure: failureSchema.optional(),
  })
  .superRefine((spec, ctx) => {
    const checkCondition = (
      condition: z.infer<typeof conditionSchema>,
      path: (string | number)[],
    ): void => {
      if (
        ["profile", "vars", "captured"].includes(condition.source) &&
        !condition.path
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "path"],
          message: `${condition.source} condition requires path`,
        });
      }
      if (condition.source.startsWith("selector") && !condition.selector) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "selector"],
          message: `${condition.source} condition requires selector`,
        });
      }
      if (
        ["equals", "notEquals", "contains", "matches"].includes(condition.operator) &&
        condition.value == null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [...path, "value"],
          message: `${condition.operator} condition requires value`,
        });
      }
      if (
        condition.operator === "matches" &&
        condition.value != null &&
        !condition.value.includes("{{")
      ) {
        try {
          new RegExp(condition.value);
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...path, "value"],
            message: `invalid regular expression "${condition.value}"`,
          });
        }
      }
    };

    const checkFills = (steps: SpecStep[], base: (string | number)[]): void => {
      steps.forEach((s, i) => {
        if (s.action === "fill" && (s.value == null) === (s.valueFrom == null)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...base, i],
            message: 'fill step requires exactly one of "value" or "valueFrom"',
          });
        }
        if (s.when) checkCondition(s.when, [...base, i, "when"]);
        if (s.action === "assert") {
          checkCondition(s.condition, [...base, i, "condition"]);
        }
        if (
          spec.specVersion === 2 &&
          s.action === "upload" &&
          !s.optional &&
          (!s.proof ||
            (!s.proof.responseUrlContains && !s.proof.successSelector))
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...base, i, "proof"],
            message:
              "specVersion 2 upload requires responseUrlContains or successSelector proof",
          });
        }
      });
    };
    checkFills(spec.steps, ["steps"]);
    checkFills(spec.auth.loginSteps, ["auth", "loginSteps"]);
    spec.workflow?.states.forEach((state, stateIndex) => {
      checkFills(state.steps, ["workflow", "states", stateIndex, "steps"]);
    });

    if (spec.specVersion === 1 && spec.steps.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["steps"],
        message: "specVersion 1 requires at least one step",
      });
    }
    if (spec.specVersion === 1 && spec.workflow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workflow"],
        message: "workflow is available only in specVersion 2",
      });
    }
    if (spec.specVersion === 1 && spec.profilePolicy) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profilePolicy"],
        message: "profilePolicy is available only in specVersion 2",
      });
    }
    if (spec.specVersion === 1 && spec.meta.resolution === "override") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meta", "resolution"],
        message: "code-adapter override is available only in specVersion 2",
      });
    }
    if (spec.specVersion === 2 && spec.steps.length === 0 && !spec.workflow) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workflow"],
        message: "specVersion 2 requires steps or a workflow",
      });
    }

    if (spec.workflow) {
      const ids = new Set<string>();
      spec.workflow.states.forEach((state, stateIndex) => {
        state.detect.conditions.forEach((condition, conditionIndex) => {
          checkCondition(condition, [
            "workflow",
            "states",
            stateIndex,
            "detect",
            "conditions",
            conditionIndex,
          ]);
        });
        if (ids.has(state.id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["workflow", "states", stateIndex, "id"],
            message: `duplicate workflow state id "${state.id}"`,
          });
        }
        ids.add(state.id);
        if (!state.terminal && state.transitions.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["workflow", "states", stateIndex, "transitions"],
            message: "non-terminal workflow state requires at least one transition",
          });
        }
      });
      spec.workflow.states.forEach((state, stateIndex) => {
        state.transitions.forEach((transition, transitionIndex) => {
          transition.conditions.forEach((condition, conditionIndex) => {
            checkCondition(condition, [
              "workflow",
              "states",
              stateIndex,
              "transitions",
              transitionIndex,
              "conditions",
              conditionIndex,
            ]);
          });
          if (!ids.has(transition.to)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [
                "workflow",
                "states",
                stateIndex,
                "transitions",
                transitionIndex,
                "to",
              ],
              message: `unknown workflow target state "${transition.to}"`,
            });
          }
        });
      });
    }

    spec.profilePolicy?.defaults.forEach((rule, index) => {
      if ((rule.value == null) === (rule.valueFrom == null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profilePolicy", "defaults", index],
          message: 'profile default requires exactly one of "value" or "valueFrom"',
        });
      }
      if (rule.when) {
        checkCondition(rule.when, [
          "profilePolicy",
          "defaults",
          index,
          "when",
        ]);
        if (rule.when.source !== "profile") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profilePolicy", "defaults", index, "when", "source"],
            message: "profilePolicy conditions must use source=profile",
          });
        }
      }
    });
    spec.profilePolicy?.required.forEach((rule, index) => {
      if (rule.when) {
        checkCondition(rule.when, [
          "profilePolicy",
          "required",
          index,
          "when",
        ]);
        if (rule.when.source !== "profile") {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profilePolicy", "required", index, "when", "source"],
            message: "profilePolicy conditions must use source=profile",
          });
        }
      }
    });

    spec.outcomes?.forEach((rule, ruleIndex) => {
      rule.detect.conditions.forEach((condition, conditionIndex) => {
        checkCondition(condition, [
          "outcomes",
          ruleIndex,
          "detect",
          "conditions",
          conditionIndex,
        ]);
      });
    });

    // Require allowedOrigins when any step uses http or graphql.
    const workflowSteps = spec.workflow?.states.flatMap((state) => state.steps) ?? [];
    const allSteps = [...spec.steps, ...spec.auth.loginSteps, ...workflowSteps];
    const hasHttpOrGraphql = allSteps.some(
      (s) => s.action === "http" || s.action === "graphql",
    );
    if (hasHttpOrGraphql) {
      if (!spec.meta.allowedOrigins || spec.meta.allowedOrigins.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["meta", "allowedOrigins"],
          message:
            "meta.allowedOrigins must be present and non-empty when any step uses action \"http\" or \"graphql\"",
        });
      } else {
        // Parse-time: validate static (non-interpolated) http/graphql step URLs
        // against allowedOrigins. Interpolated URLs (containing {{...}}) can
        // only be validated at runtime by httpRunner.ts.
        // Iterate the two step lists separately so error paths are precise.
        const allowedOrigins = spec.meta.allowedOrigins;
        const checkStepUrls = (
          steps: typeof allSteps,
          basePath: (string | number)[],
        ) => {
          steps.forEach((s, i) => {
            if (s.action !== "http" && s.action !== "graphql") return;
            const url = s.url;
            // Skip interpolated URLs — runtime SSRF guard handles them.
            if (url.includes("{{")) return;
            let origin: string;
            try {
              origin = new URL(url).origin;
            } catch {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...basePath, i, "url"],
                message: `invalid URL: "${url}"`,
              });
              return;
            }
            if (!allowedOrigins.includes(origin)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...basePath, i, "url"],
                message: `URL origin "${origin}" is not in meta.allowedOrigins`,
              });
            }
          });
        };
        checkStepUrls(spec.steps, ["steps"]);
        checkStepUrls(spec.auth.loginSteps, ["auth", "loginSteps"]);
        spec.workflow?.states.forEach((state, stateIndex) => {
          checkStepUrls(
            state.steps,
            ["workflow", "states", stateIndex, "steps"],
          );
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// Derived TS types (single source of truth — never hand-write these)
// ---------------------------------------------------------------------------

export type Transform = z.infer<typeof transformSchema>;
export type SpecStep = z.infer<typeof specStepSchema>;
export type AdapterMeta = z.infer<typeof metaSchema>;
export type AdapterAuth = z.infer<typeof authSchema>;
export type AdapterDocuments = z.infer<typeof documentsSchema>;
export type ProgramSelection = z.infer<typeof programSelectionSchema>;
export type SuccessSpec = z.infer<typeof successSchema>;
export type FailureSpec = z.infer<typeof failureSchema>;
export type SpecCondition = z.infer<typeof conditionSchema>;
export type WorkflowState = z.infer<typeof workflowStateSchema>;
export type SpecWorkflow = z.infer<typeof workflowSchema>;
export type ProfilePolicy = z.infer<typeof profilePolicySchema>;
export type OutcomeRule = z.infer<typeof outcomeRuleSchema>;
export type AdapterSpec = z.infer<typeof adapterSpecSchema>;

// ---------------------------------------------------------------------------
// parseAdapterSpec — validate a raw (untyped) spec object
// ---------------------------------------------------------------------------

export interface SpecIssue {
  path: string;
  message: string;
}

export type SpecParseResult =
  | { ok: true; spec: AdapterSpec }
  | { ok: false; error: string; issues: SpecIssue[] };

/**
 * Returns true when a spec contains any jsHook step. Accepts an untyped value
 * (e.g. a raw jsonb row) and traverses defensively, so it is safe to call on
 * both parsed `AdapterSpec`s and unvalidated stored specs.
 */
export function specHasJsHook(spec: unknown): boolean {
  const listHasJsHook = (steps: unknown): boolean =>
    Array.isArray(steps) &&
    steps.some(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        (s as { action?: unknown }).action === "jsHook",
    );
  if (typeof spec !== "object" || spec === null) return false;
  const s = spec as {
    steps?: unknown;
    auth?: { loginSteps?: unknown };
    workflow?: { states?: Array<{ steps?: unknown }> };
  };
  return (
    listHasJsHook(s.steps) ||
    listHasJsHook(s.auth?.loginSteps) ||
    (Array.isArray(s.workflow?.states) &&
      s.workflow.states.some((state) => listHasJsHook(state?.steps)))
  );
}

const PRIVILEGED_ACTIONS = new Set(["http", "graphql", "jsHook"]);

/**
 * Returns true when a spec contains any privileged step (http, graphql, or
 * jsHook). Privileged specs require super_admin approval
 * (`privilegedApproved=true`) before they can be enabled. Accepts an untyped
 * value so it can be called on raw DB rows without prior validation.
 */
export function specIsPrivileged(spec: unknown): boolean {
  const listHasPrivileged = (steps: unknown): boolean =>
    Array.isArray(steps) &&
    steps.some(
      (s) =>
        typeof s === "object" &&
        s !== null &&
        PRIVILEGED_ACTIONS.has((s as { action?: unknown }).action as string),
    );
  if (typeof spec !== "object" || spec === null) return false;
  const s = spec as {
    meta?: { resolution?: unknown };
    steps?: unknown;
    auth?: { loginSteps?: unknown };
    workflow?: { states?: Array<{ steps?: unknown }> };
  };
  return (
    s.meta?.resolution === "override" ||
    listHasPrivileged(s.steps) ||
    listHasPrivileged(s.auth?.loginSteps) ||
    (Array.isArray(s.workflow?.states) &&
      s.workflow.states.some((state) => listHasPrivileged(state?.steps)))
  );
}

/**
 * Validates a raw spec object against `adapterSpecSchema`. Returns a typed spec
 * on success, or a flat error string plus a structured issue list on failure.
 */
export function parseAdapterSpec(raw: unknown): SpecParseResult {
  const res = adapterSpecSchema.safeParse(raw);
  if (!res.success) {
    const issues: SpecIssue[] = res.error.issues.map((i) => ({
      path: i.path.join(".") || "(root)",
      message: i.message,
    }));
    return {
      ok: false,
      error: issues.map((i) => `${i.path}: ${i.message}`).join("; "),
      issues,
    };
  }
  return { ok: true, spec: res.data };
}
