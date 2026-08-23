import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
const stamp = Date.now().toString().slice(-6);
(async () => {
  const a: any = adapterByKey("bau");
  const creds = await resolvePortalCreds("bau", "bau");
  const s: any = await a.login({ credentials: creds, headless: true });
  const page = s.page; const out: any = {};
  const body = async () => (await page.evaluate("(()=>document.body?document.body.innerText:'')()")).replace(/\s+/g, " ");
  const btns = async () => await page.evaluate("(()=>{var r=[];document.querySelectorAll('button,[role=button],input[type=submit],a.slds-button').forEach(function(b){var t=(b.value||b.innerText||'').trim().slice(0,28);if(t)r.push(t)});return Array.from(new Set(r)).slice(0,25)})()");
  try {
    await page.goto("https://applyonline.bau.edu.tr/agency/s/application-form", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    // fill student-create
    await page.locator('input[name="First_Name"]').first().fill("Mehmet").catch(()=>{});
    await page.locator('input[name="Last_Name"]').first().fill("Yilmaz").catch(()=>{});
    await page.locator('input[name*="Passport" i]').first().fill("FAS"+stamp).catch(()=>{});
    // citizenship combobox
    try { const cb = page.locator('input[id*=combobox]').first(); if (await cb.count()) { await cb.click().catch(()=>{}); await cb.fill("Turkey").catch(()=>{}); await page.waitForTimeout(1500); const o = page.locator("[role=option], lightning-base-combobox-item, .slds-listbox__option").first(); if (await o.count()) await o.click({timeout:3000}).catch(()=>{}); } } catch(e){}
    // email: remaining empty required non-combobox
    try { const c = page.locator("input[required]"); const n = await c.count(); for (let i=0;i<n;i++){ const el=c.nth(i); if(!(await el.isVisible().catch(()=>false)))continue; const idr=((await el.getAttribute("id").catch(()=>""))||"")+((await el.getAttribute("role").catch(()=>""))||""); if(/combobox/i.test(idr))continue; const ty=(await el.getAttribute("type").catch(()=>""))||"text"; if(ty==="radio"||ty==="checkbox")continue; if((await el.inputValue().catch(()=>"x"))===""){ await el.fill("fas"+stamp+"@example.com").catch(()=>{}); break; } } } catch(e){}
    await page.waitForTimeout(500);
    out.step0btns = await btns();
    // Next
    await page.getByRole("button", { name: /^\s*(next|ileri|continue|devam|kaydet|save)\s*$/i }).first().click({ timeout: 5000 }).catch(()=>{});
    await page.waitForTimeout(6000);
    out.step1head = (await body()).slice(0, 130);
    out.step1btns = await btns();
    // Create New Application
    const cna = page.getByRole("button", { name: /create new application|add application|yeni başvuru/i }).first();
    out.cnaFound = await cna.count();
    if (await cna.count()) { await cna.click({ timeout: 6000 }).catch(()=>{}); await page.waitForTimeout(6000); }
    out.step2head = (await body()).slice(0, 130);
    out.step2btns = await btns();
  } catch (e: any) { out.err = e.message; }
  finally { try { await s.close(); } catch(e){} }
  console.log("WALK " + JSON.stringify(out));
  process.exit(0);
})();
