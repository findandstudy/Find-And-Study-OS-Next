import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
(async () => {
  const a: any = adapterByKey("sit");
  const creds = await resolvePortalCreds("sit", "sit");
  const s: any = await a.login({ credentials: creds, headless: true });
  const page = s.page;
  const out: any = {};
  try {
    out.loginUrl = page.url();
    await page.goto("https://partners.sitconnect.net/students", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    out.url = page.url();
    const rows = page.locator("table tbody tr, [role=row]");
    out.rowCount = await rows.count().catch(() => 0);
    out.body = (await page.evaluate("(()=>document.body?document.body.innerText:'')()")).replace(/\s+/g, " ").slice(0, 700);
    if (out.rowCount > 0) {
      await rows.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(3500);
      out.afterRowUrl = page.url();
      const addBtn = page.getByRole("button", { name: /add application/i }).first();
      out.hasAddBtn = await addBtn.count().catch(() => 0);
      if (out.hasAddBtn) {
        await addBtn.click({ timeout: 6000 }).catch(() => {});
        await page.waitForTimeout(3500);
        out.dialog = await page.evaluate(() => {
          const els = Array.from(document.querySelectorAll("select, input, [role=combobox], [role=listbox], button, [class*=control], [class*=select]"));
          return els.slice(0, 70).map((e: any) => ({ tag: e.tagName, type: e.getAttribute("type"), role: e.getAttribute("role"), name: e.getAttribute("name"), ph: e.getAttribute("placeholder"), aria: e.getAttribute("aria-label"), txt: (e.innerText || "").replace(/\s+/g, " ").slice(0, 45) }));
        });
      }
    }
  } catch (e: any) { out.error = e.message; }
  console.log("SIT-DBG " + JSON.stringify(out, null, 1));
  await s.close().catch(() => {});
  process.exit(0);
})();
