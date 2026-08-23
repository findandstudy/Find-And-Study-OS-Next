/**
 * Excel (.xlsx) export / import / template helpers for Task #202.
 *
 * Replaces the earlier JSON-only flow with workbooks that:
 *   - export every editable field losslessly,
 *   - on import, accept the same workbook back and round-trip,
 *   - ship a "download template" path that injects DYNAMIC dropdown values
 *     (current valid modes, current CRM pipeline stages, etc.) so admins
 *     never have to guess the allowed strings.
 *
 * Nested structures (presetFilters, theme, validationRules, options,
 * allowedDomains, …) are stored as JSON text in their own cells; on import
 * the strings are JSON-parsed back into the original shape so the
 * round-trip stays lossless.
 */

import ExcelJS from "exceljs";
import { ImportValidationError, assertNoPrototypePollution } from "./exportImport";

export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// --- Column type metadata -------------------------------------------------

export type CellKind = "string" | "boolean" | "number" | "json" | "enum";

export interface ColumnSpec {
  key: string;             // object property name on export rows
  header: string;          // human-readable header
  kind: CellKind;
  width?: number;
  required?: boolean;
  options?: readonly string[]; // for kind === "enum"
  note?: string;           // tooltip shown when hovering the header
}

// --- Workbook builder ------------------------------------------------------

interface SheetSpec<T extends Record<string, unknown>> {
  name: string;
  columns: readonly ColumnSpec[];
  rows: T[];
}

function applyHeader(ws: ExcelJS.Worksheet, columns: readonly ColumnSpec[]): void {
  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.key,
    width: c.width ?? Math.max(14, c.header.length + 2),
  }));
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true };
  headerRow.alignment = { vertical: "middle" };
  headerRow.height = 22;
  columns.forEach((c, i) => {
    const cell = headerRow.getCell(i + 1);
    if (c.note) cell.note = c.note;
    if (c.required) {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFDE7E9" },
      };
    } else {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFEFEFEF" },
      };
    }
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
}

function serializeCell(kind: CellKind, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  switch (kind) {
    case "boolean": return value === true ? "TRUE" : "FALSE";
    case "number": return typeof value === "number" ? value : Number(value);
    case "json": return JSON.stringify(value);
    default: return String(value);
  }
}

function applyValidations(
  ws: ExcelJS.Worksheet,
  columns: readonly ColumnSpec[],
  rowCount: number,
): void {
  // Apply data validation to the next 500 rows so empty templates also
  // get dropdowns ready to fill in.
  const lastRow = Math.max(rowCount + 1, 501);
  columns.forEach((c, i) => {
    const colLetter = ws.getColumn(i + 1).letter;
    if (c.kind === "boolean") {
      for (let r = 2; r <= lastRow; r++) {
        ws.getCell(`${colLetter}${r}`).dataValidation = {
          type: "list",
          allowBlank: !c.required,
          formulae: ['"TRUE,FALSE"'],
          showErrorMessage: true,
          errorTitle: "Invalid value",
          error: "Pick TRUE or FALSE.",
        };
      }
    } else if (c.kind === "enum" && c.options && c.options.length > 0) {
      // Excel inline list formulae are capped at 255 chars including the
      // surrounding quotes. If the joined literal is too long, fall back
      // to a named range on a hidden helper sheet so the dropdown still
      // works no matter how many dynamic options are present.
      const inline = `"${c.options.join(",")}"`;
      let formula = inline;
      if (inline.length > 255) {
        // Excel inline list formulae cap at 255 chars. Fall back to a
        // workbook-scoped defined name pointing at a hidden helper sheet
        // so the dropdown still works across every Excel client (some
        // clients reject raw cross-sheet references in data validation).
        const helperSheetName = `_opts_${c.key}`;
        const definedName = `_opts_${c.key}_rng`;
        let helper = ws.workbook.getWorksheet(helperSheetName);
        if (!helper) {
          helper = ws.workbook.addWorksheet(helperSheetName, { state: "hidden" });
          c.options.forEach((opt, idx) => { helper!.getCell(`A${idx + 1}`).value = opt; });
        }
        const lastOptRow = c.options.length;
        const range = `${helperSheetName}!$A$1:$A$${lastOptRow}`;
        // Register a workbook-scoped defined name (idempotent: ExcelJS
        // stores definedNames in a Map keyed by name).
        ws.workbook.definedNames.add(range, definedName);
        formula = definedName;
      }
      for (let r = 2; r <= lastRow; r++) {
        ws.getCell(`${colLetter}${r}`).dataValidation = {
          type: "list",
          allowBlank: !c.required,
          formulae: [formula],
          showErrorMessage: true,
          errorTitle: "Invalid value",
          error: `Pick one of: ${c.options.join(", ").slice(0, 200)}.`,
        };
      }
    }
  });
}

function buildSheet<T extends Record<string, unknown>>(
  wb: ExcelJS.Workbook,
  spec: SheetSpec<T>,
): void {
  const ws = wb.addWorksheet(spec.name);
  applyHeader(ws, spec.columns);
  for (const row of spec.rows) {
    const out: Record<string, unknown> = {};
    for (const c of spec.columns) {
      out[c.key] = serializeCell(c.kind, row[c.key]);
    }
    ws.addRow(out);
  }
  applyValidations(ws, spec.columns, spec.rows.length);
}

export interface WorkbookSpec {
  sheets: SheetSpec<Record<string, unknown>>[];
  meta?: Record<string, string>;
}

export async function buildWorkbookBuffer(spec: WorkbookSpec): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "EduConsult OS";
  wb.created = new Date();
  for (const sheet of spec.sheets) {
    buildSheet(wb, sheet);
  }
  if (spec.meta) {
    const ws = wb.addWorksheet("_meta", { state: "hidden" });
    let i = 1;
    for (const [k, v] of Object.entries(spec.meta)) {
      ws.getCell(`A${i}`).value = k;
      ws.getCell(`B${i}`).value = v;
      i++;
    }
  }
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

// --- Parser ---------------------------------------------------------------

export interface ParseOptions {
  expectedKind: string;
  expectedVersion?: string;
  maxBytes?: number;
}

export const CURRENT_WORKBOOK_VERSION = "1";

export interface ParsedSheet {
  name: string;
  rows: Array<Record<string, unknown>>;
}

export interface ParsedWorkbook {
  meta: Record<string, string>;
  sheets: Map<string, ParsedSheet>;
}

function parseCell(kind: CellKind, raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  // ExcelJS wraps formulae and rich text — flatten to a plain primitive.
  let v: unknown = raw;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    if ("result" in o) v = o.result;
    else if ("text" in o) v = o.text;
    else if ("richText" in o && Array.isArray(o.richText)) {
      v = (o.richText as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
    } else if ("hyperlink" in o && "text" in o) {
      v = o.text;
    } else if (v instanceof Date) {
      v = (v as Date).toISOString();
    }
  }
  switch (kind) {
    case "string": return String(v).trim();
    case "number": {
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    }
    case "boolean": {
      if (typeof v === "boolean") return v;
      const s = String(v).trim().toLowerCase();
      if (["true", "1", "yes", "evet", "doğru"].includes(s)) return true;
      if (["false", "0", "no", "hayır", "yanlış"].includes(s)) return false;
      return null;
    }
    case "enum": return String(v).trim();
    case "json": {
      const s = String(v).trim();
      if (s === "") return null;
      try {
        const parsed = JSON.parse(s);
        assertNoPrototypePollution(parsed, "cell");
        return parsed;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new ImportValidationError(`Invalid JSON in cell: ${msg}`);
      }
    }
  }
}

export async function parseWorkbookBuffer(
  buf: Buffer,
  opts: ParseOptions,
  schemas: Record<string, readonly ColumnSpec[]>,
): Promise<ParsedWorkbook> {
  if (buf.byteLength > (opts.maxBytes ?? MAX_IMPORT_BYTES)) {
    throw new ImportValidationError("Import file exceeds 2 MB limit", 413);
  }
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ImportValidationError(`Could not parse Excel file: ${msg}`);
  }

  // Read meta sheet for kind/version provenance check.
  const meta: Record<string, string> = {};
  const metaSheet = wb.getWorksheet("_meta");
  if (metaSheet) {
    metaSheet.eachRow((row) => {
      const k = String(row.getCell(1).value ?? "").trim();
      const v = String(row.getCell(2).value ?? "").trim();
      if (k) meta[k] = v;
    });
  }
  if (!meta.kind) {
    throw new ImportValidationError(
      `Workbook is missing its provenance marker. Re-download the template or export and try again (expected kind "${opts.expectedKind}").`,
    );
  }
  if (meta.kind !== opts.expectedKind) {
    throw new ImportValidationError(
      `Wrong workbook kind: expected "${opts.expectedKind}", got "${meta.kind}".`,
    );
  }
  const expectedVersion = opts.expectedVersion ?? CURRENT_WORKBOOK_VERSION;
  if (meta.version && meta.version !== expectedVersion) {
    throw new ImportValidationError(
      `Unsupported workbook version "${meta.version}". This server only accepts version "${expectedVersion}". Re-export from a matching server.`,
    );
  }

  const sheets = new Map<string, ParsedSheet>();
  for (const [sheetName, columns] of Object.entries(schemas)) {
    const ws = wb.getWorksheet(sheetName);
    if (!ws) {
      sheets.set(sheetName, { name: sheetName, rows: [] });
      continue;
    }
    // Header row is row 1 — map header text to column index so the parser
    // does not care about column order. Fall back to the schema order if
    // the header is blank.
    const headerToIdx = new Map<string, number>();
    const headerRow = ws.getRow(1);
    headerRow.eachCell((cell, col) => {
      const h = String(cell.value ?? "").trim();
      if (h) headerToIdx.set(h, col);
    });
    const colByIndex = columns.map((c, i) => ({
      spec: c,
      idx: headerToIdx.get(c.header) ?? i + 1,
    }));

    const rows: Array<Record<string, unknown>> = [];
    for (let r = 2; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      // Skip fully-empty rows so trailing blanks do not error.
      let hasAny = false;
      for (const { idx } of colByIndex) {
        const v = row.getCell(idx).value;
        if (v !== null && v !== undefined && v !== "") { hasAny = true; break; }
      }
      if (!hasAny) continue;

      const out: Record<string, unknown> = {};
      for (const { spec, idx } of colByIndex) {
        const cell = row.getCell(idx).value;
        try {
          out[spec.key] = parseCell(spec.kind, cell);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          throw new ImportValidationError(
            `${sheetName}!${ws.getColumn(idx).letter}${r} (${spec.header}): ${msg}`,
          );
        }
      }
      assertNoPrototypePollution(out, `${sheetName}[${r}]`);
      rows.push(out);
    }
    sheets.set(sheetName, { name: sheetName, rows });
  }
  return { meta, sheets };
}

// --- Embed widgets schema -------------------------------------------------

export const EMBED_KIND = "embed_widgets";

// Canonical list of filter keys the embed widget supports. Mirrors the
// FILTER_KEYS list in artifacts/edcons/src/pages/admin/Embeds.tsx — keep
// the two in sync so admins see the same allowed keys in the UI and the
// downloaded Excel template.
export const EMBED_FILTER_KEYS = [
  "country", "city", "universityType", "universityId", "level", "language",
] as const;

export type EmbedFilterKey = (typeof EMBED_FILTER_KEYS)[number];

// Catalog of currently-valid values for each filter key, sampled from the
// live DB so admins don't have to guess what to type into the JSON cells.
// `null` for `universityId` because IDs are numeric — the sample
// universities list is rendered as a separate reference instead.
export interface EmbedFilterCatalog {
  countries: readonly string[];
  cities: readonly string[];
  universityTypes: readonly string[];
  levels: readonly string[];
  languages: readonly string[];
  // Every active university — admins can paste the right numeric id
  // into presetFilters.universityId. Not capped: the dedicated
  // "Universities" sheet is the source of truth for IDs.
  universities: ReadonlyArray<{ id: number; name: string; country: string | null; city: string | null; type: string | null }>;
}

export function embedWidgetColumns(
  validModes: readonly string[],
  catalog?: EmbedFilterCatalog,
): readonly ColumnSpec[] {
  const keysList = EMBED_FILTER_KEYS.join(", ");
  const presetNote = catalog
    ? `Object of default filter values applied on load. Valid keys: ${keysList}. ` +
      `See the "Filter reference" sheet for sample values from your live data.`
    : `Object of default filter values applied on load. Valid keys: ${keysList}.`;
  const arrayNote = `Array of filter keys. Allowed: ${keysList}.`;
  return [
    { key: "name", header: "Name", kind: "string", required: true, width: 28 },
    { key: "slug", header: "Slug", kind: "string", required: true, width: 28,
      note: "Lowercase letters, digits, and dashes. Used as the cross-installation identity." },
    { key: "mode", header: "Mode", kind: "enum", required: true, options: validModes, width: 22 },
    { key: "isActive", header: "Active", kind: "boolean", required: true, width: 10 },
    { key: "theme", header: "Theme (JSON)", kind: "json", width: 40,
      note: 'Object, e.g. {"primary":"#0ea5e9","radius":"8px"}' },
    { key: "presetFilters", header: "Preset filters (JSON)", kind: "json", width: 36,
      note: presetNote },
    { key: "lockedFilters", header: "Locked filters (JSON)", kind: "json", width: 28,
      note: arrayNote + ' Example: ["country","level"]' },
    { key: "hiddenFilters", header: "Hidden filters (JSON)", kind: "json", width: 28,
      note: arrayNote },
    { key: "visibleFilters", header: "Visible filters (JSON)", kind: "json", width: 28,
      note: arrayNote },
    { key: "allowedDomains", header: "Allowed domains (JSON)", kind: "json", width: 36,
      note: 'Array of hostnames permitted to embed, e.g. ["example.com"]' },
    { key: "aiConnectionKey", header: "AI connection key", kind: "string", width: 24,
      note: "Secret-free integrations.key reference. Defaults to claude." },
    { key: "aiExtractorId", header: "AI extractor ID", kind: "number", width: 18,
      note: "Optional active embed-scope extractor ID. Leave blank for the default." },
  ];
}

// --- Embed filter reference (read-only docs sheets) ----------------------
// One sheet per filter dimension so admins can see EVERY valid value in
// full, not just a sample. Sheets are read-only documentation — the
// parser ignores them on import.

const SUMMARY_COLUMNS: readonly ColumnSpec[] = [
  { key: "filterKey", header: "Filter key", kind: "string", width: 20 },
  { key: "valueType", header: "Value type", kind: "string", width: 14 },
  { key: "count", header: "Total options", kind: "number", width: 14 },
  { key: "lookupSheet", header: "See sheet", kind: "string", width: 26 },
  { key: "exampleUsage", header: "Example preset JSON", kind: "string", width: 44 },
  { key: "description", header: "Description", kind: "string", width: 60 },
];

const SIMPLE_VALUE_COLUMNS: readonly ColumnSpec[] = [
  { key: "value", header: "Value (paste this into JSON cells)", kind: "string", width: 50 },
];

const UNIVERSITY_REF_COLUMNS: readonly ColumnSpec[] = [
  { key: "id", header: "ID (universityId)", kind: "number", width: 18 },
  { key: "name", header: "University name", kind: "string", width: 50 },
  { key: "country", header: "Country", kind: "string", width: 22 },
  { key: "city", header: "City", kind: "string", width: 22 },
  { key: "type", header: "Type", kind: "string", width: 18 },
];

const EMPTY_PLACEHOLDER = "(no values yet — add some in the admin UI)";

function listRows(values: readonly string[]): Array<Record<string, unknown>> {
  if (values.length === 0) return [{ value: EMPTY_PLACEHOLDER }];
  return values.map((v) => ({ value: v }));
}

/**
 * Build the full set of reference sheets for the template/export:
 *   1. "Filter reference"  — summary index with counts + example JSON
 *   2. "Countries"         — every distinct active country
 *   3. "Cities"            — every distinct active city
 *   4. "University types"  — every distinct universityType
 *   5. "Levels"            — every distinct program degree
 *   6. "Languages"         — every distinct program language
 *   7. "Universities"      — every active university (id, name, country, city, type)
 *
 * Every list reflects the live DB on the moment of download, so adding a
 * new university / language / level shows up on the next template.
 */
export function buildEmbedFilterReferenceSheets(
  catalog: EmbedFilterCatalog,
): Array<SheetSpec<Record<string, unknown>>> {
  const summary: SheetSpec<Record<string, unknown>> = {
    name: "Filter reference",
    columns: SUMMARY_COLUMNS,
    rows: [
      {
        filterKey: "country", valueType: "string",
        count: catalog.countries.length, lookupSheet: "Countries",
        exampleUsage: '{"country":"Turkey"}',
        description: "Country name as stored on the university record.",
      },
      {
        filterKey: "city", valueType: "string",
        count: catalog.cities.length, lookupSheet: "Cities",
        exampleUsage: '{"city":"Istanbul"}',
        description: "City name as stored on the university record.",
      },
      {
        filterKey: "universityType", valueType: "string",
        count: catalog.universityTypes.length, lookupSheet: "University types",
        exampleUsage: '{"universityType":"Private"}',
        description: "Distinct universityType values across active universities.",
      },
      {
        filterKey: "universityId", valueType: "number",
        count: catalog.universities.length, lookupSheet: "Universities",
        exampleUsage: '{"universityId":1}',
        description: "Pick the numeric ID from the Universities sheet.",
      },
      {
        filterKey: "level", valueType: "string",
        count: catalog.levels.length, lookupSheet: "Levels",
        exampleUsage: '{"level":"Master"}',
        description: "Distinct program degree values (Bachelor, Master, PhD, …).",
      },
      {
        filterKey: "language", valueType: "string",
        count: catalog.languages.length, lookupSheet: "Languages",
        exampleUsage: '{"language":"English"}',
        description: "Distinct program language values.",
      },
    ],
  };

  const universityRows: Array<Record<string, unknown>> = catalog.universities.length
    ? catalog.universities.map((u) => ({
        id: u.id, name: u.name,
        country: u.country ?? "", city: u.city ?? "", type: u.type ?? "",
      }))
    : [{ id: null, name: EMPTY_PLACEHOLDER, country: "", city: "", type: "" }];

  return [
    summary,
    { name: "Countries", columns: SIMPLE_VALUE_COLUMNS, rows: listRows(catalog.countries) },
    { name: "Cities", columns: SIMPLE_VALUE_COLUMNS, rows: listRows(catalog.cities) },
    { name: "University types", columns: SIMPLE_VALUE_COLUMNS, rows: listRows(catalog.universityTypes) },
    { name: "Levels", columns: SIMPLE_VALUE_COLUMNS, rows: listRows(catalog.levels) },
    { name: "Languages", columns: SIMPLE_VALUE_COLUMNS, rows: listRows(catalog.languages) },
    { name: "Universities", columns: UNIVERSITY_REF_COLUMNS, rows: universityRows },
  ];
}

/**
 * @deprecated Use `buildEmbedFilterReferenceSheets` to ship the full
 * multi-sheet reference. Kept as a back-compat shim so callers that
 * only want the summary index still work.
 */
export function buildEmbedFilterReferenceSheet(
  catalog: EmbedFilterCatalog,
): SheetSpec<Record<string, unknown>> {
  return buildEmbedFilterReferenceSheets(catalog)[0];
}

// --- Web-to-Lead forms schema --------------------------------------------

export const FORMS_KIND = "website_forms";

export const VALID_FIELD_TYPES = [
  "text", "email", "phone", "textarea", "select",
  "checkbox", "number", "date", "url",
] as const;

export const VALID_SUBMIT_ACTIONS = ["email", "webhook", "crm"] as const;

export function formColumns(
  pipelineStages: readonly string[],
  commonSources: readonly string[],
): readonly ColumnSpec[] {
  return [
    { key: "name", header: "Name", kind: "string", required: true, width: 28 },
    { key: "slug", header: "Slug", kind: "string", required: true, width: 28,
      note: "Lowercase letters, digits, and dashes. Used to link to the Fields sheet." },
    { key: "description", header: "Description", kind: "string", width: 36 },
    { key: "submitAction", header: "Submit action", kind: "enum", required: true,
      options: VALID_SUBMIT_ACTIONS, width: 16 },
    { key: "submitEmail", header: "Submit email", kind: "string", width: 28 },
    { key: "submitWebhookUrl", header: "Submit webhook URL", kind: "string", width: 32 },
    { key: "successMessage", header: "Success message", kind: "string", width: 32 },
    { key: "errorMessage", header: "Error message", kind: "string", width: 32 },
    { key: "crmSource", header: "CRM source", kind: "enum",
      options: commonSources, width: 22,
      note: "Pick from the current lead-source list or type a custom value." },
    { key: "crmPipelineStage", header: "CRM pipeline stage", kind: "enum",
      options: pipelineStages, width: 26,
      note: "Pick one of the configured lead pipeline stage keys." },
    { key: "pageSourceTag", header: "Page source tag", kind: "string", width: 22 },
    { key: "isActive", header: "Active", kind: "boolean", required: true, width: 10 },
  ];
}

// Catalog of currently-valid values surfaced as a multi-sheet
// reference inside the forms template/export, mirroring the embed
// catalog approach. Lists are read-only documentation — the parser
// ignores them on re-import.
export interface FormsCatalog {
  pipelineStages: readonly string[];
  crmSources: readonly string[];
  pageTags: readonly string[];
}

export function buildFormsReferenceSheets(
  catalog: FormsCatalog,
): Array<SheetSpec<Record<string, unknown>>> {
  const summary: SheetSpec<Record<string, unknown>> = {
    name: "Form reference",
    columns: [
      { key: "column", header: "Forms sheet column", kind: "string", width: 26 },
      { key: "valueType", header: "Value type", kind: "string", width: 14 },
      { key: "count", header: "Total options", kind: "number", width: 14 },
      { key: "lookupSheet", header: "See sheet", kind: "string", width: 22 },
      { key: "description", header: "Description", kind: "string", width: 60 },
    ],
    rows: [
      { column: "submitAction", valueType: "enum",
        count: VALID_SUBMIT_ACTIONS.length, lookupSheet: "Submit actions",
        description: "How a submission is delivered. One of: email, webhook, crm." },
      { column: "crmSource", valueType: "string",
        count: catalog.crmSources.length, lookupSheet: "CRM sources",
        description: "Free-form text. Pick from existing values or type a new one." },
      { column: "crmPipelineStage", valueType: "string",
        count: catalog.pipelineStages.length, lookupSheet: "Pipeline stages",
        description: "Must match a configured lead pipeline stage key." },
      { column: "pageSourceTag", valueType: "string",
        count: catalog.pageTags.length, lookupSheet: "Page tags",
        description: "Slug of the website page the form lives on (optional but recommended for analytics)." },
      { column: "Fields.fieldType", valueType: "enum",
        count: VALID_FIELD_TYPES.length, lookupSheet: "Field types",
        description: "Allowed field types on the Fields sheet." },
    ],
  };

  const simple = (name: string, values: readonly string[]): SheetSpec<Record<string, unknown>> => ({
    name,
    columns: [{ key: "value", header: "Value (paste this into the matching cell)", kind: "string", width: 50 }],
    rows: values.length
      ? values.map((v) => ({ value: v }))
      : [{ value: "(no values yet — add some in the admin UI)" }],
  });

  return [
    summary,
    simple("Submit actions", VALID_SUBMIT_ACTIONS),
    simple("CRM sources", catalog.crmSources),
    simple("Pipeline stages", catalog.pipelineStages),
    simple("Page tags", catalog.pageTags),
    simple("Field types", VALID_FIELD_TYPES),
  ];
}

export function formFieldColumns(): readonly ColumnSpec[] {
  return [
    { key: "form_slug", header: "Form slug", kind: "string", required: true, width: 28,
      note: "Must match a Slug in the Forms sheet." },
    { key: "fieldType", header: "Field type", kind: "enum", required: true,
      options: VALID_FIELD_TYPES, width: 14 },
    { key: "label", header: "Label", kind: "string", required: true, width: 24 },
    { key: "name", header: "Name", kind: "string", required: true, width: 22,
      note: "Internal field name used as the form key." },
    { key: "placeholder", header: "Placeholder", kind: "string", width: 24 },
    { key: "isRequired", header: "Required", kind: "boolean", required: true, width: 10 },
    { key: "sortOrder", header: "Sort order", kind: "number", width: 12 },
    { key: "validationRules", header: "Validation rules (JSON)", kind: "json", width: 30,
      note: 'Object, e.g. {"minLength":2,"maxLength":80}' },
    { key: "options", header: "Options (JSON)", kind: "json", width: 30,
      note: 'For select/checkbox fields. Array of {"label":"…","value":"…"}.' },
  ];
}

// --- Lossless coercion (cell -> DB row) -----------------------------------

// --- Agents schema --------------------------------------------------------

export const AGENTS_KIND = "agents";

export const AGENT_STATUSES = ["active", "inactive"] as const;
export const AGENT_ENTITY_TYPES = ["company", "individual"] as const;

// Catalog of currently-valid references sampled from the live DB so admins
// don't have to guess numeric IDs (parent agent, contract template) or the
// allowed contract languages when filling in the template.
export interface AgentCatalog {
  languages: readonly string[];
  contractTemplates: ReadonlyArray<{ id: number; name: string; language: string | null; entityType: string | null }>;
  parentAgents: ReadonlyArray<{ id: number; name: string; company: string | null }>;
}

export function agentColumns(catalog?: AgentCatalog): readonly ColumnSpec[] {
  const langOptions = catalog && catalog.languages.length > 0 ? catalog.languages : undefined;
  return [
    { key: "firstName", header: "First name", kind: "string", required: true, width: 20 },
    { key: "lastName", header: "Last name", kind: "string", required: true, width: 20 },
    { key: "email", header: "Email", kind: "string", width: 28,
      note: "Used to match existing agents on import (case-insensitive)." },
    { key: "phone", header: "Phone", kind: "string", width: 18 },
    { key: "status", header: "Status", kind: "enum", options: AGENT_STATUSES, width: 12,
      note: "Blank defaults to active." },
    { key: "entityType", header: "Entity type", kind: "enum", options: AGENT_ENTITY_TYPES, width: 14,
      note: "Blank defaults to company." },
    { key: "companyName", header: "Company name", kind: "string", width: 26 },
    { key: "businessName", header: "Business name", kind: "string", width: 26 },
    { key: "agencyCode", header: "Agency code", kind: "string", width: 16 },
    { key: "category", header: "Category", kind: "string", width: 16 },
    { key: "country", header: "Country", kind: "string", width: 18 },
    { key: "state", header: "State", kind: "string", width: 16 },
    { key: "city", header: "City", kind: "string", width: 16 },
    { key: "address", header: "Address", kind: "string", width: 30 },
    { key: "taxNumber", header: "Tax number", kind: "string", width: 18 },
    { key: "preferredContractLanguage", header: "Contract language",
      kind: langOptions ? "enum" : "string", options: langOptions, width: 16,
      note: "Two-letter code, e.g. en, tr, fr. Blank defaults to en." },
    { key: "commissionRate", header: "Commission rate (%)", kind: "number", width: 18 },
    { key: "subAgentCommissionRate", header: "Sub-agent commission rate (%)", kind: "number", width: 26 },
    { key: "hideServiceFees", header: "Hide service fees", kind: "boolean", width: 16,
      note: "Blank defaults to FALSE." },
    { key: "canManageStaff", header: "Can manage staff", kind: "boolean", width: 16,
      note: "Blank defaults to TRUE." },
    { key: "branch", header: "Branch", kind: "string", width: 18 },
    { key: "notes", header: "Notes", kind: "string", width: 36 },
    { key: "contractStartDate", header: "Contract start date", kind: "string", width: 18,
      note: "Format YYYY-MM-DD." },
    { key: "contractEndDate", header: "Contract end date", kind: "string", width: 18,
      note: "Format YYYY-MM-DD." },
    { key: "parentAgentId", header: "Parent agent ID", kind: "number", width: 16,
      note: "Optional. Set to make this a sub-agent. See the 'Parent agents' sheet for IDs." },
    { key: "assignedContractTemplateId", header: "Contract template ID", kind: "number", width: 20,
      note: "Optional. See the 'Contract templates' sheet for IDs." },
  ];
}

function toIsoDate(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// Map a DB agent row to the flat export shape (one key per column).
export function agentExportRows(
  rows: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return rows.map((r) => ({
    firstName: r.firstName,
    lastName: r.lastName,
    email: r.email,
    phone: r.phone,
    status: r.status,
    entityType: r.entityType,
    companyName: r.companyName,
    businessName: r.businessName,
    agencyCode: r.agencyCode,
    category: r.category,
    country: r.country,
    state: r.state,
    city: r.city,
    address: r.address,
    taxNumber: r.taxNumber,
    preferredContractLanguage: r.preferredContractLanguage,
    commissionRate: r.commissionRate,
    subAgentCommissionRate: r.subAgentCommissionRate,
    hideServiceFees: r.hideServiceFees,
    canManageStaff: r.canManageStaff,
    branch: r.branch,
    notes: r.notes,
    contractStartDate: toIsoDate(r.contractStartDate),
    contractEndDate: toIsoDate(r.contractEndDate),
    parentAgentId: r.parentAgentId,
    assignedContractTemplateId: r.assignedContractTemplateId,
  }));
}

// Read-only reference sheets bundled into the agents template/export so
// admins can look up valid IDs and language codes. The parser ignores
// these on re-import.
export function buildAgentReferenceSheets(
  catalog: AgentCatalog,
): Array<SheetSpec<Record<string, unknown>>> {
  const simple = (name: string, header: string, values: readonly string[]): SheetSpec<Record<string, unknown>> => ({
    name,
    columns: [{ key: "value", header, kind: "string", width: 40 }],
    rows: values.length ? values.map((v) => ({ value: v })) : [{ value: "(no values yet)" }],
  });

  const templateRows: Array<Record<string, unknown>> = catalog.contractTemplates.length
    ? catalog.contractTemplates.map((t) => ({
        id: t.id, name: t.name, language: t.language ?? "", entityType: t.entityType ?? "",
      }))
    : [{ id: null, name: "(no templates yet)", language: "", entityType: "" }];

  const parentRows: Array<Record<string, unknown>> = catalog.parentAgents.length
    ? catalog.parentAgents.map((p) => ({ id: p.id, name: p.name, company: p.company ?? "" }))
    : [{ id: null, name: "(no parent agents yet)", company: "" }];

  return [
    simple("Statuses", "Status (paste into the Status cell)", AGENT_STATUSES),
    simple("Entity types", "Entity type (paste into the Entity type cell)", AGENT_ENTITY_TYPES),
    simple("Languages", "Contract language code", catalog.languages),
    {
      name: "Contract templates",
      columns: [
        { key: "id", header: "ID (Contract template ID)", kind: "number", width: 22 },
        { key: "name", header: "Template name", kind: "string", width: 40 },
        { key: "language", header: "Language", kind: "string", width: 14 },
        { key: "entityType", header: "Entity type", kind: "string", width: 16 },
      ],
      rows: templateRows,
    },
    {
      name: "Parent agents",
      columns: [
        { key: "id", header: "ID (Parent agent ID)", kind: "number", width: 20 },
        { key: "name", header: "Agent name", kind: "string", width: 30 },
        { key: "company", header: "Company", kind: "string", width: 30 },
      ],
      rows: parentRows,
    },
  ];
}

// Coerce one parsed Excel row into agent insert values. Throws
// ImportValidationError on invalid enum / number values. Does not set
// userId, phoneE164, or embedToken — the route adds those.
export function toAgentInsertValues(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const str = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };
  const num = (v: unknown, label: string): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n)) throw new ImportValidationError(`Invalid number for ${label}: "${String(v)}"`);
    return n;
  };
  const intId = (v: unknown, label: string): number | null => {
    const n = num(v, label);
    if (n === null) return null;
    if (!Number.isInteger(n) || n <= 0) throw new ImportValidationError(`Invalid ID for ${label}: "${String(v)}"`);
    return n;
  };
  const date = (v: unknown): Date | null => {
    if (v === null || v === undefined || v === "") return null;
    const d = v instanceof Date ? v : new Date(String(v));
    if (isNaN(d.getTime())) throw new ImportValidationError(`Invalid date: "${String(v)}"`);
    return d;
  };

  const firstName = str(row.firstName);
  const lastName = str(row.lastName);
  if (!firstName) throw new ImportValidationError("First name is required");
  if (!lastName) throw new ImportValidationError("Last name is required");

  const statusRaw = str(row.status);
  if (statusRaw && !(AGENT_STATUSES as readonly string[]).includes(statusRaw)) {
    throw new ImportValidationError(`Invalid status "${statusRaw}". Allowed: ${AGENT_STATUSES.join(", ")}.`);
  }
  const entityRaw = str(row.entityType);
  if (entityRaw && !(AGENT_ENTITY_TYPES as readonly string[]).includes(entityRaw)) {
    throw new ImportValidationError(`Invalid entity type "${entityRaw}". Allowed: ${AGENT_ENTITY_TYPES.join(", ")}.`);
  }

  return {
    firstName,
    lastName,
    email: str(row.email),
    phone: str(row.phone),
    status: statusRaw ?? "active",
    entityType: entityRaw ?? "company",
    companyName: str(row.companyName),
    businessName: str(row.businessName),
    agencyCode: str(row.agencyCode),
    category: str(row.category),
    country: str(row.country),
    state: str(row.state),
    city: str(row.city),
    address: str(row.address),
    taxNumber: str(row.taxNumber),
    preferredContractLanguage: str(row.preferredContractLanguage) ?? "en",
    commissionRate: num(row.commissionRate, "commission rate"),
    subAgentCommissionRate: num(row.subAgentCommissionRate, "sub-agent commission rate"),
    hideServiceFees: row.hideServiceFees === true,
    canManageStaff: row.canManageStaff === false ? false : true,
    branch: str(row.branch),
    notes: str(row.notes),
    contractStartDate: date(row.contractStartDate),
    contractEndDate: date(row.contractEndDate),
    parentAgentId: intId(row.parentAgentId, "parent agent ID"),
    assignedContractTemplateId: intId(row.assignedContractTemplateId, "contract template ID"),
  };
}

export function toEmbedInsertValues(
  row: Record<string, unknown>,
  validModes: readonly string[],
): Record<string, unknown> {
  // Reject invalid modes loudly rather than silently coercing — admins
  // would otherwise discover the wrong mode only after publishing.
  if (typeof row.mode !== "string" || !validModes.includes(row.mode)) {
    throw new ImportValidationError(
      `Invalid mode "${String(row.mode ?? "")}". Allowed: ${validModes.join(", ")}.`,
    );
  }
  const mode = row.mode;
  return {
    name: row.name,
    slug: row.slug,
    mode,
    presetFilters: (row.presetFilters as Record<string, unknown>) ?? {},
    lockedFilters: (row.lockedFilters as unknown[]) ?? [],
    hiddenFilters: (row.hiddenFilters as unknown[]) ?? [],
    visibleFilters: (row.visibleFilters as unknown[]) ?? [],
    theme: (row.theme as Record<string, unknown>) ?? {},
    allowedDomains: (row.allowedDomains as unknown[]) ?? [],
    aiConnectionKey:
      typeof row.aiConnectionKey === "string" && row.aiConnectionKey.trim()
        ? row.aiConnectionKey.trim().toLowerCase()
        : "claude",
    aiExtractorId: (() => {
      if (row.aiExtractorId === null || row.aiExtractorId === undefined || row.aiExtractorId === "") return null;
      const value = Number(row.aiExtractorId);
      if (!Number.isInteger(value) || value <= 0) {
        throw new ImportValidationError("AI extractor ID must be a positive integer.");
      }
      return value;
    })(),
    // Blank cells default to `true` so admins can leave the column empty
    // when creating widgets from the template; explicit FALSE still wins.
    isActive: row.isActive === false ? false : true,
  };
}

// --- Portal program mapping schema ---------------------------------------
//
// Bulk CRM-program → portal-option mapping. The template ships one row per CRM
// program (id + name + the current override, if any) and an EMPTY portal_value
// column for the admin to fill. On import only non-empty portal_value rows are
// upserted into portal_program_mapping.program_overrides.

export const PROGRAM_MAPPING_KIND = "portal_program_mapping";

export const PROGRAM_MAPPING_SHEET = "ProgramMapping";

export const programMappingColumns: readonly ColumnSpec[] = [
  {
    key: "crm_program_id",
    header: "crm_program_id",
    kind: "string",
    required: true,
    width: 16,
    note: "CRM program ID — eşleme anahtarı. DEĞİŞTİRMEYİN.",
  },
  {
    key: "crm_program_name",
    header: "crm_program_name",
    kind: "string",
    width: 40,
    note: "Bilgi amaçlı. İçe aktarımda yok sayılır.",
  },
  {
    key: "current_portal_value",
    header: "current_portal_value",
    kind: "string",
    width: 28,
    note: "Mevcut override. Bilgi amaçlı. İçe aktarımda yok sayılır.",
  },
  {
    key: "portal_value",
    header: "portal_value",
    kind: "string",
    width: 28,
    note: "Portal opsiyon değeri (v) ya da etiketi (t). Boş bırakılırsa satır atlanır.",
  },
  {
    key: "portal_option_hint",
    header: "portal_option_hint",
    kind: "string",
    width: 44,
    note: "Canlı portal opsiyon ipucu. Bilgi amaçlı.",
  },
];
