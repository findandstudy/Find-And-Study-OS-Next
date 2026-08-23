import { launchPortal } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";

const key = process.argv[2];
const loginUrl = process.argv[3];
const formPath = process.argv[4] || "application-form";
const MAXSTEPS = 14;

const DUMP = "(() => { var acc=[]; var seen=new Set();" +
  "function walk(root){ var els=[]; try{ els=Array.prototype.slice.call(root.querySelectorAll('input,select,textarea,button,[role=combobox]')); }catch(e){}" +
  "for(var i=0;i<els.length;i++){ var el=els[i]; if(seen.has(el))continue; seen.add(el); var g=function(a){return el.getAttribute?(el.getAttribute(a)||''):'';}; var vis=true; try{vis=el.offsetParent!==null||el.getClientRects().length>0;}catch(e){} if(!vis)continue; acc.push({tag:el.tagName.toLowerCase(),type:g('type'),name:g('name'),id:el.id||'',ph:g('placeholder'),aria:g('aria-label'),txt:(el.innerText||'').trim().slice(0,40)}); }" +
  "var all=[]; try{ all=Array.prototype.slice.call(root.querySelectorAll('*')); }catch(e){} for(var j=0;j<all.length;j++){ if(all[j].shadowRoot) walk(all[j].shadowRoot); } }" +
  "walk(document); return acc; })()";
const HEAD = "(() => { var h=document.querySelector('h1,h2,.slds-text-heading_medium,legend'); return (h&&h.innerText||'').trim().slice(0,80); })()";
const ERR = "(() => { var e=[]; var ns=document.querySelectorAll('.slds-has-error,[class*=error i],[role=alert],.errorMessage'); for(var i=0;i<ns.length;i++){ var t=(ns[i].innerText||'').trim(); if(t&&t.length<160&&e.indexOf(t)<0)e.push(t);} return e.slice(0,8); })()";
const sig = (fields: any[]) => JSON.stringify((fields || []).map((f: any) => (f.name || f.txt || "")).filter(Boolean).sort());

(async () => {
  if (!key || !loginUrl) { console.log("usage"); process.exit(1); }
  let creds: any;
  try { creds = await resolvePortalCreds(key, key); } catch (e: any) { console.log("CREDS_ERR " + e.message); process.exit(2); }
  console.log("CREDS_OK user=" + creds.user);
  const session = await launchPortal();
  const page: any = session.page;
  const out: any = { key, steps: [] };
  const fillStep = async () => {
    try { const r = page.locator("input[type=radio]"); if (await r.count()) { const el = r.first(); const id = await el.getAttribute("id").catch(() => null); let ok = false; if (id) { const lb = page.locator("label[for=\"" + id + "\"]").first(); if (await lb.count()) { await lb.click({ timeout: 3000 }).catch(() => {}); ok = await el.isChecked().catch(() => false); } } if (!ok) await el.check({ force: true, timeout: 3000 }).catch(() => {}); } } catch (e) {}
    const byName = async (n: string, v: string) => { try { const l = page.locator("input[name=\"" + n + "\"]").first(); if (await l.count() && await l.isVisible().catch(() => false)) { await l.fill(v).catch(() => {}); await l.press("Tab").catch(() => {}); } } catch (e) {} };
    await byName("Student_First_Name", "Test"); await byName("Student_Last_Name", "Applicant");
    try { const p = page.locator("input[name*=Passport i],input[name*=passport i]").first(); if (await p.count() && await p.isVisible().catch(() => false)) { await p.fill("FAS" + String(Date.now()).slice(-7)).catch(() => {}); await p.press("Tab").catch(() => {}); } } catch (e) {}
    try { const em = page.locator("input[placeholder=\"you@example.com\"], input[type=email], input[name*=mail i]").first(); if (await em.count() && await em.isVisible().catch(() => false)) { await em.fill("fas.test." + Date.now() + "@example.com").catch(() => {}); await em.press("Tab").catch(() => {}); } } catch (e) {}
    try { const s = page.locator("select"); const n = await s.count(); for (let i = 0; i < n; i++) await s.nth(i).selectOption({ index: 1 }).catch(() => {}); } catch (e) {}
    try { const fi = page.locator("input[type=file]"); const n = await fi.count(); for (let i = 0; i < n; i++) await fi.nth(i).setInputFiles("/tmp/dummy.pdf").catch(() => {}); } catch (e) {}
    try { const sa = page.getByRole("button", { name: /show all/i }).first(); if (await sa.count()) { await sa.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(1500); } } catch (e) {}
    try { const sp = page.getByRole("button", { name: /select_program|^\s*select\s*$|seç/i }).first(); if (await sp.count()) { await sp.click({ timeout: 4000 }).catch(() => {}); await page.waitForTimeout(1500); } } catch (e) {}
    try { const t = page.locator("input[type=text],input:not([type]),textarea"); const n = await t.count(); for (let i = 0; i < Math.min(n, 20); i++) { const el = t.nth(i); if (!(await el.isVisible().catch(() => false))) continue; if (await el.inputValue().catch(() => "x")) continue; await el.fill("Test").catch(() => {}); } } catch (e) {}
  };
  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    await page.locator("input[type=email], input[name*=email i]").first().fill(creds.user).catch(() => {});
    await page.locator("input[type=password]").first().fill(creds.password).catch(() => {});
    await page.getByRole("button", { name: /login|giris|sign in/i }).first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(8000);
    out.loggedIn = await page.evaluate("(() => { var p=document.querySelector('input[type=password]'); return !(p&&p.offsetParent); })()").catch(() => null);
    await page.goto(loginUrl.replace(/\/$/, "") + "/" + formPath, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(6000);
    for (let step = 1; step <= MAXSTEPS; step++) {
      const heading = await page.evaluate(HEAD).catch(() => "");
      let fields = await page.evaluate(DUMP).catch(() => []);
      if (!fields.length) { await page.waitForTimeout(6000); fields = await page.evaluate(DUMP).catch(() => []); }
      const errs = await page.evaluate(ERR).catch(() => []);
      const hasNext = await page.getByRole("button", { name: /^\s*(next|ileri|sonraki|devam)\s*$/i }).count();
      const hasSubmit = await page.getByRole("button", { name: /submit|complete|tamamla|gönder|finish|onayla/i }).count();
      out.steps.push({ step, heading, fieldCount: fields.length, fields, errs, hasNext: !!hasNext, hasSubmit: !!hasSubmit });
      await page.screenshot({ path: "/tmp/" + key + "-step" + step + ".png", fullPage: true }).catch(() => {});
      if (hasSubmit && !hasNext) { out.reachedFinal = true; break; }
      if (!hasNext) { out.stoppedNoNext = true; break; }
      const before = sig(fields);
      await fillStep();
      await page.getByRole("button", { name: /^\s*(next|ileri|sonraki|devam)\s*$/i }).first().click({ timeout: 6000 }).catch(() => {});
      let moved = false;
      for (let t = 0; t < 12; t++) { await page.waitForTimeout(1000); const nf = await page.evaluate(DUMP).catch(() => []); if (sig(nf) !== before) { moved = true; break; } }
      if (!moved) { out.blockedAtStep = step; out.blockErr = await page.evaluate(ERR).catch(() => []); break; }
    }
  } catch (e: any) { out.error = e.message; }
  finally { await session.close(); }
  console.log("RESULT " + JSON.stringify(out));
  process.exit(0);
})();
