import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
(async () => {
  const a: any = adapterByKey("sit");
  const creds = await resolvePortalCreds("sit", "sit");
  const s: any = await a.login({ credentials: creds, headless: true });
  const page = s.page;
  const out: any = {};
  try {
    await page.goto("https://partners.sitconnect.net/students", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    const icon = page.locator("table tbody tr").first().locator(".lucide-info").first();
    out.iconCount = await icon.count().catch(()=>0);
    await icon.click({ timeout: 6000 }).catch(async()=>{ await icon.locator("xpath=..").click({timeout:4000}).catch(()=>{}); });
    await page.waitForTimeout(4500);
    out.afterUrl = page.url();
    const addBtn = page.getByRole("button", { name: /add application/i }).first();
    out.hasAddBtn = await addBtn.count().catch(()=>0);
    if (out.hasAddBtn) {
      await addBtn.click({ timeout: 6000 }).catch(()=>{});
      await page.waitForTimeout(4000);
      out.afterAddUrl = page.url();
      out.dialogBody = (await page.evaluate("(()=>document.body?document.body.innerText:'')()")).replace(/\s+/g," ").slice(0,500);
      out.dialog = await page.evaluate(() => Array.from(document.querySelectorAll("select, input, [role=combobox], [class*=control], [class*=-control], label")).slice(0,60).map((e:any)=>({tag:e.tagName,type:e.getAttribute("type"),role:e.getAttribute("role"),ph:e.getAttribute("placeholder"),aria:e.getAttribute("aria-label"),txt:(e.innerText||"").replace(/\s+/g," ").slice(0,40)})));
    }
  } catch (e:any) { out.error = e.message; }
  console.log("SIT3 " + JSON.stringify(out, null, 1));
  await s.close().catch(()=>{});
  process.exit(0);
})();
