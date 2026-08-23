import { adapterForUniversity } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
const BTNS = "(()=>{var a=[];function w(r){var e=[];try{e=[].slice.call(r.querySelectorAll('button,a[role=button],[role=option],lightning-button,c-eduhub-program-card,tr'))}catch(x){}for(var i=0;i<e.length;i++){var el=e[i];var vis=true;try{vis=el.offsetParent!==null}catch(x){}if(!vis)continue;var t=(el.innerText||el.getAttribute('title')||el.getAttribute('aria-label')||'').trim().slice(0,50);if(t)a.push(el.tagName.toLowerCase()+':'+t)}var al=[];try{al=[].slice.call(r.querySelectorAll('*'))}catch(x){}for(var j=0;j<al.length;j++){if(al[j].shadowRoot)w(al[j].shadowRoot)}}w(document);return a.slice(0,60)})()";
const hasKw = "(()=>{var f=false;function w(r){try{if(r.querySelector('input[placeholder*=Keyword i],input[placeholder*=keyword i]'))f=true}catch(x){}var al=[];try{al=[].slice.call(r.querySelectorAll('*'))}catch(x){}for(var j=0;j<al.length;j++){if(al[j].shadowRoot)w(al[j].shadowRoot)}}w(document);return f})()";
(async () => {
  const adapter: any = adapterForUniversity("Üsküdar Üniversitesi");
  const creds = await resolvePortalCreds(adapter.key, adapter.key);
  const session: any = await adapter.login({ credentials: creds, headless: true });
  const page = session.page;
  await page.goto("https://apply.uskudar.edu.tr/agency/s/application-form", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);
  const pickRadioNext = async () => { const r = page.locator("input[type=radio]"); if (await r.count()) { const id = await r.first().getAttribute("id"); if (id) await page.locator("label[for=\"" + id + "\"]").first().click().catch(() => {}); } await page.getByRole("button", { name: /^\s*next\s*$/i }).first().click().catch(() => {}); await page.waitForTimeout(5000); };
  await pickRadioNext();
  await page.locator("input[name=\"Student_First_Name\"]").first().fill("Mehmet").catch(() => {}); await page.keyboard.press("Tab");
  await page.locator("input[name=\"Student_Last_Name\"]").first().fill("Yilmaz").catch(() => {}); await page.keyboard.press("Tab");
  await page.locator("input[name=\"Student_Passport_Number\"]").first().fill("FAS" + String(Date.now()).slice(-7)).catch(() => {}); await page.keyboard.press("Tab");
  await page.locator("input[placeholder=\"you@example.com\"]").first().fill("fas.p." + String(Date.now()).slice(-7) + "@example.com").catch(() => {}); await page.keyboard.press("Tab");
  await page.getByRole("button", { name: /^\s*next\s*$/i }).first().click().catch(() => {});
  await page.waitForTimeout(6000);
  for (let i = 0; i < 3; i++) { if (await page.evaluate(hasKw).catch(() => false)) break; await pickRadioNext(); }
  console.log("AT_PROGRAM hasKw=" + (await page.evaluate(hasKw).catch(() => false)));
  console.log("BTNS " + JSON.stringify(await page.evaluate(BTNS).catch(() => [])));
  const sa = page.getByRole("button", { name: /show all/i }).first(); if (await sa.count()) { await sa.click().catch(() => {}); await page.waitForTimeout(2500); }
  console.log("AFTER_SHOWALL " + JSON.stringify(await page.evaluate(BTNS).catch(() => [])));
  await page.screenshot({ path: "/tmp/uskudar-program.png", fullPage: true }).catch(() => {});
  await session.close().catch(() => {});
  process.exit(0);
})();
