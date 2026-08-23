import { launchPortal } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
const key = process.argv[2];
const loginUrl = process.argv[3];
const DUMP = "(() => { var a=[]; var seen=new Set(); function w(r){ var e=[]; try{e=Array.prototype.slice.call(r.querySelectorAll('input,select,button,[role=combobox]'))}catch(x){} for(var i=0;i<e.length;i++){var el=e[i]; if(seen.has(el))continue; seen.add(el); var vis=true; try{vis=el.offsetParent!==null}catch(x){} if(!vis)continue; var g=function(n){return el.getAttribute?(el.getAttribute(n)||''):''}; a.push((el.tagName.toLowerCase())+':'+(g('name')||g('type')||(el.innerText||'').trim().slice(0,18))); } var al=[]; try{al=Array.prototype.slice.call(r.querySelectorAll('*'))}catch(x){} for(var j=0;j<al.length;j++){if(al[j].shadowRoot)w(al[j].shadowRoot)} } w(document); return a.slice(0,25); })()";
(async () => {
  const out: any = { key, loginUrl };
  let creds: any; try { creds = await resolvePortalCreds(key, key); } catch (e: any) { console.log("RESULT " + JSON.stringify({ key, credErr: e.message })); process.exit(0); }
  const session: any = await launchPortal();
  const page = session.page;
  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    out.captcha = /recaptcha|hcaptcha/i.test(await page.content());
    for (const s of ["input[type=email]","input[name*=email i]","input[type=text]"]) { const l=page.locator(s).first(); if((await l.count())&&(await l.isVisible().catch(()=>false))){ await l.fill(creds.user).catch(()=>{}); break; } }
    await page.locator("input[type=password]").first().fill(creds.password).catch(()=>{});
    await page.getByRole("button",{name:/login|sign in|giris/i}).first().click({timeout:8000}).catch(()=>{});
    await page.waitForTimeout(7000);
    out.loginOk = !(await page.locator("input[type=password]").first().isVisible().catch(()=>false));
    await page.goto(loginUrl.replace(/\/$/,"") + "/application-form", { waitUntil:"domcontentloaded", timeout:60000 }).catch(()=>{});
    await page.waitForTimeout(6000);
    out.formUrl = page.url();
    out.heading = (await page.evaluate("(()=>{var h=document.querySelector('h1,h2');return h?h.innerText.slice(0,60):''})()").catch(()=>"")) as string;
    out.fields = await page.evaluate(DUMP).catch(()=>[]);
    out.eduhubRadio = (out.fields||[]).some((f:string)=>/eduhubPicklistOptions/i.test(f));
  } catch (e: any) { out.error = e.message; }
  finally { await session.close().catch(()=>{}); }
  console.log("RESULT " + JSON.stringify(out));
  process.exit(0);
})();
