import { adapterByKey } from "@workspace/portal-adapters";
import { resolvePortalCreds } from "../src/credResolver.js";
(async () => {
  const a: any = adapterByKey("sit");
  const creds = await resolvePortalCreds("sit", "sit");
  const s: any = await a.login({ credentials: creds, headless: true });
  const page = s.page;
  const out: any = {};
  try {
    await page.goto("https://partners.sitconnect.net/students", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    out.inputs = await page.evaluate(() => Array.from(document.querySelectorAll("input")).map((e:any)=>({ph:e.getAttribute("placeholder"),aria:e.getAttribute("aria-label"),type:e.getAttribute("type"),name:e.getAttribute("name")})));
  } catch (e:any) { out.error = e.message; }
  console.log("SITINP " + JSON.stringify(out));
  await s.close().catch(()=>{});
  process.exit(0);
})();
