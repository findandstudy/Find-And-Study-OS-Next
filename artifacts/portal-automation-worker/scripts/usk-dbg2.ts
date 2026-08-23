import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
const SEL = 'input[name="Student_First_Name"]';
const stamp = Date.now().toString().slice(-6);
(async () => {
  const a: any = adapterByKey("uskudar");
  const creds = await resolvePortalCreds("uskudar", "uskudar");
  const s: any = await a.login({ credentials: creds, headless: true });
  const page = s.page;
  const out: any = { steps: [] };
  const body = async () => (await page.evaluate("(()=>document.body?document.body.innerText:'')()")).replace(/\s+/g, " ");
  try {
    await page.goto("https://apply.uskudar.edu.tr/agency/s/application-form", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    for (let i = 0; i < 6; i++) {
      if (await page.locator(SEL).count()) { out.reachedAt = i; break; }
      const card = page.locator('input[type=radio]').first();
      if (await card.count()) { const id = await card.getAttribute("id"); if (id) await page.locator('label[for="' + id + '"]').first().click({ timeout: 2000 }).catch(()=>{}); else await card.click({timeout:2000}).catch(()=>{}); }
      await page.getByRole("button", { name: /next|ileri|continue|devam/i }).first().click({ timeout: 4000 }).catch(()=>{});
      await page.waitForTimeout(3500);
    }
    if (!(await page.locator(SEL).count())) { out.error = "never reached student"; out.hint = (await body()).slice(0,160); console.log("DBG2 "+JSON.stringify(out)); process.exit(0); }
    // dump all visible fields on student step
    out.fields = await page.evaluate("(()=>{var r=[];document.querySelectorAll('input,select,textarea').forEach(function(e){var ty=e.type||e.tagName.toLowerCase();if(ty==='hidden')return;var v=e.offsetParent!==null;if(!v)return;r.push(ty+':'+(e.getAttribute('name')||e.id||'?')+(e.required?'*':''))});return r.slice(0,40)})()");
    // fill known fields
    const fillN = async (nm: string, val: string) => { const l = page.locator('input[name="'+nm+'"]').first(); if (await l.count()) { await l.fill(val).catch(()=>{}); } };
    await fillN("Student_First_Name", "Mehmet");
    await fillN("Student_Last_Name", "Yilmaz");
    await fillN("Student_Passport_Number", "FAS" + stamp);
    const em = page.locator('input[type=email], input[placeholder="you@example.com"]').first();
    if (await em.count()) await em.fill("fas.dry" + stamp + "@example.com").catch(()=>{});
    out.filledFN = await page.locator(SEL).first().inputValue().catch(()=>"ERR");
    const before = (await body()).slice(0, 80);
    // click Next
    await page.getByRole("button", { name: /next|ileri|continue|devam/i }).first().click({ timeout: 5000 }).catch(()=>{});
    await page.waitForTimeout(5000);
    const after = (await body()).slice(0, 80);
    out.advanced = before !== after;
    out.beforeHead = before; out.afterHead = after;
    out.validation = (await body()).match(/required|zorunlu|please|geçerli|enter |must |invalid/i) ? (await body()).replace(/\s+/g," ").slice(0,200) : "none";
    out.stillStudent = (await page.locator(SEL).count()) > 0;
  } catch (e: any) { out.error = e.message; }
  finally { try { await s.close(); } catch(e){} }
  console.log("DBG2 " + JSON.stringify(out));
  process.exit(0);
})();
