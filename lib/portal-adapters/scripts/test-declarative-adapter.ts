/**
 * test-declarative-adapter.ts — unit tests for the DB-backed declarative
 * adapter SPEC interpreter (the richer, versioned sibling of declarativeAdapter).
 *
 * Covers (no real DB, no real browser):
 *   SV  — parseAdapterSpec: happy path + invalid specs (bad url, bad key,
 *         unknown profile field, fill xor value/valueFrom, empty steps).
 *   JH  — specHasJsHook detection over both steps and auth.loginSteps.
 *   HLP — pure helpers: resolveProfileValue, applyTransform, resolveProgramValue.
 *   STP — executeSpecStep against a mock page for every action type, plus the
 *         `optional` swallow and the jsHook trust gate (allowJsHook on/off).
 *   DRY — runSpecSteps skips terminal `click {final:true}` in dry mode.
 *   CLS — classifyResult: success/alreadyExists/programMissing/failure/redirect.
 *   ADP — createSpecAdapter shape + matches().
 *   ROW — buildSpecAdapterFromRow / specRowAllowsJsHook: jsHook trust derived
 *         from source="builtin" OR jsHookApproved; invalid stored spec → null.
 *
 * Run:
 *   pnpm --filter @workspace/portal-adapters test:declarative-adapter
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseAdapterSpec,
  specHasJsHook,
  specIsPrivileged,
  type AdapterSpec,
} from "../src/declarative/schema.js";
import {
  resolveProfileValue,
  applyTransform,
  resolveProgramValue,
  classifyResult,
  executeSpecStep,
  runSpecSteps,
  evaluateCondition,
  isMutatingSpecStep,
  detectStableWorkflowState,
  runSpecWorkflow,
  applyProfilePolicy,
  classifyOutcomeRules,
  createSpecAdapter,
  type SpecPage,
  type StepContext,
} from "../src/declarative/interpreter.js";
import {
  specRowAllowsJsHook,
  specRowAllowsOverride,
  buildSpecAdapterFromRow,
} from "../src/specLoader.js";
import type { SubmitProfile, SubmitFiles, ProgramOption } from "../src/types.js";
import type { PortalAdapterSpec } from "@workspace/db";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal but fully-valid spec used as the happy-path baseline. */
function validRawSpec(): unknown {
  return {
    specVersion: 1,
    meta: {
      key: "test_uni",
      name: "Test Üniversitesi",
      baseUrl: "https://apply.test-uni.example.com",
      matches: ["test university", "test_uni"],
    },
    auth: {
      loginUrl: "https://apply.test-uni.example.com/login",
      loginSteps: [
        { action: "fill", selector: "#email", valueFrom: "profile.email" },
        { action: "fill", selector: "#password", valueFrom: "profile.passportNumber" },
        { action: "click", selector: "button[type=submit]" },
        { action: "waitFor", selector: ".dashboard" },
      ],
    },
    steps: [
      { action: "navigate", url: "https://apply.test-uni.example.com/apply" },
      { action: "fill", selector: "#firstName", valueFrom: "profile.firstName" },
      { action: "fill", selector: "#note", value: "AGENT-2026" },
      { action: "select", selector: "#gender", valueFrom: "profile.gender" },
      { action: "upload", selector: "#passportFile", slot: "passport" },
      { action: "waitFor", selector: ".form-loaded" },
      { action: "click", selector: "#submitBtn", final: true },
    ],
    documents: {
      slots: { passport: { fileField: "passport", target: "pdf" } },
    },
    success: { successText: "application submitted", alreadyExistsText: "already registered" },
  };
}

const TEST_PROFILE: SubmitProfile = {
  email: "test@example.com",
  passportNumber: "A1234567",
  firstName: "Ali",
  lastName: "Yılmaz",
  dateOfBirth: "2000-01-01",
  gender: "male",
  fatherName: "Mehmet",
  motherName: "Fatma",
  nationality: "Turkish",
  address: "Istanbul",
  phone: "+905001234567",
  level: "bachelor",
  programName: "Computer Engineering",
  programId: "42",
};

const TEST_FILES: SubmitFiles = {
  passport: "/tmp/passport.pdf",
  photo: "/tmp/photo.jpg",
};

function ctx(over: Partial<StepContext> = {}): StepContext {
  return {
    profile: TEST_PROFILE,
    files: TEST_FILES,
    documentSlots: {
      slots: { passport: { fileField: "passport", required: true } },
    },
    allowJsHook: false,
    vars: {},
    captured: {},
    allowedOrigins: [],
    dryRun: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Mock page factory
// ---------------------------------------------------------------------------

interface Call {
  method: string;
  args: unknown[];
}

function makeMockPage(
  over?: Partial<SpecPage> & { _html?: string; _url?: string; _isChecked?: boolean; _hasEl?: boolean },
): { page: SpecPage; calls: Call[] } {
  const calls: Call[] = [];
  const html = over?._html ?? "<html><body></body></html>";
  const currentUrl = over?._url ?? "";
  const isChecked = over?._isChecked ?? false;
  const hasEl = over?._hasEl ?? false;

  const page: SpecPage = {
    goto: async (...args) => { calls.push({ method: "goto", args }); },
    fill: async (...args) => { calls.push({ method: "fill", args }); },
    click: async (...args) => { calls.push({ method: "click", args }); },
    selectOption: async (...args) => { calls.push({ method: "selectOption", args }); },
    setInputFiles: async (...args) => { calls.push({ method: "setInputFiles", args }); },
    waitForSelector: async (...args) => { calls.push({ method: "waitForSelector", args }); },
    content: async () => html,
    $: async (...args) => { calls.push({ method: "$", args }); return hasEl ? ({} as unknown) : null; },
    evaluate: async (...args) => { calls.push({ method: "evaluate", args }); return undefined; },
    isChecked: async (...args) => { calls.push({ method: "isChecked", args }); return isChecked; },
    url: () => currentUrl,
    ...over,
  };
  return { page, calls };
}

// ---------------------------------------------------------------------------
// SV — spec validation
// ---------------------------------------------------------------------------

test("SV1: parseAdapterSpec accepts a valid spec", () => {
  const res = parseAdapterSpec(validRawSpec());
  assert.equal(res.ok, true, "valid spec parses");
  if (res.ok) {
    assert.equal(res.spec.meta.key, "test_uni");
    assert.equal(res.spec.specVersion, 1);
    assert.equal(res.spec.steps.length, 7);
  }
});

test("SV2: rejects a non-https / unsafe baseUrl", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.meta as Record<string, unknown>).baseUrl = "http://insecure.example.com";
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, false, "http url rejected");
});

test("SV3: rejects an invalid meta.key (uppercase/spaces)", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.meta as Record<string, unknown>).key = "Test Uni";
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, false, "bad key rejected");
});

test("SV4: rejects an unknown profile field in valueFrom", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>)[1].valueFrom = "profile.notARealField";
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, false, "unknown profile field rejected");
});

test("SV5: rejects a fill step with BOTH value and valueFrom", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>)[1].value = "literal";
  // step[1] already has valueFrom — now it has both.
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, false, "fill xor enforced (both present)");
  if (!res.ok) {
    assert.ok(
      res.issues.some((i) => /exactly one of/.test(i.message)),
      "issue mentions the xor rule",
    );
  }
});

test("SV6: rejects a fill step with NEITHER value nor valueFrom", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  const steps = raw.steps as Array<Record<string, unknown>>;
  delete steps[2].value; // step[2] was { fill, value } — strip it
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, false, "fill xor enforced (neither present)");
});

test("SV7: rejects an empty steps array", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  raw.steps = [];
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, false, "empty steps rejected");
});

// ---------------------------------------------------------------------------
// JH — jsHook detection
// ---------------------------------------------------------------------------

test("JH1: specHasJsHook false for a hook-free spec", () => {
  assert.equal(specHasJsHook(validRawSpec()), false);
});

test("JH2: specHasJsHook true when a step is a jsHook", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as unknown[]).push({ action: "jsHook", script: "window.scrollTo(0,0)" });
  assert.equal(specHasJsHook(raw), true);
});

test("JH3: specHasJsHook true when a LOGIN step is a jsHook", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.auth as { loginSteps: unknown[] }).loginSteps.push({
    action: "jsHook",
    script: "document.cookie",
  });
  assert.equal(specHasJsHook(raw), true);
});

test("JH4: specHasJsHook tolerates non-object input", () => {
  assert.equal(specHasJsHook(null), false);
  assert.equal(specHasJsHook("nope"), false);
  assert.equal(specHasJsHook(42), false);
});

// ---------------------------------------------------------------------------
// HLP — pure helpers
// ---------------------------------------------------------------------------

test("HLP1: resolveProfileValue reads profile.<field> and bare field", () => {
  assert.equal(resolveProfileValue(TEST_PROFILE, "profile.firstName"), "Ali");
  assert.equal(resolveProfileValue(TEST_PROFILE, "gender"), "male");
  assert.equal(resolveProfileValue(TEST_PROFILE, "profile.missing"), "");
});

test("HLP2: applyTransform override/map use the table, fuzzy is passthrough", () => {
  assert.equal(applyTransform("male", { type: "override", table: { male: "M" } }), "M");
  assert.equal(applyTransform("x", { type: "map", table: { male: "M" } }), "x", "keeps original when unmapped");
  assert.equal(applyTransform("male", { type: "fuzzy" }), "male");
  assert.equal(applyTransform("male", undefined), "male");
});

test("HLP4: resolveProgramValue — exact label match", () => {
  const opts: ProgramOption[] = [{ v: "100", t: "Computer Engineering" }];
  const res = resolveProgramValue(opts, TEST_PROFILE, { source: "ajaxOptions" });
  assert.equal(res?.value, "100");
  assert.equal(res?.conf, 1);
});

test("HLP5: resolveProgramValue — no candidate returns null", () => {
  const opts: ProgramOption[] = [{ v: "1", t: "Underwater Basket Weaving" }];
  const res = resolveProgramValue(opts, { ...TEST_PROFILE, programId: "" }, {
    source: "ajaxOptions",
    fuzzyThreshold: 0.99,
  });
  assert.equal(res, null);
});

// ---------------------------------------------------------------------------
// STP — executeSpecStep per action
// ---------------------------------------------------------------------------

test("STP1: navigate → page.goto(url)", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(page, { action: "navigate", url: "https://e.com/x" }, ctx());
  assert.deepEqual([calls[0].method, calls[0].args[0]], ["goto", "https://e.com/x"]);
});

test("STP2: fill valueFrom reads profile + applies transform", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "fill", selector: "#g", valueFrom: "profile.gender", transform: { type: "override", table: { male: "M" } } },
    ctx(),
  );
  assert.deepEqual([calls[0].method, calls[0].args[0], calls[0].args[1]], ["fill", "#g", "M"]);
});

test("STP3: fill literal value", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(page, { action: "fill", selector: "#n", value: "LIT" }, ctx());
  assert.equal(calls[0].args[1], "LIT");
});

test("STP4: select by value vs byLabel", async () => {
  const { page: p1, calls: c1 } = makeMockPage();
  await executeSpecStep(p1, { action: "select", selector: "#g", valueFrom: "profile.gender" }, ctx());
  assert.deepEqual(c1[0].args[1], "male");

  const { page: p2, calls: c2 } = makeMockPage();
  await executeSpecStep(p2, { action: "select", selector: "#g", valueFrom: "profile.gender", byLabel: true }, ctx());
  assert.deepEqual(c2[0].args[1], { label: "male" });
});

test("STP5: upload resolves slot → file path", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(page, { action: "upload", selector: "#f", slot: "passport" }, ctx());
  assert.deepEqual([calls[0].method, calls[0].args[1]], ["setInputFiles", "/tmp/passport.pdf"]);
});

test("STP6: upload with no required file fails closed before setInputFiles", async () => {
  const { page, calls } = makeMockPage();
  await assert.rejects(
    executeSpecStep(
      page,
      { action: "upload", selector: "#f", slot: "transcript" },
      ctx(),
    ),
    /data_missing.*transcript/,
  );
  assert.equal(calls.length, 0, "no setInputFiles when slot has no file");
});

test("STP7: check clicks only when current state differs", async () => {
  const { page: unchecked, calls: c1 } = makeMockPage({ _isChecked: false });
  await executeSpecStep(unchecked, { action: "check", selector: "#agree", value: true }, ctx());
  assert.ok(c1.some((c) => c.method === "click"), "clicks to check an unchecked box");

  const { page: checked, calls: c2 } = makeMockPage({ _isChecked: true });
  await executeSpecStep(checked, { action: "check", selector: "#agree", value: true }, ctx());
  assert.ok(!c2.some((c) => c.method === "click"), "no click when already checked");
});

test("STP8: radio maps profile value → selector", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "radio", valueFrom: "profile.level", map: { bachelor: "#lvl-bsc", master: "#lvl-msc" } },
    ctx(),
  );
  assert.deepEqual([calls[0].method, calls[0].args[0]], ["click", "#lvl-bsc"]);
});

test("STP9: waitFor → page.waitForSelector", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(page, { action: "waitFor", selector: ".ready" }, ctx());
  assert.deepEqual([calls[0].method, calls[0].args[0]], ["waitForSelector", ".ready"]);
});

test("STP10: optional step swallows page errors", async () => {
  const { page } = makeMockPage({
    waitForSelector: async () => { throw new Error("timeout"); },
  });
  await assert.doesNotReject(
    executeSpecStep(page, { action: "waitFor", selector: ".never", optional: true }, ctx()),
  );
});

test("STP11: non-optional step rethrows page errors", async () => {
  const { page } = makeMockPage({
    waitForSelector: async () => { throw new Error("timeout"); },
  });
  await assert.rejects(
    executeSpecStep(page, { action: "waitFor", selector: ".never" }, ctx()),
    /timeout/,
  );
});

// ---------------------------------------------------------------------------
// STP — jsHook trust gate
// ---------------------------------------------------------------------------

test("STP12: jsHook is SKIPPED when allowJsHook=false", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(page, { action: "jsHook", script: "window.x=1" }, ctx({ allowJsHook: false }));
  assert.ok(!calls.some((c) => c.method === "evaluate"), "evaluate not called when untrusted");
});

test("STP13: jsHook RUNS when allowJsHook=true", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(page, { action: "jsHook", script: "window.x=1" }, ctx({ allowJsHook: true }));
  assert.ok(calls.some((c) => c.method === "evaluate"), "evaluate called when trusted");
});

// ---------------------------------------------------------------------------
// DRY — dry-run skips terminal click
// ---------------------------------------------------------------------------

test("DRY1: runSpecSteps skips click{final:true} in dry mode", async () => {
  const { page, calls } = makeMockPage();
  await runSpecSteps(
    page,
    [
      { action: "fill", selector: "#a", value: "x" },
      { action: "click", selector: "#submit", final: true },
    ],
    ctx(),
    true,
  );
  assert.ok(!calls.some((c) => c.method === "click"), "final click skipped in dry mode");
  assert.ok(calls.some((c) => c.method === "fill"), "non-final steps still run");
});

test("DRY2: runSpecSteps runs the final click in live mode", async () => {
  const { page, calls } = makeMockPage();
  await runSpecSteps(
    page,
    [{ action: "click", selector: "#submit", final: true }],
    ctx(),
    false,
  );
  assert.ok(calls.some((c) => c.method === "click"), "final click runs in live mode");
});

// ---------------------------------------------------------------------------
// CLS — classifyResult
// ---------------------------------------------------------------------------

test("CLS1: successText → submitted", async () => {
  const { page } = makeMockPage({ _html: "<p>Application submitted successfully</p>" });
  const res = await classifyResult(page, { successText: "application submitted" });
  assert.equal(res.submitted, true);
});

test("CLS2: alreadyExistsText → alreadyExists", async () => {
  const { page } = makeMockPage({ _html: "<p>You are already registered</p>" });
  const res = await classifyResult(page, { successText: "ok", alreadyExistsText: "already registered" });
  assert.equal(res.alreadyExists, true);
  assert.equal(res.submitted, false);
});

test("CLS3: programMissingText → programMissing", async () => {
  const { page } = makeMockPage({ _html: "<p>program not found</p>" });
  const res = await classifyResult(page, { successText: "ok", programMissingText: "program not found" });
  assert.equal(res.programMissing, true);
});

test("CLS4: failureText → not submitted with detail", async () => {
  const { page } = makeMockPage({ _html: "<p>system error occurred</p>" });
  const res = await classifyResult(page, { successText: "ok" }, { failureText: "system error" });
  assert.equal(res.submitted, false);
  assert.equal(res.detail, "failureText matched");
});

test("CLS5: redirectPattern captures externalRef from URL", async () => {
  const { page } = makeMockPage({
    _html: "<p>thanks</p>",
    _url: "https://portal.example.com/done/AB12-CD34",
  });
  const res = await classifyResult(page, { redirectPattern: "/done/([A-Z0-9-]+)" });
  assert.equal(res.submitted, true);
  assert.equal(res.externalRef, "AB12-CD34");
});

test("CLS6: successSelector presence → submitted", async () => {
  const { page } = makeMockPage({ _hasEl: true });
  const res = await classifyResult(page, { successSelector: ".success-banner" });
  assert.equal(res.submitted, true);
});

// ---------------------------------------------------------------------------
// ADP — createSpecAdapter
// ---------------------------------------------------------------------------

test("ADP1: createSpecAdapter exposes key/label/matches/login/submit", () => {
  const parsed = parseAdapterSpec(validRawSpec());
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const adapter = createSpecAdapter(parsed.spec);
  assert.equal(adapter.key, "test_uni");
  assert.equal(adapter.label, "Test Üniversitesi");
  assert.equal(typeof adapter.matches, "function");
  assert.equal(typeof adapter.login, "function");
  assert.equal(typeof adapter.submit, "function");
});

test("ADP2: matches() case-folds spec.meta.matches against the name", () => {
  const parsed = parseAdapterSpec(validRawSpec());
  if (!parsed.ok) throw new Error("fixture invalid");
  const adapter = createSpecAdapter(parsed.spec);
  assert.equal(adapter.matches("Test University application portal"), true);
  assert.equal(adapter.matches("Bogazici University"), false);
});

// ---------------------------------------------------------------------------
// ROW — buildSpecAdapterFromRow / jsHook trust
// ---------------------------------------------------------------------------

function makeSpecRow(over: Partial<PortalAdapterSpec> = {}): PortalAdapterSpec {
  const now = new Date();
  return {
    id: 1,
    key: "test_uni",
    version: 1,
    name: "Test Üniversitesi",
    spec: validRawSpec() as Record<string, unknown>,
    source: "uploaded",
    enabled: true,
    jsHookApproved: false,
    createdBy: 1,
    createdAt: now,
    updatedAt: now,
    ...over,
  } as PortalAdapterSpec;
}

test("ROW1: specRowAllowsJsHook — builtin always trusted", () => {
  assert.equal(specRowAllowsJsHook({ source: "builtin", jsHookApproved: false }), true);
});

test("ROW2: specRowAllowsJsHook — user trusted only when approved", () => {
  assert.equal(specRowAllowsJsHook({ source: "uploaded", jsHookApproved: false }), false);
  assert.equal(specRowAllowsJsHook({ source: "uploaded", jsHookApproved: true }), true);
});

test("ROW3: buildSpecAdapterFromRow builds an adapter for a valid row", () => {
  const adapter = buildSpecAdapterFromRow(makeSpecRow());
  assert.notEqual(adapter, null);
  assert.equal(adapter?.key, "test_uni");
});

test("ROW4: buildSpecAdapterFromRow returns null for an invalid stored spec", () => {
  const adapter = buildSpecAdapterFromRow(makeSpecRow({ spec: { garbage: true } as Record<string, unknown> }));
  assert.equal(adapter, null);
});

test("ROW5: jsHook in a user/unapproved row is skipped at run time", async () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as unknown[]).push({ action: "jsHook", script: "window.x=1" });
  const adapter = buildSpecAdapterFromRow(makeSpecRow({ spec: raw as Record<string, unknown>, source: "uploaded", jsHookApproved: false }));
  assert.notEqual(adapter, null, "row still builds (jsHook is skipped, not rejected)");
});

// ---------------------------------------------------------------------------
// HLP — new transform: toDMY
// ---------------------------------------------------------------------------

test("HLP6: applyTransform toDMY converts ISO date to DD.MM.YYYY", () => {
  assert.equal(applyTransform("2003-07-15", { type: "toDMY" }), "15.07.2003");
  assert.equal(applyTransform("1999-01-31", { type: "toDMY" }), "31.01.1999");
});

test("HLP7: applyTransform toDMY passes through non-ISO strings unchanged", () => {
  assert.equal(applyTransform("15.07.2003", { type: "toDMY" }), "15.07.2003", "already DMY");
  assert.equal(applyTransform("", { type: "toDMY" }), "", "empty string");
  assert.equal(applyTransform("not-a-date", { type: "toDMY" }), "not-a-date", "non-date");
});

// ---------------------------------------------------------------------------
// SV — schema accepts new step types + name/ariaLabel hints
// ---------------------------------------------------------------------------

test("SV8: parseAdapterSpec accepts a fill step with name hint (no selector)", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>)[1] = {
    action: "fill",
    selector: "#firstName",
    name: "firstName",
    valueFrom: "profile.firstName",
  };
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, true, "name hint accepted alongside selector");
});

test("SV9: parseAdapterSpec accepts a fill step with ariaLabel hint", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>)[1] = {
    action: "fill",
    selector: "#firstName",
    ariaLabel: "First Name",
    valueFrom: "profile.firstName",
  };
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, true, "ariaLabel hint accepted alongside selector");
});

test("SV10: parseAdapterSpec accepts a lookup step (all selector fields optional)", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>).push({
    action: "lookup",
    name: "country",
    valueFrom: "profile.nationality",
    optionText: "Turkey",
  });
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, true, "lookup step with name hint accepted");
});

test("SV11: parseAdapterSpec accepts a selectLabel step", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>).push({
    action: "selectLabel",
    selector: "#gender",
    valueFrom: "profile.gender",
    map: { male: "Erkek", female: "Kadın" },
  });
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, true, "selectLabel step accepted");
});

test("SV12: parseAdapterSpec accepts a clickCardByText step with literal text", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>).push({
    action: "clickCardByText",
    text: "Computer Science",
  });
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, true, "clickCardByText with literal text accepted");
});

test("SV13: parseAdapterSpec accepts a clickCardByText step with textFrom", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>).push({
    action: "clickCardByText",
    textFrom: "profile.programName",
    containerHint: ".lwc-card-list",
  });
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, true, "clickCardByText with textFrom accepted");
});

test("SV14: parseAdapterSpec accepts a phone step", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>).push({
    action: "phone",
    countryFrom: "profile.nationality",
    numberFrom: "profile.phone",
  });
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, true, "phone step accepted");
});

test("SV15: parseAdapterSpec accepts a phone step with explicit selectors", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>).push({
    action: "phone",
    countryFrom: "profile.nationality",
    numberFrom: "profile.phone",
    countrySelector: "#countryCombo",
    numberSelector: "#phoneNumber",
  });
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, true, "phone step with explicit selectors accepted");
});

test("SV16: parseAdapterSpec accepts toDMY transform on a fill step", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.steps as Array<Record<string, unknown>>)[1] = {
    action: "fill",
    selector: "#dob",
    valueFrom: "profile.dateOfBirth",
    transform: { type: "toDMY" },
  };
  const res = parseAdapterSpec(raw);
  assert.equal(res.ok, true, "toDMY transform accepted on fill step");
});

// ---------------------------------------------------------------------------
// STP — executeSpecStep for 4 new step types
// ---------------------------------------------------------------------------

test("STP14: lookup — fills input + clicks matching option (fallback path)", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "lookup", selector: "#country", valueFrom: "profile.nationality" },
    ctx(),
  );
  const fills = calls.filter((c) => c.method === "fill");
  const clicks = calls.filter((c) => c.method === "click");
  assert.equal(fills.length, 1, "fills the input");
  assert.equal(fills[0].args[0], "#country", "uses selector as locator");
  assert.equal(fills[0].args[1], "Turkish", "resolved from profile.nationality");
  assert.equal(clicks.length, 1, "clicks one option");
  assert.ok(String(clicks[0].args[0]).includes("Turkish"), "click target contains the typed value");
});

test("STP15: lookup — uses name hint when provided", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "lookup", name: "countryField", valueFrom: "profile.nationality", optionText: "TURKEY" },
    ctx(),
  );
  const fills = calls.filter((c) => c.method === "fill");
  assert.equal(fills[0].args[0], '[name="countryField"]', "name resolved to [name=...] selector");
  assert.equal(fills[0].args[1], "Turkish", "typed value from profile");
  const clicks = calls.filter((c) => c.method === "click");
  assert.ok(String(clicks[0].args[0]).includes("TURKEY"), "optionText overrides typed value for click");
});

test("STP16: lookup — prefers getByRole when page supports it", async () => {
  const roleCalls: Array<{ role: string; name: string }> = [];
  const { page, calls } = makeMockPage({
    getByRole: (role, opts) => {
      roleCalls.push({ role, name: String(opts?.name ?? "") });
      return { click: async () => { calls.push({ method: "getByRoleClick", args: [role, opts?.name] }); } };
    },
  });
  await executeSpecStep(
    page,
    { action: "lookup", selector: "#c", valueFrom: "profile.nationality" },
    ctx(),
  );
  assert.equal(roleCalls.length, 1, "getByRole called once");
  assert.equal(roleCalls[0].role, "option", "role=option");
  assert.equal(roleCalls[0].name, "Turkish", "name matches resolved profile value");
  assert.ok(calls.some((c) => c.method === "getByRoleClick"), "getByRole click dispatched");
  assert.ok(!calls.some((c) => c.method === "click"), "fallback CSS click NOT used");
});

test("STP17: selectLabel — calls selectOption with { label } object", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "selectLabel", selector: "#gender", valueFrom: "profile.gender" },
    ctx(),
  );
  assert.equal(calls[0].method, "selectOption", "calls selectOption");
  assert.equal(calls[0].args[0], "#gender", "selector");
  assert.deepEqual(calls[0].args[1], { label: "male" }, "passes { label } not string");
});

test("STP18: selectLabel — applies map before selecting", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    {
      action: "selectLabel",
      selector: "#gender",
      valueFrom: "profile.gender",
      map: { male: "Erkek", female: "Kadın" },
    },
    ctx(),
  );
  assert.deepEqual(calls[0].args[1], { label: "Erkek" }, "map applied: male → Erkek");
});

test("STP19: selectLabel — uses name hint as locator", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "selectLabel", name: "genderSelect", valueFrom: "profile.gender" },
    ctx(),
  );
  assert.equal(calls[0].args[0], '[name="genderSelect"]', "name resolved to [name=...] selector");
});

test("STP20: clickCardByText — literal text + default container", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "clickCardByText", text: "Computer Engineering" },
    ctx(),
  );
  assert.equal(calls.length, 1, "one page.click call");
  assert.ok(String(calls[0].args[0]).includes("Computer Engineering"), "selector contains the text");
  assert.ok(String(calls[0].args[0]).startsWith(":is("), "uses default :is() container");
});

test("STP21: clickCardByText — textFrom resolves from profile", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "clickCardByText", textFrom: "profile.programName" },
    ctx(),
  );
  assert.ok(String(calls[0].args[0]).includes("Computer Engineering"), "profile value used");
});

test("STP22: clickCardByText — containerHint scopes the selector", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "clickCardByText", text: "Bilgisayar", containerHint: ".lwc-programs" },
    ctx(),
  );
  const sel = String(calls[0].args[0]);
  assert.ok(sel.startsWith(".lwc-programs"), "containerHint is the leading selector");
  assert.ok(sel.includes("Bilgisayar"), "text is embedded in selector");
});

test("STP23: phone — fills country input, clicks option, fills phone (fallback path)", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "phone", countryFrom: "profile.nationality", numberFrom: "profile.phone" },
    ctx(),
  );
  const fills = calls.filter((c) => c.method === "fill");
  const clicks = calls.filter((c) => c.method === "click");
  assert.equal(fills.length, 2, "two fill calls: country + number");
  assert.ok(String(fills[0].args[1]) === "Turkish", "first fill = country value");
  assert.ok(String(fills[1].args[1]) === "+905001234567", "second fill = phone value");
  assert.equal(clicks.length, 1, "one click to select country option");
  assert.ok(String(clicks[0].args[0]).includes("Turkish"), "option click matches country value");
});

test("STP24: phone — uses explicit countrySelector / numberSelector when provided", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    {
      action: "phone",
      countryFrom: "profile.nationality",
      numberFrom: "profile.phone",
      countrySelector: "#countryCombo",
      numberSelector: "#phoneInput",
    },
    ctx(),
  );
  const fills = calls.filter((c) => c.method === "fill");
  assert.equal(fills[0].args[0], "#countryCombo", "explicit countrySelector used");
  assert.equal(fills[1].args[0], "#phoneInput", "explicit numberSelector used");
});

test("STP25: phone — uses getByRole for country option when available", async () => {
  const roleCalls: string[] = [];
  const { page, calls } = makeMockPage({
    getByRole: (role, opts) => {
      roleCalls.push(String(opts?.name ?? ""));
      return { click: async () => { calls.push({ method: "getByRoleClick", args: [role] }); } };
    },
  });
  await executeSpecStep(
    page,
    { action: "phone", countryFrom: "profile.nationality", numberFrom: "profile.phone" },
    ctx(),
  );
  assert.equal(roleCalls[0], "Turkish", "getByRole called with country name");
  assert.ok(calls.some((c) => c.method === "getByRoleClick"), "getByRole click dispatched");
  assert.ok(!calls.some((c) => c.method === "click"), "CSS fallback click NOT used");
});

// ---------------------------------------------------------------------------
// STP — name/ariaLabel hints on existing step types
// ---------------------------------------------------------------------------

test("STP26: fill with name hint uses [name=...] selector", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "fill", selector: "#ignored", name: "firstName", valueFrom: "profile.firstName" },
    ctx(),
  );
  assert.equal(calls[0].args[0], '[name="firstName"]', "name hint wins over selector");
  assert.equal(calls[0].args[1], "Ali", "profile value resolved");
});

test("STP27: fill with ariaLabel hint uses [aria-label=...] selector", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "fill", selector: "#ignored", ariaLabel: "Email Address", valueFrom: "profile.email" },
    ctx(),
  );
  assert.equal(calls[0].args[0], '[aria-label="Email Address"]', "ariaLabel hint wins over selector");
});

test("STP28: waitFor with name hint resolves to [name=...] selector", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "waitFor", selector: "#ignored", name: "dashboardReady" },
    ctx(),
  );
  assert.equal(calls[0].method, "waitForSelector", "waitForSelector called");
  assert.equal(calls[0].args[0], '[name="dashboardReady"]', "name hint used");
});

test("STP29: click with ariaLabel hint resolves to [aria-label=...] selector", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    { action: "click", selector: "#ignored", ariaLabel: "Submit Application" },
    ctx(),
  );
  assert.equal(calls[0].args[0], '[aria-label="Submit Application"]', "ariaLabel hint used for click");
});

// ---------------------------------------------------------------------------
// STP — privileged gate: new actions are NOT privileged
// ---------------------------------------------------------------------------

test("PRIV1: new UI actions are not in the privileged set (specIsPrivileged)", () => {
  const withNewActions = {
    steps: [
      { action: "lookup", selector: "#a", valueFrom: "profile.nationality" },
      { action: "selectLabel", selector: "#b", valueFrom: "profile.gender" },
      { action: "clickCardByText", text: "Foo" },
      { action: "phone", countryFrom: "profile.nationality", numberFrom: "profile.phone" },
    ],
    auth: { loginSteps: [] },
  };
  assert.equal(specIsPrivileged(withNewActions), false, "new UI steps never trigger privileged gate");
});

// ---------------------------------------------------------------------------
// ALTINBAS — declarative spec round-trip validation
// ---------------------------------------------------------------------------

// ALTINBAS1 / ALTINBAS2 removed: altinbas reverted to imperative adapter;
// no longer present in declarativeSpecRaws. Coverage now lives in TR11
// (test-registry.ts) which checks family="altinbas" + name-matching.

// ---------------------------------------------------------------------------
// SPEC V2 — guarded state machine, strict dry-run and override authorization
// ---------------------------------------------------------------------------

function validV2Spec(): Record<string, unknown> {
  const base = validRawSpec() as Record<string, unknown>;
  base.specVersion = 2;
  base.meta = {
    ...(base.meta as Record<string, unknown>),
    resolution: "override",
    dryRunPolicy: "strict",
  };
  base.steps = [
    { action: "navigate", url: "https://apply.test-uni.example.com/apply" },
  ];
  base.workflow = {
    stableReads: 2,
    settleMs: 0,
    maxTransitions: 5,
    states: [
      {
        id: "Personal Information",
        detect: {
          conditions: [
            {
              source: "selectorText",
              selector: ".slds-path__stage-name",
              operator: "equals",
              value: "Stage: Personal Information",
            },
          ],
        },
        steps: [
          {
            action: "fill",
            selector: "#firstName",
            valueFrom: "profile.firstName",
            when: {
              source: "profile",
              path: "firstName",
              operator: "notEmpty",
            },
          },
          { action: "click", selector: "button.next" },
        ],
        transitions: [
          {
            to: "Completed",
            conditions: [
              {
                source: "selectorText",
                selector: ".slds-path__stage-name",
                operator: "equals",
                value: "Stage: Completed",
              },
            ],
          },
        ],
        maxRetries: 1,
      },
      {
        id: "Completed",
        detect: {
          conditions: [
            {
              source: "selectorText",
              selector: ".slds-path__stage-name",
              operator: "equals",
              value: "Stage: Completed",
            },
          ],
        },
        terminal: true,
      },
    ],
  };
  return base;
}

test("V2-SV1: v2 workflow parses and override is privileged", () => {
  const raw = validV2Spec();
  const parsed = parseAdapterSpec(raw);
  assert.equal(parsed.ok, true);
  assert.equal(specIsPrivileged(raw), true, "code override requires privileged approval");
});

test("V2-SV2: v1 cannot request code-adapter override", () => {
  const raw = validRawSpec() as Record<string, unknown>;
  (raw.meta as Record<string, unknown>).resolution = "override";
  const parsed = parseAdapterSpec(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.issues.some((issue) => issue.path === "meta.resolution"));
  }
});

test("V2-SV3: workflow rejects an unknown transition target", () => {
  const raw = validV2Spec();
  const workflow = raw.workflow as {
    states: Array<{ transitions?: Array<{ to: string }> }>;
  };
  workflow.states[0].transitions![0].to = "Nonexistent";
  const parsed = parseAdapterSpec(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.issues.some((issue) => /unknown workflow target/.test(issue.message)));
  }
});

test("V2-SV4: jsHook and privileged actions are discovered inside workflow states", () => {
  const raw = validV2Spec();
  const workflow = raw.workflow as {
    states: Array<{ steps?: Array<Record<string, unknown>> }>;
  };
  workflow.states[0].steps!.push({ action: "jsHook", script: "window.scrollTo(0,0)" });
  assert.equal(specHasJsHook(raw), true);
  assert.equal(specIsPrivileged(raw), true);
});

test("V2-SV5: unreadable or incomplete conditions fail schema validation", () => {
  const raw = validV2Spec();
  const workflow = raw.workflow as {
    states: Array<{
      detect: { conditions: Array<Record<string, unknown>> };
    }>;
  };
  delete workflow.states[0].detect.conditions[0].selector;
  const parsed = parseAdapterSpec(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(
      parsed.issues.some(
        (issue) => issue.path.endsWith("detect.conditions.0.selector"),
      ),
    );
  }
});

test("V2-SV6: static program selection requires an authored option catalog", () => {
  const raw = validV2Spec();
  raw.programSelection = { source: "static" };
  (raw.steps as unknown[]).push({ action: "selectProgram", selector: "#program" });
  const parsed = parseAdapterSpec(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(
      parsed.issues.some((issue) =>
        issue.path.endsWith("programSelection.options"),
      ),
    );
  }
});

test("V2-SV7: profile defaults require one source and profile-only conditions", () => {
  const raw = validV2Spec();
  raw.profilePolicy = {
    defaults: [
      {
        field: "cityOfBirth",
        value: "Istanbul",
        valueFrom: "profile.addressCity",
        reason: "legacy_policy",
      },
      {
        field: "visaSupport",
        value: "No",
        reason: "legacy_policy",
        when: {
          source: "selectorExists",
          selector: ".wizard",
          operator: "exists",
        },
      },
    ],
  };
  const parsed = parseAdapterSpec(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.issues.some((issue) => /exactly one/.test(issue.message)));
    assert.ok(parsed.issues.some((issue) => /source=profile/.test(issue.message)));
  }
});

test("V2-SV8: required upload needs portal/server success proof", () => {
  const raw = validV2Spec();
  delete raw.workflow;
  raw.steps = [
    { action: "upload", selector: "#passport", slot: "passport" },
  ];
  const parsed = parseAdapterSpec(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(
      parsed.issues.some((issue) =>
        /requires responseUrlContains or successSelector proof/.test(issue.message),
      ),
    );
  }
});

test("V2-SV9: upload proof text cannot exist without its proof source", () => {
  const raw = validV2Spec();
  delete raw.workflow;
  raw.steps = [
    {
      action: "upload",
      selector: "#passport",
      slot: "passport",
      proof: {
        responseTextIncludes: '"success":true',
        successText: "Uploaded",
      },
    },
  ];
  const parsed = parseAdapterSpec(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(
      parsed.issues.some((issue) =>
        issue.path.endsWith("proof.responseUrlContains"),
      ),
    );
    assert.ok(
      parsed.issues.some((issue) =>
        issue.path.endsWith("proof.successSelector"),
      ),
    );
  }
});

test("V2-COND1: profile condition gates a fill step", async () => {
  const { page, calls } = makeMockPage();
  await executeSpecStep(
    page,
    {
      action: "fill",
      selector: "#city",
      valueFrom: "profile.cityOfBirth",
      when: {
        source: "profile",
        path: "cityOfBirth",
        operator: "notEmpty",
      },
    },
    ctx({ profile: { ...TEST_PROFILE, cityOfBirth: undefined } }),
  );
  assert.equal(calls.filter((call) => call.method === "fill").length, 0);
});

test("V2-COND2: selector text and interpolated expected values are read-only", async () => {
  const { page } = makeMockPage({
    textContent: async () => "Computer Engineering",
  });
  const matched = await evaluateCondition(
    page,
    {
      source: "selectorText",
      selector: ".program",
      operator: "equals",
      value: "{{profile.programName}}",
    },
    ctx(),
  );
  assert.equal(matched, true);
});

test("V2-RB1: fill exact readback accepts matching value and rejects mismatch", async () => {
  const matching = makeMockPage({
    inputValue: async () => "Ali",
    getAttribute: async () => "false",
  });
  await executeSpecStep(
    matching.page,
    {
      action: "fill",
      selector: "#name",
      valueFrom: "profile.firstName",
      readback: {
        source: "value",
        comparison: "exact",
        rejectAriaInvalid: true,
      },
    },
    ctx(),
  );
  const mismatch = makeMockPage({
    inputValue: async () => "Different",
    getAttribute: async () => "false",
  });
  await assert.rejects(
    executeSpecStep(
      mismatch.page,
      {
        action: "fill",
        selector: "#name",
        valueFrom: "profile.firstName",
        readback: {
          source: "value",
          comparison: "exact",
          rejectAriaInvalid: true,
        },
      },
      ctx(),
    ),
    /readback did not match/,
  );
});

test("V2-RB2: readback rejects aria-invalid even when value matches", async () => {
  const { page } = makeMockPage({
    inputValue: async () => "Ali",
    getAttribute: async () => "true",
  });
  await assert.rejects(
    executeSpecStep(
      page,
      {
        action: "fill",
        selector: "#name",
        valueFrom: "profile.firstName",
        readback: {
          source: "value",
          comparison: "exact",
          rejectAriaInvalid: true,
        },
      },
      ctx(),
    ),
    /aria-invalid/,
  );
});

test("V2-UP1: upload is recorded only after filename and server proofs pass", async () => {
  const stepCtx = ctx({ uploadedSlots: new Set<string>() });
  const { page, calls } = makeMockPage({
    inputValue: async () => "C:\\fakepath\\passport.pdf",
    waitForResponse: async (predicate) => {
      const response = {
        url: () => "https://apply.test-uni.example.com/api/documents/upload",
        status: () => 201,
        text: async () => '{"success":true}',
      };
      assert.equal(predicate(response), true);
      return response;
    },
  });
  await executeSpecStep(
    page,
    {
      action: "upload",
      selector: "#passport",
      slot: "passport",
      proof: {
        localFileName: true,
        responseUrlContains: "/documents/upload",
        responseTextIncludes: '"success":true',
        timeoutMs: 1000,
      },
    },
    stepCtx,
  );
  assert.equal(calls.filter((call) => call.method === "setInputFiles").length, 1);
  assert.deepEqual([...stepCtx.uploadedSlots!], ["passport"]);
});

test("V2-UP2: non-2xx upload response never records the document slot", async () => {
  const stepCtx = ctx({ uploadedSlots: new Set<string>() });
  const { page } = makeMockPage({
    inputValue: async () => "passport.pdf",
    waitForResponse: async () => ({
      url: () => "https://apply.test-uni.example.com/api/documents/upload",
      status: () => 500,
      text: async () => "failed",
    }),
  });
  await assert.rejects(
    executeSpecStep(
      page,
      {
        action: "upload",
        selector: "#passport",
        slot: "passport",
        proof: {
          localFileName: true,
          responseUrlContains: "/documents/upload",
          timeoutMs: 1000,
        },
      },
      stepCtx,
    ),
    /upload response failed.*status=500/,
  );
  assert.deepEqual([...stepCtx.uploadedSlots!], []);
});

test("V2-CLICK1: CSS and role clicks fail closed unless the target is unique", async () => {
  const css = makeMockPage({
    $$eval: async <T>() => (2 as unknown as T),
  });
  await assert.rejects(
    executeSpecStep(
      css.page,
      { action: "click", selector: ".next", requireUnique: true },
      ctx(),
    ),
    /not unique/,
  );

  const calls: Call[] = [];
  const role = makeMockPage({
    getByRole: () => ({
      count: async () => 1,
      click: async () => {
        calls.push({ method: "roleClick", args: [] });
      },
    }),
  });
  await executeSpecStep(
    role.page,
    {
      action: "clickRole",
      role: "button",
      name: "Next",
      exact: true,
    },
    ctx(),
  );
  assert.equal(calls.length, 1);
});

test("V2-POL1: explicit defaults fill only blanks and required runs afterward", () => {
  const result = applyProfilePolicy(
    { ...TEST_PROFILE, cityOfBirth: undefined, visaSupport: "Yes" },
    {
      defaults: [
        {
          field: "cityOfBirth",
          valueFrom: "profile.address",
          reason: "approved_legacy_address_policy",
        },
        {
          field: "visaSupport",
          value: "No",
          reason: "approved_legacy_no_policy",
        },
      ],
      required: [
        { field: "cityOfBirth", message: "birth city unavailable" },
        {
          field: "eduDegree",
          message: "graduate education degree unavailable",
          when: {
            source: "profile",
            path: "level",
            operator: "contains",
            value: "master",
            caseInsensitive: true,
          },
        },
      ],
    },
  );
  assert.equal(result.profile.cityOfBirth, "Istanbul");
  assert.equal(result.profile.visaSupport, "Yes", "nonblank source is never overwritten");
  assert.equal(result.defaultsApplied.length, 1);
  assert.equal(result.missing.length, 0, "Bachelor does not trigger Master-only rule");
});

test("V2-POL2: preflight blocks before the first portal mutation", async () => {
  const raw = validV2Spec();
  delete raw.workflow;
  raw.steps = [{ action: "click", selector: "#mutating-next" }];
  raw.profilePolicy = {
    required: [
      { field: "cityOfBirth", message: "birth city unavailable" },
    ],
  };
  const parsed = parseAdapterSpec(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const adapter = createSpecAdapter(parsed.spec);
  const { page, calls } = makeMockPage();
  await assert.rejects(
    adapter.submit(
      { page: page as never, close: async () => undefined },
      { ...TEST_PROFILE, cityOfBirth: undefined },
      TEST_FILES,
      true,
    ),
    /data_missing.*cityOfBirth/,
  );
  assert.equal(calls.filter((call) => call.method === "click").length, 0);
});

test("V2-DRY1: strict dry-run skips every DOM mutation but keeps read-only steps", async () => {
  const { page, calls } = makeMockPage({ _hasEl: true });
  const steps = [
    { action: "navigate", url: "https://e.com/apply" },
    { action: "fill", selector: "#name", valueFrom: "profile.firstName" },
    { action: "upload", selector: "#passport", slot: "passport" },
    { action: "click", selector: "#next" },
    {
      action: "assert",
      condition: {
        source: "selectorExists",
        selector: ".wizard",
        operator: "exists",
      },
      message: "wizard missing",
    },
  ] as const;
  await runSpecSteps(
    page,
    [...steps],
    ctx({ dryRun: true, dryRunPolicy: "strict" }),
    true,
  );
  assert.equal(calls.filter((call) => call.method === "goto").length, 1);
  assert.equal(calls.filter((call) => call.method === "$").length, 1);
  assert.equal(calls.filter((call) => call.method === "fill").length, 0);
  assert.equal(calls.filter((call) => call.method === "setInputFiles").length, 0);
  assert.equal(calls.filter((call) => call.method === "click").length, 0);
  assert.equal(isMutatingSpecStep(steps[1]), true);
  assert.equal(isMutatingSpecStep(steps[4]), false);
});

test("V2-PROG1: selectProgram uses exact/static option and captures proof", async () => {
  const { page, calls } = makeMockPage();
  const stepCtx = ctx({
    programSelection: {
      source: "static",
      options: [
        { value: "portal-42", label: "Computer Engineering", enabled: true },
      ],
    },
  });
  await executeSpecStep(
    page,
    { action: "selectProgram", selector: "#program" },
    stepCtx,
  );
  const selectCall = calls.find((call) => call.method === "selectOption");
  assert.deepEqual(selectCall?.args, ["#program", "portal-42"]);
  assert.equal(stepCtx.captured.selectedProgramValue, "portal-42");
  assert.equal(stepCtx.captured.selectedProgramConfidence, 1);
});

test("V2-PROG2: selectProgram enumerates live options and fails closed below threshold", async () => {
  const { page } = makeMockPage({
    $$eval: async <T>() =>
      ([{ value: "x", name: "Unrelated Programme", enabled: true }] as unknown as T),
  });
  await assert.rejects(
    executeSpecStep(
      page,
      { action: "selectProgram", selector: "#program" },
      ctx({
        programSelection: {
          source: "ajaxOptions",
          selector: "#program",
          fuzzyThreshold: 0.99,
        },
      }),
    ),
    /program_missing/,
  );
});

test("V2-PROG3: adapter returns structured programFull for a disabled exact match", async () => {
  const raw = validV2Spec();
  delete raw.workflow;
  raw.steps = [{ action: "selectProgram", selector: "#program" }];
  raw.programSelection = {
    source: "static",
    options: [
      {
        value: "portal-42",
        label: "Computer Engineering",
        enabled: false,
      },
    ],
  };
  const parsed = parseAdapterSpec(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const adapter = createSpecAdapter(parsed.spec);
  const { page } = makeMockPage();
  const result = await adapter.submit(
    { page: page as never, close: async () => undefined },
    TEST_PROFILE,
    TEST_FILES,
    true,
  );
  assert.equal(result.programFull, true);
  assert.equal(result.requestedProgram?.value, "portal-42");
  assert.equal(result.openPrograms?.[0].enabled, false);
});

test("V2-PROG4: adapter returns programMissing with catalog proof for no match", async () => {
  const raw = validV2Spec();
  delete raw.workflow;
  raw.steps = [{ action: "selectProgram", selector: "#program" }];
  raw.programSelection = {
    source: "static",
    fuzzyThreshold: 0.99,
    options: [
      {
        value: "other",
        label: "Unrelated Programme",
        enabled: true,
      },
    ],
  };
  const parsed = parseAdapterSpec(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  const adapter = createSpecAdapter(parsed.spec);
  const { page } = makeMockPage();
  const result = await adapter.submit(
    { page: page as never, close: async () => undefined },
    TEST_PROFILE,
    TEST_FILES,
    true,
  );
  assert.equal(result.programMissing, true);
  assert.equal(result.resolution, "not_in_dropdown");
  assert.equal(result.availablePrograms?.[0].name, "Unrelated Programme");
});

test("V2-OUT1: ordered outcome rules classify submitted/already/full fail-closed", async () => {
  const raw = validV2Spec();
  raw.outcomes = [
    {
      outcome: "alreadyExists",
      detail: "portal duplicate proof",
      detect: {
        conditions: [
          {
            source: "selectorText",
            selector: ".status",
            operator: "contains",
            value: "already registered",
            caseInsensitive: true,
          },
        ],
      },
    },
    {
      outcome: "programFull",
      detect: {
        conditions: [
          {
            source: "selectorText",
            selector: ".status",
            operator: "contains",
            value: "full quota",
            caseInsensitive: true,
          },
        ],
      },
    },
    {
      outcome: "submitted",
      externalRefFrom: { source: "captured", path: "applicationId" },
      detect: {
        conditions: [
          {
            source: "captured",
            path: "status",
            operator: "equals",
            value: "Evaluation",
          },
        ],
      },
    },
  ];
  const parsed = parseAdapterSpec(raw);
  if (!parsed.ok || !parsed.spec.outcomes) throw new Error("outcome fixture invalid");

  const duplicatePage = makeMockPage({
    textContent: async () => "Student already registered",
  }).page;
  const duplicate = await classifyOutcomeRules(
    duplicatePage,
    parsed.spec.outcomes,
    ctx(),
  );
  assert.equal(duplicate.alreadyExists, true);

  const submitted = await classifyOutcomeRules(
    makeMockPage({ textContent: async () => "" }).page,
    parsed.spec.outcomes,
    ctx({ captured: { status: "Evaluation", applicationId: "APP-42" } }),
  );
  assert.equal(submitted.submitted, true);
  assert.equal(submitted.externalRef, "APP-42");

  const unknown = await classifyOutcomeRules(
    makeMockPage({ textContent: async () => "Unknown" }).page,
    parsed.spec.outcomes,
    ctx(),
  );
  assert.equal(unknown.submitted, false);
  assert.match(unknown.detail ?? "", /unproved/);
});

test("V2-WF1: state changes only after stable detection + authored transition", async () => {
  const parsed = parseAdapterSpec(validV2Spec());
  if (!parsed.ok || !parsed.spec.workflow) throw new Error("v2 fixture invalid");
  let stage = "Stage: Personal Information";
  const { page, calls } = makeMockPage({
    textContent: async () => stage,
    click: async (...args) => {
      calls.push({ method: "click", args });
      stage = "Stage: Completed";
    },
    waitForTimeout: async () => undefined,
  });
  const terminal = await runSpecWorkflow(page, parsed.spec.workflow, ctx());
  assert.equal(terminal, "Completed");
  assert.equal(calls.filter((call) => call.method === "click").length, 1);
});

test("V2-WF2: same validated state retries within its bound, then fails closed", async () => {
  const parsed = parseAdapterSpec(validV2Spec());
  if (!parsed.ok || !parsed.spec.workflow) throw new Error("v2 fixture invalid");
  const { page, calls } = makeMockPage({
    textContent: async () => "Stage: Personal Information",
    waitForTimeout: async () => undefined,
  });
  await assert.rejects(
    runSpecWorkflow(page, parsed.spec.workflow, ctx()),
    /did not advance after 2 attempt/,
  );
  assert.equal(calls.filter((call) => call.method === "click").length, 2);
});

test("V2-WF3: strict dry-run proves current state and performs zero workflow mutation", async () => {
  const parsed = parseAdapterSpec(validV2Spec());
  if (!parsed.ok || !parsed.spec.workflow) throw new Error("v2 fixture invalid");
  const { page, calls } = makeMockPage({
    textContent: async () => "Stage: Personal Information",
    waitForTimeout: async () => undefined,
  });
  const state = await runSpecWorkflow(
    page,
    parsed.spec.workflow,
    ctx({ dryRun: true, dryRunPolicy: "strict" }),
  );
  assert.equal(state, "Personal Information");
  assert.equal(calls.filter((call) => call.method === "fill").length, 0);
  assert.equal(calls.filter((call) => call.method === "click").length, 0);
});

test("V2-ROW1: override requires enabled + privilegedApproved + v2 override spec", () => {
  const row = makeSpecRow({
    spec: validV2Spec(),
    enabled: true,
    privilegedApproved: true,
  });
  assert.equal(specRowAllowsOverride(row), true);
  assert.equal(specRowAllowsOverride({ ...row, privilegedApproved: false }), false);
  assert.equal(specRowAllowsOverride({ ...row, enabled: false }), false);
  assert.equal(
    specRowAllowsOverride({ ...row, spec: validRawSpec() as Record<string, unknown> }),
    false,
  );
});
