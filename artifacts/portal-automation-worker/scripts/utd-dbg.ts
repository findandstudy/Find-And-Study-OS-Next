import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
(async () => {
  const a: any = adapterByKey("united");
  const creds = await resolvePortalCreds("united", "united");
  const s: any = await a.login({ credentials: creds, headless: true });
  const page = s.page;
  const out: any = {};
  try {
    out.loginUrl = page.url();
    out.nav = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((x:any)=>({t:(x.innerText||"").replace(/\s+/g," ").trim().slice(0,30),h:x.getAttribute("href")})).filter((o:any)=>o.t).slice(0,40));
    const apply = page.getByRole("link", { name: /apply new student/i }).first();
    out.hasApply = await apply.count().catch(()=>0);
    if (!out.hasApply) { const b = page.getByRole("button", { name: /apply new student/i }).first(); if (await b.count()) { out.hasApply = 1; await b.click({timeout:6000}).catch(()=>{}); } }
    else await apply.click({ timeout: 8000 }).catch(()=>{});
    await page.waitForTimeout(5000);
    out.step1Url = page.url();
    out.step1Body = (await page.evaluate("(()=>document.body?document.body.innerText:'')()")).replace(/\s+/g," ").slice(0,600);
    out.step1Fields = await page.evaluate(() => Array.from(document.querySelectorAll("select, input, [role=combobox], button")).slice(0,40).map((e:any)=>({tag:e.tagName,type:e.getAttribute("type"),role:e.getAttribute("role"),name:e.getAttribute("name"),id:e.getAttribute("id"),ph:e.getAttribute("placeholder"),txt:(e.innerText||"").replace(/\s+/g," ").slice(0,30)})));
  } catch (e:any) { out.error = e.message; }
  console.log("UTD " + JSON.stringify(out, null, 1));
  await s.close().catch(()=>{});
  process.exit(0);
})();
