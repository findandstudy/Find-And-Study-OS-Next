// ---------------------------------------------------------------------------
// Multico CRM adapter
//
// Portal: https://www.multico.com.tr/crm/
//
// Multico is the EXCLUSIVE submission channel for Topkapı University for
// students whose nationality is one of the 7 Central Asian nationalities
// (Azerbaijan, Kazakhstan, Uzbekistan, Kyrgyzstan, Tajikistan, Turkmenistan,
// Mongolia). Direct Topkapı submissions are blocked for this segment via
// portal_university_exclusions; the enqueueIfEligible hook re-routes them here.
//
// ARCHITECTURE (HTTP-first, Playwright only for session):
//   1. login()  — launch a minimal headless browser, POST to /crm/login via
//                 Playwright form fill to acquire session cookies.
//   2. submit() — all CRM reads/writes via page.request (Playwright's
//                 APIRequestContext sharing the browser cookie jar).
//
// FLOW (submit):
//   a) Passport search   → duplicate check (reuse existing student ID)
//   b) Program catalog   → fetch + cache; match via shared matchProgram +
//                          local fuzzy fallback; fail fast on no-match
//   c) Student create    → multipart POST (skipped in dry-run + on duplicate)
//   d) Document upload   → multipart per-document (skipped in dry-run)
//   e) Application create→ POST; parse result row from student edit page
//   f) Return SubmitResult with externalRef, result_json fields
//
// DRY-RUN (doSubmit=false):
//   Performs login + passport search + catalog fetch + program match.
//   Skips student create, doc upload, application create.
//   Returns: { submitted:false, dryRun:true, wouldCreateStudent, alreadyExists,
//              matchedProgram?, alternatives? }
//
// PERIODIC STATUS POLL:
//   pollStatus(page, studentId, applicationId) → fetch student edit page and
//   parse the Candidate Applications table for the stored application row.
// ---------------------------------------------------------------------------

import type {
  UniversityAdapter,
  AdapterSession,
  SubmitProfile,
  SubmitFiles,
  SubmitResult,
  LoginOpts,
} from "../../types.js";
import { launchPortal, saveState, logger } from "../../browser.js";
import { portalCreds } from "../../portalCreds.js";
import { fold, matchProgram } from "../../programMatch.js";
import type { ProgramCandidate } from "../../programMatch.js";
import { db, portalProgramCacheTable, type PortalProgramOption } from "@workspace/db";
import { and, eq, gt } from "drizzle-orm";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ADAPTER_KEY   = "multico";
const MULTICO_BASE  = "https://www.multico.com.tr/crm";
const LOGIN_URL     = `${MULTICO_BASE}/login`;
const STORAGE_PATH  = "/tmp/multico-portal-state.json";
export const MULTICO_STUDENT_FORM_PATH = "/students/add";

/** Cache TTL for program catalog (8 hours). */
const PROGRAM_CACHE_TTL_MS = 8 * 60 * 60 * 1000;

/**
 * Keep Multico's student-create and document PATCH payloads below a
 * conservative boundary. The live CRM may answer an oversized multipart POST
 * with the add form again (HTTP 200) instead of an explicit 413, which makes a
 * transport-size failure look like a validation failure.
 */
export const MULTICO_MULTIPART_SAFE_BYTES = 12 * 1024 * 1024;

export function isMulticoMultipartWithinSafeBudget(
  sizes: readonly number[],
): boolean {
  return sizes.every((size) => Number.isFinite(size) && size >= 0) &&
    sizes.reduce((sum, size) => sum + size, 0) <=
      MULTICO_MULTIPART_SAFE_BYTES;
}

type MulticoUploadFile = {
  fieldName: string;
  filePath: string;
  name: string;
  mimeType: string;
  buffer: Buffer;
};

function runGhostscriptPdfOptimization(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "gs",
      [
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.4",
        "-dPDFSETTINGS=/ebook",
        "-dDetectDuplicateImages=true",
        "-dCompressFonts=true",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dSAFER",
        `-sOutputFile=${outputPath}`,
        inputPath,
      ],
      { timeout: 60_000, maxBuffer: 256 * 1024 },
      (error) => {
        if (error) reject(error);
        else resolve();
      },
    );
  });
}

async function optimizeMulticoMultipartFiles(
  files: MulticoUploadFile[],
): Promise<MulticoUploadFile[]> {
  if (
    isMulticoMultipartWithinSafeBudget(
      files.map((file) => file.buffer.length),
    )
  ) {
    return files;
  }

  const originalBytes = files.reduce(
    (sum, file) => sum + file.buffer.length,
    0,
  );
  const optimizedByDigest = new Map<string, Buffer | null>();
  const optimized: MulticoUploadFile[] = [];

  for (const file of files) {
    if (
      file.mimeType !== "application/pdf" ||
      !file.buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))
    ) {
      optimized.push(file);
      continue;
    }

    const digest = createHash("sha256").update(file.buffer).digest("hex");
    let candidate = optimizedByDigest.get(digest);
    if (candidate === undefined) {
      const outputPath = path.join(
        path.dirname(file.filePath),
        `.multico-${file.fieldName}-${process.pid}.pdf`,
      );
      try {
        await runGhostscriptPdfOptimization(file.filePath, outputPath);
        const output = await fs.readFile(outputPath);
        candidate =
          output.subarray(0, 5).equals(Buffer.from("%PDF-")) &&
          output.length < file.buffer.length
            ? output
            : null;
        optimizedByDigest.set(digest, candidate);
      } catch (error) {
        throw new Error(
          "Multico PDF optimization failed for oversized documents: " +
            (error instanceof Error ? error.message : String(error)),
        );
      } finally {
        await fs.rm(outputPath, { force: true }).catch(() => {});
      }
    }
    optimized.push(
      candidate
        ? {
            ...file,
            name: file.name.replace(/\.pdf$/i, "-optimized.pdf"),
            buffer: candidate,
          }
        : file,
    );
  }

  const optimizedBytes = optimized.reduce(
    (sum, file) => sum + file.buffer.length,
    0,
  );
  logger.info(
    `[multico] multipart optimized: ` +
      `${Math.ceil(originalBytes / 1024)}KB → ` +
      `${Math.ceil(optimizedBytes / 1024)}KB`,
  );
  if (
    !isMulticoMultipartWithinSafeBudget(
      optimized.map((file) => file.buffer.length),
    )
  ) {
    throw new Error(
      `Multico required documents exceed the safe upload budget after ` +
        `loss-controlled PDF optimization ` +
        `(${Math.ceil(optimizedBytes / 1024)}KB > ` +
        `${Math.ceil(MULTICO_MULTIPART_SAFE_BYTES / 1024)}KB)`,
    );
  }
  return optimized;
}

// ---------------------------------------------------------------------------
// Central Asian nationality list — exported for the enqueue hook and tests
// ---------------------------------------------------------------------------

/**
 * Country names (lowercase) for the 7 Central Asian nationalities exclusively
 * served by Multico for Topkapı University. Checked case-insensitively against
 * the student.nationality field (may store country names OR nationality
 * adjectives, e.g. "Uzbekistan" or "Uzbek" or "Uzbekistani").
 *
 * Exported so that:
 *   - `isMulticoNationality()` can be imported by the enqueue hook without
 *     duplicating the list
 *   - Tests can verify edge-case nationality strings against the canonical list
 */
export const MULTICO_NATIONALITIES = [
  "azerbaijan",
  "kazakhstan",
  "uzbekistan",
  "kyrgyzstan",
  "tajikistan",
  "turkmenistan",
  "mongolia",
] as const;

export type MulticoNationality = (typeof MULTICO_NATIONALITIES)[number];

/**
 * Accepted country and demonym spellings after `fold()` normalization.
 * CRM records are not language-normalized, so both English and Turkish values
 * occur. Exact matching prevents short substrings routing unrelated countries.
 */
const MULTICO_NATIONALITY_ALIASES = new Set([
  "azerbaijan", "azerbaijani", "azeri", "azerbaycan", "azerbaycanli",
  "kazakhstan", "kazakh", "kazakhstani", "kazakistan", "kazak",
  "uzbekistan", "uzbek", "uzbekistani", "ozbekistan", "ozbek",
  "kyrgyzstan", "kyrgyz", "kyrgyzstani", "kirgizistan", "kirgiz",
  "tajikistan", "tajik", "tajikistani", "tacikistan", "tacik",
  "turkmenistan", "turkmen", "turkmenistani",
  "mongolia", "mongolian", "mongol", "mogolistan", "mogol",
]);

/**
 * Returns true when the given student.nationality value belongs to one of the
 * 7 Central Asian nationalities handled exclusively by Multico.
 * Matching is diacritic/case-insensitive but exact after normalization.
 */
export function isMulticoNationality(
  nationality: string | null | undefined,
): boolean {
  if (!nationality) return false;
  return MULTICO_NATIONALITY_ALIASES.has(fold(nationality));
}

/** Stable routing predicate: portal row keys may change; adapter keys do not. */
export function shouldRouteTopkapiToMultico(
  adapterKey: string | null | undefined,
  nationality: string | null | undefined,
): boolean {
  return adapterKey === "topkapi" && isMulticoNationality(nationality);
}

// ---------------------------------------------------------------------------
// Program-type mapping (application level → Multico program_type field value)
// ---------------------------------------------------------------------------

const PROGRAM_TYPE_MAP: Record<string, string> = {
  bachelor:               "Bachelor",
  associate:              "Associate",
  master:                 "Master Thesis",
  "masters (thesis)":     "Master Thesis",
  "masters thesis":       "Master Thesis",
  "master thesis":        "Master Thesis",
  "masters (non-thesis)": "Master Non-Thesis",
  "masters non-thesis":   "Master Non-Thesis",
  "master non-thesis":    "Master Non-Thesis",
  nonthesis:              "Master Non-Thesis",
  doctorate:              "Doctorate",
  doctoral:               "Doctorate",
  phd:                    "Doctorate",
  language:               "Language School",
  "language school":      "Language School",
};

export function mapProgramType(level: string): string | null {
  const f = fold(level);
  // Specific thesis variants must win before the generic "master" key.
  if (/(?:non thesis|nonthesis)/.test(f)) return "Master Non-Thesis";
  if (/(?:master|masters).*(?:thesis)/.test(f)) return "Master Thesis";
  for (const [key, value] of Object.entries(PROGRAM_TYPE_MAP)) {
    if (f.includes(fold(key))) return value;
  }
  return null;
}

const MULTICO_GPA_SYSTEMS = new Set([
  "4",
  "5",
  "10",
  "20",
  "30",
  "100",
  "250",
  "500",
  "1000",
]);

/** Normalize CRM GPA-scale labels to the exact values accepted by Multico. */
export function normalizeMulticoGpaSystem(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().replace(/\.0+$/, "");
  return MULTICO_GPA_SYSTEMS.has(normalized) ? normalized : null;
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parses all `<option value="..." >text</option>` pairs from a named <select>
 * in an HTML string. Returns the raw value/text pairs; caller normalises.
 */
function parseSelectOptions(
  html: string,
  selectNameOrId: string,
): Array<{ value: string; text: string }> {
  const escaped = selectNameOrId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match the specific select block by name or id attribute.
  const selectRe = new RegExp(
    `<select[^>]+(?:name|id)=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/select>`,
    "i",
  );
  const selMatch = selectRe.exec(html);
  const inner = selMatch?.[1] ?? html;

  const results: Array<{ value: string; text: string }> = [];
  const optRe = /<option[^>]+value=["']([^"']+)["'][^>]*>([\s\S]*?)<\/option>/gi;
  let m: RegExpExecArray | null;
  while ((m = optRe.exec(inner)) !== null) {
    const text = m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    if (m[1] && text) {
      results.push({ value: m[1], text });
    }
  }
  return results;
}

/**
 * Extracts a student CRM ID from a Multico search-results HTML page.
 * Looks for href patterns like "/crm/students/1234" or "students/edit/1234".
 * Returns the first numeric ID found, or null.
 */
export function parseMulticoStudentIdFromHtml(html: string): string | null {
  const patterns = [
    /\/crm\/students\/edit\/(\d+)/i,
    /\/crm\/students\/(\d+)/i,
    /students\/detail\/(\d+)/i,
    /student_id['":\s]+(\d+)/i,
    /\bdata-id=["'](\d+)["']/i,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  return null;
}

/**
 * The application-add route silently redirects invalid student IDs back to
 * /crm/students with HTTP 200. Treat the final URL as part of the contract so
 * a redirected list page can never be mistaken for an empty program catalog.
 */
export function isExpectedMulticoApplicationFormUrl(
  url: string,
  studentId: string,
): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === "https://www.multico.com.tr" &&
      parsed.pathname.replace(/\/+$/, "") ===
        `/crm/student-applications/add/${studentId}`
    );
  } catch {
    return false;
  }
}

export function isExpectedMulticoStudentEditUrl(
  url: string,
  studentId: string,
): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.origin === new URL(MULTICO_BASE).origin &&
      parsed.pathname === `/crm/students/edit/${studentId}`
    );
  } catch {
    return false;
  }
}

export function extractMulticoResponseDiagnostics(html: string): string[] {
  const diagnostics = new Set<string>();
  for (const tag of html.match(/<(?:input|select|textarea)\b[^>]*>/gi) ?? []) {
    if (!/(?:is-invalid|has-error|\berror\b)/i.test(tag)) continue;
    const name = /\bname=["']([^"']+)["']/i.exec(tag)?.[1];
    if (name) diagnostics.add(`invalid:${name}`);
  }

  const messagePattern =
    /<(?:div|span|small|p|li)\b[^>]*class=["'][^"']*(?:alert|invalid-feedback|error|danger)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|span|small|p|li)>/gi;
  for (const match of html.matchAll(messagePattern)) {
    const text = match[1]
      .replace(/<[^>]+>/g, " ")
      .replace(/&(?:nbsp|#160);/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
      .replace(/\b\d{5,}\b/g, "[number]")
      .replace(/\s+/g, " ")
      .trim();
    if (
      text &&
      /required|invalid|error|failed|upload|file|large|exceed|school|year|passport|diploma|transcript/i.test(
        text,
      )
    ) {
      diagnostics.add(text.slice(0, 160));
    }
  }
  return [...diagnostics].slice(0, 12);
}

export function findMatchingMulticoApplication(
  html: string,
  programName: string,
): { applicationId: string; fee: string; status: string } | null {
  const wanted = fold(programName.replace(/\([^)]*\)/g, " ")).trim();
  if (!wanted) return null;
  const rows = html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
  const matches: Array<{ applicationId: string; fee: string; status: string }> = [];
  for (const row of rows) {
    const text = row
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
    const normalized = fold(text.replace(/\([^)]*\)/g, " ")).trim();
    if (
      !normalized.includes(wanted) &&
      !wanted.includes(normalized)
    ) {
      const wantedTokens = wanted.split(" ").filter((token) => token.length > 2);
      const rowTokens = new Set(
        normalized.split(" ").filter((token) => token.length > 2),
      );
      if (
        wantedTokens.length < 2 ||
        wantedTokens.filter((token) => rowTokens.has(token)).length /
          wantedTokens.length <
          0.8
      ) {
        continue;
      }
    }
    const id =
      /student-applications\/(?:edit|view)\/\d+\/(\d+)/i.exec(row)?.[1] ??
      /student-applications\/(?:edit\/|view\/)?(\d+)/i.exec(row)?.[1] ??
      /#\s*(\d+)/.exec(text)?.[1] ??
      /application[_-]?id[^0-9]*(\d+)/i.exec(row)?.[1];
    if (!id) continue;
    const status =
      /(Pending Review|Pending|Accepted|Rejected|Review|Waiting|In Progress|Completed)/i.exec(
        text,
      )?.[1] ?? "Pending Review";
    const fee =
      /([\d,.]+\s*(?:USD|EUR|TRY|₺|\$|€))/.exec(text)?.[1] ?? "";
    matches.push({ applicationId: id, fee, status });
  }
  return matches.length === 1 ? matches[0] : null;
}

async function readMulticoApplicationTable(
  page: AdapterSession["page"],
  studentId: string,
): Promise<{ tableFound: boolean; html: string; rows: Array<{ html: string; text: string }> }> {
  const response = await page.goto(
    `${MULTICO_BASE}/students/edit/${studentId}`,
    { waitUntil: "networkidle" },
  );
  // A successful application POST redirects directly to this exact page.
  // Playwright may return null when goto() is then asked to navigate to the
  // already-current URL. Accept that only when the same-origin, exact student
  // route is visible; every other null response remains fail-closed.
  if (
    (response && !response.ok()) ||
    (!response && !isExpectedMulticoStudentEditUrl(page.url(), studentId))
  ) {
    throw new Error(
      `Multico student application table returned ` +
        `${response?.status() ?? "none"}`,
    );
  }
  return page.locator("table").evaluateAll((tables) => {
    const table = tables.find((candidate) => {
      const headings = Array.from(candidate.querySelectorAll("th")).map((heading) =>
        (heading.textContent ?? "").trim().toLowerCase(),
      );
      return headings.includes("department") && headings.includes("university");
    });
    if (!table) return { tableFound: false, html: "", rows: [] };
    const rows = Array.from(table.querySelectorAll("tbody tr")).map((row) => ({
      html: row.innerHTML,
      text: (row.textContent ?? "").replace(/\s+/g, " ").trim(),
    }));
    return {
      tableFound: true,
      html: table.innerHTML,
      rows,
    };
  });
}

async function findMatchingMulticoApplicationInDom(
  page: AdapterSession["page"],
  studentId: string,
  programName: string,
): Promise<{
  tableFound: boolean;
  application: { applicationId: string; fee: string; status: string } | null;
}> {
  const table = await readMulticoApplicationTable(page, studentId);
  return {
    tableFound: table.tableFound,
    application: table.tableFound
      ? findMatchingMulticoApplication(
          `<table>${table.html}</table>`,
          programName,
        )
      : null,
  };
}

// ---------------------------------------------------------------------------
// Program catalog — fetch + cache
// ---------------------------------------------------------------------------

/**
 * Finds a valid, existing Multico student ID that can be used to open the
 * application-add form for read-only catalog discovery. New students do not
 * yet have a Multico ID, and invalid placeholder IDs redirect to /crm/students.
 */
async function resolveCatalogStudentId(
  page: AdapterSession["page"],
  existingStudentId: string | null,
): Promise<string> {
  if (existingStudentId) return existingStudentId;

  const response = await page.goto(`${MULTICO_BASE}/students`, {
    waitUntil: "domcontentloaded",
  });
  if (!response?.ok()) {
    throw new Error(
      `Multico catalog_unavailable: student list returned ` +
        `${response?.status() ?? "none"}`,
    );
  }

  const studentLinks = page.locator(
    'a[href*="/crm/students/edit/"], a[href*="students/edit/"]',
  );
  await studentLinks
    .first()
    .waitFor({ state: "attached", timeout: 10_000 })
    .catch(() => null);
  const hrefs = await studentLinks.evaluateAll((links) =>
    links
      .map((link) => link.getAttribute("href") ?? "")
      .filter(Boolean),
  );
  const studentId =
    hrefs
      .map(parseMulticoStudentIdFromHtml)
      .find((candidate): candidate is string => candidate !== null) ?? null;
  if (!studentId) {
    throw new Error(
      "Multico catalog_unavailable: no valid catalog student context",
    );
  }
  return studentId;
}

/**
 * Fetches the Topkapı-only department catalog from the live application form.
 * The form initially contains departments from every university. Selecting
 * university + program type fires a read-only AJAX request which replaces the
 * department options with the exact target subset.
 *
 * Options format: "Program Adı (Degree - DİL)" e.g. "Bilgisayar Mühendisliği (Lisans - Türkçe)"
 */
async function fetchProgramCatalogFromCrm(
  page: AdapterSession["page"],
  studentId: string,
  programType: string,
): Promise<ProgramCandidate[]> {
  const url = `${MULTICO_BASE}/student-applications/add/${studentId}`;
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  if (
    !response?.ok() ||
    !isExpectedMulticoApplicationFormUrl(page.url(), studentId)
  ) {
    throw new Error(
      `Multico catalog_unavailable: application form redirected ` +
        `(status=${response?.status() ?? "none"}, finalUrl=${page.url()})`,
    );
  }

  const universitySelect = page.locator('select[name="university_id"]');
  const programTypeSelect = page.locator('select[name="program_type"]');
  const departmentSelect = page.locator('select[name="department_id"]');

  if (
    (await universitySelect.count()) !== 1 ||
    (await programTypeSelect.count()) !== 1 ||
    (await departmentSelect.count()) !== 1
  ) {
    throw new Error(
      "Multico catalog_unavailable: application form controls missing",
    );
  }

  const universities = await universitySelect.locator("option").evaluateAll(
    (options) =>
      options.map((option) => ({
        value: option.getAttribute("value") ?? "",
        text: option.textContent?.trim() ?? "",
      })),
  );
  const topkapiOptions = universities.filter(
    (option) => option.value && fold(option.text).includes("topkapi"),
  );
  if (topkapiOptions.length !== 1) {
    throw new Error(
      `Multico catalog_unavailable: Topkapı university option is not unique ` +
        `(count=${topkapiOptions.length})`,
    );
  }

  const programTypes = await programTypeSelect.locator("option").evaluateAll(
    (options) =>
      options.map((option) => ({
        value: option.getAttribute("value") ?? "",
        text: option.textContent?.trim() ?? "",
      })),
  );
  const requestedProgramType = fold(programType);
  const programTypeOptions = programTypes.filter(
    (option) =>
      option.value && fold(option.text) === requestedProgramType,
  );
  if (programTypeOptions.length !== 1) {
    throw new Error(
      `Multico catalog_unavailable: program type option is not unique ` +
        `(type=${programType}, count=${programTypeOptions.length})`,
    );
  }

  const waitForDepartmentAjax = () =>
    page
      .waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          candidate.url().includes(
            "/crm/ajax/get-departments-by-university.php",
          ),
        { timeout: 10_000 },
      )
      .catch(() => null);

  const universityAjax = waitForDepartmentAjax();
  await universitySelect.selectOption(topkapiOptions[0].value);
  const universityResponse = await universityAjax;
  if (!universityResponse?.ok()) {
    throw new Error(
      "Multico catalog_unavailable: university department filter failed",
    );
  }

  const programTypeAjax = waitForDepartmentAjax();
  await programTypeSelect.selectOption(programTypeOptions[0].value);
  const programTypeResponse = await programTypeAjax;
  if (!programTypeResponse?.ok()) {
    throw new Error(
      "Multico catalog_unavailable: program-type department filter failed",
    );
  }

  const options = await departmentSelect.locator("option").evaluateAll(
    (elements) =>
      elements
        .map((option) => ({
          id: option.getAttribute("value") ?? "",
          name: option.textContent?.trim() ?? "",
        }))
        .filter((option) => option.id && option.name),
  );
  if (options.length === 0) {
    throw new Error(
      `Multico catalog_unavailable: filtered department list is empty ` +
        `(type=${programType})`,
    );
  }

  logger.info(
    `[multico] filtered Topkapı catalog loaded ` +
      `(type=${programType}, programs=${options.length})`,
  );
  return options;
}

/**
 * Returns cached programs from portal_program_cache if fresh (< 8h), else
 * fetches live from the CRM and writes back to cache.
 *
 * Cache key: (universityKey=ADAPTER_KEY, level=programType). The table stores
 * PortalProgramOption[] {v, t}; we convert to ProgramCandidate {id, name}
 * for the caller.
 */
async function getProgramCatalog(
  page: AdapterSession["page"],
  studentId: string,
  programType: string,
): Promise<ProgramCandidate[]> {
  const cutoff = new Date(Date.now() - PROGRAM_CACHE_TTL_MS);

  const [cached] = await db
    .select()
    .from(portalProgramCacheTable)
    .where(
      and(
        eq(portalProgramCacheTable.universityKey, ADAPTER_KEY),
        eq(portalProgramCacheTable.level, programType),
        gt(portalProgramCacheTable.fetchedAt, cutoff),
      ),
    )
    .limit(1);

  if (cached?.options && Array.isArray(cached.options) && cached.options.length > 0) {
    const opts = cached.options as PortalProgramOption[];
    return opts.map((o) => ({ id: o.v, name: o.t }));
  }

  const live = await fetchProgramCatalogFromCrm(
    page,
    studentId,
    programType,
  );
  if (live.length > 0) {
    const cacheOpts: PortalProgramOption[] = live.map((c) => ({ v: c.id, t: c.name }));
    await db
      .insert(portalProgramCacheTable)
      .values({
        universityKey: ADAPTER_KEY,
        level: programType,
        options: cacheOpts,
        fetchedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [portalProgramCacheTable.universityKey, portalProgramCacheTable.level],
        set: { options: cacheOpts, fetchedAt: new Date() },
      })
      .catch(() => {});
  }
  return live;
}

// ---------------------------------------------------------------------------
// Program matching
// ---------------------------------------------------------------------------

/**
 * Matches the CRM program name + level to a Multico department_id option.
 * Returns: { candidate, conf } on success, or null with top-3 alternatives.
 */
function matchMulticoProgram(
  profile: Pick<SubmitProfile, "programName" | "level" | "programNameMap" | "programNameMapGeneral" | "programSynonyms">,
  candidates: ProgramCandidate[],
): {
  match: ProgramCandidate | null;
  conf: number;
  alternatives: ProgramCandidate[];
} {
  if (candidates.length === 0) {
    return { match: null, conf: 0, alternatives: [] };
  }

  const result = matchProgram(
    profile.programName,
    candidates,
    {
      nameMap:        profile.programNameMap,
      nameMapGeneral: profile.programNameMapGeneral,
      synonyms:       profile.programSynonyms as readonly (readonly string[])[] | undefined,
    },
  );

  if (result) {
    return { match: result.match, conf: result.conf, alternatives: [] };
  }

  // No match — compute top-3 alternatives sorted by fold similarity
  const queryFolded = fold(profile.programName);
  const scored = candidates
    .map((c) => {
      const cf = fold(c.name);
      let score = 0;
      const qTokens = queryFolded.split(" ").filter((t) => t.length > 1);
      const cTokens = new Set(cf.split(" ").filter((t) => t.length > 1));
      for (const t of qTokens) if (cTokens.has(t)) score++;
      return { candidate: c, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((s) => s.candidate);

  return { match: null, conf: 0, alternatives: scored };
}

// ---------------------------------------------------------------------------
// Nationality → Multico nationality_id resolver
// ---------------------------------------------------------------------------

/**
 * Fetches the nationality <select> options from the student creation form and
 * returns the option value whose text matches the student's nationality.
 * Matching is fold-based (normalised) to handle Turkish diacritics.
 */
async function resolveNationalityId(
  page: AdapterSession["page"],
  nationality: string,
): Promise<string | null> {
  const resp = await page.request.get(
    `${MULTICO_BASE}${MULTICO_STUDENT_FORM_PATH}`,
  );
  const html = await resp.text();
  const opts = parseSelectOptions(html, "nationality_id");
  const natFolded = fold(nationality);
  for (const o of opts) {
    if (fold(o.text).includes(natFolded) || natFolded.includes(fold(o.text))) {
      return o.value;
    }
  }
  return null;
}

/**
 * Fetches the phone_code <select> options and finds the entry matching the
 * student's nationality/country. Returns the raw option value (Multico format:
 * "+{dialCode} - {CountryName}").
 */
async function resolvePhoneCode(
  page: AdapterSession["page"],
  nationality: string,
): Promise<string | null> {
  const resp = await page.request.get(
    `${MULTICO_BASE}${MULTICO_STUDENT_FORM_PATH}`,
  );
  const html = await resp.text();
  const opts = parseSelectOptions(html, "phone_code");
  const natFolded = fold(nationality);
  for (const o of opts) {
    if (fold(o.text).includes(natFolded) || natFolded.includes(fold(o.value ?? ""))) {
      return o.value;
    }
  }
  return null;
}

/**
 * Fetches the university_id <select> options from the application-add form and
 * returns the option value matching "Topkapi" (case-insensitive).
 */
async function resolveTopkapiUniversityId(
  page: AdapterSession["page"],
  studentId: string,
): Promise<string | null> {
  const resp = await page.request.get(`${MULTICO_BASE}/student-applications/add/${studentId}`);
  const html = await resp.text();
  const opts = parseSelectOptions(html, "university_id");
  const query = fold("topkapi");
  for (const o of opts) {
    if (fold(o.text).includes(query)) return o.value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Student search (duplicate check)
// ---------------------------------------------------------------------------

/**
 * Searches for an existing student by passport number.
 * Returns the Multico CRM student ID string if found, null otherwise.
 */
async function searchStudentByPassport(
  page: AdapterSession["page"],
  passportNumber: string,
  email: string,
): Promise<string | null> {
  const response = await page.goto(`${MULTICO_BASE}/students`, {
    waitUntil: "networkidle",
  });
  if (!response?.ok()) {
    throw new Error(
      `Multico dedup_unknown: student list returned ` +
        `${response?.status() ?? "none"}`,
    );
  }

  const searchInput = page.locator("input.inputDatatablesSearch");
  if ((await searchInput.count()) !== 1) {
    throw new Error(
      "Multico dedup_unknown: student search control is not unique",
    );
  }
  await searchInput.fill(email);
  await searchInput.press("Enter");
  await page.waitForTimeout(1_000);

  const rows = page.locator("table.data-table tbody tr");
  const noRecords = (await rows.allTextContents()).some((text) =>
    /no matching|no data/i.test(text),
  );
  if (noRecords) return null;

  const hrefs = await rows.locator("a").evaluateAll((links) =>
    links
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.includes("/crm/students/edit/")),
  );
  const uniqueHrefs = [...new Set(hrefs)];
  const verifiedIds: string[] = [];
  for (const href of uniqueHrefs) {
    const studentId = parseMulticoStudentIdFromHtml(href);
    if (!studentId) continue;
    const studentResponse = await page.request.get(href);
    if (!studentResponse.ok()) {
      throw new Error(
        `Multico dedup_unknown: student detail returned ` +
          `${studentResponse.status()}`,
      );
    }
    const studentHtml = await studentResponse.text();
    if (studentHtml.toLowerCase().includes(passportNumber.toLowerCase())) {
      verifiedIds.push(studentId);
    }
  }
  const uniqueIds = [...new Set(verifiedIds)];
  if (uniqueIds.length > 1) {
    throw new Error(
      `Multico dedup_unknown: multiple students matched verified passport ` +
        `(count=${uniqueIds.length})`,
    );
  }
  if (uniqueIds.length === 0) {
    return null;
  }
  return uniqueIds[0];
}

// ---------------------------------------------------------------------------
// Student create (multipart POST)
// ---------------------------------------------------------------------------

/** Formats ISO-8601 date "YYYY-MM-DD" to Multico dd/mm/yyyy format. */
function toMulticoDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return iso;
}

/**
 * Extracts prior school fields from the SubmitProfile (education_records first,
 * falling back to direct student fields).
 */
function extractSchoolFields(profile: SubmitProfile): {
  schoolName: string;
  gpa: string;
  gpaSystem: string;
  graduateYear: string;
} {
  // Prefer education_records (FIX-15)
  if (profile.educationRecords && profile.educationRecords.length > 0) {
    const appliedLevel = (profile.level ?? "").toLowerCase();
    // For master/phd → use bachelor record; for bachelor/associate → use high school
    const targetLevel = /master|phd|doktora|doctorate/.test(appliedLevel)
      ? "bachelor"
      : "high school";
    const rec =
      profile.educationRecords.find((r) =>
        fold(r.level ?? "").includes(fold(targetLevel)),
      ) ?? profile.educationRecords[0];

    return {
      schoolName:   rec?.schoolName ?? profile.schoolName ?? "",
      gpa:          rec?.gpa?.toString() ?? (profile.gpa != null ? String(profile.gpa) : ""),
      gpaSystem:    normalizeMulticoGpaSystem(rec?.gpaType) ?? "4",
      graduateYear: rec?.endYear?.toString() ?? (profile.graduationYear != null ? String(profile.graduationYear) : ""),
    };
  }

  return {
    schoolName:   profile.schoolName ?? "",
    gpa:          profile.gpa != null ? String(profile.gpa) : "",
    gpaSystem:    "4",
    graduateYear: profile.graduationYear != null ? String(profile.graduationYear) : "",
  };
}

/**
 * Creates a new student in the Multico CRM via multipart POST.
 * Returns the new student CRM ID (from redirect or follow-up passport search).
 * Throws on failure.
 */
async function createMulticoStudent(
  page: AdapterSession["page"],
  profile: SubmitProfile,
  files: SubmitFiles,
): Promise<{ studentId: string; uploadedSlots: string[] }> {
  const school = extractSchoolFields(profile);

  // The live form is POST /students/add and carries an agent_id hidden field.
  // Resolve it from the authenticated form instead of hardcoding or omitting it.
  const formResponse = await page.request.get(
    `${MULTICO_BASE}${MULTICO_STUDENT_FORM_PATH}`,
  );
  if (!formResponse.ok()) {
    throw new Error(
      `Multico student form unavailable (status=${formResponse.status()})`,
    );
  }
  const formHtml = await formResponse.text();
  const agentId =
    /<input[^>]+name=["']agent_id["'][^>]+value=["']([^"']+)["']/i.exec(
      formHtml,
    )?.[1] ??
    /<input[^>]+value=["']([^"']+)["'][^>]+name=["']agent_id["']/i.exec(
      formHtml,
    )?.[1];
  if (!agentId) {
    throw new Error("Multico student form contract missing agent_id");
  }

  // Resolve nationality_id and phone_code dynamically from the form
  const nationalityId = await resolveNationalityId(page, profile.nationality);
  const phoneCode = await resolvePhoneCode(page, profile.nationality);
  if (!nationalityId) {
    throw new Error(
      `Multico nationality could not be mapped exactly: ${profile.nationality}`,
    );
  }

  // Build multipart form data
  const formData: Record<string, string> = {
    agent_id:         agentId,
    name:              profile.firstName,
    surname:           profile.lastName,
    status:            "1",
    passport_number:   profile.passportNumber,
    phone:             profile.phone,
    email:             profile.email,
    mother_name:       profile.motherName || "-",
    father_name:       profile.fatherName || "-",
    dob:               toMulticoDate(profile.dateOfBirth),
    gender:            profile.gender,
    address:           profile.address,
    residence_country: nationalityId,
    hasBlueCard:       "0",
    hasMultipleNationality: "0",
    visaStatus:        "Subject To",
    schoolType:        "High School",
    school_name:       school.schoolName,
    schoolGPASystem:   school.gpaSystem,
    schoolGPA:         school.gpa,
    graduate_year:     school.graduateYear,
    student_note:      "",
    submit:            "Save",
  };

  if (nationalityId) formData["nationality_id"] = nationalityId;
  if (phoneCode)     formData["phone_code"]     = phoneCode;

  const multipartData: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = { ...formData };
  const requiredFiles = [
    ["file_passport", files.passport],
    ["file_diploma", files.diploma],
    ["file_transcript", files.transcript],
  ] as const;
  const uploadFiles: MulticoUploadFile[] = [];
  for (const [fieldName, filePath] of requiredFiles) {
    if (!filePath) {
      throw new Error(
        `Multico student form contract requires ${fieldName}`,
      );
    }
    const buffer = await fs.readFile(filePath);
    uploadFiles.push({
      fieldName,
      filePath,
      name: path.basename(filePath),
      mimeType: filePath.toLowerCase().endsWith(".pdf")
        ? "application/pdf"
        : "application/octet-stream",
      buffer,
    });
  }
  if (files.photo) {
    const buffer = await fs.readFile(files.photo);
    uploadFiles.push({
      fieldName: "profile_photo",
      filePath: files.photo,
      name: path.basename(files.photo).replace(/\.[^.]+$/, ".jpg"),
      mimeType: "image/jpeg",
      buffer,
    });
  }
  const preparedUploads = await optimizeMulticoMultipartFiles(uploadFiles);
  const uploadedSlots: string[] = [];
  for (const upload of preparedUploads) {
    multipartData[upload.fieldName] = {
      name: upload.name,
      mimeType: upload.mimeType,
      buffer: upload.buffer,
    };
    uploadedSlots.push(upload.fieldName);
  }

  const resp = await page.request.post(
    `${MULTICO_BASE}${MULTICO_STUDENT_FORM_PATH}`,
    {
    multipart: multipartData,
    },
  );
  const html = await resp.text();

  // Check for success indicator
  const successPatterns = [
    /record has been created/i,
    /başarıyla oluşturuldu/i,
    /successfully created/i,
    /öğrenci eklendi/i,
    /student added/i,
  ];
  const isSuccess = successPatterns.some((re) => re.test(html));

  if (!resp.ok()) {
    throw new Error(
      `Multico student create failed (status=${resp.status()})`,
    );
  }

  const redirectStudentId = parseMulticoStudentIdFromHtml(resp.url());
  const studentId =
    redirectStudentId ??
    (await searchStudentByPassport(
      page,
      profile.passportNumber,
      profile.email,
    ));
  if (!studentId) {
    const diagnostics = extractMulticoResponseDiagnostics(html);
    const responsePath = (() => {
      try {
        return new URL(resp.url()).pathname;
      } catch {
        return "unknown";
      }
    })();
    throw new Error(
      `Multico student create could not be proved ` +
        `(path=${responsePath}, successMarker=${isSuccess}, ` +
        `responseBytes=${Buffer.byteLength(html)}, ` +
        `validation=${diagnostics.join(" | ") || "none"})`,
    );
  }
  return { studentId, uploadedSlots };
}

// ---------------------------------------------------------------------------
// Document upload (separate from student create for retry-safety)
// ---------------------------------------------------------------------------

const DOC_FIELD_MAP: Record<string, string> = {
  passport:          "file_passport",
  passport_document: "file_passport",
  diploma:           "file_diploma",
  hs_diploma:        "file_diploma",
  high_school_diploma: "file_diploma",
  transcript:        "file_transcript",
  marks_sheet:       "file_transcript",
  photo:             "profile_photo",
  photograph:        "profile_photo",
  english:           "file_toefl_ibt",
  toefl:             "file_toefl_ibt",
  equivalence:       "file_equivalance",
  nostrification:    "file_equivalance",
};

/**
 * Uploads student documents to the Multico student edit page.
 * Applies JPEG conversion for profile_photo (portal policy).
 * Returns the list of uploaded document slots.
 */
async function uploadDocuments(
  page: AdapterSession["page"],
  studentId: string,
  files: SubmitFiles,
  skipSlots: readonly string[] = [],
): Promise<string[]> {
  const uploadedSlots: string[] = [];
  const uploadFiles: MulticoUploadFile[] = [];
  const multipartData: Record<string, string | { name: string; mimeType: string; buffer: Buffer }> = {
    _method: "PATCH",
  };

  const fileMap: Record<string, string | undefined> = {
    file_passport:   files.passport,
    file_diploma:    files.diploma,
    file_transcript: files.transcript,
    profile_photo:   files.photo,
    file_toefl_ibt:  files.english,
  };

  for (const [fieldName, filePath] of Object.entries(fileMap)) {
    if (!filePath || skipSlots.includes(fieldName)) continue;
    try {
      let buf = await fs.readFile(filePath);
      let mimeType = "application/octet-stream";
      let name = path.basename(filePath);

      // Note: JPEG conversion for profile_photo is handled upstream by the
      // portal-runner (shared download core) before files reach this adapter.
      // If the file is already a JPEG/PNG the portal typically accepts it.
      if (fieldName === "profile_photo") {
        mimeType = "image/jpeg";
        name = name.replace(/\.[^.]+$/, ".jpg");
      } else if (filePath.toLowerCase().endsWith(".pdf")) {
        mimeType = "application/pdf";
      }

      uploadFiles.push({
        fieldName,
        filePath,
        name,
        mimeType,
        buffer: buf,
      });
    } catch {
      logger.warn(`[multico] doc upload: could not read file for ${fieldName}: ${filePath}`);
    }
  }

  if (uploadFiles.length === 0) return uploadedSlots;
  const preparedUploads = await optimizeMulticoMultipartFiles(uploadFiles);
  for (const upload of preparedUploads) {
    multipartData[upload.fieldName] = {
      name: upload.name,
      mimeType: upload.mimeType,
      buffer: upload.buffer,
    };
    uploadedSlots.push(upload.fieldName);
  }

  const uploadResponse = await page.request.post(
    `${MULTICO_BASE}/students/update/${studentId}`,
    {
    multipart: multipartData,
    },
  );
  if (!uploadResponse.ok()) {
    throw new Error(
      `Multico document upload failed (status=${uploadResponse.status()})`,
    );
  }

  return uploadedSlots;
}

async function verifyStudentDocuments(
  page: AdapterSession["page"],
  studentId: string,
  fields: readonly string[],
): Promise<string[]> {
  const response = await page.goto(
    `${MULTICO_BASE}/students/edit/${studentId}`,
    { waitUntil: "networkidle" },
  );
  if (!response?.ok()) {
    throw new Error(
      `Multico document verification failed (status=${
        response?.status() ?? "none"
      })`,
    );
  }

  return page.evaluate((requiredFields) => {
    const present: string[] = [];
    for (const fieldName of requiredFields) {
      const control = document.querySelector(
        `input[name="${fieldName}"]`,
      );
      const container =
        control?.closest(".form-group") ??
        control?.parentElement?.parentElement ??
        control?.parentElement;
      if (container?.querySelector("a[href]")) present.push(fieldName);
    }
    return present;
  }, fields);
}

// ---------------------------------------------------------------------------
// Application create
// ---------------------------------------------------------------------------

/** Derives the academic year string "YYYY-YYYY Fall Semester". */
function currentAcademicYear(): string {
  const now = new Date();
  const y = now.getFullYear();
  const start = now.getMonth() >= 5 ? y : y - 1;
  return `${start}-${start + 1} Fall Semester`;
}

/**
 * Creates an application in the Multico CRM and parses the result.
 * Returns { applicationId, fee, status } from the student edit page.
 */
async function createApplication(
  page: AdapterSession["page"],
  studentId: string,
  departmentId: string,
  universityId: string,
  programType: string,
  programName: string,
  note = "",
): Promise<{ applicationId: string; fee: string; status: string }> {
  const formUrl = `${MULTICO_BASE}/student-applications/add/${studentId}`;
  const formResponse = await page.goto(formUrl, {
    waitUntil: "networkidle",
  });
  if (
    !formResponse?.ok() ||
    !isExpectedMulticoApplicationFormUrl(page.url(), studentId)
  ) {
    throw new Error(
      "Multico application form could not be opened exactly",
    );
  }

  const academicYearSelect = page.locator('select[name="academic_year"]');
  const universitySelect = page.locator('select[name="university_id"]');
  const programTypeSelect = page.locator('select[name="program_type"]');
  const departmentSelect = page.locator('select[name="department_id"]');
  const noteInput = page.locator('textarea[name="student_note"]');
  const submitButton = page.locator('button[name="submit"][type="submit"]');
  for (const control of [
    academicYearSelect,
    universitySelect,
    programTypeSelect,
    departmentSelect,
    noteInput,
    submitButton,
  ]) {
    if ((await control.count()) !== 1) {
      throw new Error(
        "Multico application form controls are not unique",
      );
    }
  }

  const resolveOptionValue = async (
    select: typeof academicYearSelect,
    text: string,
  ): Promise<string> => {
    const wanted = fold(text);
    const options = await select.locator("option").evaluateAll((elements) =>
      elements.map((option) => ({
        value: option.getAttribute("value") ?? "",
        text: option.textContent?.trim() ?? "",
      })),
    );
    const matches = options.filter(
      (option) => option.value && fold(option.text) === wanted,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Multico application option is not unique (count=${matches.length})`,
      );
    }
    return matches[0].value;
  };
  const academicYearId = await resolveOptionValue(
    academicYearSelect,
    currentAcademicYear(),
  );
  const programTypeId = await resolveOptionValue(
    programTypeSelect,
    programType,
  );

  const waitForDepartmentAjax = () =>
    page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        candidate.url().includes(
          "/crm/ajax/get-departments-by-university.php",
        ),
      { timeout: 10_000 },
    );
  const universityAjax = waitForDepartmentAjax();
  await universitySelect.selectOption(universityId);
  if (!(await universityAjax).ok()) {
    throw new Error("Multico application university filter failed");
  }
  const programTypeAjax = waitForDepartmentAjax();
  await programTypeSelect.selectOption(programTypeId);
  if (!(await programTypeAjax).ok()) {
    throw new Error("Multico application program-type filter failed");
  }
  await academicYearSelect.selectOption(academicYearId);
  const departmentMatches = await departmentSelect
    .locator(`option[value="${departmentId}"]`)
    .count();
  if (departmentMatches !== 1) {
    throw new Error(
      "Multico matched department is absent after exact filters",
    );
  }
  await departmentSelect.selectOption(departmentId);
  await noteInput.fill(note);

  const submitResponsePromise = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      candidate.url() === formUrl,
    { timeout: 15_000 },
  );
  await submitButton.click();
  const submitResponse = await submitResponsePromise;
  if (!submitResponse.ok()) {
    throw new Error(
      `Multico application create failed (status=${submitResponse.status()})`,
    );
  }

  const observedApplications =
    await findMatchingMulticoApplicationInDom(
      page,
      studentId,
      programName,
    );
  if (!observedApplications.tableFound) {
    throw new Error(
      "Multico application verification table is missing",
    );
  }
  if (observedApplications.application) {
    return observedApplications.application;
  }

  const responseHtml = await submitResponse.text().catch(() => "");
  const diagnostics = extractMulticoResponseDiagnostics(responseHtml);
  throw new Error(
    `Multico application create could not be proved ` +
      `(path=${new URL(submitResponse.url()).pathname}, ` +
      `validation=${diagnostics.join(" | ") || "none"})`,
  );
}

// ---------------------------------------------------------------------------
// Status poll
// ---------------------------------------------------------------------------

/**
 * Fetches the student edit page and parses the current status of the given
 * application ID from the Candidate Applications table.
 */
export async function pollStatus(
  page: AdapterSession["page"],
  studentId: string,
  applicationId: string,
): Promise<{ status: string } | null> {
  const table = await readMulticoApplicationTable(page, studentId);
  if (!table.tableFound) return null;
  const idEscaped = applicationId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const row = table.rows.find(
    (candidate) =>
      new RegExp(
        `student-applications/(?:edit|view)/\\d+/${idEscaped}(?:["'?/]|$)`,
        "i",
      ).test(candidate.html) ||
      new RegExp(`^#?\\s*${idEscaped}\\b`).test(candidate.text),
  );
  if (!row) return null;
  const status =
    /(Pending Review|Pending|Accepted|Rejected|Review|Waiting|In Progress|Completed)/i.exec(
      row.text,
    )?.[1];
  if (status) return { status: status.trim() };
  return null;
}

// ---------------------------------------------------------------------------
// Adapter login
// ---------------------------------------------------------------------------

async function multicoLogin(page: AdapterSession["page"], creds: { user: string; password: string }): Promise<void> {
  // Navigate to login page
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // If already logged in (storage-state reuse), check the URL.
  if (!page.url().includes("login")) {
    logger.info("[multico] session reused — already logged in");
    return;
  }

  // Fill and submit login form
  const emailInput = page.locator('input[name="email"], input[type="email"]').first();
  const passInput  = page.locator('input[name="password"], input[type="password"]').first();
  const submitBtn  = page.locator('button[type="submit"], input[type="submit"]').first();

  await emailInput.fill(creds.user);
  await passInput.fill(creds.password);
  await submitBtn.click();

  // Wait for redirect away from login (max 15s).
  try {
    await page.waitForURL(
      (url) => !url.toString().includes("login"),
      { timeout: 15000 },
    );
  } catch {
    const currentUrl = page.url();
    throw new Error(`[multico] Login failed — still on login page: ${currentUrl}`);
  }

  // Persist the session state.
  await saveState(page, STORAGE_PATH).catch(() => {});
  logger.info("[multico] login successful");
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------

export const multicoAdapter: UniversityAdapter = {
  key:   ADAPTER_KEY,
  label: "Multico (Topkapı Central Asia & Mongolia)",

  matches(name: string): boolean {
    return fold(name).includes(fold("multico"));
  },

  async checkStatus(
    session: AdapterSession,
    externalRef: string,
  ): Promise<{ status: string } | null> {
    // externalRef format: "studentId:applicationId" (see submit return above).
    const sep = externalRef.lastIndexOf(":");
    if (sep === -1) return null;
    const studentId     = externalRef.slice(0, sep);
    const applicationId = externalRef.slice(sep + 1);
    if (!studentId || !applicationId) return null;
    return pollStatus(session.page, studentId, applicationId);
  },

  async login(opts?: LoginOpts): Promise<AdapterSession> {
    const creds = opts?.credentials ?? portalCreds(ADAPTER_KEY);
    const session = await launchPortal({
      headless: opts?.headless ?? true,
      storagePath: STORAGE_PATH,
    });
    try {
      await multicoLogin(session.page, creds);
      return session;
    } catch (err) {
      await session.close().catch(() => {});
      throw err;
    }
  },

  async submit(
    session: AdapterSession,
    profile: SubmitProfile,
    files: SubmitFiles,
    doSubmit = true,
  ): Promise<SubmitResult> {
    const page = session.page;
    const isDry = !doSubmit;

    // ---- Step A: Duplicate check (passport search) -----------------------
    logger.info(`[multico] submit app=${profile.applicationDbId ?? "?"} dry=${isDry}`);

    let existingStudentId: string | null = null;
    try {
      existingStudentId = await searchStudentByPassport(
        page,
        profile.passportNumber,
        profile.email,
      );
    } catch (err) {
      throw new Error(
        "Multico dedup_unknown: passport search could not be verified",
      );
    }

    const alreadyExists = existingStudentId !== null;
    logger.info(
      `[multico] duplicate check → alreadyExists=${alreadyExists}` +
        (existingStudentId ? ` studentId=${existingStudentId}` : ""),
    );

    // ---- Step B: Program catalog + match ---------------------------------
    const programType = mapProgramType(profile.level);
    if (!programType) {
      throw new Error(
        "Multico data_missing: unsupported or empty application level",
      );
    }
    const catalogStudentId = await resolveCatalogStudentId(
      page,
      existingStudentId,
    );
    const candidates = await getProgramCatalog(
      page,
      catalogStudentId,
      programType,
    );

    const { match, alternatives } = matchMulticoProgram(profile, candidates);

    if (!match) {
      logger.warn(`[multico] no program match for "${profile.programName}" (${profile.level}), alternatives=${alternatives.length}`);
      return {
        submitted:      false,
        alreadyExists,
        programMissing: true,
        resolution:     "not_in_dropdown",
        availablePrograms: candidates.map((c) => ({ value: c.id, name: c.name, enabled: true })),
        meta: {
          dryRun:             isDry,
          wouldCreateStudent: !alreadyExists,
          wouldApply:         false,
          alternatives:       alternatives.map((a) => ({ id: a.id, name: a.name })),
        },
        detail: `Program bulunamadı: "${profile.programName}" (${profile.level}). Alternatives: ${alternatives.map((a) => a.name).join("; ") || "none"}`,
      };
    }

    logger.info(`[multico] program matched: "${match.name}" (id=${match.id})`);

    const missingDocuments = (
      ["passport", "diploma", "transcript"] as const
    ).filter((slot) => !files[slot]);

    let existingTarget:
      | { applicationId: string; fee: string; status: string }
      | null = null;
    if (existingStudentId) {
      const observedApplications =
        await findMatchingMulticoApplicationInDom(
          page,
          existingStudentId,
          match.name,
        );
      if (!observedApplications.tableFound) {
        throw new Error(
          "Multico dedup_unknown: existing student page has no verifiable application table",
        );
      }
      existingTarget = observedApplications.application;
    }

    // ---- DRY-RUN exit ----------------------------------------------------
    if (isDry) {
      return {
        submitted:      false,
        alreadyExists,
        programMissing: false,
        meta: {
          dryRun:             true,
          wouldCreateStudent: !alreadyExists,
          wouldApply:         !existingTarget,
          existingTargetApplicationId:
            existingTarget?.applicationId ?? null,
          matchedStudentId:   existingStudentId,
          matchedProgram:     { id: match.id, name: match.name },
        },
        detail: existingTarget
          ? `Dry-run: target application already exists (Multico appId=${existingTarget.applicationId})`
          : alreadyExists
          ? `Dry-run: existing student will be reused for program="${match.name}"`
          : `Dry-run: new student, program="${match.name}"`,
      };
    }

    if (missingDocuments.length > 0) {
      return {
        submitted: false,
        alreadyExists,
        programMissing: false,
        missingDocuments,
        detail:
          "Multico: passport, diploma and transcript are required before application processing",
      };
    }

    // ---- Step C: Student create (if not duplicate) ----------------------
    let studentId = existingStudentId;
    let inlineUploadedSlots: string[] = [];
    if (!alreadyExists) {
      try {
        const created = await createMulticoStudent(page, profile, files);
        studentId = created.studentId;
        inlineUploadedSlots = created.uploadedSlots;
        logger.info(`[multico] student created: studentId=${studentId}`);
      } catch (err) {
        throw new Error(`Multico student create error: ${(err as Error).message}`);
      }
    }

    if (!studentId) {
      throw new Error("Multico: studentId not resolved after student create/lookup");
    }

    // ---- Step D: Document upload ----------------------------------------
    const requestedUploadFields = [
      "file_passport",
      "file_diploma",
      "file_transcript",
      ...(files.photo ? ["profile_photo"] : []),
      ...(files.english ? ["file_toefl_ibt"] : []),
    ];
    const presentBeforeUpload = await verifyStudentDocuments(
      page,
      studentId,
      requestedUploadFields,
    );
    let uploadedSlots: string[] = [
      ...new Set([...inlineUploadedSlots, ...presentBeforeUpload]),
    ];
    try {
      const patchedSlots = await uploadDocuments(
        page,
        studentId,
        files,
        uploadedSlots,
      );
      uploadedSlots = [...new Set([...uploadedSlots, ...patchedSlots])];
      logger.info(
        `[multico] documents sent: ${uploadedSlots.join(", ") || "none"}`,
      );
    } catch (err) {
      throw new Error(
        `Multico document upload error: ${(err as Error).message}`,
      );
    }
    const requiredUploadFields = [
      "file_passport",
      "file_diploma",
      "file_transcript",
    ];
    const verifiedUploads = await verifyStudentDocuments(
      page,
      studentId,
      requiredUploadFields,
    );
    const missingUploads = requiredUploadFields.filter(
      (slot) => !verifiedUploads.includes(slot),
    );
    if (missingUploads.length > 0) {
      return {
        submitted: false,
        alreadyExists,
        programMissing: false,
        missingDocuments: missingUploads,
        uploadedSlots: verifiedUploads,
        detail:
          "Multico: required document upload could not be proved; application creation blocked",
      };
    }
    uploadedSlots = [...new Set([...uploadedSlots, ...verifiedUploads])];

    if (existingTarget) {
      return {
        submitted: true,
        alreadyExists,
        programMissing: false,
        uploadedSlots,
        externalRef: `${studentId}:${existingTarget.applicationId}`,
        meta: {
          studentId,
          applicationId: existingTarget.applicationId,
          fee: existingTarget.fee,
          status: existingTarget.status,
          repairedExisting: true,
          program: { id: match.id, name: match.name },
        },
        detail:
          `Multico existing application verified and documents repaired — ` +
          `studentId=${studentId} appId=${existingTarget.applicationId}`,
      };
    }

    // ---- Step E: Resolve university_id (Topkapı in Multico CRM) --------
    const universityId = await resolveTopkapiUniversityId(page, studentId);
    if (!universityId) {
      throw new Error("Multico: could not resolve Topkapı university_id from application-add form");
    }

    // ---- Step F: Application create ------------------------------------
    let applicationData: { applicationId: string; fee: string; status: string };
    try {
      applicationData = await createApplication(
        page,
        studentId,
        match.id,
        universityId,
        programType,
        match.name,
      );
    } catch (err) {
      throw new Error(`Multico application create error: ${(err as Error).message}`);
    }

    logger.info(
      `[multico] application created: appId=${applicationData.applicationId} fee=${applicationData.fee} status=${applicationData.status}`,
    );

    return {
      submitted:      true,
      alreadyExists,
      programMissing: false,
      uploadedSlots,
      // Encode both IDs so checkStatus can split and poll without querying meta.
      externalRef:    `${studentId}:${applicationData.applicationId}`,
      meta: {
        studentId,
        applicationId: applicationData.applicationId,
        fee:           applicationData.fee,
        status:        applicationData.status,
        program:       { id: match.id, name: match.name },
      },
      detail: `Submitted to Multico CRM — studentId=${studentId} appId=${applicationData.applicationId}`,
    };
  },
};
