/**
 * Task #202 — Lossless JSON export/import for Embed widgets AND Web-to-Lead forms.
 *
 * Pure-unit tests for the helpers in `src/lib/exportImport.ts`. Covers the
 * envelope contract (kind / version / size cap), prototype-pollution guard,
 * field-picking, summary tallying, and slug renaming.
 *
 * The route-level integration is exercised in the existing inbox-suite and
 * webhook-dedup tests; this script keeps the helpers regression-locked
 * without a database dependency so it runs in any environment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_VERSION,
  MAX_IMPORT_BYTES,
  buildEnvelope,
  parseEnvelope,
  pickFields,
  assertNoPrototypePollution,
  emptySummary,
  tallyResult,
  nextAvailableSlug,
  isValidConflictStrategy,
  ImportValidationError,
} from "../src/lib/exportImport";

test("buildEnvelope produces a v1 envelope of the given kind", () => {
  const env = buildEnvelope("embed_widgets", [{ slug: "a" }, { slug: "b" }]);
  assert.equal(env.kind, "embed_widgets");
  assert.equal(env.version, EXPORT_VERSION);
  assert.equal(env.items.length, 2);
  assert.ok(/\d{4}-\d{2}-\d{2}T/.test(env.exportedAt));
});

test("pickFields keeps only whitelisted keys and drops volatile ones", () => {
  const row = { id: 7, slug: "hello", name: "Hi", createdAt: "2026-01-01", secret: "x" };
  const picked = pickFields(row, ["name", "slug"]);
  assert.deepEqual(picked, { name: "Hi", slug: "hello" });
});

test("parseEnvelope round-trips a buildEnvelope output", () => {
  const env = buildEnvelope("website_forms", [{ slug: "contact" }]);
  const items = parseEnvelope<{ slug: string }>(env, { expectedKind: "website_forms" });
  assert.equal(items.length, 1);
  assert.equal(items[0].slug, "contact");
});

test("parseEnvelope rejects wrong kind", () => {
  const env = buildEnvelope("embed_widgets", []);
  assert.throws(
    () => parseEnvelope(env, { expectedKind: "website_forms" }),
    (e: unknown) => e instanceof ImportValidationError && /Wrong envelope kind/.test((e as Error).message),
  );
});

test("parseEnvelope rejects unsupported version", () => {
  const env = { kind: "embed_widgets", version: 99, exportedAt: "now", items: [] };
  assert.throws(
    () => parseEnvelope(env, { expectedKind: "embed_widgets" }),
    (e: unknown) => e instanceof ImportValidationError && /Unsupported envelope version/.test((e as Error).message),
  );
});

test("parseEnvelope rejects non-object payload", () => {
  assert.throws(() => parseEnvelope("not an envelope", { expectedKind: "embed_widgets" }), ImportValidationError);
  assert.throws(() => parseEnvelope(null, { expectedKind: "embed_widgets" }), ImportValidationError);
  assert.throws(() => parseEnvelope([], { expectedKind: "embed_widgets" }), ImportValidationError);
});

test("parseEnvelope rejects items that is not an array", () => {
  const bad = { kind: "embed_widgets", version: EXPORT_VERSION, exportedAt: "x", items: { 0: "a" } };
  assert.throws(() => parseEnvelope(bad, { expectedKind: "embed_widgets" }), ImportValidationError);
});

test("parseEnvelope enforces the size cap", () => {
  const huge = { kind: "embed_widgets", version: EXPORT_VERSION, exportedAt: "x", items: [{ blob: "a".repeat(MAX_IMPORT_BYTES + 1) }] };
  assert.throws(
    () => parseEnvelope(huge, { expectedKind: "embed_widgets" }),
    (e: unknown) => e instanceof ImportValidationError && (e as ImportValidationError).status === 413,
  );
});

test("assertNoPrototypePollution rejects __proto__ / constructor / prototype keys", () => {
  const polluted = JSON.parse('{"items":[{"__proto__":{"polluted":true}}]}');
  assert.throws(() => assertNoPrototypePollution(polluted), ImportValidationError);
  assert.throws(() => assertNoPrototypePollution({ x: { constructor: 1 } }), ImportValidationError);
  assert.throws(() => assertNoPrototypePollution({ a: [{ prototype: 1 }] }), ImportValidationError);
  // Safe values pass.
  assertNoPrototypePollution({ a: 1, b: [{ c: "ok" }] });
  assertNoPrototypePollution(null);
  assertNoPrototypePollution("string");
});

test("parseEnvelope rejects prototype pollution in items", () => {
  const env = JSON.parse(JSON.stringify({
    kind: "embed_widgets", version: EXPORT_VERSION, exportedAt: "x",
    items: [JSON.parse('{"slug":"bad","__proto__":{"polluted":1}}')],
  }));
  assert.throws(() => parseEnvelope(env, { expectedKind: "embed_widgets" }), ImportValidationError);
});

test("tallyResult accumulates counters and preserves order", () => {
  const s = emptySummary(4);
  tallyResult(s, { index: 0, slug: "a", status: "created" });
  tallyResult(s, { index: 1, slug: "b", status: "updated" });
  tallyResult(s, { index: 2, slug: "c", status: "renamed", finalSlug: "c-copy" });
  tallyResult(s, { index: 3, slug: "d", status: "skipped" });
  assert.equal(s.created, 1);
  assert.equal(s.updated, 1);
  assert.equal(s.renamed, 1);
  assert.equal(s.skipped, 1);
  assert.equal(s.errors, 0);
  assert.equal(s.results.length, 4);
  assert.equal(s.results[2].finalSlug, "c-copy");
});

test("nextAvailableSlug picks the first free suffix", async () => {
  const taken = new Set(["form-copy", "form-copy-2"]);
  const next = await nextAvailableSlug("form", async (c) => taken.has(c));
  assert.equal(next, "form-copy-3");
});

test("nextAvailableSlug collapses repeated -copy suffixes", async () => {
  const next = await nextAvailableSlug("form-copy-2", async () => false);
  assert.equal(next, "form-copy");
});

test("isValidConflictStrategy accepts the three known values", () => {
  assert.equal(isValidConflictStrategy("skip"), true);
  assert.equal(isValidConflictStrategy("overwrite"), true);
  assert.equal(isValidConflictStrategy("rename"), true);
  assert.equal(isValidConflictStrategy("nope"), false);
  assert.equal(isValidConflictStrategy(undefined), false);
});

test("round-trip: buildEnvelope -> JSON string -> parseEnvelope is lossless", () => {
  const original = [
    { name: "Widget A", slug: "widget-a", isActive: true, presetFilters: { country: "TR" }, allowedDomains: ["a.com"] },
    { name: "Widget B", slug: "widget-b", isActive: false, presetFilters: {}, allowedDomains: [] },
  ];
  const env = buildEnvelope("embed_widgets", original);
  const transported = JSON.parse(JSON.stringify(env));
  const items = parseEnvelope<typeof original[number]>(transported, { expectedKind: "embed_widgets" });
  assert.deepEqual(items, original);
});

// --- Excel round-trip tests (Task #202 v2) -------------------------------
import {
  buildWorkbookBuffer,
  parseWorkbookBuffer,
  embedWidgetColumns,
  buildEmbedFilterReferenceSheets,
  EMBED_FILTER_KEYS,
  formColumns,
  formFieldColumns,
  EMBED_KIND,
  FORMS_KIND,
  type EmbedFilterCatalog,
} from "../src/lib/exportImportExcel";

const VALID_MODES = ["combined", "course_finder", "application_only", "lead_form"];

test("xlsx: embed widget round-trip preserves every editable field", async () => {
  const cols = embedWidgetColumns(VALID_MODES);
  const original = {
    name: "Main widget",
    slug: "main-widget",
    mode: "lead_form",
    isActive: true,
    theme: { primary: "#0ea5e9", radius: "8px" },
    presetFilters: { country: "TR" },
    lockedFilters: ["country"],
    hiddenFilters: ["fee"],
    visibleFilters: ["level", "subject"],
    allowedDomains: ["example.com", "edu.tr"],
  };
  const buf = await buildWorkbookBuffer({
    sheets: [{ name: "Widgets", columns: cols, rows: [original] }],
    meta: { kind: EMBED_KIND, version: "1", exportedAt: "2026-05-25" },
  });
  const parsed = await parseWorkbookBuffer(buf, { expectedKind: EMBED_KIND }, { Widgets: cols });
  const row = parsed.sheets.get("Widgets")!.rows[0];
  assert.equal(row.name, original.name);
  assert.equal(row.slug, original.slug);
  assert.equal(row.mode, original.mode);
  assert.equal(row.isActive, true);
  assert.deepEqual(row.theme, original.theme);
  assert.deepEqual(row.presetFilters, original.presetFilters);
  assert.deepEqual(row.lockedFilters, original.lockedFilters);
  assert.deepEqual(row.hiddenFilters, original.hiddenFilters);
  assert.deepEqual(row.visibleFilters, original.visibleFilters);
  assert.deepEqual(row.allowedDomains, original.allowedDomains);
});

test("xlsx: parseWorkbookBuffer rejects wrong kind", async () => {
  const cols = embedWidgetColumns(VALID_MODES);
  const buf = await buildWorkbookBuffer({
    sheets: [{ name: "Widgets", columns: cols, rows: [] }],
    meta: { kind: "something_else", version: "1", exportedAt: "x" },
  });
  await assert.rejects(
    () => parseWorkbookBuffer(buf, { expectedKind: EMBED_KIND }, { Widgets: cols }),
    /Wrong workbook kind/,
  );
});

test("xlsx: parseWorkbookBuffer rejects oversized payload", async () => {
  const cols = embedWidgetColumns(VALID_MODES);
  // 1 byte buffer with the maxBytes guard set to 0 to force a 413.
  await assert.rejects(
    () => parseWorkbookBuffer(Buffer.from([0]), { expectedKind: EMBED_KIND, maxBytes: 0 }, { Widgets: cols }),
    /exceeds 2 MB limit/,
  );
});

test("xlsx: form workbook splits Forms + Fields and round-trips both", async () => {
  const fCols = formColumns(["new", "qualified", "won"], ["website", "embed"]);
  const fldCols = formFieldColumns();
  const form = {
    name: "Lead form",
    slug: "lead-form",
    description: "Main lead form",
    submitAction: "crm",
    submitEmail: null,
    submitWebhookUrl: null,
    successMessage: "Thanks!",
    errorMessage: "Please try again",
    crmSource: "website",
    crmPipelineStage: "new",
    pageSourceTag: "homepage",
    isActive: true,
  };
  const field = {
    form_slug: "lead-form",
    fieldType: "select",
    label: "Country",
    name: "country",
    placeholder: "Pick a country",
    isRequired: true,
    sortOrder: 1,
    validationRules: { minLength: 2 },
    options: [{ label: "Türkiye", value: "TR" }, { label: "USA", value: "US" }],
  };
  const buf = await buildWorkbookBuffer({
    sheets: [
      { name: "Forms", columns: fCols, rows: [form] },
      { name: "Fields", columns: fldCols, rows: [field] },
    ],
    meta: { kind: FORMS_KIND, version: "1", exportedAt: "x" },
  });
  const parsed = await parseWorkbookBuffer(buf, { expectedKind: FORMS_KIND }, {
    Forms: fCols, Fields: fldCols,
  });
  const f = parsed.sheets.get("Forms")!.rows[0];
  const fld = parsed.sheets.get("Fields")!.rows[0];
  assert.equal(f.submitAction, "crm");
  assert.equal(f.crmPipelineStage, "new");
  assert.equal(f.isActive, true);
  assert.equal(fld.form_slug, "lead-form");
  assert.equal(fld.fieldType, "select");
  assert.equal(fld.isRequired, true);
  assert.equal(fld.sortOrder, 1);
  assert.deepEqual(fld.validationRules, { minLength: 2 });
  assert.deepEqual(fld.options, [{ label: "Türkiye", value: "TR" }, { label: "USA", value: "US" }]);
});

test("xlsx: parser rejects prototype-polluting JSON cell", async () => {
  const cols = embedWidgetColumns(VALID_MODES);
  // Build a workbook with a JSON cell that contains __proto__ pollution.
  // We use the low-level ExcelJS to inject the bad cell.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Widgets");
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key }));
  ws.addRow({
    name: "x",
    slug: "x",
    mode: "combined",
    isActive: "TRUE",
    theme: '{"__proto__":{"polluted":true}}',
  });
  const meta = wb.addWorksheet("_meta", { state: "hidden" });
  meta.getCell("A1").value = "kind";
  meta.getCell("B1").value = EMBED_KIND;
  const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  await assert.rejects(
    () => parseWorkbookBuffer(buf, { expectedKind: EMBED_KIND }, { Widgets: cols }),
    /Disallowed property|__proto__/,
  );
});

test("xlsx: parser requires _meta.kind to be present", async () => {
  const cols = embedWidgetColumns(VALID_MODES);
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Widgets");
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key }));
  // No _meta sheet at all
  const buf = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  await assert.rejects(
    () => parseWorkbookBuffer(buf, { expectedKind: EMBED_KIND }, { Widgets: cols }),
    /missing its provenance marker/,
  );
});

test("xlsx: long enum option lists fall back to a hidden helper sheet", async () => {
  // Build a fake column with 60 options each 10 chars long -> well past 255.
  const longOpts = Array.from({ length: 60 }, (_, i) => `option_${String(i).padStart(3, "0")}`);
  const cols = [
    { key: "name", header: "Name", kind: "string" as const, required: true },
    { key: "slug", header: "Slug", kind: "string" as const, required: true },
    { key: "mode", header: "Mode", kind: "enum" as const, options: longOpts, required: true },
    { key: "isActive", header: "Active", kind: "boolean" as const, required: true },
  ];
  const buf = await buildWorkbookBuffer({
    sheets: [{ name: "Widgets", columns: cols, rows: [
      { name: "n", slug: "s", mode: "option_005", isActive: true },
    ] }],
    meta: { kind: EMBED_KIND, version: "1", exportedAt: "x" },
  });
  // Workbook must still round-trip cleanly.
  const parsed = await parseWorkbookBuffer(buf, { expectedKind: EMBED_KIND }, { Widgets: cols });
  assert.equal(parsed.sheets.get("Widgets")!.rows[0].mode, "option_005");
  // Confirm the hidden helper sheet exists.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  assert.ok(wb.getWorksheet("_opts_mode"), "expected hidden helper sheet for long enum");
});

test("xlsx: blank isActive cell defaults to active on embed import", async () => {
  const { toEmbedInsertValues } = await import("../src/lib/exportImportExcel");
  const blank = toEmbedInsertValues({ name: "n", slug: "s", mode: "combined", isActive: null }, VALID_MODES);
  assert.equal(blank.isActive, true);
  const explicitOff = toEmbedInsertValues({ name: "n", slug: "s", mode: "combined", isActive: false }, VALID_MODES);
  assert.equal(explicitOff.isActive, false);
});

test("xlsx: long enum fallback registers a workbook defined name and uses it", async () => {
  const longOpts = Array.from({ length: 60 }, (_, i) => `option_${String(i).padStart(3, "0")}`);
  const cols = [
    { key: "name", header: "Name", kind: "string" as const, required: true },
    { key: "slug", header: "Slug", kind: "string" as const, required: true },
    { key: "mode", header: "Mode", kind: "enum" as const, options: longOpts, required: true },
    { key: "isActive", header: "Active", kind: "boolean" as const, required: true },
  ];
  const buf = await buildWorkbookBuffer({
    sheets: [{ name: "Widgets", columns: cols, rows: [
      { name: "n", slug: "s", mode: "option_010", isActive: true },
    ] }],
    meta: { kind: EMBED_KIND, version: "1", exportedAt: "x" },
  });
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  // Defined name registered.
  const names = wb.definedNames.model;
  const hit = names.find((n: { name: string }) => n.name === "_opts_mode_rng");
  assert.ok(hit, `expected defined name _opts_mode_rng, got ${JSON.stringify(names.map((n: { name: string }) => n.name))}`);
  // Validation formula uses the defined name, not a raw sheet reference.
  const ws = wb.getWorksheet("Widgets")!;
  const dv = ws.getCell("C2").dataValidation!;
  assert.deepEqual(dv.formulae, ["_opts_mode_rng"]);
});

test("xlsx: multiple long-enum columns get distinct defined names", async () => {
  const longA = Array.from({ length: 60 }, (_, i) => `a_${String(i).padStart(3, "0")}`);
  const longB = Array.from({ length: 70 }, (_, i) => `b_${String(i).padStart(3, "0")}`);
  const cols = [
    { key: "name", header: "Name", kind: "string" as const, required: true },
    { key: "alpha", header: "Alpha", kind: "enum" as const, options: longA, required: true },
    { key: "beta", header: "Beta", kind: "enum" as const, options: longB, required: true },
  ];
  const buf = await buildWorkbookBuffer({
    sheets: [{ name: "Sheet1", columns: cols, rows: [] }],
    meta: { kind: EMBED_KIND, version: "1", exportedAt: "x" },
  });
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const names = wb.definedNames.model.map((n: { name: string }) => n.name).sort();
  assert.deepEqual(names, ["_opts_alpha_rng", "_opts_beta_rng"]);
});

test("xlsx: toEmbedInsertValues rejects invalid mode instead of silently coercing", async () => {
  const { toEmbedInsertValues } = await import("../src/lib/exportImportExcel");
  assert.throws(
    () => toEmbedInsertValues({ name: "n", slug: "s", mode: "totally_made_up", isActive: true }, VALID_MODES),
    /Invalid mode/,
  );
  // Empty / missing mode also rejected
  assert.throws(
    () => toEmbedInsertValues({ name: "n", slug: "s", mode: "", isActive: true }, VALID_MODES),
    /Invalid mode/,
  );
});

test("xlsx: server-level round-trip — export embed bytes can be re-imported losslessly", async () => {
  const cols = embedWidgetColumns(VALID_MODES);
  const original = [
    { name: "Alpha", slug: "alpha", mode: "combined", isActive: true,
      theme: { primary: "#0ea5e9" }, presetFilters: { country: "TR" },
      lockedFilters: ["country"], hiddenFilters: [], visibleFilters: ["level"],
      allowedDomains: ["alpha.example.com"] },
    { name: "Beta", slug: "beta", mode: "lead_form", isActive: false,
      theme: {}, presetFilters: {}, lockedFilters: [], hiddenFilters: [],
      visibleFilters: [], allowedDomains: [] },
  ];
  // Pretend this was an /export response.
  const exportBuf = await buildWorkbookBuffer({
    sheets: [{ name: "Widgets", columns: cols, rows: original }],
    meta: { kind: EMBED_KIND, version: "1", exportedAt: new Date().toISOString() },
  });
  // Re-parse as if it had been uploaded to /import.
  const parsed = await parseWorkbookBuffer(exportBuf, { expectedKind: EMBED_KIND }, { Widgets: cols });
  const rows = parsed.sheets.get("Widgets")!.rows;
  assert.equal(rows.length, original.length);
  const { toEmbedInsertValues } = await import("../src/lib/exportImportExcel");
  for (let i = 0; i < rows.length; i++) {
    const vals = toEmbedInsertValues(rows[i], VALID_MODES);
    // Every editable field survives the round-trip.
    assert.equal(vals.name, original[i].name);
    assert.equal(vals.slug, original[i].slug);
    assert.equal(vals.mode, original[i].mode);
    assert.equal(vals.isActive, original[i].isActive);
    assert.deepEqual(vals.theme, original[i].theme);
    assert.deepEqual(vals.presetFilters, original[i].presetFilters);
    assert.deepEqual(vals.lockedFilters, original[i].lockedFilters);
    assert.deepEqual(vals.allowedDomains, original[i].allowedDomains);
  }
});

test("xlsx: template ships one dedicated sheet per filter dimension", async () => {
  const catalog: EmbedFilterCatalog = {
    countries: ["Turkey", "United Kingdom"],
    cities: ["Istanbul", "London"],
    universityTypes: ["Private", "State"],
    levels: ["Bachelor", "Master"],
    languages: ["English", "Turkish"],
    universities: [
      { id: 1, name: "Beykoz Univ.", country: "Turkey", city: "Istanbul", type: "Private" },
      { id: 2, name: "Okan Univ.", country: "Turkey", city: "Istanbul", type: "Private" },
    ],
  };
  const cols = embedWidgetColumns(["combined"], catalog);
  const refSheets = buildEmbedFilterReferenceSheets(catalog);
  // Summary + one sheet per filter dimension (countries, cities, types,
  // levels, languages, universities).
  const names = refSheets.map((s) => s.name);
  assert.deepEqual(names, [
    "Filter reference", "Countries", "Cities", "University types",
    "Levels", "Languages", "Universities",
  ]);
  // The summary sheet has one row per canonical filter key.
  const summary = refSheets[0];
  assert.equal(summary.rows.length, EMBED_FILTER_KEYS.length);
  for (const k of EMBED_FILTER_KEYS) {
    assert.ok(summary.rows.some((r) => r.filterKey === k), `missing summary row for "${k}"`);
  }
  // Per-dimension sheets list EVERY value in full, not a sample.
  const get = (name: string) => refSheets.find((s) => s.name === name)!;
  assert.deepEqual(get("Countries").rows.map((r) => r.value), ["Turkey", "United Kingdom"]);
  assert.deepEqual(get("Levels").rows.map((r) => r.value), ["Bachelor", "Master"]);
  assert.equal(get("Universities").rows.length, 2);
  assert.equal(get("Universities").rows[0].id, 1);
  // Header notes on the Widgets sheet must reference every filter key.
  const presetCol = cols.find((c) => c.key === "presetFilters")!;
  for (const k of EMBED_FILTER_KEYS) {
    assert.ok(presetCol.note?.includes(k), `presetFilters note should mention key "${k}"`);
  }
  // The full workbook (Widgets + 7 reference sheets) round-trips: the
  // parser ignores reference sheets and only reads Widgets.
  const buf = await buildWorkbookBuffer({
    sheets: [{ name: "Widgets", columns: cols, rows: [] }, ...refSheets],
    meta: { kind: EMBED_KIND, version: "1", exportedAt: "x" },
  });
  const parsed = await parseWorkbookBuffer(buf, { expectedKind: EMBED_KIND }, { Widgets: cols });
  assert.equal(parsed.sheets.get("Widgets")!.rows.length, 0);
});

test("xlsx: empty catalog still produces every reference sheet with placeholders", async () => {
  const empty: EmbedFilterCatalog = {
    countries: [], cities: [], universityTypes: [], levels: [], languages: [],
    universities: [],
  };
  const refSheets = buildEmbedFilterReferenceSheets(empty);
  assert.equal(refSheets.length, 7);
  // Every list sheet renders a single placeholder row instead of being empty.
  for (const name of ["Countries", "Cities", "University types", "Levels", "Languages"]) {
    const s = refSheets.find((x) => x.name === name)!;
    assert.equal(s.rows.length, 1);
    assert.ok(String(s.rows[0].value).length > 0);
  }
  const unis = refSheets.find((s) => s.name === "Universities")!;
  assert.equal(unis.rows.length, 1);
});

test("xlsx: parser rejects workbook with mismatched version", async () => {
  const cols = embedWidgetColumns(VALID_MODES);
  const buf = await buildWorkbookBuffer({
    sheets: [{ name: "Widgets", columns: cols, rows: [] }],
    meta: { kind: EMBED_KIND, version: "999", exportedAt: "x" },
  });
  await assert.rejects(
    () => parseWorkbookBuffer(buf, { expectedKind: EMBED_KIND }, { Widgets: cols }),
    /Unsupported workbook version/,
  );
});
