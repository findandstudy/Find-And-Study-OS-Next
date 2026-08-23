import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
const stamp = Date.now().toString().slice(-6);
(async () => {
  const a: any = adapterByKey("bau");
  const creds = await resolvePortalCreds("bau", "bau");
  const s: any = await a.login({ credentials: creds, headless: true });
  const page = s.page; const trace: any[] = [];
  const body = async () => (await page.evaluate("(()=>document.body?document.body.innerText:'')()")).replace(/\s+/g, " ");
  try {
    await page.goto("https://applyonline.bau.edu.tr/agency/s/application-form", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    for (let step = 0; step < 9; step++) {
      const before = (await body()).slice(0, 500);
      const tag = before.replace(/Skip to Main Content.*?My Account /, "").slice(0, 55);
      // fill text inputs (name/passport)
      await page.locator('input[name="First_Name"], input[name="Student_First_Name"]').first().fill("Mehmet").catch(()=>{});
      await page.locator('input[name="Last_Name"], input[name="Student_Last_Name"]').first().fill("Yilmaz").catch(()=>{});
      await page.locator('input[name*="Passport" i]').first().fill("FAS"+stamp).catch(()=>{});
      // comboboxes (citizenship etc): type + pick option
      try { const cb = page.locator("input[id*=combobox], input[role=combobox]"); const cn = await cb.count(); for (let i=0;i<cn;i++){ const e=cb.nth(i); if(!(await e.isVisible().catch(()=>false)))continue; if((await e.inputValue().catch(()=>"x"))!=="")continue; await e.click().catch(()=>{}); await e.fill("Turkey").catch(()=>{}); await page.waitForTimeout(1200); const o=page.locator("[role=option], lightning-base-combobox-item, .slds-listbox__option").first(); if(await o.count())await o.click({timeout:2500}).catch(()=>{}); await page.waitForTimeout(400);} } catch(e){}
      // remaining empty required text -> email
      try { const c=page.locator("input[required]"); const n=await c.count(); for(let i=0;i<n;i++){const el=c.nth(i); if(!(await el.isVisible().catch(()=>false)))continue; const idr=((await el.getAttribute("id").catch(()=>""))||"")+((await el.getAttribute("role").catch(()=>""))||""); if(/combobox/i.test(idr))continue; const ty=(await el.getAttribute("type").catch(()=>""))||"text"; if(ty==="radio"||ty==="checkbox")continue; if((await el.inputValue().catch(()=>"x"))===""){await el.fill("fas"+stamp+"@example.com").catch(()=>{});break;}}}catch(e){}
      // native selects
      try { const se=page.locator("select"); const sn=await se.count(); for(let i=0;i<sn;i++){const el=se.nth(i); if(await el.isVisible().catch(()=>false))await el.selectOption({index:1}).catch(()=>{});}}catch(e){}
      // radio card
      try { const r=page.locator("input[type=radio]"); if(await r.count()){const id=await r.first().getAttribute("id").catch(()=>null); if(id)await page.locator('label[for="'+id+'"]').first().click({timeout:2000}).catch(()=>{}); await r.first().check({force:true}).catch(()=>{});}}catch(e){}
      // program "Select" button
      try { const sel=page.getByRole("button",{name:/^select$/i}).first(); if(await sel.count())await sel.click({timeout:3000}).catch(()=>{});}catch(e){}
      await page.waitForTimeout(800);
      // advance: Next or CNA
      let clicked="none";
      const nx=page.getByRole("button",{name:/^\s*(next|ileri|sonraki|devam)\s*$/i}).first();
      if(await nx.count()){await nx.click({timeout:5000}).catch(()=>{});clicked="next";}
      else { const cna=page.getByRole("button",{name:/create new application|add application/i}).first(); if(await cna.count()){await cna.click({timeout:5000}).catch(()=>{});clicked="cna";} }
      await page.waitForTimeout(5000);
      const after=(await body()).slice(0,500);
      trace.push({step, tag, clicked, moved: after!==before});
      if(/review|completed|tamamlan/i.test(after)){trace.push({final:"REVIEW/DONE reached"});break;}
      if(after===before){trace.push({stuck:tag});break;}
    }
  } catch (e: any) { trace.push({err:e.message}); }
  finally { try { await s.close(); } catch(e){} }
  console.log("FULL " + JSON.stringify(trace));
  process.exit(0);
})();
