import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
const KEY = process.env.K || "ozyegin";
const BASE = process.env.B || "https://apply.ozyegin.edu.tr/agency/s";
const SELS = 'input[name="Student_First_Name"], input[name="First_Name"]';
const stamp = Date.now().toString().slice(-6);
(async () => {
  const a: any = adapterByKey(KEY);
  const creds = await resolvePortalCreds(KEY, KEY);
  const s: any = await a.login({ credentials: creds, headless: true });
  const page = s.page; const out: any = {};
  const body = async () => (await page.evaluate("(()=>document.body?document.body.innerText:'')()")).replace(/\s+/g, " ");
  try {
    await page.goto(BASE.replace(/\/$/, "") + "/application-form", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    for (let i = 0; i < 6; i++) {
      if (await page.locator(SELS).count()) { out.reachedAt = i; break; }
      const c = page.locator('input[type=radio]').first();
      if (await c.count()) { const id = await c.getAttribute("id"); if (id) await page.locator('label[for="'+id+'"]').first().click({timeout:2000}).catch(()=>{}); }
      await page.getByRole("button", { name: /next|ileri|continue|devam/i }).first().click({ timeout: 4000 }).catch(()=>{});
      await page.waitForTimeout(3500);
    }
    if (!(await page.locator(SELS).count())) { out.err = "no student"; out.b = (await body()).slice(0,150); console.log("STU "+JSON.stringify(out)); process.exit(0); }
    out.fields = await page.evaluate("(()=>{var r=[];document.querySelectorAll('input,select,textarea').forEach(function(e){var ty=e.type||e.tagName.toLowerCase();if(ty==='hidden')return;var rect=e.getBoundingClientRect();if(rect.width===0&&rect.height===0)return;r.push(ty+':'+(e.getAttribute('name')||e.id||'?')+'|ph='+(e.getAttribute('placeholder')||'')+'|req='+(e.required?1:0))});return r.slice(0,40)})()");
    // fill all text-ish + selects, then Next
    const fb = (await body()).slice(0, 100);
    await page.locator('input[name="Student_First_Name"], input[name="First_Name"]').first().fill("Mehmet").catch(()=>{});
    await page.locator('input[name="Student_Last_Name"], input[name="Last_Name"]').first().fill("Yilmaz").catch(()=>{});
    await page.locator('input[name*="Passport" i], input[name*="Pasaport" i]').first().fill("FAS"+stamp).catch(()=>{});
    const em = page.locator('input[type=email], input[placeholder*="@"], input[name*="mail" i]').first();
    if (await em.count()) await em.fill("fas"+stamp+"@example.com").catch(()=>{});
    await page.getByRole("button", { name: /next|ileri|continue|devam/i }).first().click({ timeout: 5000 }).catch(()=>{});
    await page.waitForTimeout(5000);
    const fa = (await body()).slice(0, 100);
    out.advanced = fb !== fa; out.after = fa;
  } catch (e: any) { out.err = e.message; }
  finally { try { await s.close(); } catch(e){} }
  console.log("STU " + JSON.stringify(out));
  process.exit(0);
})();
