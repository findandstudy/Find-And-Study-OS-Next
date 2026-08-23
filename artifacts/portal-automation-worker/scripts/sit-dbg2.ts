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
    out.links = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((x:any)=>x.getAttribute("href")).filter((h:string)=>h && /student/i.test(h)).slice(0,20));
    out.rowActions = await page.evaluate(() => { const tr = document.querySelector("table tbody tr"); if(!tr) return null; return Array.from(tr.querySelectorAll("a,button,svg,[role=button],[class*=action],[class*=icon]")).slice(0,15).map((e:any)=>({tag:e.tagName,href:e.getAttribute("href"),aria:e.getAttribute("aria-label"),title:e.getAttribute("title"),cls:(e.getAttribute("class")||"").slice(0,40),txt:(e.innerText||"").slice(0,20)})); });
    const det = (out.links||[]).find((h:string)=>/\/students\/.+/.test(h));
    if (det) {
      const url = det.startsWith("http") ? det : ("https://partners.sitconnect.net"+det);
      out.detUrl = url;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(4000);
      const addBtn = page.getByRole("button", { name: /add application/i }).first();
      out.hasAddBtn = await addBtn.count().catch(()=>0);
      if (out.hasAddBtn) {
        await addBtn.click({ timeout: 6000 }).catch(()=>{});
        await page.waitForTimeout(3500);
        out.dialog = await page.evaluate(() => Array.from(document.querySelectorAll("select, input, [role=combobox], [role=button], [class*=control], [class*=select__]")).slice(0,60).map((e:any)=>({tag:e.tagName,type:e.getAttribute("type"),role:e.getAttribute("role"),ph:e.getAttribute("placeholder"),aria:e.getAttribute("aria-label"),txt:(e.innerText||"").replace(/\s+/g," ").slice(0,40)})));
      }
    }
  } catch (e:any) { out.error = e.message; }
  console.log("SIT2 " + JSON.stringify(out, null, 1));
  await s.close().catch(()=>{});
  process.exit(0);
})();
