import { launchPortal } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
(async () => {
  const creds: any = await resolvePortalCreds("emu", "emu");
  const session: any = await launchPortal();
  const page = session.page;
  try {
    await page.goto("https://applyonline.emu.edu.tr/agency", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    for (const s of ["input[type=email]","input[name*=email i]","input[type=text]"]) { const l=page.locator(s).first(); if((await l.count())&&(await l.isVisible().catch(()=>false))){ await l.fill(creds.user).catch(()=>{}); break; } }
    await page.locator("input[type=password]").first().fill(creds.password).catch(()=>{});
    await page.getByRole("button",{name:/login|sign in|giris|gönder|submit/i}).first().click({timeout:8000}).catch(()=>{});
    await page.waitForTimeout(7000);
    const out:any = { url: page.url(), loginOk: !(await page.locator("input[type=password]").first().isVisible().catch(()=>false)) };
    out.links = await page.evaluate("(()=>{var r=[];document.querySelectorAll('a[href]').forEach(function(a){var t=(a.innerText||'').trim().slice(0,30);var h=a.getAttribute('href')||'';if(h&&!h.startsWith('#'))r.push(t+' => '+h)});return Array.from(new Set(r)).slice(0,60)})()").catch(()=>[]);
    out.buttons = await page.evaluate("(()=>{var r=[];document.querySelectorAll('button,[role=button],input[type=submit]').forEach(function(b){var t=(b.innerText||b.value||'').trim().slice(0,30);if(t)r.push(t)});return Array.from(new Set(r)).slice(0,40)})()").catch(()=>[]);
    console.log("EMU " + JSON.stringify(out));
  } catch(e:any){ console.log("ERR "+e.message); } finally { await session.close().catch(()=>{}); }
  process.exit(0);
})();
