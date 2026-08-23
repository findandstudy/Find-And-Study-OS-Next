import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
const stamp = Date.now().toString().slice(-6);
(async () => {
  const a: any = adapterByKey("bau");
  const creds = await resolvePortalCreds("bau", "bau");
  const s: any = await a.login({ credentials: creds, headless: true });
  const page = s.page; const out: any = {};
  const body = async () => (await page.evaluate("(()=>document.body?document.body.innerText:'')()")).replace(/\s+/g, " ");
  const fill = async () => {
    await page.locator('input[name="First_Name"], input[name="Student_First_Name"]').first().fill("Mehmet").catch(()=>{});
    await page.locator('input[name="Last_Name"], input[name="Student_Last_Name"]').first().fill("Yilmaz").catch(()=>{});
    await page.locator('input[name*="Passport" i]').first().fill("FAS"+stamp).catch(()=>{});
    try { const cb=page.locator("input[id*=combobox], input[role=combobox]"); const cn=await cb.count(); for(let i=0;i<cn;i++){const e=cb.nth(i); if(!(await e.isVisible().catch(()=>false)))continue; if((await e.inputValue().catch(()=>"x"))!=="")continue; await e.click().catch(()=>{}); await e.fill("Turkey").catch(()=>{}); await page.waitForTimeout(1200); const o=page.locator("[role=option], lightning-base-combobox-item, .slds-listbox__option").first(); if(await o.count())await o.click({timeout:2500}).catch(()=>{}); await page.waitForTimeout(400);} } catch(e){}
    try { const c=page.locator("input[required]"); const n=await c.count(); for(let i=0;i<n;i++){const el=c.nth(i); if(!(await el.isVisible().catch(()=>false)))continue; const idr=((await el.getAttribute("id").catch(()=>""))||"")+((await el.getAttribute("role").catch(()=>""))||""); if(/combobox/i.test(idr))continue; const ty=(await el.getAttribute("type").catch(()=>""))||"text"; if(ty==="radio"||ty==="checkbox")continue; if((await el.inputValue().catch(()=>"x"))===""){await el.fill("fas"+stamp+"@example.com").catch(()=>{});break;}}}catch(e){}
    try { const se=page.locator("select"); const sn=await se.count(); for(let i=0;i<sn;i++){const el=se.nth(i); if(await el.isVisible().catch(()=>false))await el.selectOption({index:1}).catch(()=>{});}}catch(e){}
    try { const r=page.locator("input[type=radio]"); if(await r.count()){const id=await r.first().getAttribute("id").catch(()=>null); if(id)await page.locator('label[for="'+id+'"]').first().click({timeout:2000}).catch(()=>{}); await r.first().check({force:true}).catch(()=>{});}}catch(e){}
    try { const sel=page.getByRole("button",{name:/^select$/i}).first(); if(await sel.count())await sel.click({timeout:3000}).catch(()=>{});}catch(e){}
  };
  const adv = async () => { const nx=page.getByRole("button",{name:/^\s*(next|ileri|sonraki|devam)\s*$/i}).first(); if(await nx.count()){await nx.click({timeout:5000}).catch(()=>{});return;} const cna=page.getByRole("button",{name:/create new application|add application/i}).first(); if(await cna.count())await cna.click({timeout:5000}).catch(()=>{}); };
  try {
    await page.goto("https://applyonline.bau.edu.tr/agency/s/application-form", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    for (let step=0; step<9; step++) {
      const before=(await body()).slice(0,300);
      await fill(); await page.waitForTimeout(700); await adv(); await page.waitForTimeout(5000);
      const after=(await body()).slice(0,300);
      if(after===before){
        out.stuckStep=step;
        out.fullBody=(await body()).slice(0,700);
        out.buttons=await page.evaluate("(()=>{var r=[];document.querySelectorAll('button,[role=button],input[type=submit]').forEach(function(b){var t=(b.value||b.innerText||'').trim();if(t)r.push(t.slice(0,30))});return Array.from(new Set(r)).slice(0,30)})()").catch(()=>[]);
        break;
      }
      if(/review and submit|completed/i.test(after)){out.reachedFinal=true;break;}
    }
  } catch (e:any) { out.err=e.message; }
  finally { try { await s.close(); } catch(e){} }
  console.log("S4 " + JSON.stringify(out));
  process.exit(0);
})();
