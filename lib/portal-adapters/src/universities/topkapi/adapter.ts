import type {
  UniversityAdapter,
  AdapterSession,
  SubmitProfile,
  SubmitFiles,
  SubmitResult,
  LoginOpts,
  ProgramOption,
} from "../../types.js";
import type { Page, Locator } from "playwright-core";
import { launchPortal, saveState, logger } from "../../browser.js";
import { portalCreds } from "../../portalCreds.js";
import {
  matchProgram,
  fold,
  parseTrack,
  hasThesisMarker,
  hasNonThesisMarker,
  expandProgramTokens,
} from "../../programMatch.js";
import type { ProgramCandidate } from "../../programMatch.js";
import { detectExclusiveRegion } from "../../exclusiveRegion.js";
import {
  formatGraduationForInput,
  formatGraduationForDatepicker,
  mapEduLevel,
  eduLevelCandidates,
  isPlaceholderChoice,
} from "./format.js";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const PORTAL_URL   = "https://apply.topkapi.edu.tr";
const STORAGE_PATH = "/tmp/topkapi-portal-state.json";

// ---------------------------------------------------------------------------
// Country resolution — nationality text → Topkapi portal dropdown label (Turkish)
//
// The Topkapi portal uses Turkish country names in all dropdowns.
// Values here must match the portal's <option> text exactly (or a substring of it)
// so that selectByBest's partial-label match finds the right option.
// ---------------------------------------------------------------------------
const COUNTRY_MAP: Record<string, string> = {
  afghan:         "Afganistan",
  algerian:       "Cezayir",
  azerbaijani:    "Azerbaycan",
  azerbaijanian:  "Azerbaycan",
  bahraini:       "Bahreyn",
  bangladeshi:    "Bangladeş",
  british:        "Birleşik Krallık",
  chinese:        "Çin",
  egyptian:       "Mısır",
  emirati:        "Birleşik Arap Emirlikleri",
  french:         "Fransa",
  german:         "Almanya",
  indian:         "Hindistan",
  iranian:        "İran",
  iraqi:          "Irak",
  jordanian:      "Ürdün",
  kazakh:         "Kazakistan",
  kuwaiti:        "Kuveyt",
  kyrgyz:         "Kırgızistan",
  lebanese:       "Lübnan",
  libyan:         "Libya",
  moroccan:       "Fas",
  nigerian:       "Nijerya",
  omani:          "Umman",
  pakistani:      "Pakistan",
  palestinian:    "Filistin",
  qatari:         "Katar",
  russian:        "Rusya",
  saudi:          "Suudi Arabistan",
  somali:         "Somali",
  sudanese:       "Sudan",
  syrian:         "Suriye",
  tajik:          "Tacikistan",
  tunisian:       "Tunus",
  turk:           "Türkiye",
  turkish:        "Türkiye",
  turkmen:        "Türkmenistan",
  ukrainian:      "Ukrayna",
  uzbek:          "Özbekistan",
  yemeni:         "Yemen",
};

// Also map commonly-seen raw country-name values (not adjectives) to Turkish.
// Handles cases where student.nationality stores "Uzbekistan" instead of "Uzbek".
const COUNTRY_NAME_MAP: Record<string, string> = {
  "united kingdom": "Birleşik Krallık",
  "united states": "Amerika Birleşik Devletleri",
  "united states of america": "Amerika Birleşik Devletleri",
  "united arab emirates": "Birleşik Arap Emirlikleri",
  afghanistan: "Afganistan",
  algeria: "Cezayir",
  azerbaijan: "Azerbaycan",
  bahrain: "Bahreyn",
  bangladesh: "Bangladeş",
  cameroon: "Kamerun",
  china: "Çin",
  egypt: "Mısır",
  france: "Fransa",
  germany: "Almanya",
  ghana: "Gana",
  india: "Hindistan",
  indonesia: "Endonezya",
  iran: "İran",
  iraq: "Irak",
  jordan: "Ürdün",
  kazakhstan: "Kazakistan",
  kenya: "Kenya",
  kuwait: "Kuveyt",
  kyrgyzstan: "Kırgızistan",
  lebanon: "Lübnan",
  libya: "Libya",
  morocco: "Fas",
  nigeria: "Nijerya",
  oman: "Umman",
  pakistan: "Pakistan",
  palestine: "Filistin",
  qatar: "Katar",
  russia: "Rusya",
  "saudi arabia": "Suudi Arabistan",
  somalia: "Somali",
  sudan: "Sudan",
  syria: "Suriye",
  tajikistan: "Tacikistan",
  tanzania: "Tanzanya",
  tunisia: "Tunus",
  turkey: "Türkiye",
  turkmenistan: "Türkmenistan",
  ukraine: "Ukrayna",
  uzbekistan: "Özbekistan",
  yemen: "Yemen",
};

// ---------------------------------------------------------------------------
// Turkish → English country name translation (Topkapi-only).
//
// resolveCountry() above always returns a TURKISH country name (portal used
// to be Turkish-only). The Step-2/Step-3 country <select>s now carry ONLY
// English option text ("Afghanistan", "Turkey", …) — matching the Turkish
// name against them fails, the field stays at value="0", and the wizard
// rejects the whole step with "Please check field(s)". Translate the
// Turkish name to English right before matching against select options; the
// Turkish name itself (from resolveCountry) is kept as a same-call fallback
// candidate in case a given select ever reverts to Turkish text.
// ---------------------------------------------------------------------------
function normalizeTr(s: string): string {
  return s
    .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
    .replace(/Ş/g, "s").replace(/ş/g, "s")
    .replace(/Ğ/g, "g").replace(/ğ/g, "g")
    .replace(/Ü/g, "u").replace(/ü/g, "u")
    .replace(/Ö/g, "o").replace(/ö/g, "o")
    .replace(/Ç/g, "c").replace(/ç/g, "c")
    .toLowerCase()
    .trim();
}

const TR_TO_EN_COUNTRY: Record<string, string> = {
  turkiye: "Turkey",
  afganistan: "Afghanistan",
  kazakistan: "Kazakhstan",
  ozbekistan: "Uzbekistan",
  turkmenistan: "Turkmenistan",
  azerbaycan: "Azerbaijan",
  nijerya: "Nigeria",
  misir: "Egypt",
  suriye: "Syria",
  irak: "Iraq",
  iran: "Iran",
  urdun: "Jordan",
  filistin: "Palestine",
  fas: "Morocco",
  cezayir: "Algeria",
  tunus: "Tunisia",
  libya: "Libya",
  sudan: "Sudan",
  somali: "Somalia",
  etiyopya: "Ethiopia",
  kenya: "Kenya",
  gana: "Ghana",
  kamerun: "Cameroon",
  kirgizistan: "Kyrgyzstan",
  tacikistan: "Tajikistan",
  hindistan: "India",
  bangladesh: "Bangladesh",
  endonezya: "Indonesia",
  malezya: "Malaysia",
  filipinler: "Philippines",
  pakistan: "Pakistan",
  yemen: "Yemen",
  rusya: "Russia",
  ukrayna: "Ukraine",
  almanya: "Germany",
  fransa: "France",
  ingiltere: "United Kingdom",
  cin: "China",
  "guney afrika": "South Africa",
  mogolistan: "Mongolia",
  nepal: "Nepal",
  arnavutluk: "Albania",
  kosova: "Kosovo",
  // Additional Turkish names resolveCountry() can already produce, so every
  // possible output of resolveCountry() has an English translation here.
  bahreyn: "Bahrain",
  "birlesik krallik": "United Kingdom",
  "amerika birlesik devletleri": "United States",
  "birlesik arap emirlikleri": "United Arab Emirates",
  kuveyt: "Kuwait",
  lubnan: "Lebanon",
  umman: "Oman",
  katar: "Qatar",
  "suudi arabistan": "Saudi Arabia",
  tanzanya: "Tanzania",
};

/** Translate a resolveCountry() Turkish country name to English; returns the
 *  original (unchanged) name when no mapping exists, so callers can still
 *  fall back to it. */
function toEnglishCountryName(name: string): string {
  return TR_TO_EN_COUNTRY[normalizeTr(name)] ?? name;
}

function resolveCountry(
  nationality: string,
  overrides?: Record<string, string>,
): string {
  const lower = nationality.toLowerCase().trim();
  // 0. Panel-managed override (DB wins) — exact key first, then adjective substring.
  if (overrides) {
    if (overrides[lower]) return overrides[lower];
    for (const [key, value] of Object.entries(overrides)) {
      if (key && lower.includes(key)) return value;
    }
  }
  // 1. Exact country-name match (e.g. "Uzbekistan" → "Özbekistan")
  if (COUNTRY_NAME_MAP[lower]) return COUNTRY_NAME_MAP[lower];
  // 2. Nationality-adjective substring match (e.g. "uzbek" in "Uzbekistani" → "Özbekistan")
  for (const [key, value] of Object.entries(COUNTRY_MAP)) {
    if (lower.includes(key)) return value;
  }
  return nationality; // fallback: pass raw to portal (label-match will try)
}

// mapEduLevel (applied program-level label) now lives in ./format.js so the
// pure mapping logic is unit-testable without pulling in Playwright.

// ---------------------------------------------------------------------------
// ISO-8601 date → Turkish dd.mm.yyyy
// ---------------------------------------------------------------------------
function toTrDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const [y, m, d] = parts;
  return `${d}.${m}.${y}`;
}

// ---------------------------------------------------------------------------
// Fuzzy program-label fallback matching (Topkapi-only).
//
// The shared matchProgram() (used by SIT/United/Altınbaş too — never edited
// here) already handles exact/name-map matches plus a thesis/language hard
// filter + token-Jaccard score. It still misses labels like "Master of Cyber
// Security (Non-Thesis) (Turkish)" against a terse portal option like "Siber
// Güvenlik Tezsiz (Türkçe)": the query-only filler tokens ("master", "of",
// "non", "thesis", "turkish") inflate the Jaccard union while only the
// subject words actually overlap (via synonyms), sinking the score below the
// shared 0.6 threshold. Rather than touching the shared matcher, Topkapi runs
// this LOCAL fallback pass only when matchProgram() returns null: strip
// degree-prefix noise ("Master of ", "Bachelor in ", …) and parenthetical /
// inline variant annotations (Thesis/Non-Thesis/Turkish/English + Turkish
// equivalents) from both sides, keep the same thesis/language hard filter
// (evaluated on the UN-stripped folded name, so the variant markers still
// gate the pool), then score by token overlap (Jaccard ∪ containment) with
// its own confidence threshold + margin gate.
// ---------------------------------------------------------------------------
const FUZZY_CONF_THRESHOLD = 0.5;
const FUZZY_MARGIN_THRESHOLD = 0.1;

const DEGREE_PREFIX_RE =
  /^(master'?s?\s+(?:of|in|degree\s+in)|bachelor'?s?\s+(?:of|in|degree\s+in)|phd\s+in|doctorate\s+(?:of|in)|doctor\s+of\s+philosophy\s+in|associate\s+(?:of|in)|msc\s+in|ba\s+in|bs\s+in)\s+/i;

const VARIANT_WORD_RE =
  /\b(non[\s-]?thesis|nonthesis|thesis|tezsiz|tezli|turkish|turkce|türkçe|english|ingilizce|i̇ngilizce)\b/gi;

/** Strip degree-prefix noise + variant-annotation words, then fold to tokens. */
function normalizeForFuzzyMatch(raw: string): string {
  const noPrefix  = raw.replace(DEGREE_PREFIX_RE, "");
  const noParens  = noPrefix.replace(/\([^)]*\)/g, " ");
  const noVariant = noParens.replace(VARIANT_WORD_RE, " ");
  return fold(noVariant).replace(/\s+/g, " ").trim();
}

/** Split a normalized label into a folded token set (matches programMatch's tokenize). */
function fuzzyTokenize(norm: string): Set<string> {
  return new Set(norm.split(" ").filter((t) => t.length > 1));
}

/**
 * Jaccard over SYNONYM-EXPANDED token sets (reuses the shared EN↔TR
 * dictionary via expandProgramTokens so "cyber"↔"siber" / "security"↔
 * "guvenlik" still bridge), rewarded when one label's tokens are fully
 * contained in the other's (common when the portal drops a leading
 * "Master of" or an "and"-joined subtitle).
 */
function tokenOverlapConf(
  aNorm: string,
  bNorm: string,
  synonyms?: readonly (readonly string[])[],
): number {
  const at = expandProgramTokens(fuzzyTokenize(aNorm), synonyms);
  const bt = expandProgramTokens(fuzzyTokenize(bNorm), synonyms);
  if (at.size === 0 || bt.size === 0) return 0;
  let inter = 0;
  for (const t of at) if (bt.has(t)) inter++;
  const union = at.size + bt.size - inter;
  const jaccardConf = union === 0 ? 0 : inter / union;
  const containmentConf = inter / Math.min(at.size, bt.size);
  return Math.max(jaccardConf, containmentConf * 0.85);
}

/**
 * Local last-resort fuzzy match: contains/token-overlap (synonym-aware) over
 * normalized (noise-stripped) labels, respecting the same thesis/language
 * variant as a hard pre-filter (reusing the shared markers/parseTrack so
 * behaviour stays identical to matchProgram's own hard filter). Returns null
 * (never throws) when no candidate clears the confidence + margin gate — the
 * caller reports a clear "skipped: program eşleşmedi" result.
 */
function fuzzyFallbackMatch(
  programName: string,
  options: ProgramCandidate[],
  synonyms?: readonly (readonly string[])[],
): { match: ProgramCandidate; conf: number } | null {
  if (options.length === 0) return null;

  const qFolded = fold(programName);
  let pool = options;

  if (hasThesisMarker(qFolded)) {
    const f = pool.filter((o) => hasThesisMarker(fold(o.name)));
    if (f.length > 0) pool = f;
  } else if (hasNonThesisMarker(qFolded)) {
    const f = pool.filter((o) => hasNonThesisMarker(fold(o.name)));
    if (f.length > 0) pool = f;
  }

  const qTrack = parseTrack(programName);
  if (qTrack) {
    const opposite = qTrack === "en" ? "tr" : "en";
    const same = pool.filter((o) => parseTrack(o.name) === qTrack);
    pool = same.length > 0 ? same : pool.filter((o) => parseTrack(o.name) !== opposite);
  }
  if (pool.length === 0) return null;

  const qNorm = normalizeForFuzzyMatch(programName);
  if (!qNorm) return null;

  const scored = pool
    .map((o) => ({
      match: o,
      conf: tokenOverlapConf(qNorm, normalizeForFuzzyMatch(o.name), synonyms),
    }))
    .filter((s) => s.conf >= FUZZY_CONF_THRESHOLD)
    .sort((a, b) => b.conf - a.conf);

  if (scored.length === 0) return null;
  if (scored.length === 1) return scored[0];

  const margin = scored[0].conf - scored[1].conf;
  return margin >= FUZZY_MARGIN_THRESHOLD ? scored[0] : null;
}

// ---------------------------------------------------------------------------
// Dismiss any open jconfirm dialog via direct DOM click (bypasses overlay).
// Logs the dialog text + all button labels for debugging.
// ---------------------------------------------------------------------------
async function dismissJconfirm(page: Page, logger: typeof import("../../browser.js").logger): Promise<boolean> {
  try {
    const info = await page.evaluate(() => {
      const dlg = document.querySelector(".jconfirm.jconfirm-open") as HTMLElement | null;
      if (!dlg) return null;
      const msg = (dlg.querySelector(".jconfirm-content, .jconfirm-message") as HTMLElement | null)?.innerText ?? "";
      const btns = Array.from(dlg.querySelectorAll("button")).map((b) => ({
        text: (b as HTMLElement).innerText.trim(),
        cls: (b as HTMLElement).className,
      }));
      // Click the first button (usually the confirm/OK button)
      const first = dlg.querySelector("button") as HTMLElement | null;
      if (first) first.click();
      return { msg, btns, clicked: !!first };
    });
    if (!info) return false;
    logger.info("[topkapi] jconfirm dismissed — msg:", info.msg.slice(0, 200), "btns:", JSON.stringify(info.btns), "clicked:", info.clicked);
    // Give the dialog animation time to close
    await page.waitForSelector(".jconfirm.jconfirm-open", { state: "hidden", timeout: 2000 }).catch(() => {});
    return info.clicked;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Click the visible "Next Step" / "Sonraki Adım" button (language-agnostic).
// Pre-dismisses any open jconfirm before clicking (e.g. lingering from prev
// step), then post-dismisses one that may open as a result (e.g. new-student
// confirmation). DOM-click used to bypass Playwright overlay detection.
// ---------------------------------------------------------------------------
async function clickNext(page: Page, logger: typeof import("../../browser.js").logger): Promise<void> {
  // Pre-dismiss any leftover modal before attempting the click (loop)
  for (let i = 0; i < 5; i++) {
    if ((await page.locator(".jconfirm.jconfirm-open").count()) === 0) break;
    await dismissJconfirm(page, logger);
    await page.waitForTimeout(400);
  }

  const btn = page.getByRole("button", { name: /(Sonraki Adım|Next Step)/i });
  await btn.waitFor({ state: "visible", timeout: 30000 });
  await btn.click({ force: true });

  // Post-dismiss any modal that opened as a result of the click
  try {
    await page.waitForSelector(".jconfirm.jconfirm-open", { timeout: 3000 });
    await dismissJconfirm(page, logger);
  } catch { /* no modal — continue */ }
}

// ---------------------------------------------------------------------------
// gotoAndWait — navigate with a resilient wait strategy.
//
// The application form is a heavy SPA page; "networkidle"/"load" can exceed
// the default 30s action timeout even after a successful login (slow AJAX
// polling never lets the network go fully idle). "domcontentloaded" fires as
// soon as the DOM is parsed, so we pair it with an explicit waitForSelector
// for the element the caller actually needs, and retry once on timeout
// before giving up — a single transient slow load should not fail the run.
// ---------------------------------------------------------------------------
async function gotoAndWait(
  page: Page,
  url: string,
  readySelector: string,
  log: typeof import("../../browser.js").logger = logger,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForSelector(readySelector, { timeout: 60000 });
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      log.warn(
        `[topkapi] goto("${url}") attempt ${attempt} failed (${(err as Error).message}) — retrying`,
      );
      await page.waitForTimeout(1000);
    }
  }
}

// ---------------------------------------------------------------------------
// gotoWithRetry — plain navigation (no readySelector) with the same
// domcontentloaded/60s + 1-retry resilience as gotoAndWait, for call sites
// (login) that don't have a single obvious ready-selector to wait on.
// ---------------------------------------------------------------------------
async function gotoWithRetry(
  page: Page,
  url: string,
  log: typeof import("../../browser.js").logger = logger,
): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      return;
    } catch (err) {
      if (attempt === 2) throw err;
      log.warn(
        `[topkapi] goto("${url}") attempt ${attempt} failed (${(err as Error).message}) — retrying`,
      );
      await page.waitForTimeout(1000);
    }
  }
}

// ---------------------------------------------------------------------------
// Select <option> by value first, then exact label, then partial label
// ---------------------------------------------------------------------------
async function selectByBest(
  page: Page,
  selector: string,
  value: string,
): Promise<boolean> {
  // 1. By value
  try {
    await page.selectOption(selector, { value });
    const v = await page.$eval(selector, (el) => (el as HTMLSelectElement).value);
    if (v && v !== "0" && v !== "") return true;
  } catch { /* try label */ }

  // 2. By exact label
  try {
    await page.selectOption(selector, { label: value });
    const v = await page.$eval(selector, (el) => (el as HTMLSelectElement).value);
    if (v && v !== "0" && v !== "") return true;
  } catch { /* try partial */ }

  // 3. Normalized bidirectional contains — handles Turkish ALL-CAPS ("ÖZBEKİSTAN"),
  //    Turkey↔Türkiye variants, and cases where the option text is shorter than the
  //    search term (e.g. portal "UK" vs search "United Kingdom").
  //    IMPORTANT: no named inner functions — esbuild wraps them with __name()
  //    which does not exist inside page.$eval's browser sandbox.
  const optVal = await page.$eval<string, string>(
    selector,
    (el, v) => {
      // Inline normaliser: Turkish İ → i, NFD decompose, strip combining diacritics, lowercase
      const nv = v.replace(/\u0130/gi, "i").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
      const sel = el as HTMLSelectElement;
      const opt = Array.from(sel.options).find((o) => {
        const nt = o.text.replace(/\u0130/gi, "i").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        return nt.includes(nv) || nv.includes(nt);
      });
      return opt?.value ?? "";
    },
    value,
  );
  if (optVal && optVal !== "0") {
    // Use jQuery val+trigger so hidden select2 widgets repaint correctly
    await setSelectByValue(page, selector, optVal);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Select the first "real" option of a <select> (non-empty, non-"0" value).
// Used by listPrograms() to satisfy required country dropdowns with any valid
// value when probing the program list (the actual value is irrelevant there).
// ---------------------------------------------------------------------------
async function selectFirstRealOption(
  page: Page,
  selector: string,
): Promise<boolean> {
  const val = await page
    .$eval(selector, (el) => {
      const sel = el as HTMLSelectElement;
      const opt = Array.from(sel.options).find(
        (o) => o.value && o.value !== "0" && o.value !== "",
      );
      return opt?.value ?? "";
    })
    .catch(() => "");
  if (!val) return false;
  await page.selectOption(selector, { value: val }).catch(() => {});
  return true;
}

// ---------------------------------------------------------------------------
// Fire native + jQuery "change" so select2 / jQuery-bound widgets sync to a
// value that was set programmatically. Playwright's selectOption()/fill() sets
// the underlying native control, but the select2 (twopulse-select2) rendered
// widget only updates when jQuery's change handler runs — without this the
// portal keeps the field visually/server-side EMPTY. Mirrors the proven Step 2
// country pattern used elsewhere in this adapter.
// ---------------------------------------------------------------------------
async function syncChange(page: Page, selector: string): Promise<void> {
  await page
    .evaluate((sel) => {
      const e = document.querySelector(sel);
      if (!e) return;
      e.dispatchEvent(new Event("input", { bubbles: true }));
      e.dispatchEvent(new Event("change", { bubbles: true }));
      const w = window as unknown as {
        jQuery?: (el: Element) => { trigger: (ev: string) => void };
      };
      if (w.jQuery) w.jQuery(e).trigger("change");
    }, selector)
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Diagnose the real DOM widget for the first present selector and log it. The
// returned `type` (lowercased input type, or tagName for non-inputs) lets the
// caller format values for the actual widget (e.g. a native date picker).
// ---------------------------------------------------------------------------
async function describeInput(
  page: Page,
  selectors: string[],
  label: string,
  logger: typeof import("../../browser.js").logger,
): Promise<{ type: string; desc: string }> {
  let sel = "";
  for (const s of selectors) {
    if (await page.locator(s).count()) {
      sel = s;
      break;
    }
  }
  if (!sel) {
    logger.warn(`[topkapi] Step 3 DOM: ${label} — no element found`);
    return { type: "", desc: "(not found)" };
  }
  const info = await page
    .$eval(sel, (el) => {
      const e = el as HTMLInputElement;
      return {
        tag: e.tagName.toLowerCase(),
        type: (e.getAttribute("type") || "").toLowerCase(),
        placeholder: e.getAttribute("placeholder") || "",
        readOnly: e.readOnly === true,
        cls: (e.getAttribute("class") || "").slice(0, 60),
      };
    })
    .catch(() => null);
  if (!info) {
    logger.warn(`[topkapi] Step 3 DOM: ${label} — could not read element`);
    return { type: "", desc: "(unreadable)" };
  }
  const type = info.tag === "input" ? info.type || "text" : info.tag;
  const desc =
    `tag=${info.tag} type=${info.type || "(none)"}` +
    (info.readOnly ? " readonly" : "") +
    (info.placeholder ? ` placeholder="${info.placeholder}"` : "") +
    (info.cls ? ` class="${info.cls}"` : "");
  logger.info(`[topkapi] Step 3 DOM: ${label} ${desc}`);
  return { type, desc };
}

// ---------------------------------------------------------------------------
// Dump every Step-3 dependent field the portal AJAX-renders after the education
// level is selected (name family `applicationEducationInformation*` plus the
// legacy bare names). Logs name/tag/type for each — definitive evidence for the
// next dry-run if a fill selector still misses. Best-effort; never throws.
// ---------------------------------------------------------------------------
async function logEduDependents(
  page: Page,
  logger: typeof import("../../browser.js").logger,
): Promise<void> {
  const fields = await page
    .$$eval(
      '[name^="applicationEducationInformation"], input[name="schoolName[]"], input[name="GPA[]"], input[name="GraduationDate[]"], select[name="country[]"]',
      (els) =>
        els.map((el) => {
          const e = el as HTMLInputElement;
          return {
            name: e.getAttribute("name") || "",
            tag: e.tagName.toLowerCase(),
            type: (e.getAttribute("type") || "").toLowerCase(),
          };
        }),
    )
    .catch(() => [] as Array<{ name: string; tag: string; type: string }>);
  if (fields.length === 0) {
    logger.warn(
      "[topkapi] Step 3 dependents: no applicationEducationInformation* fields found",
    );
    return;
  }
  logger.info(
    `[topkapi] Step 3 dependents: ${fields
      .map((f) => `${f.name}(${f.tag}${f.type ? ":" + f.type : ""})`)
      .join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Read the current .value of an input/select (trimmed; "" on miss).
// ---------------------------------------------------------------------------
async function readValue(page: Page, selector: string): Promise<string> {
  return page
    .$eval(selector, (el) =>
      ((el as HTMLInputElement | HTMLSelectElement).value ?? "").trim(),
    )
    .catch(() => "");
}

// ---------------------------------------------------------------------------
// Read a <select>'s full option list ({value,text}). Casts to HTMLSelectElement
// so .options is typed; returns [] when the element is absent.
// ---------------------------------------------------------------------------
async function readSelectOptions(
  page: Page,
  selector: string,
): Promise<{ value: string; text: string }[]> {
  return page
    .$eval(selector, (el) => {
      const s = el as HTMLSelectElement;
      return Array.from(s.options).map((o) => ({
        value: o.value,
        text: (o.text || "").trim(),
      }));
    })
    .catch(() => [] as { value: string; text: string }[]);
}

// ---------------------------------------------------------------------------
// Read a <select>'s currently-selected {value,text,index}. Works on a select2
// because select2 keeps the underlying native <select> in sync.
// ---------------------------------------------------------------------------
async function readSelectChoice(
  page: Page,
  selector: string,
): Promise<{ value: string; text: string; index: number }> {
  return page
    .$eval(selector, (el) => {
      const s = el as HTMLSelectElement;
      const i = s.selectedIndex;
      const o = i >= 0 ? s.options[i] : null;
      return {
        value: (s.value || "").trim(),
        text: (o ? o.text : "").trim(),
        index: i,
      };
    })
    .catch(() => ({ value: "", text: "", index: -1 }));
}

// ---------------------------------------------------------------------------
// Set a <select> to an exact option VALUE in-page and fire change. Uses
// jQuery.val().trigger("change") when present so a HIDDEN select2 widget repaints
// its visible chip and runs its AJAX change handler (page.selectOption() can't
// click a display:none select2). Falls back to native value + dispatched events.
// ---------------------------------------------------------------------------
async function setSelectByValue(
  page: Page,
  selector: string,
  value: string,
): Promise<void> {
  await page
    .evaluate(
      (arg) => {
        const s = document.querySelector(arg.sel) as HTMLSelectElement | null;
        if (!s) return;
        const idx = Array.from(s.options).findIndex((o) => o.value === arg.val);
        if (idx < 0) return;
        s.selectedIndex = idx;
        s.value = arg.val;
        s.dispatchEvent(new Event("input", { bubbles: true }));
        s.dispatchEvent(new Event("change", { bubbles: true }));
        const w = window as unknown as {
          jQuery?: (el: Element) => {
            val: (v: string) => { trigger: (ev: string) => void };
          };
        };
        if (w.jQuery) w.jQuery(s).val(arg.val).trigger("change");
      },
      { sel: selector, val: value },
    )
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Diagnose the REAL Step-3 dropdown widget BEFORE selecting: select2 detection,
// option list, and outerHTML. This is what tells us why a value "won't stick".
// ---------------------------------------------------------------------------
async function logEduWidget(
  page: Page,
  selector: string,
  label: string,
  logger: typeof import("../../browser.js").logger,
): Promise<void> {
  const info = await page
    .evaluate((sel) => {
      const s = document.querySelector(sel) as HTMLSelectElement | null;
      if (!s) return null;
      const sib = s.nextElementSibling as HTMLElement | null;
      const isSelect2 =
        s.classList.contains("select2-hidden-accessible") ||
        (!!sib && (sib.className || "").indexOf("select2") >= 0) ||
        !!(s.parentElement && s.parentElement.querySelector(".select2-container"));
      const opts = Array.from(s.options).map(
        (o) => `${o.value}::${(o.text || "").trim()}`,
      );
      return {
        tag: s.tagName.toLowerCase(),
        cls: (s.getAttribute("class") || "").slice(0, 100),
        isSelect2,
        optCount: s.options.length,
        opts: opts.slice(0, 30),
        outerHTML: s.outerHTML.slice(0, 400),
      };
    }, selector)
    .catch(() => null);
  if (!info) {
    logger.warn(`[topkapi] Step 3 widget: ${label} — element not found`);
    return;
  }
  logger.info(
    `[topkapi] Step 3 widget: ${label} tag=${info.tag} select2=${info.isSelect2} optCount=${info.optCount} class="${info.cls}"`,
  );
  logger.info(
    `[topkapi] Step 3 widget: ${label} options=${JSON.stringify(info.opts)}`,
  );
  logger.info(`[topkapi] Step 3 widget: ${label} outerHTML=${info.outerHTML}`);
}

// ---------------------------------------------------------------------------
// Select a <select>/select2 by trying ordered label CANDIDATES against the real
// option texts (exact fold match first, then substring), set it in-page, fire
// change, and verify the read-back is NOT a placeholder ("Seçim Yapın"). Retries
// once. Returns the final option text ("" if nothing stuck) so the caller can
// hard-fail instead of submitting blanks. With diagnose=true the widget is
// logged first (used for the education-level dropdown).
// ---------------------------------------------------------------------------
async function selectByCandidatesVerified(
  page: Page,
  selector: string,
  candidates: string[],
  label: string,
  logger: typeof import("../../browser.js").logger,
  diagnose = false,
): Promise<string> {
  if (diagnose) await logEduWidget(page, selector, label, logger);
  const options = await readSelectOptions(page, selector);
  if (options.length === 0) {
    logger.warn(`[topkapi] Step 3 ${label}: no <select> options found`);
    return "";
  }
  // Skip index 0 (the placeholder option) when matching. Match candidates
  // against BOTH the option VALUE and the visible TEXT (folded): the
  // education-level select2 carries English degree keys as option VALUES
  // ("Bachelor") with Turkish labels as TEXT ("Lisans"), while country uses a
  // numeric VALUE ("162") with the country name as TEXT ("Pakistan").
  const folded = options.map((o, i) => ({
    ...o,
    i,
    ft: fold(o.text),
    fv: fold(o.value),
  }));
  const pickable = (o: { i: number; value: string }) =>
    o.i > 0 && !!o.value && o.value !== "0";
  for (let attempt = 1; attempt <= 2; attempt++) {
    for (const cand of candidates) {
      const cf = fold(cand);
      if (!cf) continue;
      const match =
        folded.find((o) => pickable(o) && (o.fv === cf || o.ft === cf)) ||
        folded.find(
          (o) => pickable(o) && (o.fv.includes(cf) || o.ft.includes(cf)),
        );
      if (!match) continue;
      await setSelectByValue(page, selector, match.value);
      await syncChange(page, selector);
      const choice = await readSelectChoice(page, selector);
      if (!isPlaceholderChoice(choice.value, choice.text)) {
        logger.info(
          `[topkapi] Step 3 verified: ${label}=${choice.text} (value=${choice.value}) via "${cand}"`,
        );
        return choice.text;
      }
    }
    logger.warn(
      `[topkapi] Step 3 ${label} not set after attempt ${attempt} — retrying`,
    );
  }
  logger.warn(
    `[topkapi] Step 3 verified: ${label}=(empty) — tried [${candidates.join(", ")}] vs options [${options
      .map((o) => o.text)
      .filter(Boolean)
      .slice(0, 20)
      .join(", ")}]`,
  );
  return "";
}

// ---------------------------------------------------------------------------
// Fill the first present text input among `selectors`, fire change, read back;
// retry once. Logs "Step 3 verified: <label>=<value>". Returns final value.
// ---------------------------------------------------------------------------
async function fillVerified(
  page: Page,
  selectors: string[],
  value: string,
  logger: typeof import("../../browser.js").logger,
  label: string,
): Promise<string> {
  let sel = "";
  for (const s of selectors) {
    if (await page.locator(s).count()) {
      sel = s;
      break;
    }
  }
  if (!sel) {
    logger.warn(`[topkapi] Step 3 ${label}: no input found`);
    return "";
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    await page.fill(sel, value).catch(() => {});
    await syncChange(page, sel);
    const v = await readValue(page, sel);
    if (v) {
      logger.info(`[topkapi] Step 3 verified: ${label}=${v}`);
      return v;
    }
    logger.warn(
      `[topkapi] Step 3 ${label} empty after attempt ${attempt} — retrying`,
    );
  }
  logger.warn(`[topkapi] Step 3 verified: ${label}=(empty)`);
  return "";
}

// ---------------------------------------------------------------------------
// Locate the VISIBLE instance of a repeatable (`name="...[]"`) education-row
// input. The portal keeps a hidden template row alongside the real one, so a
// bare querySelector/page.fill targets the template and the read-back is always
// empty. Scans every selector's matches, logs count + visible index (confirms
// the hidden-template theory), and returns the first visible element handle
// (falling back to the first match when none report visible).
// ---------------------------------------------------------------------------
async function locateVisibleInput(
  page: Page,
  selectors: string[],
  label: string,
  logger: typeof import("../../browser.js").logger,
): Promise<Locator | null> {
  let fallback: Locator | null = null;
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const count = await loc.count().catch(() => 0);
    if (count === 0) continue;
    let visibleIndex = -1;
    for (let i = 0; i < count; i++) {
      if (await loc.nth(i).isVisible().catch(() => false)) {
        visibleIndex = i;
        break;
      }
    }
    logger.info(
      `[topkapi] Step 3 instances: ${label} sel="${sel}" count=${count} visibleIndex=${visibleIndex}`,
    );
    if (visibleIndex >= 0) return loc.nth(visibleIndex);
    if (!fallback) fallback = loc.first();
  }
  if (!fallback) logger.warn(`[topkapi] Step 3 ${label}: no input found`);
  return fallback;
}

// ---------------------------------------------------------------------------
// Set a text input's value via real DOM events (focus → value → input+change
// (bubbles) → blur). Needed for twopulse-bound inputs where a plain assignment
// or page.fill doesn't notify the framework, so the field reverts to empty.
// ---------------------------------------------------------------------------
async function setValueViaEvents(loc: Locator, value: string): Promise<void> {
  await loc
    .evaluate((el, val) => {
      const input = el as HTMLInputElement;
      input.focus();
      input.value = val as string;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    }, value)
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// Fill the VISIBLE instance of a repeatable text input and verify the read-back
// on the SAME element handle (not a fresh querySelector, which hits the hidden
// template). Tries Playwright's locator.fill() first (dispatches proper input/
// change), then falls back to explicit event dispatch; retries once. For a
// datepicker the calendar overlay is dismissed (Escape) so it can't block later
// steps. Returns the final value ("" on failure — caller's gate still throws).
// ---------------------------------------------------------------------------
async function fillVisibleVerified(
  page: Page,
  selectors: string[],
  value: string,
  logger: typeof import("../../browser.js").logger,
  label: string,
  opts: { datepicker?: boolean } = {},
): Promise<string> {
  const loc = await locateVisibleInput(page, selectors, label, logger);
  if (!loc) {
    logger.warn(`[topkapi] Step 3 verified: ${label}=(empty)`);
    return "";
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (opts.datepicker) {
      await loc.click({ timeout: 3000 }).catch(() => {});
      await setValueViaEvents(loc, value);
      await page.keyboard.press("Escape").catch(() => {});
    } else {
      await loc.fill(value, { timeout: 5000 }).catch(() => {});
    }
    let v = (await loc.inputValue().catch(() => "")).trim();
    if (!v) {
      // Fallback: framework-style event dispatch for twopulse-bound inputs.
      await setValueViaEvents(loc, value);
      v = (await loc.inputValue().catch(() => "")).trim();
    }
    if (v) {
      logger.info(`[topkapi] Step 3 verified: ${label}=${v}`);
      return v;
    }
    logger.warn(
      `[topkapi] Step 3 ${label} empty after attempt ${attempt} — retrying`,
    );
  }
  logger.warn(`[topkapi] Step 3 verified: ${label}=(empty)`);
  return "";
}

// ---------------------------------------------------------------------------
// Log a datepicker input's outerHTML + data-* attributes (esp. data-date-format)
// from its VISIBLE instance, and return the detected date format ("" if none).
// Drives formatGraduationForDatepicker so the value matches what the widget
// accepts instead of guessing.
// ---------------------------------------------------------------------------
async function readDatepickerFormat(
  page: Page,
  selectors: string[],
  logger: typeof import("../../browser.js").logger,
): Promise<string> {
  const loc = await locateVisibleInput(page, selectors, "graduationDate", logger);
  if (!loc) return "";
  const info = await loc
    .evaluate((el) => {
      const e = el as HTMLInputElement;
      const data: Record<string, string> = {};
      for (const a of Array.from(e.attributes)) {
        if (a.name.startsWith("data-")) data[a.name] = a.value;
      }
      return {
        outer: e.outerHTML.slice(0, 300),
        dateFormat:
          e.getAttribute("data-date-format") ||
          e.getAttribute("data-format") ||
          data["data-date-format"] ||
          "",
        data,
      };
    })
    .catch(() => null);
  if (!info) return "";
  logger.info(
    `[topkapi] Step 3 datepicker: dateFormat="${info.dateFormat}" data=${JSON.stringify(
      info.data,
    )} outer=${info.outer}`,
  );
  return info.dateFormat;
}

// ---------------------------------------------------------------------------
// Ensure at least one education-history row exists. Some portal configs start
// with zero rows and require clicking the green "Eğitim Geçmişi Ekle" button
// before the row's fields exist. No-op when a row is already present (the
// common case — the wizard renders one by default).
// ---------------------------------------------------------------------------
async function ensureEducationRow(
  page: Page,
  logger: typeof import("../../browser.js").logger,
): Promise<void> {
  const rowSel =
    'select[name="applicationEducationInformationEducationLevel[]"], input[name="schoolName[]"], input[name=schoolName]';
  if (await page.locator(rowSel).count()) return;
  logger.info(
    "[topkapi] Step 3: no education row present — clicking add-row button",
  );
  const addBtn = page
    .getByRole("button", {
      name: /E[ğg]itim Ge[çc]mi[şs]i.*Ekle|Ge[çc]mi[şs]i Ekle|Add.*Education|Education.*Add/i,
    })
    .first();
  if (await addBtn.count()) {
    await addBtn.click({ force: true }).catch(() => {});
    await page.waitForSelector(rowSel, { timeout: 5000 }).catch(() => {});
  } else {
    logger.warn("[topkapi] Step 3: add-row button not found");
  }
}

// ---------------------------------------------------------------------------
// Screenshot helper — writes a viewport PNG to /tmp and returns the path.
// Gated behind PORTAL_DEBUG=1; in production (no flag) returns null immediately
// so no files accumulate in /tmp. Returns null and logs a warning on any
// failure (non-fatal).
// ---------------------------------------------------------------------------
async function takeShot(page: Page, step: string): Promise<string | null> {
  if (process.env.PORTAL_DEBUG !== "1") return null;
  try {
    const p = path.join(
      os.tmpdir(),
      `portal-shot-na-${step}-${Date.now()}.png`,
    );
    await page.screenshot({ path: p, fullPage: false });
    return p;
  } catch (err) {
    logger.warn(`[topkapi] screenshot failed at step=${step}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Language — switch the portal UI to English BEFORE any program discovery so
// Step-4 program labels arrive in English (e.g.
// "International Trade and Business - English (Bachelor)"), giving near-exact
// matches against CRM English program names and recovering English-track
// programs that read as "not found" while the portal was in Turkish.
//
// Fully idempotent (skips when already English) and NON-FATAL: if the switch
// cannot be performed the run continues in the current language and the matcher
// falls back to its EN↔TR synonym dictionary exactly as before.
// ---------------------------------------------------------------------------

/**
 * Cheap, idempotent check: is the panel/form UI currently rendered in English?
 *
 * The portal's language switch is client-side and does NOT reliably update
 * <html lang>, so the RENDERED CONTENT is the ground truth. We compare the count
 * of well-known Turkish vs English UI words (including the five wizard step
 * titles, which are the strongest discriminators) and only fall back to
 * <html lang> when the content comparison is an exact tie.
 *
 * Written as a string-literal evaluate so esbuild's keep-names (`__name`) does
 * not wrap inner functions — that helper does not exist in the browser sandbox.
 */
async function isEnglishUI(page: Page): Promise<boolean> {
  return (await page.evaluate(`(function () {
    var htmlLang = (document.documentElement.getAttribute("lang") || "").trim().toLowerCase();
    var txt = (document.body ? document.body.innerText : "").toLowerCase();
    var tr = [
      "sonraki adım", "başvuruyu tamamla", "program bilgileri", "program seçimi",
      "eğitim bilgileri", "kişisel bilgiler", "ön kontrol", "belgeler",
      "başvuru", "çıkış", "kaydet", "öğrenci", "giriş"
    ];
    var en = [
      "next step", "complete application", "program choice", "program information",
      "education info", "personal info", "pre check", "documents",
      "application", "logout", "save", "student", "login"
    ];
    var trHits = 0, enHits = 0, i;
    for (i = 0; i < tr.length; i++) { if (txt.indexOf(tr[i]) >= 0) trHits++; }
    for (i = 0; i < en.length; i++) { if (txt.indexOf(en[i]) >= 0) enHits++; }
    if (enHits > trHits) return true;
    if (trHits > enHits) return false;
    if (htmlLang.indexOf("en") === 0) return true;
    if (htmlLang.indexOf("tr") === 0) return false;
    return false;
  })()`)) as boolean;
}

/**
 * Discover and activate an English language switch in the CURRENT page.
 * Adaptive (scans the live DOM rather than hard-coding a single selector) so it
 * survives theme markup changes. Returns true when a switch action was
 * performed (the caller verifies the result via isEnglishUI).
 */
async function clickEnglishSwitchInPage(page: Page): Promise<boolean> {
  // String-literal evaluate: esbuild's keep-names wraps inner arrow/named
  // functions with `__name`, which does not exist in the browser sandbox and
  // would throw here — silently killing this fallback in the bundled worker.
  return (await page.evaluate(`(function () {
    function norm(s) {
      return (s || "")
        .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
        .toLowerCase().trim();
    }

    // Best-effort: open any language-menu toggles first so on-demand menus
    // render their English entry (clicking a toggle is harmless).
    var toggles = document.querySelectorAll(
      "[data-kt-menu-trigger], .language-switch, .lang-switch, [class*='language'] [data-bs-toggle], [class*='lang'] [data-bs-toggle]"
    );
    for (var ti = 0; ti < toggles.length; ti++) {
      try { toggles[ti].click(); } catch (e) { /* ignore */ }
    }

    var clickables = document.querySelectorAll(
      "a, button, [role='menuitem'], [data-kt-lang], [data-lang], li[data-value], option"
    );

    function scoreEnglish(el) {
      var text = norm(el.textContent);
      var href = norm(el.getAttribute("href"));
      var dataLang = norm(
        el.getAttribute("data-kt-lang") ||
          el.getAttribute("data-lang") ||
          el.getAttribute("data-value") ||
          el.getAttribute("hreflang") ||
          el.getAttribute("lang")
      );
      var score = 0;
      if (dataLang === "en" || dataLang === "english") score += 100;
      if (
        /(?:^|[\\/=?&])lang(?:uage)?[=\\/]en(?![a-z])/.test(href) ||
        /(?:^|[\\/=?&])locale[=\\/]en(?![a-z])/.test(href)
      ) {
        score += 90;
      }
      if (text === "english" || text === "en") score += 60;
      // A short label containing "english" (e.g. a flag menu item) — but never a
      // long program name like "English Language and Literature".
      if (/\\benglish\\b/.test(text) && text.length <= 24) score += 25;
      return score;
    }

    var best = null;
    var bestScore = 0;
    for (var i = 0; i < clickables.length; i++) {
      var s = scoreEnglish(clickables[i]);
      if (s > bestScore) { bestScore = s; best = clickables[i]; }
    }
    if (!best || bestScore < 60) return false;

    if (best.tagName === "OPTION") {
      var sel = best.closest("select");
      if (sel) {
        sel.value = best.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }
    try { best.click(); return true; } catch (e2) { return false; }
  })()`)) as boolean;
}

/**
 * Poll isEnglishUI() for a few seconds after a switch click. The portal's
 * language switch is client-side (no full reload / navigation event), so the
 * English re-render can land a tick or two after the click — a single immediate
 * check is racy and returns a false negative.
 */
async function waitForEnglish(page: Page): Promise<boolean> {
  await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await isEnglishUI(page).catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(250);
  }
}

/**
 * Diagnostic: log the candidate language-switcher markup from the top bar so the
 * exact selector can be pinned from a live dry-run when the heuristic click
 * misses. Emitted only once per switch attempt (when the UI is not yet English).
 * String-literal evaluate to stay clear of esbuild's `__name` wrapping.
 */
async function dumpLanguageSwitcher(page: Page): Promise<void> {
  try {
    const info = await page.evaluate(`(function () {
      var out = [];
      var nodes = document.querySelectorAll(
        "a, button, [role='menuitem'], [data-kt-lang], [data-lang], [class*='lang'], [class*='language']"
      );
      for (var i = 0; i < nodes.length && out.length < 25; i++) {
        var el = nodes[i];
        var t = (el.textContent || "").replace(/\\s+/g, " ").trim();
        if (t.length > 40) t = t.slice(0, 40);
        var href = (el.getAttribute("href") || "").slice(0, 60);
        var cls = (el.getAttribute("class") || "").slice(0, 60);
        var img = el.querySelector ? el.querySelector("img") : null;
        var flag = img ? (img.getAttribute("src") || "").slice(0, 60) : "";
        var hay = (t + " " + href + " " + cls + " " + flag).toLowerCase();
        if (/lang|locale|english|ingilizce|turkce|türkçe|flag/.test(hay)) {
          out.push({ tag: el.tagName, text: t, href: href, cls: cls, flag: flag });
        }
      }
      return JSON.stringify({
        htmlLang: document.documentElement.getAttribute("lang") || "",
        url: location.href,
        candidates: out
      });
    })()`);
    logger.info("[topkapi] language switcher DOM:", info);
  } catch (e) {
    logger.warn("[topkapi] language switcher dump failed:", (e as Error).message);
  }
}

/**
 * Open the top-right language menu (flag + dropdown) with a REAL Playwright
 * click so the theme's (Metronic/Bootstrap) framework handlers fire and an
 * animated dropdown gets time to paint its items before we look for "English".
 * Best-effort: tries several trigger shapes, most-specific first. Never throws.
 */
async function openLanguageMenu(page: Page): Promise<void> {
  const triggerCandidates: Locator[] = [
    // VERIFIED (live DOM): the trigger is a top-right flag + text showing the
    // CURRENT language autonym ("Türkçe" while Turkish, "English" once English),
    // and it is NOT necessarily a button/link — it can be a plain <span>/<div>.
    // Match by visible text inside the header so a text-only trigger is caught.
    page
      .locator("header, .app-header, .header, #kt_app_header, [class*='header']")
      .getByText(/^\s*(English|Türkçe|İngilizce|Turkish)\s*$/i),
    // Metronic KT dropdown toggle carrying a country flag — the usual switcher.
    page.locator("[data-kt-menu-trigger]").filter({
      has: page.locator("img[src*='flag'], img[src*='flags']"),
    }),
    // Any header/topbar/nav clickable that contains a flag image (top-right).
    page
      .locator(
        "header a, header button, .app-header a, .app-header button, " +
          ".app-navbar a, .app-navbar button, .topbar a, .topbar button, " +
          "nav a, nav button",
      )
      .filter({ has: page.locator("img[src*='flag'], img[src*='flags']") }),
    // A clickable whose WHOLE label is a language autonym / short code.
    page.getByRole("button", { name: /^\s*(türkçe|turkce|english|ingilizce|tr|en)\s*$/i }),
    page.getByRole("link", { name: /^\s*(türkçe|turkce|english|ingilizce|tr|en)\s*$/i }),
    // Generic language-classed toggles.
    page.locator(
      ".language-switch, .lang-switch, [class*='language'] [data-bs-toggle], " +
        "[class*='lang'] [data-bs-toggle], [class*='language'] [data-kt-menu-trigger]",
    ),
  ];
  for (const cand of triggerCandidates) {
    // Iterate ALL matches and click the first VISIBLE one (the text trigger can
    // resolve to a hidden template alongside the real top-right switcher).
    let els: Locator[];
    try {
      els = await cand.all();
    } catch { continue; }
    for (const el of els) {
      try {
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ timeout: 3000 });
        // Give an animated dropdown time to render its language entries.
        await page.waitForTimeout(500);
        return;
      } catch { /* try next matching element */ }
    }
  }
}

/**
 * Click a visible "English" entry using real Playwright locators. Returns true
 * when a click was dispatched (the caller verifies the effect via isEnglishUI).
 * Text matches are anchored to the WHOLE element label (^english$ / ^ingilizce$)
 * so they never catch a long programme name like "English Language and
 * Literature". Attribute/route-based candidates come first as they are the most
 * robust and language-agnostic.
 */
async function clickEnglishOption(page: Page): Promise<boolean> {
  const optionCandidates: Locator[] = [
    // VERIFIED (live DOM): the menu entry is a real <a> link whose exact text is
    // "English" (href="javascript:;", client-side handler). Try it first.
    page.getByRole("link", { name: /^\s*english\s*$/i }),
    // Explicit locale data-attributes / hreflang (most robust, language-agnostic).
    page.locator("[data-kt-lang='en'], [data-lang='en'], a[hreflang='en']"),
    // Locale routes encoded in the href.
    page.locator(
      "a[href*='lang=en'], a[href*='/lang/en'], a[href*='locale=en'], " +
        "a[href*='/locale/en'], a[href*='language=en'], a[href*='/language/en']",
    ),
    // Menu item / link / button whose whole label is the English autonym
    // ("English") or the Turkish word for it ("İngilizce").
    page.getByRole("menuitem", { name: /^\s*(english|ingilizce)\s*$/i }),
    page.getByRole("link", { name: /^\s*(english|ingilizce)\s*$/i }),
    page.getByRole("button", { name: /^\s*(english|ingilizce)\s*$/i }),
    // Any clickable whose ENTIRE text is English/İngilizce (excludes programmes).
    page
      .locator("a, button, li, [role='menuitem']")
      .filter({ hasText: /^\s*(english|ingilizce)\s*$/i }),
    // Flag image explicitly labelled English inside a clickable.
    page
      .locator("a, button, [role='menuitem']")
      .filter({ has: page.locator("img[alt*='English' i], img[title*='English' i]") }),
  ];
  for (const cand of optionCandidates) {
    // Iterate ALL matches, not just .first(): the portal renders a hidden
    // template <a>English</a> alongside the visible menu entry, and .first()
    // may resolve to the hidden one — skipping the whole candidate.
    let els: Locator[];
    try {
      els = await cand.all();
    } catch { continue; }
    for (const el of els) {
      try {
        if (!(await el.isVisible().catch(() => false))) continue;
        await el.click({ timeout: 3000 });
        return true;
      } catch { /* try next matching element */ }
    }
  }
  return false;
}

interface EnsureEnglishOpts {
  /**
   * When true, throw an explicit error if the UI could not be confirmed English
   * after a retry (used on the program-discovery path so we never submit through
   * a Turkish dropdown). When false (login pre-warm) the switch is best-effort.
   */
  fatal?: boolean;
  /**
   * Page to re-land on after a navigating strategy (locale-URL GET). The form
   * path passes the /add URL so a server-side locale switch re-renders the form
   * in English; the login path passes /panel.
   */
  returnTo?: string;
  /** Short label included in every log line to identify the call site. */
  context?: string;
}

/**
 * Ensure the portal UI is rendered in English. Idempotent. Must be called on a
 * page that carries the top-right language switcher (the /panel dashboard AND
 * every /panel/applications/add wizard page do).
 *
 * IMPORTANT — a fresh navigation to /add reverts to the account's default
 * (Turkish), so this MUST be re-run on the form page itself, not only once after
 * login. On the program-discovery path pass { fatal: true }: an English-only
 * (or renamed) programme is missing/wrong in the Turkish dropdown, so continuing
 * in Turkish risks the wrong application — we stop hard instead.
 *
 * Required log contract (relied on by ops when reading the worker log):
 *   [topkapi] language: switching to English…
 *   [topkapi] language: confirmed English            (success)
 *   [topkapi] language: SWITCH FAILED (still Turkish) (failure)
 */
async function ensureEnglishLanguage(
  page: Page,
  opts: EnsureEnglishOpts = {},
): Promise<void> {
  const { fatal = false, returnTo, context } = opts;
  const tag = context ? ` (${context})` : "";

  // Proof-of-entry: if this line is ABSENT from the live worker log, the call
  // site was never reached (dead/guarded path). Emitted before anything else.
  logger.info(
    `[topkapi] ensureEnglishLanguage() ENTER url=${page.url()}${tag} fatal=${fatal}`,
  );

  try {
    if (await isEnglishUI(page)) {
      logger.info(`[topkapi] language: already English${tag} — skipping switch`);
      return;
    }
  } catch { /* detection best-effort */ }

  logger.info(`[topkapi] language: switching to English…${tag}`);
  // One-shot diagnostic so the real switcher markup shows up in a live dry-run
  // whenever the heuristic click below misses.
  await dumpLanguageSwitcher(page);

  // Two passes of the IN-PLACE strategies (the switch is client-side, so we
  // verify by polling the rendered UI rather than waiting on a navigation).
  for (let attempt = 0; attempt < 2; attempt++) {
    // Strategy A — REAL interaction with the top-right flag/language menu.
    try {
      await openLanguageMenu(page);
      if (await clickEnglishOption(page)) {
        if (await waitForEnglish(page)) {
          logger.info(`[topkapi] language: confirmed English${tag} (top-right menu)`);
          return;
        }
      }
    } catch (e) {
      logger.warn(`[topkapi] language menu interaction failed${tag}:`, (e as Error).message);
    }

    // Strategy B — in-page DOM heuristic (unusual switcher markup).
    try {
      if (await clickEnglishSwitchInPage(page)) {
        if (await waitForEnglish(page)) {
          logger.info(`[topkapi] language: confirmed English${tag} (DOM heuristic)`);
          return;
        }
      }
    } catch (e) {
      logger.warn(`[topkapi] language switch (DOM heuristic) failed${tag}:`, (e as Error).message);
    }
  }

  // Strategy C — common Laravel/Metronic locale routes (GET). Only effective
  // when the preference is server-side; afterwards we re-land on the caller's
  // page and verify THERE, so a client-side-only default cannot masquerade as a
  // successful switch.
  const localeUrls = [
    `${PORTAL_URL}/panel?lang=en`,
    `${PORTAL_URL}/lang/en`,
    `${PORTAL_URL}/locale/en`,
    `${PORTAL_URL}/language/en`,
  ];
  for (const url of localeUrls) {
    try {
      // domcontentloaded/60s (not networkidle/30s): this SPA's slow AJAX
      // polling can keep the network non-idle well past 30s even on a normal
      // load, which was surfacing as spurious "page.goto Timeout 30000ms"
      // failures. The candidate-URL loop above/below already gives this a
      // natural retry across `localeUrls` on failure.
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (returnTo) {
        await page.goto(returnTo, { waitUntil: "domcontentloaded", timeout: 60000 });
      }
      if (await isEnglishUI(page).catch(() => false)) {
        logger.info(
          `[topkapi] language: confirmed English${tag} (via ${url}` +
            (returnTo ? ` → ${returnTo}` : "") + ")",
        );
        return;
      }
    } catch { /* try next candidate */ }
  }

  logger.error(
    `[topkapi] language: SWITCH FAILED (still Turkish)${tag} — URL=${page.url()}`,
  );

  if (fatal) {
    throw new Error(
      "Topkapı: portal dili İngilizce'ye çevrilemedi (SWITCH FAILED still Turkish) — " +
        "Türkçe arayüzde İngilizce-öğretimli programlar eksik/yanlış listelendiği için " +
        "yanlış başvuru riskiyle durduruldu.",
    );
  }

  // Non-fatal (login pre-warm): restore a stable page so later navigation works.
  try {
    await page.goto(returnTo ?? `${PORTAL_URL}/panel`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// GPA → Topkapı's 0-100 percentage scale
//
// The CRM stores GPA as free-form text and normalizeGpaRange() in profile.ts
// converts it to the FIRST numeric token (e.g. "2.80/4" → 2.80). Topkapı's
// portal rejects values ≤10 (they look nonsensical on a 0-100 scale and the
// portal shows "unparseable GPA" or "Please check fields"). This function
// auto-scales to 0-100 using the same heuristic as api-server/gpaNormalize.ts:
//   ≤4  → × 100/4   (4-point scale: 3.5 → 87.50)
//   ≤5  → × 100/5   (5-point scale: 4.2 → 84.00)
//   ≤10 → × 100/10  (10-point: 8.5 → 85.00)
//   ≤20 → × 100/20  (20-point: 15  → 75.00)
//   >20 → as-is     (already 0-100: 78.66 → 78.66)
//
// Returns "-" when gpa is undefined/missing; never throws.
// ---------------------------------------------------------------------------
function topkapiGpaTo100(gpa: number | undefined): string {
  if (gpa == null || !Number.isFinite(gpa)) return "-";
  let pct: number;
  if      (gpa <= 4)  pct = (gpa / 4)  * 100;
  else if (gpa <= 5)  pct = (gpa / 5)  * 100;
  else if (gpa <= 10) pct = (gpa / 10) * 100;
  else if (gpa <= 20) pct = (gpa / 20) * 100;
  else                pct = gpa;
  return String(Math.round(pct * 100) / 100);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------
export const topkapiAdapter: UniversityAdapter = {
  key:   "topkapi",
  label: "İstanbul Topkapı Üniversitesi",

  matches(name: string): boolean {
    const f = name
      .replace(/İ/g, "i")
      .replace(/I/g, "i")
      .replace(/ı/g, "i")
      .toLowerCase();
    return f.includes("topkapi") || f.includes("topkap");
  },

  // -------------------------------------------------------------------------
  // login
  // -------------------------------------------------------------------------
  async login(opts?: LoginOpts): Promise<AdapterSession> {
    const { user, password } = opts?.credentials ?? portalCreds("topkapi");

    const storagePath = existsSync(STORAGE_PATH) ? STORAGE_PATH : undefined;
    const session = await launchPortal({
      headless: opts?.headless ?? true,
      storagePath,
    });
    const { page } = session;

    logger.info("[topkapi] login — navigating to panel");
    await gotoWithRetry(page, `${PORTAL_URL}/panel`);

    if (page.url().includes("/login")) {
      logger.info("[topkapi] login redirect — filling credentials");
      await gotoWithRetry(page, `${PORTAL_URL}/panel/login`);
      await page.fill("input[name=email]",    user);
      await page.fill("input[name=password]", password);
      await page.click("button[type=submit]");

      // Wait until redirected to /panel but NOT /login
      await page.waitForURL(
        (url) => url.href.includes("/panel") && !url.href.includes("/login"),
        { timeout: 15000 },
      );
    }

    // Pre-warm: try to switch the portal UI to English on the dashboard. This is
    // best-effort (non-fatal) — a fresh navigation to /add reverts to the
    // account default, so submit()/listPrograms() re-enforce English (fatally)
    // on the form page itself before program discovery.
    await ensureEnglishLanguage(page, {
      context: "login",
      returnTo: `${PORTAL_URL}/panel`,
    });

    await saveState(page, STORAGE_PATH);
    logger.info("[topkapi] login successful — URL:", page.url());
    return session;
  },

  // -------------------------------------------------------------------------
  // submit
  //
  // doSubmit=true  (default) — full flow including final submit click
  // doSubmit=false           — fill all steps, stop before clicking submit
  //                            (dry-run smoke test of the form flow)
  // -------------------------------------------------------------------------
  async submit(
    session: AdapterSession,
    profile: SubmitProfile,
    files: SubmitFiles,
    doSubmit = true,
  ): Promise<SubmitResult> {
    const { page } = session;
    const country   = resolveCountry(profile.nationality, profile.countryOverrides);
    const countryEn = toEnglishCountryName(country);
    const eduLevel = mapEduLevel(profile.level, profile.programName);
    const screenshots: string[] = [];

    logger.info(
      "[topkapi] submit — program:", profile.programName,
      "level:", eduLevel,
      "doSubmit:", doSubmit,
    );

    // Raise the default action timeout to 30 s so slow portal responses don't
    // cause spurious failures (the previous 8 s was too short for AJAX renders).
    page.setDefaultTimeout(30000);

    await gotoAndWait(
      page,
      `${PORTAL_URL}/panel/applications/add`,
      "input[name=email]",
      logger,
    );

    // Enforce English ON the form page — a fresh /add URL reverts to the account
    // default (Turkish), which hides/renames English-track programs in Step 4.
    // Fatal: never submit through a Turkish dropdown.
    await ensureEnglishLanguage(page, {
      fatal: true,
      context: "submit /add",
      returnTo: `${PORTAL_URL}/panel/applications/add`,
    });

    // ── STEP 0: form loaded ──────────────────────────────────────────────────
    { const s = await takeShot(page, "step0-form"); if (s) screenshots.push(s); }

    // Debug: log semester / intake dropdown options
    const semesterOpts = await page.evaluate(() => {
      const sel = document.querySelector<HTMLSelectElement>("select[name=semesterId], select[name=semester], select[name=intake], #semesterId, #semester");
      if (!sel) return null;
      return Array.from(sel.options).map((o) => ({ value: o.value, text: o.text.trim(), selected: o.defaultSelected || o.selected }));
    });
    if (semesterOpts) {
      logger.info("[topkapi] semester options:", JSON.stringify(semesterOpts));
    } else {
      // Fallback: log all selects on the page
      const allSelects = await page.evaluate(() =>
        Array.from(document.querySelectorAll("select")).map((s) => ({
          name: s.name, id: s.id,
          opts: Array.from(s.options).map((o) => ({ v: o.value, t: o.text.trim(), sel: o.selected })).slice(0, 10),
        })),
      );
      logger.info("[topkapi] all selects on form:", JSON.stringify(allSelects));
    }

    // ── STEP 1: email + passport ─────────────────────────────────────────────
    logger.info("[topkapi] Step 1: email + passport");
    await page.fill("input[name=email]",          profile.email);
    await page.fill("input[name=passportNumber]", profile.passportNumber);

    // Verify presence without logging applicant values or request bodies.
    const fieldsPopulated = await page.evaluate(() => ({
      email: Boolean((document.querySelector("input[name=email]") as HTMLInputElement | null)?.value),
      passport: Boolean((document.querySelector("input[name=passportNumber]") as HTMLInputElement | null)?.value),
    }));
    logger.info("[topkapi] Step 1 fields populated:", fieldsPopulated);

    const checkRespPromise = page.waitForResponse(
      (r) => r.url().includes("application-check-student-exists.php"),
    );
    await clickNext(page, logger);
    const checkRespObj = await checkRespPromise;

    // Read response body to detect existing-student status directly
    let checkBody = "";
    try { checkBody = await checkRespObj.text(); } catch { /**/ }
    // Log first 300 chars (no personal data — this is just a status response)
    logger.info("[topkapi] check-student-exists response:", checkBody.slice(0, 300));

    { const s = await takeShot(page, "step1-email"); if (s) screenshots.push(s); }

    // Detect existing student from response body.
    // Topkapi returns {"status":"exists","message":"..."} for known students,
    // or {"status":"new"} (or empty/null) for first-time applicants.
    const bodyLc = checkBody.toLowerCase();
    // Topkapi returns {"status":"exists"} for known students.
    // For new students it returns {"status":"new"}, {"status":"success"}, or an empty/null body.
    const existsByBody = bodyLc.includes('"status":"exists"') || bodyLc.includes('"status": "exists"');
    const newByBody   = bodyLc.includes('"status":"new"')     || bodyLc.includes('"status": "new"')
                     || bodyLc.includes('"status":"success"') || bodyLc.includes('"status": "success"')
                     || checkBody.trim() === "" || checkBody.trim() === "null"
                     || checkBody.trim() === "{}" || checkBody.trim() === "[]";

    if (existsByBody) {
      logger.warn("[topkapi] check-student-exists: student already registered");
      return { alreadyExists: true, submitted: false, programMissing: false, screenshots };
    }

    if (!newByBody) {
      // Unknown response format — log and treat as alreadyExists to be safe
      logger.warn("[topkapi] check-student-exists: unknown response format, treating as exists");
      return { alreadyExists: true, submitted: false, programMissing: false, screenshots };
    }

    // Student is new — wait for name input field to appear
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    try {
      await page.waitForSelector("input[name=studentName]", { timeout: 20000 });
    } catch {
      logger.warn("[topkapi] studentName not visible after 20s — treating as already exists");
      return { alreadyExists: true, submitted: false, programMissing: false, screenshots };
    }

    // ── STEP 2: personal info ────────────────────────────────────────────────
    logger.info("[topkapi] Step 2: personal info");
    await page.fill("input[name=studentName]",    profile.firstName);
    await page.fill("input[name=studentSurname]", profile.lastName);
    await page.fill("input[name=dateOfBirth]",    toTrDate(profile.dateOfBirth));

    const genderVal = /^f|kad|woman|kız|kiz/i.test(profile.gender) ? "Female" : "Male";
    await selectByBest(page, "select[name=gender]", genderVal);

    await page.fill("input[name=fathersName]", profile.fatherName || "-");
    await page.fill("input[name=mothersName]", profile.motherName || "-");

    await page.waitForFunction(() => {
      const s = document.querySelector<HTMLSelectElement>("select[name=countryOfBirth]");
      return !!s && s.options.length > 1;
    }, { timeout: 30000 }).catch(() => {});

    // Country <select>s now carry ONLY English option text (the portal used
    // to be Turkish-only) — try the English translation FIRST, Turkish name
    // as a fallback candidate, exact-fold match before substring, verified +
    // retried by selectByCandidatesVerified (logs "sent"/tried candidates vs
    // real options when nothing sticks, per field).
    for (const field of ["countryOfBirth", "nationality", "addressCountry"]) {
      const text = await selectByCandidatesVerified(
        page,
        `select[name=${field}]`,
        [countryEn, country],
        field,
        logger,
      );
      if (!text) {
        logger.warn(
          `[topkapi] Step 2: ${field} not set — sent="${country}" normalized="${normalizeTr(country)}" english="${countryEn}"`,
        );
      }
    }

    logger.info("[topkapi] DBG country=" + country + " countryEn=" + countryEn + " natl=" + (profile.nationality || ""));
    logger.info("[topkapi] DBG cob=" + JSON.stringify(await page.evaluate(() => {
      const s = document.querySelector<HTMLSelectElement>("select[name=countryOfBirth]");
      return s
        ? {
            n: s.options.length,
            sel: s.value,
            sample: Array.from(s.options)
              .slice(0, 6)
              .map((o: HTMLOptionElement) => `${o.value}::${o.text}`),
          }
        : "NO";
    })));
    await page.fill("input[name=address]", profile.address || "-");
    try { await page.fill("input[name=addressCity]", "-"); } catch { /* field optional */ }
    await page.fill("input[name=mobilePhone]", profile.phone);
    const _dump = await page.evaluate(() => {
      const names = ["studentName","studentSurname","dateOfBirth","gender","fathersName","mothersName","countryOfBirth","nationality","addressCountry","address","addressCity","mobilePhone"];
      const out: Record<string, string> = {};
      for (const n of names) {
        const el = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${n}"]`);
        out[n] = el ? el.value : "MISSING";
      }
      return out;
    });
    logger.info("[topkapi] Step 2 field values:", JSON.stringify(_dump));

    await clickNext(page, logger);
    logger.info("[topkapi] Step 2 clickNext done — waiting for Step 3 form");

    // Wait for Step 3 education section to appear before filling it.
    // Without this, the wizard AJAX transition may not have rendered the fields yet.
    try {
      await page.waitForSelector(
        'select[name="applicationEducationInformationEducationLevel[]"]',
        { timeout: 20000 },
      );
      logger.info("[topkapi] Step 3 education level select is visible");
    } catch {
      logger.warn("[topkapi] Step 3 education level select not visible after 20s — form may not have advanced");
    }

    { const s = await takeShot(page, "step2-personal"); if (s) screenshots.push(s); }

    // ── STEP 3: education background ─────────────────────────────────────────
    // Every field is set THEN read back (with one retry). select2 dropdowns
    // (education level, country) need a native+jQuery change to actually stick —
    // see syncChange(). If school/GPA/graduation/level are still empty after the
    // retry we throw "education fill failed" instead of submitting blanks.
    logger.info("[topkapi] Step 3: education background");

    // Some configs start with zero education-history rows — add one if needed.
    await ensureEducationRow(page, logger);

    logger.info("[topkapi] Step 3a: selecting education level");
    // The education-level select2 is the DEGREE LEVEL OF THE PROGRAM BEING
    // APPLIED TO (Associate/Bachelor/Masters/Doctorate) — the live option dump
    // has NO "Lise"/"High School". Select the applied degree by its option VALUE
    // (mapEduLevel → "Bachelor", Turkish label "Lisans" as fallback) via the
    // select2 jQuery val+trigger path (native value alone won't stick on an
    // aria-hidden select2). Never accept the placeholder ("Seçim Yapın") as a
    // real selection — that false-positive was why the AJAX-rendered dependent
    // fields (school/GPA/grad/country) never appeared.
    const eduCandidates = eduLevelCandidates(profile.level, profile.programName);
    const v_level = await selectByCandidatesVerified(
      page,
      'select[name="applicationEducationInformationEducationLevel[]"]',
      eduCandidates,
      "educationLevel",
      logger,
      true,
    );

    // A real education-level selection makes the portal AJAX-render the dependent
    // row fields (schoolName / GPA / graduationDate / country). Wait for them to
    // appear before describing/filling — probing earlier is the root cause of the
    // "no element found" / "empty after retry" failures. The Step-3 field name
    // family is `applicationEducationInformation*[]` (confirmed for educationLevel
    // and country); legacy bare names are kept as fallbacks.
    const schoolSelectors = [
      'input[name="applicationEducationInformationSchoolName[]"]',
      'input[name="schoolName[]"]',
      "input[name=schoolName]",
    ];
    const gpaSelectors = [
      'input[name="applicationEducationInformationGpa[]"]',
      'input[name="applicationEducationInformationGPA[]"]',
      'input[name="GPA[]"]',
      "input[name=GPA]",
    ];
    const gradSelectors = [
      'input[name="applicationEducationInformationGraduationDate[]"]',
      'input[name="GraduationDate[]"]',
      "input[name=GraduationDate]",
    ];
    if (v_level) {
      await page
        .waitForSelector(schoolSelectors.join(", "), { timeout: 12000 })
        .then(() =>
          logger.info(
            "[topkapi] Step 3: dependent fields rendered after level select",
          ),
        )
        .catch(() =>
          logger.warn(
            "[topkapi] Step 3: dependent fields not visible 12s after level select",
          ),
        );
    }
    // Dump the REAL dependent-field names/widgets once they render — definitive
    // evidence for the next dry-run if any selector below still misses.
    await logEduDependents(page, logger);

    // Diagnose the REAL DOM widget type for each education field before filling
    // (the cause of "empty after retry" is field-/widget-specific — don't guess).
    await describeInput(page, schoolSelectors, "schoolName", logger);
    await describeInput(page, gpaSelectors, "gpa", logger);
    const gradInput = await describeInput(page, gradSelectors, "graduationDate", logger);

    // These are repeatable (`name="...[]"`) rows with a hidden template alongside
    // the visible one, so fill+verify must target the SAME visible element (via
    // fillVisibleVerified) and use real input/change events (twopulse binding).
    logger.info("[topkapi] Step 3b: filling school name");
    const v_school = await fillVisibleVerified(
      page,
      schoolSelectors,
      profile.schoolName ?? "-",
      logger,
      "schoolName",
    );

    logger.info("[topkapi] Step 3c: filling GPA");
    // topkapiGpaTo100 converts the normalized GPA (e.g. 2.80 from "2.80/4") to
    // Topkapı's expected 0-100 scale (e.g. 70.0). Passing sub-10 values causes
    // the portal to show "unparseable GPA" / "Please check fields" on Next.
    const gpaVal = topkapiGpaTo100(profile.gpa);
    logger.info(`[topkapi] Step 3c: GPA raw=${profile.gpa ?? "n/a"} → portal="${gpaVal}"`);
    const v_gpa = await fillVisibleVerified(
      page,
      gpaSelectors,
      gpaVal,
      logger,
      "gpa",
    );

    logger.info("[topkapi] Step 3d: filling graduation date");
    // graduationDate is a twopulse-datepicker (native type="text"), so a bare
    // year gets cleared. Read the picker's data-date-format and expand the year
    // into a full date the widget accepts; fall back to the native-type path when
    // the field is NOT a datepicker.
    const gradIsDatepicker = /datepicker/i.test(gradInput.desc);
    let gradValue: string;
    if (gradIsDatepicker) {
      const fmt = await readDatepickerFormat(page, gradSelectors, logger);
      gradValue = formatGraduationForDatepicker(profile.graduationYear, fmt);
    } else {
      gradValue = formatGraduationForInput(profile.graduationYear, gradInput.type);
    }
    const v_grad = await fillVisibleVerified(
      page,
      gradSelectors,
      gradValue,
      logger,
      "graduationDate",
      { datepicker: gradIsDatepicker },
    );

    logger.info("[topkapi] Step 3e: selecting country");
    // The dependent country field shares the educationLevel name family
    // (`applicationEducationInformationCountry[]`, confirmed in the live select
    // dump) and is a select2 whose option VALUE is numeric (e.g. Pakistan=162)
    // with the country name as visible TEXT — so match the resolved country name
    // against the option text. Legacy bare `country[]` kept as a fallback.
    await selectByCandidatesVerified(
      page,
      'select[name="applicationEducationInformationCountry[]"], select[name="country[]"]',
      [countryEn, country],
      "country",
      logger,
    );

    logger.info("[topkapi] Step 3f: filling main language");
    try {
      const ml = page.locator("input[name=mainLanguage], select[name=mainLanguage]").first();
      if (await ml.count()) {
        const tag = await ml.evaluate((e) => e.tagName).catch(() => "");
        if (tag === "SELECT") {
          await selectByCandidatesVerified(
            page,
            "select[name=mainLanguage]",
            ["English", "İngilizce", "Ingilizce"],
            "mainLanguage",
            logger,
          );
        } else {
          await ml.fill("English");
          await syncChange(page, "input[name=mainLanguage]");
        }
      }
    } catch (e) { /* main language not shown for this program */ }

    if (profile.languageScore != null) {
      logger.info("[topkapi] Step 3g: filling language score");
      try {
        await page.fill("input[name=toeflIbtScore]", String(profile.languageScore));
        await syncChange(page, "input[name=toeflIbtScore]");
      } catch { /* optional */ }
    }

    // Hard gate: never advance with a silently-empty education section. Education
    // level drives the Step 4 program list; school+GPA+graduation are portal-
    // required. Fail loudly (and screenshot) instead of a blank submission.
    const eduMissing: string[] = [];
    if (!v_level) eduMissing.push("educationLevel");
    if (!v_school) eduMissing.push("schoolName");
    if (!v_gpa) eduMissing.push("gpa");
    if (!v_grad) eduMissing.push("graduationDate");
    if (eduMissing.length > 0) {
      { const s = await takeShot(page, "step3-education-fail"); if (s) screenshots.push(s); }
      throw new Error(
        `Topkapı Step 3: education fill failed — empty after retry: ${eduMissing.join(", ")}`,
      );
    }

    logger.info("[topkapi] Step 3: clicking Next");
    await clickNext(page, logger);
    logger.info("[topkapi] Step 3 clickNext done");

    { const s = await takeShot(page, "step3-education"); if (s) screenshots.push(s); }

    // ── STEP 4: program selection (AJAX) ─────────────────────────────────────
    // GUARANTEED English switch immediately before program discovery. Do NOT
    // rely on the earlier /add call alone — a wizard step can revert to the
    // account default (Turkish), which hides/renames English-track programmes.
    // Unconditional + fatal so we never read a Turkish dropdown. When English is
    // already active this returns immediately (logs "already English"), so it is
    // a cheap no-op on the happy path and never resets the wizard.
    await ensureEnglishLanguage(page, {
      fatal: true,
      context: "pre-step4",
      returnTo: `${PORTAL_URL}/panel/applications/add`,
    });

    logger.info("[topkapi] Step 4: program selection (AJAX)");
    await page.waitForSelector("input[name=educationLevel]", { timeout: 15000 }).catch(async () => {
      const d = await page.evaluate(() => {
        const r = Array.from(document.querySelectorAll<HTMLInputElement>("input[type=radio]")).map((x) => x.name);
        const se = Array.from(document.querySelectorAll<HTMLSelectElement>("select")).map((x) => x.name);
        return { radios: [...new Set(r)], selects: [...new Set(se)] };
      });
      logger.warn("[topkapi] STEP4 DBG " + JSON.stringify(d));
    });

    // Trigger the AJAX call by programmatically checking the education-level radio
    await page.evaluate((lv: string) => {
      const radios = document.querySelectorAll<HTMLInputElement>(
        "input[name=educationLevel]",
      );
      for (const r of Array.from(radios)) {
        if (r.value === lv) {
          r.checked = true;
          r.dispatchEvent(new Event("change", { bubbles: true }));
          r.dispatchEvent(new Event("click",  { bubbles: true }));
          break;
        }
      }
    }, eduLevel);

    // Wait for the program dropdown to populate (>1 option = real options loaded)
    await page.waitForFunction(
      () => {
        const sel = document.querySelector<HTMLSelectElement>(
          "select[name=programFirstPreference]",
        );
        return sel !== null && sel.options.length > 1;
      },
      { timeout: 12000 },
    );

    // Read options WITH their enabled/disabled state. The portal marks a full
    // programme with the native `disabled` attribute AND/OR a "(Kontenjan Dolu)"
    // suffix in the option text — a disabled option cannot be selected, so
    // page.selectOption() would block ~8s ("option being selected is not
    // enabled") before failing. We capture `disabled` to fast-fail instead.
    type RawProgramOption = { id: string; name: string; disabled: boolean };
    const readProgramOptions = (): Promise<RawProgramOption[]> =>
      page.$$eval(
        "select[name=programFirstPreference] option",
        (opts) =>
          (opts as HTMLOptionElement[])
            .filter((o) => o.value && o.value !== "0" && o.value !== "")
            .map((o) => {
              const name = o.textContent?.trim() ?? "";
              return {
                id: o.value,
                name,
                disabled:
                  o.disabled ||
                  /\(\s*(?:Kontenjan\s*Dolu|Quota\s*Full)\s*\)/i.test(name),
              };
            }),
      );

    let programOptionsRaw: RawProgramOption[] = await readProgramOptions();

    // The program <select> is populated by an AJAX call fired when the
    // education-level radio is checked. If that AJAX ran while the UI was still
    // Turkish, switching language afterwards does NOT re-fetch it — the options
    // stay Turkish-labelled. English mode always renders a parenthesised degree
    // ("(Bachelor)"/"(Master)"…) and an explicit track ("- English"/"- Turkish");
    // Turkish mode renders "(Türkçe - Lisans …)" with no parenthesised degree.
    const looksTurkishOnly = (opts: RawProgramOption[]): boolean =>
      opts.length > 0 &&
      opts.some((o) =>
        /(?:türkçe|turkce)\s*[-–]\s*(?:lisans|önlisans|onlisans|yüksek|yuksek|doktora)/i.test(
          o.name,
        ),
      ) &&
      !opts.some(
        (o) =>
          /[-–]\s*english\b/i.test(o.name) ||
          /\(\s*(?:bachelor|master|associate|phd|doctorate)\s*\)/i.test(o.name),
      );

    if (looksTurkishOnly(programOptionsRaw)) {
      logger.warn(
        "[topkapi] Step 4: program list still Turkish after English switch — re-triggering AJAX to reload in English",
      );
      await page.evaluate((lv: string) => {
        const radios = document.querySelectorAll<HTMLInputElement>(
          "input[name=educationLevel]",
        );
        for (const r of Array.from(radios)) {
          if (r.value === lv) {
            r.checked = true;
            r.dispatchEvent(new Event("change", { bubbles: true }));
            r.dispatchEvent(new Event("click", { bubbles: true }));
            break;
          }
        }
      }, eduLevel);
      await page
        .waitForFunction(
          () => {
            const sel = document.querySelector<HTMLSelectElement>(
              "select[name=programFirstPreference]",
            );
            return sel !== null && sel.options.length > 1;
          },
          { timeout: 12000 },
        )
        .catch(() => {});
      const reread = await readProgramOptions();
      if (reread.length > 0) programOptionsRaw = reread;
    }

    // Fatal: if the list is STILL Turkish-only after the switch + refetch, the
    // English switch did not take effect on program discovery — abort instead of
    // silently submitting the wrong (Turkish) programme. Override/synonyms/
    // fallback stay as the safety net for the English path only.
    if (looksTurkishOnly(programOptionsRaw)) {
      logger.error(
        "[topkapi] language: SWITCH FAILED — aborting submission (program list still Turkish)",
      );
      throw new Error(
        "topkapi: could not switch portal to English before program discovery",
      );
    }

    // matchProgram only needs {id,name}; keep a plain ProgramCandidate list.
    const programOptions: ProgramCandidate[] = programOptionsRaw.map((o) => ({
      id: o.id,
      name: o.name,
    }));
    const openPrograms = programOptionsRaw.filter((o) => !o.disabled);

    logger.info(
      `[topkapi] ${programOptions.length} program option(s) (${openPrograms.length} açık). First 10:`,
      programOptionsRaw
        .slice(0, 10)
        .map((o) => `${o.id}: ${o.name}${o.disabled ? " [DOLU]" : ""}`),
    );
    // Debug: list every OPEN (enabled, not Kontenjan Dolu) programme so an
    // operator can pick the nearest available one if the target is full.
    logger.info(
      `[topkapi] Açık programlar (${openPrograms.length}): ` +
        openPrograms.map((o) => `${o.id}: ${o.name}`).join(", "),
    );

    // Panel-managed mapping data merges OVER the built-in code defaults (DB wins):
    //   - programNameMap:  portal label → CRM program name (General ∪ university).
    //   - programSynonyms: passed through to EXTEND the matcher's dictionary.
    // Matching is fully NAME-based — CRM program IDs are never consulted, so a
    // catalog re-sync (which renumbers IDs) can no longer break a mapping. The
    // name map is reverse-resolved inside matchProgram (conf 1.0) before fuzzy.
    let matchResult = matchProgram(profile.programName, programOptions, {
      nameMap: profile.programNameMap,
      nameMapGeneral: profile.programNameMapGeneral,
      synonyms: profile.programSynonyms,
    });

    // Local fuzzy fallback (Topkapi-only, see fuzzyFallbackMatch above): the
    // shared matcher's Jaccard score can be diluted by degree-prefix/variant
    // filler words the portal's terse labels omit. Only engaged when the
    // shared matcher found nothing — never overrides a real match.
    if (!matchResult) {
      const fuzzy = fuzzyFallbackMatch(profile.programName, programOptions, profile.programSynonyms);
      if (fuzzy) {
        logger.info(
          `[topkapi] Fuzzy fallback matched "${profile.programName}" → "${fuzzy.match.name}" (conf=${fuzzy.conf.toFixed(2)})`,
        );
        matchResult = fuzzy;
      }
    }

    if (!matchResult) {
      logger.warn(
        `[topkapi] No program match for "${profile.programName}" (programId=${profile.programId}). All ${programOptions.length} options (value: label):`,
        programOptions.map((o) => `${o.id}: ${o.name}`),
      );
      // Full, NON-truncated dump (logger array args can be clipped by the log
      // transport) — every option as {v,t} so missing program values are visible.
      console.log(
        "[topkapi] ALL OPTIONS:",
        JSON.stringify(programOptions.map((o) => ({ v: o.id, t: o.name }))),
      );
      { const s = await takeShot(page, "step4-no-program"); if (s) screenshots.push(s); }
      // Structural result (NO throw): the dropdown WAS reached but the requested
      // programme is not offered. Surface the full option list (with enabled
      // flags) + resolution so the orchestrator can supersede to a configured
      // backup programme — exactly like the Kontenjan Dolu branch, but triggered
      // by "not in dropdown" instead of "quota full".
      return {
        programMissing: true,
        submitted: false,
        alreadyExists: false,
        resolution: "not_in_dropdown",
        requestedProgram: { name: profile.programName },
        availablePrograms: programOptionsRaw.map((o) => ({
          value: o.id,
          name: o.name,
          enabled: !o.disabled,
        })),
        detail: `skipped: program eşleşmedi — "${profile.programName}" not found in dropdown (${programOptions.length} option(s) available)`,
        screenshots,
      };
    }

    logger.info(
      `[topkapi] Matched: "${matchResult.match.name}" (conf=${matchResult.conf.toFixed(2)})`,
    );

    // ── KONTENJAN DOLU fast-fail ─────────────────────────────────────────────
    // If the matched programme is disabled / "(Kontenjan Dolu)", never attempt
    // page.selectOption (it would hang ~8s on a not-enabled option). Throw an
    // immediate, explicit error and surface the open programmes so an operator
    // can pick the nearest available one.
    const matchedOpt = programOptionsRaw.find(
      (o) => o.id === matchResult!.match.id,
    );
    if (matchedOpt?.disabled) {
      const openList = openPrograms
        .slice(0, 15)
        .map((o) => `${o.id}: ${o.name}`)
        .join(", ");
      logger.warn(
        `[topkapi] Program kontenjanı dolu — "${matchResult.match.name}". Açık programlar (${openPrograms.length}): ${openPrograms
          .map((o) => `${o.id}: ${o.name}`)
          .join(", ")}`,
      );
      { const s = await takeShot(page, "step4-kontenjan-dolu"); if (s) screenshots.push(s); }
      // Structural result (NO throw): surface the requested-but-full programme
      // and the full programme list (enabled flags) so the orchestrator can
      // supersede. The submission did not proceed.
      return {
        submitted: false,
        alreadyExists: false,
        programMissing: false,
        programFull: true,
        requestedProgram: {
          value: matchResult.match.id,
          name: matchResult.match.name,
        },
        openPrograms: programOptionsRaw.map((o) => ({
          value: o.id,
          name: o.name,
          enabled: !o.disabled,
        })),
        detail: `Program kontenjanı dolu — ${matchResult.match.name}. Açık programlar: [${openList}]`,
        screenshots,
      };
    }

    // The program dropdown is a HIDDEN select2 (twopulse-select2, aria-hidden),
    // so page.selectOption() can't reach it (timeout). Select it the same way as
    // the other select2 fields: jQuery .val().trigger("change") in-page.
    await setSelectByValue(
      page,
      "select[name=programFirstPreference]",
      matchResult.match.id,
    );

    const selVal = await page.$eval(
      "select[name=programFirstPreference]",
      (el) => (el as HTMLSelectElement).value,
    );
    if (!selVal || selVal === "0" || selVal === "") {
      logger.warn("[topkapi] Program select verify failed after selection");
      { const s = await takeShot(page, "step4-select-fail"); if (s) screenshots.push(s); }
      return {
        programMissing: true,
        submitted: false,
        alreadyExists: false,
        detail: `Program select verify failed — matched "${matchResult.match.name}" but selection value was empty`,
        screenshots,
      };
    }

    await selectByBest(page, "select[name=needsScholarship]", "0");
    await clickNext(page, logger);

    { const s = await takeShot(page, "step4-program"); if (s) screenshots.push(s); }

    // ── STEP 5: document uploads ─────────────────────────────────────────────
    // Every slot logs its own attempt + outcome, and each upload is POSITIVELY
    // verified (the file input must actually report a selected file) — "clicked
    // setInputFiles, hopefully it worked" is never assumed. Without all four
    // mandatory documents the final submit is NOT clicked (silent-success class
    // of bug: submissions previously went through with zero documents and the
    // CRM stage advanced to awaiting_offer while the university saw "Missing").
    logger.info("[topkapi] Step 5: document uploads");
    await page.waitForSelector("input[name=filePassport]", { state: "attached", timeout: 10000 });

    const DOC_INPUTS: Array<{ slot: keyof SubmitFiles; selector: string }> = [
      { slot: "photo",      selector: "input[name=filePhoto]" },
      { slot: "passport",   selector: "input[name=filePassport]" },
      { slot: "transcript", selector: "input[name=fileTranscript]" },
      { slot: "diploma",    selector: "input[name=fileDiploma]" },
    ];
    const uploadedSlots: string[] = [];
    const slotFailures: string[] = [];
    for (const { slot, selector } of DOC_INPUTS) {
      const localPath = files[slot];
      if (!localPath) {
        logger.warn(`[topkapi] Step 5: ${slot} — yerel dosya yok (indirme başarısız veya CRM'de belge yok)`);
        slotFailures.push(`${slot}: dosya yok`);
        continue;
      }
      logger.info(`[topkapi] Step 5: ${slot} yükleniyor (${path.basename(localPath)})`);
      try {
        await page.setInputFiles(selector, localPath);
        // Positive verification: the input element must report a selected file.
        const attachedCount = await page
          .$eval(selector, (el) => (el as HTMLInputElement).files?.length ?? 0)
          .catch(() => 0);
        if (attachedCount > 0) {
          uploadedSlots.push(slot);
          logger.info(`[topkapi] Step 5: ${slot} → ok`);
        } else {
          slotFailures.push(`${slot}: input dosyayı kabul etmedi`);
          logger.warn(`[topkapi] Step 5: ${slot} → hata(input dosyayı kabul etmedi)`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        slotFailures.push(`${slot}: ${msg}`);
        logger.warn(`[topkapi] Step 5: ${slot} → hata(${msg})`);
      }
    }
    logger.info(
      `[topkapi] Step 5 özet: ${uploadedSlots.length}/${DOC_INPUTS.length} yüklendi` +
      ` [${uploadedSlots.join(", ")}]` +
      (slotFailures.length ? ` | eksik/hata: [${slotFailures.join("; ")}]` : ""),
    );

    { const s = await takeShot(page, "step5-docs"); if (s) screenshots.push(s); }

    if (!doSubmit) {
      logger.info("[topkapi] doSubmit=false — stopping before final submit (dry run)");
      return { submitted: false, alreadyExists: false, programMissing: false, uploadedSlots, screenshots };
    }

    // MANDATORY-DOCUMENT GATE: all four slots (photo, passport, transcript,
    // diploma) must be verified-attached before "Başvuruyu Tamamla" may be
    // clicked. Otherwise fail loudly — submitted=false, real reason in detail —
    // so the writeback marks the submission failed and the CRM stage does NOT
    // advance. No silent success, ever.
    const missingDocuments = DOC_INPUTS
      .map((d) => d.slot as string)
      .filter((slot) => !uploadedSlots.includes(slot));
    if (missingDocuments.length > 0) {
      logger.warn(
        "[topkapi] zorunlu belgeler eksik — Başvuruyu Tamamla TIKLANMADI: " +
        slotFailures.join("; "),
      );
      { const s = await takeShot(page, "step5-docs-missing").catch(() => null); if (s) screenshots.push(s); }
      return {
        submitted: false,
        alreadyExists: false,
        programMissing: false,
        missingDocuments,
        uploadedSlots,
        detail:
          `Belgeler yüklenemedi — başvuru gönderilmedi. ` +
          `Yüklenen: [${uploadedSlots.join(", ") || "yok"}]. ` +
          `Eksik/hata: ${slotFailures.join("; ")}`,
        screenshots,
      };
    }

    // ── FINAL SUBMIT ─────────────────────────────────────────────────────────
    // Success criterion mirrors the proven fas-automation engine: a 2xx/3xx
    // response from application-save.php IS the submission proof (submitted=true).
    // The /applications/success/<uuid> redirect is best-effort — used only to
    // capture externalRef when present; it is NOT required for success. The
    // captured <uuid> is returned as externalRef so the runner persists it to
    // portal_submissions.external_ref.
    logger.info("[topkapi] clicking Complete Application / Başvuruyu Tamamla");

    // Clear any leftover modal, then make sure the final-submit button is reachable.
    for (let i = 0; i < 5; i++) { if ((await page.locator(".jconfirm.jconfirm-open").count()) === 0) break; await dismissJconfirm(page, logger); await page.waitForTimeout(400); }
    for (let i = 0; i < 5; i++) {
      const finBtn = page.getByRole("button", { name: /(Başvuruyu Tamamla|Complete Application)/i });
      if (await finBtn.isVisible().catch(() => false)) { logger.warn("[topkapi] final-submit visible after " + i + " advance(s)"); break; }
      logger.warn("[topkapi] advancing to final step (Next Step / Sonraki Adım) #" + (i + 1));
      await clickNext(page, logger).catch(() => {});
      await page.waitForTimeout(1800).catch(() => {});
    }

    // Arm the application-save.php response wait BEFORE clicking submit so we
    // never miss a fast response.
    const savePromise = page
      .waitForResponse((r) => r.url().includes("application-save.php"), { timeout: 45_000 })
      .catch(() => null);

    await page.getByRole("button", { name: /(Başvuruyu Tamamla|Complete Application)/i }).click().catch(async () => { await page.getByRole("button", { name: /(Başvuruyu Tamamla|Complete Application)/i }).click({ force: true }).catch(() => {}); });

    // (a) Confirm the optional .jconfirm summary modal if it appears.
    const modalAppeared = await page
      .waitForSelector(".jconfirm", { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    if (modalAppeared) {
      let confirmed = await page
        .locator(".jconfirm")
        .getByRole("button", { name: /Tamamla|Onayla|Evet|Gönder|Confirm|Complete|Approve|Yes|Submit|OK/i })
        .first()
        .click({ timeout: 2000 })
        .then(() => true)
        .catch(() => false);
      if (!confirmed) {
        confirmed = await page
          .locator(".jconfirm .btn-blue, .jconfirm .btn-primary, .jconfirm button")
          .first()
          .click({ timeout: 2000 })
          .then(() => true)
          .catch(() => false);
      }
      logger.info("[topkapi] summary modal " + (confirmed ? "confirmed" : "appeared but confirm click failed"));
    } else {
      logger.info("[topkapi] no summary modal — direct submit");
    }

    // (b) Read the application-save.php RESPONSE BODY — the body, not the bare
    // HTTP status, decides success. Always log status + first 600 chars so a
    // rejection reason is visible (HTTP 200 alone is never treated as success).
    const resp = await savePromise;
    const saveStatus = resp ? resp.status() : 0;
    let bodyText = "";
    try { bodyText = resp ? await resp.text() : ""; } catch { /* body unreadable */ }
    logger.info("[topkapi] application-save.php " + saveStatus + " BODY: " + bodyText.slice(0, 600));

    let saved = false;
    let externalRef: string | undefined;
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed !== null && typeof parsed === "object") {
        const j = parsed as Record<string, unknown>;
        saved = j.status === "success" || j.success === true || !!j.redirect || !!j.applicationId;
        const rid = typeof j.redirect === "string" ? j.redirect : typeof j.url === "string" ? j.url : "";
        const mm = rid.match(/success\/([0-9a-f-]{8,})/i);
        if (mm) externalRef = mm[1];
        if (!saved && (j.message || j.error)) {
          logger.warn("[topkapi] SAVE REJECTED: " + String(j.message ?? j.error));
        }
      }
    } catch { /* body is not JSON */ }

    // (c) Best-effort: success URL redirect (captures external_ref AND confirms
    // saved when the body wasn't conclusive JSON). Not required once saved.
    if (!externalRef) {
      try {
        await page.waitForURL(/\/applications\/success\//i, { timeout: 10000 });
        const m = page.url().match(/\/applications\/success\/([0-9a-f-]{8,})/i);
        if (m) { externalRef = m[1]; saved = true; }
      } catch { /* no redirect */ }
    }

    { const s2 = await takeShot(page, "final").catch(() => null); if (s2) screenshots.push(s2); }

    // Submission proof = body success/redirect/applicationId (or the success-url
    // redirect). HTTP 200 alone is NOT success.
    const submitted = saved;

    if (submitted) {
      if (externalRef !== undefined) {
        logger.info("[topkapi] success url " + externalRef);
      } else {
        logger.warn("[topkapi] saved but success-url not captured — save=" + saveStatus + " url=" + page.url());
      }
      return { submitted: true, alreadyExists: false, programMissing: false, externalRef, uploadedSlots, screenshots };
    }

    // Reactive exclusive-region safety net: some restricted nationalities are
    // rejected with an "Exclusive bölge / acenta üzerinden" message instead of
    // being saved. Detect it WITHOUT overriding a successful submit (checked
    // only in the not-saved branch). Permanent skip — no retry.
    if (detectExclusiveRegion(bodyText)) {
      logger.warn("[topkapi] exclusive-region response detected — marking exclusive_region");
      return {
        submitted: false,
        alreadyExists: false,
        programMissing: false,
        exclusiveRegion: true,
        detail: "Exclusive bölge — acenta üzerinden başvurulmalı",
        screenshots,
      };
    }

    logger.warn(
      "[topkapi] submit not saved — save=" + saveStatus + " modal=" + modalAppeared + " url=" + page.url(),
    );
    return {
      submitted: false,
      alreadyExists: false,
      programMissing: false,
      detail:
        "submit not confirmed — application-save.php body not success (status " + saveStatus + ")",
      screenshots,
    };
  },

  // -------------------------------------------------------------------------
  // listPrograms — fetch the LIVE program option list WITHOUT submitting.
  //
  // Reuses the same Step 1-4 wizard navigation as submit() but with synthetic
  // throwaway applicant data, stopping at the Step 4 AJAX program dropdown.
  // Nothing is persisted on the portal — the final submit click is never made.
  // The caller owns the session lifecycle (login + creds + close).
  // -------------------------------------------------------------------------
  async listPrograms(
    session: AdapterSession,
    level?: string,
  ): Promise<ProgramOption[]> {
    const { page } = session;
    const eduLevel = mapEduLevel(level ?? "Bachelor", "");
    logger.info("[topkapi] listPrograms — level:", level ?? "(default)", "→", eduLevel);

    page.setDefaultTimeout(30000);
    await gotoAndWait(
      page,
      `${PORTAL_URL}/panel/applications/add`,
      "input[name=email]",
      logger,
    );

    // Enforce English ON the form page before probing Step-4 programs — a fresh
    // /add URL reverts to the account default (Turkish), which hides/renames
    // English-track programs. Fatal: never report a Turkish-only program list.
    await ensureEnglishLanguage(page, {
      fatal: true,
      context: "listPrograms /add",
      returnTo: `${PORTAL_URL}/panel/applications/add`,
    });

    // ── STEP 1: synthetic new-student check ──────────────────────────────────
    const stamp = Date.now();
    await page.fill("input[name=email]", `program-probe-${stamp}@example.invalid`);
    await page.fill("input[name=passportNumber]", `PROBE${stamp}`);

    const checkRespPromise = page
      .waitForResponse((r) =>
        r.url().includes("application-check-student-exists.php"),
      )
      .catch(() => null);
    await clickNext(page, logger);
    await checkRespPromise;

    try {
      await page.waitForSelector("input[name=studentName]", { timeout: 20000 });
    } catch {
      throw new Error(
        "Topkapı: yeni öğrenci formu açılmadı — program listesi çekilemedi",
      );
    }

    // ── STEP 2: minimal personal info (throwaway values) ─────────────────────
    await page.fill("input[name=studentName]", "Program");
    await page.fill("input[name=studentSurname]", "Probe");
    await page.fill("input[name=dateOfBirth]", "01.01.2000");
    await selectByBest(page, "select[name=gender]", "Male");
    await page.fill("input[name=fathersName]", "-");
    await page.fill("input[name=mothersName]", "-");

    await page
      .waitForFunction(
        () => {
          const s = document.querySelector("select[name=countryOfBirth]");
          return !!s && (s as HTMLSelectElement).options.length > 1;
        },
        { timeout: 30000 },
      )
      .catch(() => {});
    await selectFirstRealOption(page, "select[name=countryOfBirth]");
    await selectFirstRealOption(page, "select[name=nationality]");
    await selectFirstRealOption(page, "select[name=addressCountry]");
    await page.evaluate(() => {
      ["countryOfBirth", "nationality", "addressCountry"].forEach((n) => {
        const e = document.querySelector("select[name=" + n + "]");
        if (e) {
          e.dispatchEvent(new Event("change", { bubbles: true }));
          const w = window as unknown as { jQuery?: (el: Element) => { trigger: (ev: string) => void } };
          if (w.jQuery) w.jQuery(e).trigger("change");
        }
      });
    });
    await page.fill("input[name=address]", "-");
    try { await page.fill("input[name=addressCity]", "-"); } catch { /* optional */ }
    await page.fill("input[name=mobilePhone]", "5000000000");

    await clickNext(page, logger);

    try {
      await page.waitForSelector(
        'select[name="applicationEducationInformationEducationLevel[]"]',
        { timeout: 20000 },
      );
    } catch {
      throw new Error("Topkapı: eğitim adımı açılmadı — program listesi çekilemedi");
    }

    // ── STEP 3: education level (drives the Step 4 program list) ──────────────
    await selectByBest(
      page,
      'select[name="applicationEducationInformationEducationLevel[]"]',
      eduLevel,
    );
    try { await page.fill('input[name="schoolName[]"]', "-"); }
    catch { try { await page.fill("input[name=schoolName]", "-"); } catch { /* optional */ } }
    try { await page.fill('input[name="GPA[]"]', "-"); } catch { /* optional */ }
    try { await page.fill('input[name="GraduationDate[]"]', "-"); } catch { /* optional */ }
    try { await selectFirstRealOption(page, 'select[name="country[]"]'); } catch { /* optional */ }

    await clickNext(page, logger);

    // ── STEP 4: trigger AJAX + extract the program dropdown options ───────────
    await page.waitForSelector("input[name=educationLevel]", { timeout: 15000 });
    await page.evaluate((lv: string) => {
      const radios = document.querySelectorAll<HTMLInputElement>(
        "input[name=educationLevel]",
      );
      for (const r of Array.from(radios)) {
        if (r.value === lv) {
          r.checked = true;
          r.dispatchEvent(new Event("change", { bubbles: true }));
          r.dispatchEvent(new Event("click", { bubbles: true }));
          break;
        }
      }
    }, eduLevel);

    await page.waitForFunction(
      () => {
        const sel = document.querySelector<HTMLSelectElement>(
          "select[name=programFirstPreference]",
        );
        return sel !== null && sel.options.length > 1;
      },
      { timeout: 12000 },
    );

    const options: ProgramOption[] = await page.$$eval(
      "select[name=programFirstPreference] option",
      (opts) =>
        (opts as HTMLOptionElement[])
          .filter((o) => o.value && o.value !== "0" && o.value !== "")
          .map((o) => ({ v: o.value, t: o.textContent?.trim() ?? "" })),
    );

    logger.info(
      `[topkapi] listPrograms — ${options.length} option(s) for level=${eduLevel}`,
    );
    return options;
  },
};
