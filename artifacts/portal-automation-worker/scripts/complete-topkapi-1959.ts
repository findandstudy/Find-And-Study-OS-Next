/**
 * complete-topkapi-1959.ts
 *
 * One-shot: completes portal application 2026/3819 (SANA TARIQ, app_id=1959)
 * by navigating to the existing application view/edit page and filling:
 *   • Eğitim Geçmişi (Education History)
 *   • Belgeler (Documents)
 *
 * Run:
 *   pnpm --filter @workspace/portal-automation-worker run complete-1959
 */

import fs   from "node:fs/promises";
import os   from "node:os";
import path from "node:path";
import { db, documentsTable } from "@workspace/db";
import { and, eq, isNull }    from "drizzle-orm";
import {
  launchPortal,
  saveState,
  logger,
  setCredsOverride,
  clearCredsOverride,
  mapDocType,
} from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Page = any;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PORTAL_URL   = "https://apply.topkapi.edu.tr";
const STORAGE_PATH = "/tmp/topkapi-portal-state.json";
const APP_REF      = "2026/3819";
const STUDENT_ID   = 1982;

const EDU = {
  level:      "Lise",
  schoolName: "GOVT DEGREE GIRLS COLLEGE SECTOR 11-B NORTH KARACHI",
  gpa:        "46",
  gradYear:   "2008",
  country:    "Pakistan",
};

// ---------------------------------------------------------------------------
// Helper: screenshot
// ---------------------------------------------------------------------------
async function shot(page: Page, tag: string): Promise<void> {
  try {
    const p = path.join(os.tmpdir(), `complete-1959-${tag}-${Date.now()}.png`);
    await page.screenshot({ path: p, fullPage: false });
    logger.info(`[complete-1959] screenshot → ${p}`);
  } catch { /* non-fatal */ }
}

// ---------------------------------------------------------------------------
// Helper: soft wait — avoids hanging networkidle
// ---------------------------------------------------------------------------
async function softWait(page: Page, ms = 2000): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: ms });
  } catch { /* ignore */ }
  await page.waitForTimeout(500);
}

// ---------------------------------------------------------------------------
// Helper: selectByBest
// ---------------------------------------------------------------------------
async function selectByBest(page: Page, selector: string, value: string): Promise<boolean> {
  try {
    const optVal = await page.$eval(
      selector,
      (el: HTMLSelectElement, v: string) => {
        const nv  = v.replace(/\u0130/gi, "i").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
        const opt = Array.from(el.options).find(
          (o) => o.text.replace(/\u0130/gi, "i").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().includes(nv),
        );
        return opt?.value ?? "";
      },
      value,
    );
    if (optVal && optVal !== "0") {
      await page.selectOption(selector, { value: optVal });
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 1: prepare document files from DB (base64 → tmp)
// ---------------------------------------------------------------------------
async function prepareFiles(): Promise<Record<string, string>> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "complete-1959-"));

  // NOTE: intentionally includes soft-deleted docs (file_data lives there)
  const docs = await db
    .select({
      id:       documentsTable.id,
      type:     documentsTable.type,
      fileData: documentsTable.fileData,
      fileUrl:  documentsTable.fileUrl,
      fileKey:  documentsTable.fileKey,
      name:     documentsTable.name,
      deletedAt: documentsTable.deletedAt,
    })
    .from(documentsTable)
    .where(eq(documentsTable.studentId, STUDENT_ID));  // no deletedAt filter

  logger.info(`[complete-1959] fetched ${docs.length} docs for student ${STUDENT_ID}`);

  // Prefer non-deleted docs with file_data; fall back to deleted ones that still have data
  const sorted = [
    ...docs.filter((d) => !d.deletedAt && d.fileData),
    ...docs.filter((d) => !d.deletedAt && !d.fileData && (d.fileUrl ?? d.fileKey)),
    ...docs.filter((d) =>  d.deletedAt && d.fileData),
  ];

  const files: Record<string, string> = {};

  for (const doc of sorted) {
    if (!doc.type) continue;
    const key = mapDocType(doc.type);
    if (!key || files[key]) continue;

    if (doc.fileData) {
      const extMatch = (doc.name ?? "").match(/\.([a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : "bin";
      const dest = path.join(tempDir, `${key}.${ext}`);
      await fs.writeFile(dest, Buffer.from(doc.fileData, "base64"));
      files[key] = dest;
      logger.info(`[complete-1959] prepared ${key} from doc#${doc.id} → ${dest}`);
    } else if (doc.fileUrl ?? doc.fileKey) {
      const url = (doc.fileUrl ?? doc.fileKey)!;
      const ext = url.split("?")[0].split(".").pop()?.toLowerCase() ?? "bin";
      const dest = path.join(tempDir, `${key}.${ext}`);
      const res = await fetch(url);
      if (res.ok) {
        await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
        files[key] = dest;
        logger.info(`[complete-1959] downloaded ${key} from doc#${doc.id} → ${dest}`);
      }
    }
  }

  logger.info("[complete-1959] files ready:", Object.keys(files));
  return files;
}

// ---------------------------------------------------------------------------
// Step 2: login
// ---------------------------------------------------------------------------
async function loginPortal(): Promise<Page> {
  const creds = await resolvePortalCreds("topkapi", "topkapi");
  setCredsOverride("topkapi", creds);

  const { existsSync } = await import("node:fs");
  const storagePath    = existsSync(STORAGE_PATH) ? STORAGE_PATH : undefined;
  const session        = await launchPortal({ headless: true, storagePath });
  const { page }       = session;

  await page.goto(`${PORTAL_URL}/panel`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);

  if (page.url().includes("/login")) {
    logger.info("[complete-1959] redirected to login, authenticating…");
    await page.goto(`${PORTAL_URL}/panel/login`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await page.fill("input[name=email]",    creds.user);
    await page.fill("input[name=password]", creds.password);
    await page.click("button[type=submit]");
    await page.waitForURL(
      (url: URL) => url.href.includes("/panel") && !url.href.includes("/login"),
      { timeout: 15000 },
    );
  }
  await saveState(page, STORAGE_PATH);
  logger.info("[complete-1959] logged in:", page.url());
  return page;
}

// ---------------------------------------------------------------------------
// Step 3: navigate to application 2026/3819
// Returns the UUID of the application found on the portal
// ---------------------------------------------------------------------------
async function navigateToApp(page: Page): Promise<void> {
  logger.info("[complete-1959] navigating to applications list…");
  await page.goto(`${PORTAL_URL}/panel/applications`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await shot(page, "list");

  // Log all links to understand page structure
  const allLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a[href*=view], a[href*=application]"))
      .slice(0, 20)
      .map((a: HTMLAnchorElement) => ({ text: a.innerText?.trim().slice(0, 40), href: a.href })),
  );
  logger.info("[complete-1959] application links:", JSON.stringify(allLinks));

  // Try clicking any link/element containing the reference
  try {
    await page.locator(`text=${APP_REF}`).first().waitFor({ timeout: 8000 });

    // Find nearest <a> wrapping the reference text
    const href = await page.evaluate((ref: string) => {
      const el = Array.from(document.querySelectorAll("*")).find(
        (e) => (e as HTMLElement).innerText?.trim() === ref,
      );
      const a = el?.closest("a") ?? el?.querySelector("a");
      if (a) return (a as HTMLAnchorElement).href;
      const rowA = el?.closest("tr")?.querySelector("a");
      return (rowA as HTMLAnchorElement | null)?.href ?? null;
    }, APP_REF);

    if (href) {
      logger.info("[complete-1959] navigating directly to:", href);
      await page.goto(href, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
      await shot(page, "app-view");
      return;
    }

    // Fallback: click the row element
    await page.locator(`tr:has-text("${APP_REF}") a`).first().click();
    await page.waitForTimeout(2000);
    await shot(page, "app-view-click");
    return;
  } catch {
    logger.warn("[complete-1959] link by text not found — trying UUID from last run");
  }

  // Last resort: the UUID from the previous run
  const uuid = "4ba402fa-4493-4973-ab0b-d66d796539c5";
  logger.warn(`[complete-1959] using known UUID: ${uuid}`);
  await page.goto(`${PORTAL_URL}/panel/applications/view/${uuid}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await shot(page, "direct-view");
  logger.info("[complete-1959] direct-view URL:", page.url());
}

// ---------------------------------------------------------------------------
// Step 4: fill education history
// ---------------------------------------------------------------------------
async function fillEducation(page: Page): Promise<void> {
  logger.info("[complete-1959] === EDUCATION HISTORY ===");

  // Click the education tab
  const eduTabSelectors = [
    'a:has-text("Eğitim Bilgisi")',
    'li:has-text("Eğitim Bilgisi") a',
    'a:has-text("Eğitim")',
    'button:has-text("Eğitim Bilgisi")',
  ];
  for (const sel of eduTabSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await page.click(sel);
        await softWait(page, 3000);
        logger.info(`[complete-1959] clicked edu tab via: ${sel}`);
        break;
      }
    } catch { /* try next */ }
  }
  await shot(page, "edu-tab");

  // Log all buttons on page to understand save button structure
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll("button, input[type=submit], a.btn"))
      .map((b: HTMLElement) => ({ tag: b.tagName, text: b.innerText?.trim().slice(0, 30), type: (b as HTMLInputElement).type ?? "", cls: b.className.slice(0, 40) }))
      .slice(0, 30),
  );
  logger.info("[complete-1959] buttons on page:", JSON.stringify(buttons));

  // Log all selects
  const selects = await page.evaluate(() =>
    Array.from(document.querySelectorAll("select[name]"))
      .map((s: HTMLSelectElement) => ({
        name: s.name,
        opts: Array.from(s.options).map((o) => o.text.trim()).slice(0, 8),
      })),
  );
  logger.info("[complete-1959] selects:", JSON.stringify(selects));

  // --- Education level select ---
  // From form snapshot: likely applicationEducationInformationEducationLevel[]
  const eduLevelSelectors = [
    'select[name="applicationEducationInformationEducationLevel[]"]',
    'select[name*="EducationLevel"]',
    'select[name*="educationLevel"]',
    'select[name*="EduLevel"]',
    'select[name*="eduLevel"]',
  ];
  let eduLevelFilled = false;
  for (const sel of eduLevelSelectors) {
    const ok = await selectByBest(page, sel, EDU.level);
    if (ok) {
      logger.info(`[complete-1959] education level set via: ${sel}`);
      eduLevelFilled = true;
      break;
    }
  }
  if (!eduLevelFilled) logger.warn("[complete-1959] education level not filled");

  // --- School name ---
  // From form snapshot: applicationEducationInformationSchoolName[]
  try {
    await page.fill('input[name="applicationEducationInformationSchoolName[]"]', EDU.schoolName);
    logger.info("[complete-1959] school name filled");
  } catch {
    try {
      await page.fill('input[name*="SchoolName"]', EDU.schoolName);
      logger.info("[complete-1959] school name filled via wildcard");
    } catch { logger.warn("[complete-1959] school name not filled"); }
  }

  // --- GPA ---
  // From form snapshot: applicationEducationInformationGPA[]
  try {
    await page.fill('input[name="applicationEducationInformationGPA[]"]', EDU.gpa);
    logger.info("[complete-1959] GPA filled");
  } catch {
    try {
      await page.fill('input[name*="GPA"]', EDU.gpa);
      logger.info("[complete-1959] GPA filled via wildcard");
    } catch { logger.warn("[complete-1959] GPA not filled"); }
  }

  // --- Graduation date ---
  // From form snapshot: applicationEducationInformationGraduationDate[]
  try {
    await page.fill('input[name="applicationEducationInformationGraduationDate[]"]', EDU.gradYear);
    logger.info("[complete-1959] graduation date filled");
  } catch {
    try {
      await page.fill('input[name*="GraduationDate"]', EDU.gradYear);
      logger.info("[complete-1959] graduation date filled via wildcard");
    } catch { logger.warn("[complete-1959] graduation date not filled"); }
  }

  // --- Country ---
  // Likely: applicationEducationInformationCountry[]
  const countrySelectors = [
    'select[name="applicationEducationInformationCountry[]"]',
    'select[name*="Country"]',
    'select[name*="country"]',
  ];
  let countryFilled = false;
  for (const sel of countrySelectors) {
    const ok = await selectByBest(page, sel, EDU.country);
    if (ok) {
      logger.info(`[complete-1959] country set via: ${sel}`);
      countryFilled = true;
      break;
    }
  }
  if (!countryFilled) logger.warn("[complete-1959] country not filled");

  await shot(page, "edu-filled");

  // --- Save education section ---
  // Try to find and click the Kaydet button
  const savedViaButton = await page.evaluate(() => {
    // Find all buttons with "Kaydet" text
    const btns = Array.from(document.querySelectorAll("button, input[type=submit]"));
    const kaydet = btns.find((b) =>
      (b as HTMLElement).innerText?.includes("Kaydet") ||
      (b as HTMLInputElement).value?.includes("Kaydet"),
    ) as HTMLElement | undefined;
    if (kaydet) { kaydet.click(); return true; }
    return false;
  });

  if (savedViaButton) {
    logger.info("[complete-1959] education save button clicked (Kaydet)");
  } else {
    // Try form submit
    const submitted = await page.evaluate(() => {
      const form = document.querySelector("form");
      if (form) { form.submit(); return true; }
      return false;
    });
    logger.info(`[complete-1959] education form submit: ${submitted}`);
  }

  await page.waitForTimeout(3000);
  await shot(page, "edu-saved");
  logger.info("[complete-1959] education section done");
}

// ---------------------------------------------------------------------------
// Step 5: upload documents
// ---------------------------------------------------------------------------
async function uploadDocuments(page: Page, files: Record<string, string>): Promise<void> {
  logger.info("[complete-1959] === DOCUMENTS ===");

  // Click the Belgeler tab
  const docTabSelectors = [
    'a:has-text("Belgeler")',
    'li:has-text("Belgeler") a',
    'a:has-text("Belge")',
    'button:has-text("Belgeler")',
  ];
  for (const sel of docTabSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await page.click(sel);
        await softWait(page, 3000);
        logger.info(`[complete-1959] clicked docs tab via: ${sel}`);
        break;
      }
    } catch { /* try next */ }
  }
  await shot(page, "docs-tab");

  // Log all file inputs
  const fileInputs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("input[type=file]")).map((el: HTMLInputElement) => ({
      name: el.name, id: el.id, accept: el.accept,
    })),
  );
  logger.info("[complete-1959] file inputs:", JSON.stringify(fileInputs));

  // Upload map — canonical field names from initial wizard + common variants
  const uploadMap: Record<string, string[]> = {
    photo:      ["filePhoto",      "photo",       "Photo",      "fileFoto",    "fotograf"],
    passport:   ["filePassport",   "passport",    "Passport",   "filePasaport","pasaport"],
    transcript: ["fileTranscript", "transcript",  "Transcript", "fileTranskript"],
    diploma:    ["fileDiploma",    "diploma",     "Diploma"],
  };

  for (const [key, names] of Object.entries(uploadMap)) {
    const filePath = files[key];
    if (!filePath) { logger.warn(`[complete-1959] no file for slot "${key}"`); continue; }

    let uploaded = false;
    for (const name of names) {
      try {
        const exists = await page.$(`input[type=file][name="${name}"]`);
        if (exists) {
          await page.setInputFiles(`input[type=file][name="${name}"]`, filePath);
          logger.info(`[complete-1959] uploaded ${key} via input[name="${name}"]`);
          uploaded = true;
          break;
        }
      } catch { /* try next */ }
    }

    if (!uploaded) {
      // Try wildcard name match
      for (const name of names) {
        try {
          const exists = await page.$(`input[type=file][name*="${name}"]`);
          if (exists) {
            await page.setInputFiles(`input[type=file][name*="${name}"]`, filePath);
            logger.info(`[complete-1959] uploaded ${key} via wildcard name*="${name}"`);
            uploaded = true;
            break;
          }
        } catch { /* try next */ }
      }
    }

    if (!uploaded) logger.warn(`[complete-1959] FAILED to upload ${key} — slot not found`);
  }

  await shot(page, "docs-filled");

  // Save documents
  const savedDocs = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, input[type=submit]"));
    const kaydet = btns.find((b) =>
      (b as HTMLElement).innerText?.includes("Kaydet") ||
      (b as HTMLInputElement).value?.includes("Kaydet"),
    ) as HTMLElement | undefined;
    if (kaydet) { kaydet.click(); return true; }
    return false;
  });
  logger.info(`[complete-1959] docs save clicked: ${savedDocs}`);

  await page.waitForTimeout(3000);
  await shot(page, "docs-saved");
  logger.info("[complete-1959] documents section done");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  logger.info("[complete-1959] Starting — completing application", APP_REF);

  const files = await prepareFiles();
  const missing = (["photo", "passport", "transcript", "diploma"] as const).filter((k) => !files[k]);
  if (missing.length > 0) logger.warn("[complete-1959] missing slots:", missing);

  const page = await loginPortal();
  try {
    await navigateToApp(page);
    await fillEducation(page);

    // Re-navigate to app before documents (education save may redirect)
    await navigateToApp(page);
    await uploadDocuments(page, files);

    logger.info("[complete-1959] ✓ DONE — application", APP_REF, "should now be complete");
  } finally {
    clearCredsOverride("topkapi");
    try { await page.context().browser()?.close(); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  logger.error("[complete-1959] Fatal:", err);
  process.exit(1);
});
