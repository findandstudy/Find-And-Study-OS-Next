/**
 * dump-program-options.ts — logs into Topkapi portal and dumps ALL program
 * dropdown options (id → name) from the application form.
 *
 * Output is written to /tmp/topkapi-program-options.json
 *
 * Usage:
 *   pnpm --filter @workspace/portal-automation-worker tsx ./scripts/dump-program-options.ts
 *
 * After running, paste the output into PROGRAM_MAP in:
 *   lib/portal-adapters/src/universities/topkapi/adapter.ts
 */
import fs from "node:fs/promises";
import { resolvePortalCreds } from "../src/credResolver.js";
import { adapterByKey } from "@workspace/portal-adapters";

const PORTAL_URL  = "https://apply.topkapi.edu.tr";
const OUTPUT_PATH = "/tmp/topkapi-program-options.json";

async function main(): Promise<void> {
  console.log("[dump-programs] Resolving Topkapi credentials …");
  const creds = await resolvePortalCreds("topkapi", "topkapi");
  console.log(`[dump-programs] Credentials resolved (user: ${creds.user}) — logging in …`);

  const adapter = adapterByKey("topkapi");
  if (!adapter) throw new Error("[dump-programs] No adapter found for key 'topkapi'");
  // Pass the DB-resolved credentials explicitly so the script runs standalone
  // (no TOPKAPI_EMAIL/PASSWORD env requirement — login() only falls back to env
  // when `credentials` is omitted).
  const session = await adapter.login({
    credentials: { user: creds.user, password: creds.password },
  });
  const { page } = session;

  try {
    console.log("[dump-programs] Navigating to application form …");
    await page.goto(`${PORTAL_URL}/panel/applications/add`, { waitUntil: "networkidle" });

    // The program dropdown (programFirstPreference) is on an inner wizard step.
    // We walk through steps until we find it.
    let options: Array<{ id: string; name: string; disabled: boolean }> = [];

    for (let step = 0; step <= 6; step++) {
      options = await page.$$eval(
        "select[name=programFirstPreference] option",
        (opts) =>
          (opts as HTMLOptionElement[])
            .filter((o) => o.value && o.value !== "0" && o.value !== "")
            .map((o) => {
              const name = o.textContent?.trim() ?? "";
              return {
                id: o.value,
                name,
                disabled:
                  o.disabled || /\(\s*Kontenjan\s*Dolu\s*\)/i.test(name),
              };
            }),
      ).catch(() => []);

      if (options.length > 0) {
        console.log(`[dump-programs] Found ${options.length} options at step ${step}.`);
        break;
      }

      console.log(`[dump-programs] Step ${step}: program dropdown not yet visible — advancing …`);

      // Fill minimum required fields for step navigation
      if (step === 0) {
        await page.fill("input[name=email]", "dump-test-donotsubmit@example.com").catch(() => {});
        await page.fill("input[name=passportNumber]", "DUMPTEST00").catch(() => {});
      }

      const next = page.getByRole("button", { name: /Sonraki Adım/i });
      const visible = await next.isVisible().catch(() => false);
      if (!visible) {
        console.log("[dump-programs] No 'Sonraki Adım' button at this step — stopping.");
        break;
      }
      await next.click();
      await page.waitForTimeout(2000);
    }

    if (options.length === 0) {
      console.error("[dump-programs] Could not find program dropdown in any step.");
      process.exit(1);
    }

    await fs.writeFile(OUTPUT_PATH, JSON.stringify(options, null, 2), "utf8");
    const openCount = options.filter((o) => !o.disabled).length;
    console.log(
      `\n[dump-programs] Written ${options.length} options (${openCount} open / ${options.length - openCount} Kontenjan Dolu) → ${OUTPUT_PATH}\n`,
    );
    console.log("=== PROGRAM OPTIONS (id → name [state]) ===");
    for (const o of options) {
      console.log(
        `  ${String(o.id).padStart(6)}: ${o.name}${o.disabled ? "  [KONTENJAN DOLU]" : ""}`,
      );
    }

    // Generate suggested PROGRAM_MAP entries
    console.log("\n=== SUGGESTED PROGRAM_MAP ENTRIES ===");
    console.log("// Paste into PROGRAM_MAP in lib/portal-adapters/src/universities/topkapi/adapter.ts");
    const CRM: Record<string, string> = {
      "9303":  "Bachelor of Computer Engineering (English)",
      "9298":  "Bachelor of Business Administration (English)",
      "9299":  "Bachelor of Business Administration (Turkish)",
      "9316":  "Bachelor of International Trade and Business (English)",
      "9325":  "Bachelor of Psychology (English)",
      "9339":  "Master of Business Administration (Non-Thesis) (Turkish)",
      "13583": "Master of Electrical and Electronics Engineering (Non-Thesis) (English)",
      "13588": "Master of Business Administration (Thesis) (English)",
      "13589": "Master of Business Administration (Non-Thesis) (English)",
      "13607": "Master of Management Information Systems (Non-Thesis) (English)",
      "13610": "Bachelor of Electrical and Electronics Engineering (English)",
    };

    // Simple fold for matching suggestion
    function foldStr(s: string): string {
      return s
        .replace(/İ/g, "i").replace(/I/g, "i").replace(/ı/g, "i")
        .replace(/Ş/g, "s").replace(/ş/g, "s").replace(/Ç/g, "c").replace(/ç/g, "c")
        .replace(/Ö/g, "o").replace(/ö/g, "o").replace(/Ü/g, "u").replace(/ü/g, "u")
        .replace(/Ğ/g, "g").replace(/ğ/g, "g")
        .toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
    }

    for (const [crmId, crmName] of Object.entries(CRM)) {
      // Find the best option by looking for key tokens
      const crmFolded = foldStr(crmName);
      const ranked = options
        .map(o => {
          const of2 = foldStr(o.name);
          const crmToks = new Set(crmFolded.split(" "));
          const optToks = new Set(of2.split(" "));
          let inter = 0;
          for (const t of crmToks) if (optToks.has(t)) inter++;
          const union = crmToks.size + optToks.size - inter;
          return { ...o, score: union === 0 ? 0 : inter / union };
        })
        .sort((a, b) => b.score - a.score);
      const best = ranked[0];
      const confident = best && best.score >= 0.3;
      const comment = confident ? "" : " // ❌ LOW CONFIDENCE — verify manually";
      console.log(`  "${crmId}": "${best?.id ?? "??"}",  // CRM: ${crmName}`);
      if (!confident) console.log(`           // Best guess: "${best?.name}" (score=${best?.score.toFixed(2)})${comment}`);
    }
  } finally {
    await session.close();
  }
}

main().catch((err) => {
  console.error("[dump-programs] Fatal:", err);
  process.exit(1);
});
