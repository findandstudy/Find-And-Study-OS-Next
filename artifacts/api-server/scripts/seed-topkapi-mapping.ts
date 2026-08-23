/**
 * seed-topkapi-mapping.ts — seeds prod-proven Topkapı matching data into
 * portal_program_mapping (single source, panel-editable).
 *
 * IDEMPOTENT + MERGE-NOT-CLOBBER:
 *   - programOverrides / countryOverrides: seed fills MISSING keys only —
 *     existing (panel-edited) values are preserved (existing wins).
 *   - synonyms: seed groups are APPENDED only if not already present
 *     (dedup by normalised group signature).
 *   - Also normalises auto_process=false for experimental adapter families
 *     (salesforce/sit/united/emu) so the worker never auto-submits them.
 *
 * The matcher reads these MERGED OVER the adapter's built-in code defaults
 * (DB wins). Safe to run repeatedly.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @workspace/api-server seed:topkapi-mapping
 */

import {
  db,
  pool,
  portalProgramMappingTable,
  portalUniversitiesTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { isExperimentalAdapterKey } from "@workspace/portal-adapters";

const UNIVERSITY_KEY = "topkapi_university";

// CRM programId → portal <option> value (numeric, immune to wording changes).
const SEED_PROGRAM_OVERRIDES: Record<string, string> = {
  "9338":  "166",
  "9303":  "111",
  "13607": "107",
  "13582": "126",
};

// EN↔TR synonym equivalence groups — FOLDED single tokens (lowercase ASCII).
// Extends the matcher's built-in dictionary; never removes built-in coverage.
const SEED_SYNONYMS: string[][] = [
  ["yapay", "artificial"],
  ["zeka", "intelligence"],
  ["medya", "media"],
  ["siber", "cyber"],
  ["guvenlik", "security"],
  ["gorsel", "visual"],
  ["resim", "painting"],
  ["pazarlama", "marketing"],
  ["ekonomi", "economics"],
  ["psikoloji", "psychology"],
  ["mimarlik", "architecture"],
  ["hemsirelik", "nursing"],
  ["eczacilik", "pharmacy"],
  ["hukuk", "law"],
  ["tip", "medicine"],
  ["spor", "sport", "sports"],
  ["uluslararasi", "international"],
  ["ticaret", "trade", "commerce"],
  ["bilisim", "information", "informatics", "systems"],
  ["yazilim", "software"],
  ["isletmeciligi", "isletme", "management"],
  ["yoneticiligi", "yonetim", "management"],
  ["ic", "interior"],
  ["beslenme", "nutrition"],
  ["diyetetik", "dietetics"],
  ["fizyoterapi", "physiotherapy"],
  ["rehabilitasyon", "rehabilitation"],
  ["dis", "dental", "dentistry"],
  ["hareket", "movement"],
  ["antrenman", "training"],
  // ── Gap-fills (programs that previously failed to match) ────────────────
  ["ascilik", "cookery", "gastronomy"],         // Aşçılık ↔ Cookery/Gastronomy
  ["hava", "air"],                              // Sivil Hava ↔ Civil Air
  ["ulastirma", "transportation", "transport"], // Ulaştırma ↔ Transportation
  ["sivil", "civil"],                          // Sivil ↔ Civil (aviation)
];

// Country name/adjective (lowercase) → portal dropdown label (Turkish).
// Only the entries NOT already covered by the adapter's built-in country maps.
const SEED_COUNTRY_OVERRIDES: Record<string, string> = {
  niger: "Nijer",
};

// Experimental adapter families that must never auto-submit.
const EXPERIMENTAL_HINT = "salesforce / sit / united / emu";

/** Normalised signature for a synonym group (order-insensitive). */
function groupSig(group: string[]): string {
  return [...group].map((t) => t.trim().toLowerCase()).sort().join("|");
}

async function main(): Promise<void> {
  // ----- 1. Upsert the Topkapı mapping row (merge, not clobber) ------------
  const [existing] = await db
    .select()
    .from(portalProgramMappingTable)
    .where(eq(portalProgramMappingTable.universityKey, UNIVERSITY_KEY));

  // programOverrides: existing values win over seed (don't clobber panel edits)
  const mergedOverrides: Record<string, string> = {
    ...SEED_PROGRAM_OVERRIDES,
    ...(existing?.programOverrides ?? {}),
  };

  // countryOverrides: existing values win over seed
  const mergedCountry: Record<string, string> = {
    ...SEED_COUNTRY_OVERRIDES,
    ...(existing?.countryOverrides ?? {}),
  };

  // synonyms: keep existing, append seed groups not already present
  const existingSyn: string[][] = Array.isArray(existing?.synonyms)
    ? existing!.synonyms
    : [];
  const seen = new Set(existingSyn.map(groupSig));
  const mergedSyn: string[][] = [...existingSyn];
  let addedSyn = 0;
  for (const group of SEED_SYNONYMS) {
    const sig = groupSig(group);
    if (!seen.has(sig)) {
      seen.add(sig);
      mergedSyn.push(group);
      addedSyn++;
    }
  }

  if (existing) {
    await db
      .update(portalProgramMappingTable)
      .set({
        programOverrides: mergedOverrides,
        synonyms:         mergedSyn,
        countryOverrides: mergedCountry,
        updatedAt:        new Date(),
      })
      .where(eq(portalProgramMappingTable.id, existing.id));
  } else {
    await db.insert(portalProgramMappingTable).values({
      universityKey:    UNIVERSITY_KEY,
      mappings:         {},
      programOverrides: mergedOverrides,
      synonyms:         mergedSyn,
      countryOverrides: mergedCountry,
    });
  }

  console.log(
    `[seed] topkapi mapping: overrides=${Object.keys(mergedOverrides).length} ` +
      `synonyms=${mergedSyn.length} (+${addedSyn} new) ` +
      `countries=${Object.keys(mergedCountry).length}`,
  );

  // ----- 2. Disable auto_process for experimental adapter families --------
  const unis = await db
    .select({
      id:         portalUniversitiesTable.id,
      adapterKey: portalUniversitiesTable.adapterKey,
      autoProcess: portalUniversitiesTable.autoProcess,
    })
    .from(portalUniversitiesTable);

  let disabled = 0;
  for (const u of unis) {
    if (u.autoProcess && isExperimentalAdapterKey(u.adapterKey)) {
      await db
        .update(portalUniversitiesTable)
        .set({ autoProcess: false, updatedAt: new Date() })
        .where(eq(portalUniversitiesTable.id, u.id));
      disabled++;
    }
  }
  console.log(
    `[seed] experimental adapters (${EXPERIMENTAL_HINT}): auto_process disabled on ${disabled} row(s)`,
  );

  await pool.end();
}

main().catch(async (err) => {
  console.error("[seed] FAILED:", err);
  await pool.end().catch(() => {});
  process.exit(1);
});
