import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
const SEL = 'input[name="Student_First_Name"]';
(async () => {
  const a: any = adapterByKey("uskudar");
  const creds = await resolvePortalCreds("uskudar", "uskudar");
  const s: any = await a.login({ credentials: creds, headless: true });
  const page = s.page;
  const out: any = {};
  try {
    await page.goto("https://apply.uskudar.edu.tr/agency/s/application-form", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    out.url0 = page.url();
    out.resumeBanner = /resume|continue|draft|devam|taslak/i.test(await page.evaluate("(()=>document.body?document.body.innerText:'')()"));
    // walk cards until student field appears
    for (let i = 0; i < 6; i++) {
      const has = await page.locator(SEL).count();
      if (has) { out.reachedAt = i; break; }
      const card = page.locator('input[type=radio], [class*=card i] input, lightning-input[type=radio]').first();
      if (await card.count()) { try { const id = await card.getAttribute("id"); if (id) await page.locator('label[for="' + id + '"]').first().click({ timeout: 2000 }).catch(()=>{}); else await card.click({ timeout: 2000 }).catch(()=>{}); } catch(e){} }
      const next = page.getByRole("button", { name: /next|ileri|continue|devam/i }).first();
      if (await next.count()) await next.click({ timeout: 4000 }).catch(()=>{});
      await page.waitForTimeout(3500);
    }
    const cnt = await page.locator(SEL).count();
    out.fieldCount = cnt;
    if (cnt) {
      const loc = page.locator(SEL).first();
      out.info = await loc.evaluate("(el)=>({tag:el.tagName,type:el.type,ro:el.readOnly,dis:el.disabled,role:el.getAttribute('role'),aac:el.getAttribute('aria-autocomplete'),val:el.value})");
      // A: fill
      try { await loc.fill(""); await loc.fill("AAA"); } catch(e){}
      out.afterFill = await loc.inputValue().catch(()=>"ERR");
      // B: pressSequentially
      try { await loc.fill(""); await loc.click(); await loc.pressSequentially("BBB", { delay: 80 }); } catch(e){}
      out.afterPress = await loc.inputValue().catch(()=>"ERR");
      // C: JS native setter + events
      try { await loc.evaluate("(el)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,'CCC');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));el.dispatchEvent(new Event('blur',{bubbles:true}));}"); } catch(e){}
      out.afterJS = await loc.inputValue().catch(()=>"ERR");
      // D: focus + keyboard.insertText
      try { await loc.evaluate("(el)=>{const d=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');d.set.call(el,'');}"); await loc.click(); await page.keyboard.insertText("DDD"); } catch(e){}
      out.afterInsert = await loc.inputValue().catch(()=>"ERR");
    } else {
      out.bodyHint = (await page.evaluate("(()=>document.body?document.body.innerText:'')()")).replace(/\s+/g," ").slice(0,200);
    }
  } catch (e: any) { out.error = e.message; }
  finally { try { await s.close(); } catch(e){} }
  console.log("DBG " + JSON.stringify(out));
  process.exit(0);
})();
