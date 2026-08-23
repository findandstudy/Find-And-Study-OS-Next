import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
const KEY = process.env.K || "ozyegin";
const BASE = process.env.B || "https://apply.ozyegin.edu.tr/agency/s";
const SELS = 'input[name="Student_First_Name"], input[name="First_Name"]';
const stamp = Date.now().toString().slice(-6);
const DUMP = "(() => { var a=[]; var seen=new Set(); function w(r){ var e=[]; try{e=Array.prototype.slice.call(r.querySelectorAll('input,select,textarea'))}catch(x){} for(var i=0;i<e.length;i++){var el=e[i]; if(seen.has(el))continue; seen.add(el); var ty=el.type||el.tagName.toLowerCase(); if(ty==='hidden')continue; var vis=true; try{vis=el.getClientRects().length>0}catch(x){} if(!vis)continue; a.push(ty+':'+(el.getAttribute('name')||el.id||'?')+'|v='+((el.value||'')+'').slice(0,12)+'|req='+(el.required?1:0)); } var al=[]; try{al=Array.prototype.slice.call(r.querySelectorAll('*'))}catch(x){} for(var j=0;j<al.length;j++){if(al[j].shadowRoot)w(al[j].shadowRoot);} } w(document); return a.slice(0,50); })()";
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
    out.before = await page.evaluate(DUMP);
    // fill known
    await page.locator('input[name="Student_First_Name"], input[name="First_Name"]').first().fill("Mehmet").catch(()=>{});
    await page.locator('input[name="Student_Last_Name"], input[name="Last_Name"]').first().fill("Yilmaz").catch(()=>{});
    await page.locator('input[name*="Passport" i]').first().fill("FAS"+stamp).catch(()=>{});
    const em = page.locator('input[type=email], input[placeholder*="@"], input[name*="mail" i]').first();
    if (await em.count()) await em.fill("fas"+stamp+"@example.com").catch(()=>{});
    await page.waitForTimeout(800);
    out.after = await page.evaluate(DUMP);
    await page.getByRole("button", { name: /next|ileri|continue|devam/i }).first().click({ timeout: 5000 }).catch(()=>{});
    await page.waitForTimeout(5000);
    out.advanced = !(await page.locator(SELS).count());
    out.valid = ((await body()).match(/required|zorunlu|please|geçerl|enter |must |invalid|fill/i) ? (await body()).slice(0,180) : "none");
  } catch (e: any) { out.err = e.message; }
  finally { try { await s.close(); } catch(e){} }
  console.log("STU2 " + JSON.stringify(out));
  process.exit(0);
})();
