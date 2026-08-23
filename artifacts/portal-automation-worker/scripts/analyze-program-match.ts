/**
 * analyze-program-match.ts
 * Simulates matchProgram() for all known CRM programs against estimated
 * Topkapi portal option names. Shows confidence + risk flags without
 * hitting the live portal.
 *
 * Usage: pnpm --filter @workspace/portal-automation-worker tsx ./scripts/analyze-program-match.ts
 */
import { matchProgram } from "@workspace/portal-adapters";
import type { ProgramCandidate } from "@workspace/portal-adapters";

// ---------------------------------------------------------------------------
// Known CRM programId → program name pairs
// ---------------------------------------------------------------------------
const CRM_PROGRAMS: Array<{ id: string; name: string }> = [
  { id: "9303",  name: "Bachelor of Computer Engineering (English)" },
  { id: "9298",  name: "Bachelor of Business Administration (English)" },
  { id: "9299",  name: "Bachelor of Business Administration (Turkish)" },
  { id: "9316",  name: "Bachelor of International Trade and Business (English)" },
  { id: "9325",  name: "Bachelor of Psychology (English)" },
  { id: "9339",  name: "Master of Business Administration (Non-Thesis) (Turkish)" },
  { id: "13583", name: "Master of Electrical and Electronics Engineering (Non-Thesis) (English)" },
  { id: "13588", name: "Master of Business Administration (Thesis) (English)" },
  { id: "13589", name: "Master of Business Administration (Non-Thesis) (English)" },
  { id: "13607", name: "Master of Management Information Systems (Non-Thesis) (English)" },
  { id: "13610", name: "Bachelor of Electrical and Electronics Engineering (English)" },
];

// ---------------------------------------------------------------------------
// Estimated Topkapi portal option names (Turkish, as seen in the dropdown).
// IMPORTANT: these are best-effort estimates. Run dump-program-options.ts
// against the live portal to get the real <option value="..."> pairs.
// ---------------------------------------------------------------------------
const ESTIMATED_PORTAL_OPTIONS: ProgramCandidate[] = [
  { id: "p1",  name: "Bilgisayar Mühendisliği (İngilizce)" },
  { id: "p2",  name: "İşletme (İngilizce)" },
  { id: "p3",  name: "İşletme (Türkçe)" },
  { id: "p4",  name: "Uluslararası Ticaret ve İşletme (İngilizce)" },
  { id: "p5",  name: "Psikoloji (İngilizce)" },
  { id: "p6",  name: "İşletme Yüksek Lisans (Tezsiz) (Türkçe)" },
  { id: "p7",  name: "Elektrik-Elektronik Mühendisliği Yüksek Lisans (Tezsiz) (İngilizce)" },
  { id: "p8",  name: "İşletme Yüksek Lisans (Tezli) (İngilizce)" },
  { id: "p9",  name: "İşletme Yüksek Lisans (Tezsiz) (İngilizce)" },
  { id: "p10", name: "Yönetim Bilişim Sistemleri Yüksek Lisans (Tezsiz) (İngilizce)" },
  { id: "p11", name: "Elektrik-Elektronik Mühendisliği (İngilizce)" },
];

console.log("=== PROGRAM MATCH ANALYSIS (estimated portal options) ===\n");
console.log("NOTE: Run dump-program-options.ts against live portal for real option values.\n");

let risks = 0;
for (const crm of CRM_PROGRAMS) {
  const result = matchProgram(crm.name, ESTIMATED_PORTAL_OPTIONS);
  const icon = result ? "✅" : "❌";
  console.log(`[${crm.id}] ${crm.name}`);
  if (result) {
    console.log(`  → "${result.match.name}" (id=${result.match.id}, conf=${result.conf.toFixed(2)})`);
  } else {
    console.log(`  → NO MATCH — needs a name mapping (portal label → CRM name)`);
    risks++;
  }
  console.log();
}

console.log(`Summary: ${CRM_PROGRAMS.length - risks}/${CRM_PROGRAMS.length} matched, ${risks} at risk`);
console.log("\nNext step: run dump-program-options.ts to get real portal option IDs,");
console.log("then add name mappings (portal label → CRM name) in the Program Mapping panel.");
