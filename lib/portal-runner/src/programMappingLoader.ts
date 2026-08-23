/**
 * programMappingLoader.ts — loads panel-managed mapping data from
 * portal_program_mapping and shapes it into the optional SubmitProfile fields
 * consumed by the adapters.
 *
 * Single source of truth: the adapter keeps its built-in code defaults as a
 * fallback; whatever this loader returns is merged OVER those defaults by the
 * adapter (DB wins). When no row exists (or the columns are empty) every field
 * is omitted, so the adapter behaves exactly as before — no prod change.
 */

import { db, portalProgramMappingTable, GENERAL_MAPPING_KEY } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";

export interface ProgramMappingData {
  /** { portal option label → CRM program name } — UNIVERSITY tier (checked first). */
  programNameMap?: Record<string, string>;
  /**
   * { portal option label → CRM program name } — GENERAL (all-schools) tier,
   * with any same-label university entry already shadowed out. Consulted only
   * after `programNameMap` misses (University > General).
   */
  programNameMapGeneral?: Record<string, string>;
  /** EN↔TR synonym equivalence groups (folded single tokens) — General ∪ uni. */
  programSynonyms?: string[][];
  /** Country name/adjective (lowercase) → portal label — General ∪ uni (uni wins). */
  countryOverrides?: Record<string, string>;
  /**
   * { CRM programId (string) → portal program id } — explicit ADMIN override,
   * General ∪ uni (uni wins). Unlike programNameMap, this is a raw catalog id
   * (not a name), consulted by adapters BEFORE any language filter or fuzzy
   * matcher — it is a deliberate admin decision to route a specific CRM
   * program to a specific portal program regardless of language mismatch.
   */
  programIdOverrides?: Record<string, string>;
}

interface MappingRow {
  mappings: Record<string, string> | null;
  programOverrides: Record<string, string> | null;
  synonyms: string[][] | null;
  countryOverrides: Record<string, string> | null;
}

/**
 * Fetch the panel-managed mapping data for a university, MERGED with the GENERAL
 * (all-universities default) tier. Resolution is University > General:
 *   - programNameMap:        UNIVERSITY tier only (checked first by the matcher)
 *   - programNameMapGeneral: GENERAL tier, minus any portal label the university
 *                            remapped (a uni entry shadows the same label)
 *   - countryOverrides:      { ...general, ...uni } (uni key wins)
 *   - programSynonyms:       [ ...general, ...uni ] (both extend)
 *
 * Fully name-based — the removed CRM-programId override column is no longer read.
 * Never throws — on any DB error returns {} so the adapter falls back to its
 * built-in defaults (the submission must not fail because the table is missing).
 */
export async function loadProgramMapping(
  universityKey: string,
  memberUniversityId: number | null = null,
): Promise<ProgramMappingData> {
  try {
    // GENERAL tier: single row keyed by the reserved sentinel, member NULL.
    const [generalRow] = await db
      .select({
        mappings:         portalProgramMappingTable.mappings,
        programOverrides: portalProgramMappingTable.programOverrides,
        synonyms:         portalProgramMappingTable.synonyms,
        countryOverrides: portalProgramMappingTable.countryOverrides,
      })
      .from(portalProgramMappingTable)
      .where(
        and(
          eq(portalProgramMappingTable.universityKey, GENERAL_MAPPING_KEY),
          isNull(portalProgramMappingTable.memberUniversityId),
        ),
      );

    // UNIVERSITY tier. memberUniversityId null → 1:1 row (member IS NULL),
    // today's behaviour. Non-null → the multi-portal account's row for that member.
    const memberCondition =
      memberUniversityId == null
        ? isNull(portalProgramMappingTable.memberUniversityId)
        : eq(portalProgramMappingTable.memberUniversityId, memberUniversityId);
    const [uniRow] = await db
      .select({
        mappings:         portalProgramMappingTable.mappings,
        programOverrides: portalProgramMappingTable.programOverrides,
        synonyms:         portalProgramMappingTable.synonyms,
        countryOverrides: portalProgramMappingTable.countryOverrides,
      })
      .from(portalProgramMappingTable)
      .where(
        and(
          eq(portalProgramMappingTable.universityKey, universityKey),
          memberCondition,
        ),
      );

    return mergeTiers(generalRow ?? null, uniRow ?? null);
  } catch {
    return {};
  }
}

function mergeTiers(
  general: MappingRow | null,
  uni: MappingRow | null,
): ProgramMappingData {
  const out: ProgramMappingData = {};

  const uniMap = uni?.mappings ?? {};
  if (Object.keys(uniMap).length > 0) out.programNameMap = { ...uniMap };

  // General tier minus any portal label the university explicitly remapped — a
  // per-university entry shadows the same label in General so the two-tier
  // lookup (uni first, then general) can never let General override it.
  const generalForLookup: Record<string, string> = {};
  for (const [label, crmName] of Object.entries(general?.mappings ?? {})) {
    if (!(label in uniMap)) generalForLookup[label] = crmName;
  }
  if (Object.keys(generalForLookup).length > 0)
    out.programNameMapGeneral = generalForLookup;

  const synonyms = [
    ...(Array.isArray(general?.synonyms) ? general!.synonyms : []),
    ...(Array.isArray(uni?.synonyms) ? uni!.synonyms : []),
  ];
  if (synonyms.length > 0) out.programSynonyms = synonyms;

  const country = {
    ...(general?.countryOverrides ?? {}),
    ...(uni?.countryOverrides ?? {}),
  };
  if (Object.keys(country).length > 0) out.countryOverrides = country;

  const programIdOverrides = {
    ...(general?.programOverrides ?? {}),
    ...(uni?.programOverrides ?? {}),
  };
  if (Object.keys(programIdOverrides).length > 0)
    out.programIdOverrides = programIdOverrides;

  return out;
}
