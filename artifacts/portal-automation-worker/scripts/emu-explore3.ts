import { launchPortal } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
(async () => {
  const creds: any = await resolvePortalCreds("emu", "emu");
  const session: any = await launchPortal();
  const page = session.page;
  try {
    await page.goto("https://applyonline.emu.edu.tr/agency", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3500);
    for (const s of ["input[type=email]","input[name*=email i]","input[type=text]"]) { const l=page.locator(s).first(); if((await l.count())&&(await l.isVisible().catch(()=>false))){ await l.fill(creds.user).catch(()=>{}); break; } }
    await page.locator("input[type=password]").first().fill(creds.password).catch(()=>{});
    await page.getByRole("button",{name:/login|sign in|giris|gönder|submit/i}).first().click({timeout:8000}).catch(()=>{});
    await page.waitForTimeout(6000);
    await page.evaluate("(()=>{try{__doPostBack('ctl00$lbtnUAppl','')}catch(e){}})()").catch(()=>{});
    await page.waitForTimeout(7000);
    try { const an = page.getByText(/add new/i).first(); if(await an.count()) await an.click({timeout:6000}); } catch(e){}
    await page.waitForTimeout(6000);
    const out:any = { url: page.url(), heading: await page.evaluate("(()=>{var h=document.querySelector('h1,h2,.PageTitle,#ctl00_ContentPlaceHolder1_lblTitle');return h?(h.innerText||'').slice(0,80):''})()").catch(()=>"") };
    out.fields = await page.evaluate("(()=>{var r=[];document.querySelectorAll('input,select,textarea').forEach(function(e){var ty=e.type||e.tagName.toLowerCase();if(ty==='hidden')return;var n=e.getAttribute('name')||e.id||'';var lbl='';if(e.id){var la=document.querySelector('label[for=\\''+e.id+'\\']');if(la)lbl=(la.innerText||'').trim().slice(0,25);}r.push(ty+':'+n+(lbl?'('+lbl+')':''))});return r.slice(0,70)})()").catch(()=>[]);
    out.btns = await page.evaluate("(()=>{var r=[];document.querySelectorAll('input[type=submit],input[type=button],button,a[href^=\\'javascript:__doPostBack\\']').forEach(function(b){var t=(b.value||b.innerText||'').trim().slice(0,25);if(t)r.push(t)});return Array.from(new Set(r)).slice(0,40)})()").catch(()=>[]);
    console.log("EMU3 " + JSON.stringify(out));
  } catch(e:any){ console.log("ERR "+e.message); } finally { await session.close().catch(()=>{}); }
  process.exit(0);
})();
