import type {
  UniversityAdapter,
  AdapterSession,
  SubmitProfile,
  SubmitFiles,
  SubmitResult,
  LoginOpts,
} from "../../types.js";
import { launchPortal, logger } from "../../browser.js";
import { portalCreds } from "../../portalCreds.js";
import { fold } from "../../programMatch.js";

// ---------------------------------------------------------------------------
// EMU (Eastern Mediterranean University) — ASP.NET WebForms agency portal.
// NOT Salesforce. Flow: login -> Welcome.aspx -> Undergraduate Applications
// (__doPostBack lbtnUAppl) -> "Add New" -> Undergrad_Registration.aspx -> fill
// sections (btnKaydet / btnEekle / btnPEkle / btnBekle) -> btnGonder (submit).
// ---------------------------------------------------------------------------
export const EMU_ALLOWLIST: readonly string[] = [
  "Doğu Akdeniz Üniversitesi",
  "Eastern Mediterranean University",
  "EMU",
] as const;
const EMU_ALLOWLIST_FOLDED: readonly string[] = EMU_ALLOWLIST.map(fold);

const PORTAL_URL = "https://applyonline.emu.edu.tr/agency";
const P = "ctl00$ContentPlaceHolder1$"; // ASP.NET control prefix

export const emuAdapter: UniversityAdapter = {
  key:   "emu",
  label: "EMU Portal",
  allowlist: [...EMU_ALLOWLIST],

  matches(name: string): boolean {
    const f = fold(name);
    return EMU_ALLOWLIST_FOLDED.some(entry => f.includes(entry) || entry.includes(f));
  },

  async login(opts?: LoginOpts): Promise<AdapterSession> {
    const { user, password } = opts?.credentials ?? portalCreds("emu");
    const session = await launchPortal({ headless: opts?.headless ?? true });
    logger.info("[emu] login - navigating to portal");
    const page: any = session.page;
    try {
      await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(3500);
      for (const s of ["input[type=email]","input[name*=email i]","input[type=text]"]) { const l = page.locator(s).first(); if ((await l.count()) && (await l.isVisible().catch(() => false))) { await l.fill(user).catch(() => {}); break; } }
      await page.locator("input[type=password]").first().fill(password).catch(() => {});
      await page.getByRole("button", { name: /login|sign ?in|giris|gönder|submit/i }).first().click({ timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(6000);
      if (await page.locator("input[type=password]").first().isVisible().catch(() => false)) throw new Error("[emu] login failed - wrong creds or captcha");
      logger.info("[emu] login successful -> " + page.url());
    } catch (err) { await session.close().catch(() => {}); throw err; }
    return session;
  },

  async submit(
    session: AdapterSession,
    profile: SubmitProfile,
    files: SubmitFiles,
  ): Promise<SubmitResult> {
    logger.info("[emu] submit - program:", profile.programName);
    const page: any = session.page;
    const dryRun = process.env.PORTAL_DRYRUN === "1";
    const result: any = { alreadyExists: false, submitted: false, programMissing: false };
    const bodyText = async (): Promise<string> => { try { return (await page.evaluate("(() => document.body ? document.body.innerText : '')()")) as string; } catch (e) { return ""; } };
    const fill = async (suffix: string, v?: string) => { if (!v) return; try { const l = page.locator('[name="' + P + suffix + '"]').first(); if ((await l.count()) && (await l.isVisible().catch(() => false))) await l.fill(v, { timeout: 4000 }).catch(() => {}); } catch (e) {} };
    const sel = async (suffix: string, label?: string) => { try { const s = page.locator('select[name="' + P + suffix + '"]').first(); if (!(await s.count())) return; if (label) { try { await s.selectOption({ label }); return; } catch (e) {} } await s.selectOption({ index: 1 }).catch(() => {}); } catch (e) {} };
    const clickN = async (suffix: string) => { try { const b = page.locator('[name="' + P + suffix + '"]').first(); if ((await b.count()) && (await b.isVisible().catch(() => false))) { await b.click({ timeout: 6000 }).catch(() => {}); await page.waitForTimeout(4000); } } catch (e) {} };

    try {
      await page.goto(PORTAL_URL + "/Welcome.aspx", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
      // Undergraduate Applications list
      await page.evaluate("(()=>{try{__doPostBack('ctl00$lbtnUAppl','')}catch(e){}})()").catch(() => {});
      await page.waitForTimeout(6000);
      // Add New -> registration form
      try { const an = page.getByText(/add new/i).first(); if (await an.count()) { await an.click({ timeout: 6000 }); await page.waitForTimeout(6000); } } catch (e) {}

      const txt0 = await bodyText();
      if (/already.*application|zaten.*basvuru|already applied/i.test(txt0)) { result.alreadyExists = true; }

      // --- Personal section ---
      await fill("txtAdi", profile.firstName || "Test");
      await fill("txtSoyadi", profile.lastName || "Applicant");
      await fill("txtEposta", profile.email);
      await fill("txtCepTel", (profile.phone || "5321234567").replace(/^\+?90/, ""));
      await fill("txtPasaport", profile.passportNumber);
      await fill("dedtDTar", "01/01/2000");
      await fill("txtAdres", profile.address || "Istanbul");
      await sel("ddlCins");
      await sel("ddlUyruk", profile.nationality);
      await sel("ddlUlke", profile.nationality);
      await sel("ddlPulke", profile.nationality);
      await clickN("btnKaydet");

      // --- Education section ---
      await fill("txtOkul", profile.schoolName || "High School");
      await fill("txtOSehir", profile.address || "Istanbul");
      await fill("txtOAvg", String(profile.gpa ?? "3.5"));
      await sel("ddlOUlke", profile.nationality);
      await clickN("btnEekle");

      // --- Program section ---
      await sel("ddlDonem");
      await sel("ddlBolum", profile.programName);
      await clickN("btnPEkle");
      if (/no.*program|program.*not|bölüm bulunamadı/i.test(await bodyText())) result.programMissing = true;

      // --- Documents section ---
      try {
        const order = [files.diploma, files.transcript, files.passport, files.photo].filter(Boolean) as string[];
        const fi = page.locator('input[type=file]'); const n = await fi.count();
        for (let i = 0; i < n && i < order.length; i++) { const fp = order[i] || files.passport || files.diploma; if (fp) await fi.nth(i).setInputFiles(fp).catch(() => {}); }
        await clickN("btnBekle");
      } catch (e) {}

      // --- Final submit gate ---
      const gonder = page.locator('[name="' + P + 'btnGonder"]').first();
      if (await gonder.count()) {
        if (dryRun) { result.dryReachedFinal = true; logger.info("[emu] dryRun - stopping before btnGonder (no real submit)"); }
        else { await gonder.click({ timeout: 8000 }).catch(() => {}); await page.waitForTimeout(6000); if (/completed|submitted|alindi|tamamland/i.test(await bodyText())) result.submitted = true; }
      } else {
        result.stuckStep = "no-btnGonder"; result.body = (await bodyText()).replace(/\s+/g, " ").slice(0, 200);
      }
    } catch (e: any) { result.error = e.message; }
    logger.info("[emu] submit " + JSON.stringify(result));
    return result;
  },
};
