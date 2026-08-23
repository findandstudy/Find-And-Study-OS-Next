/**
 * fix-edu-1959.ts — sets education level (Bachelor) and graduation date (01.06.2008)
 * for portal application 2026/3819, then saves.
 *
 * All page.evaluate calls use string form to avoid esbuild __name injection.
 */
import { launchPortal, logger, setCredsOverride, clearCredsOverride } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
import { existsSync } from "node:fs";
import path from "node:path";
import os   from "node:os";

const PORTAL_URL   = "https://apply.topkapi.edu.tr";
const APP_UUID     = "4ba402fa-4493-4973-ab0b-d66d796539c5";
const STORAGE_PATH = "/tmp/topkapi-portal-state.json";

const creds = await resolvePortalCreds("topkapi", "topkapi");
setCredsOverride("topkapi", creds);

const session = await launchPortal({
  headless:    true,
  storagePath: existsSync(STORAGE_PATH) ? STORAGE_PATH : undefined,
});
const page = session.page;

await page.goto(`${PORTAL_URL}/panel/applications/view/${APP_UUID}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);

await page.click('a:has-text("Eğitim Bilgisi")');
await page.waitForTimeout(2000);

// 1. Education level → "Bachelor"
const levelResult = await page.evaluate(
  `(function() {
     var sel = document.querySelector('select[name="applicationEducationInformationEducationLevel[]"]');
     if (!sel) return "NOT_FOUND";
     sel.value = "Bachelor";
     sel.dispatchEvent(new Event("change", { bubbles: true }));
     sel.dispatchEvent(new Event("input",  { bubbles: true }));
     return sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : "";
   })()`,
);
logger.info("[fix-edu] Education level →", levelResult);

await page.waitForTimeout(300);

// 2. Graduation date
await page.fill('input[name="applicationEducationInformationGraduationDate[]"]', "01.06.2008");
await page.waitForTimeout(300);

// 3. Verify
const vals = await page.evaluate(
  `(function() {
     var level   = document.querySelector('select[name="applicationEducationInformationEducationLevel[]"]');
     var school  = document.querySelector('input[name="applicationEducationInformationSchoolName[]"]');
     var gpa     = document.querySelector('input[name="applicationEducationInformationGPA[]"]');
     var gd      = document.querySelector('input[name="applicationEducationInformationGraduationDate[]"]');
     var country = document.querySelector('select[name="applicationEducationInformationCountry[]"]');
     return {
       level:   level   ? { val: level.value,   txt: level.options[level.selectedIndex] ? level.options[level.selectedIndex].text : "" } : "NF",
       school:  school  ? school.value   : "NF",
       gpa:     gpa     ? gpa.value      : "NF",
       gradDate:gd      ? gd.value       : "NF",
       country: country ? { val: country.value, txt: country.options[country.selectedIndex] ? country.options[country.selectedIndex].text : "" } : "NF",
     };
   })()`,
);
logger.info("[fix-edu] Pre-save:", JSON.stringify(vals, null, 2));

await page.screenshot({ path: path.join(os.tmpdir(), `fix-edu-prefinal-${Date.now()}.png`) });

// 4. Save
const saved = await page.evaluate(
  `(function() {
     var btns = Array.from(document.querySelectorAll("button, input[type=submit]"));
     var btn  = btns.find(function(b) {
       return b.innerText && b.innerText.indexOf("Kaydet") !== -1 ||
              b.value     && b.value.indexOf("Kaydet")    !== -1;
     });
     if (btn) { btn.click(); return true; }
     return false;
   })()`,
);
logger.info("[fix-edu] Save clicked:", saved);
await page.waitForTimeout(3000);

const finalShot = path.join(os.tmpdir(), `fix-edu-final-${Date.now()}.png`);
await page.screenshot({ path: finalShot });
logger.info("[fix-edu] Final screenshot:", finalShot);

clearCredsOverride("topkapi");
await page.context().browser()?.close();
