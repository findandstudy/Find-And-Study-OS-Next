/**
 * portalUniversityLinker.ts — Portal ⇄ CRM üniversite otomatik eşleme.
 *
 * Sorun: `portal_universities.crm_university_id` çoğu okulda NULL → fan-out o
 * okulların CRM program kataloğunu göremiyor. Bu modül portal üniversitelerini
 * (isim-tabanlı, Türkçe-duyarlı) CRM üniversitelerine bağlar ve
 * `crm_university_id`'yi otomatik doldurur.
 *
 * Kurallar:
 *   - Yalnız `crm_university_id` yazılır; başka veri değişmez.
 *   - Belirsiz / çoklu yakın aday → NULL bırak, "unmatched" raporla (asla yanlış bağlama).
 *   - Elle doğrulanmış mevcut bağ otomatik EZİLMEZ (force=true hariç).
 *   - `study_in_turkey` gibi toplayıcılar bilerek unlinked bırakılır.
 */

import {
  db,
  portalUniversitiesTable,
  universitiesTable,
  programsTable,
} from "@workspace/db";
import { and, count, eq, isNull } from "drizzle-orm";
import { transliterateToLatin } from "./textNormalize";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Fuzzy token-similarity threshold. Below this we never auto-link. */
const FUZZY_THRESHOLD = 0.8;

/**
 * Minimum lead the best fuzzy candidate must hold over the runner-up before we
 * accept it. Prevents linking when two CRM universities are almost equally
 * similar (ambiguous) — safer to leave NULL and surface as unmatched.
 */
const FUZZY_MARGIN = 0.1;

/**
 * Max extra tokens the CRM side may carry beyond the portal name in the one-way
 * containment fallback. 1 allows a single dropped city/prefix word (e.g. portal
 * "Topkapi" ⊂ CRM "Istanbul Topkapi") while keeping the match tight.
 */
const CONTAINMENT_MAX_EXTRA = 1;

/**
 * Minimum normalised (space-stripped) portal-name length for the containment
 * fallback to fire. Distinctiveness guard: keeps short/generic single tokens
 * (e.g. "ege", "koc") from auto-linking on containment alone; a real name like
 * "topkapi" (7 chars) clears it.
 */
const CONTAINMENT_MIN_LEN = 5;

/**
 * Multi-portal aggregators that submit on behalf of many member universities.
 * They are NOT a single CRM university, so they are intentionally left unlinked.
 * (isMultiPortal rows are also skipped dynamically below.)
 */
const AGGREGATOR_KEYS = new Set<string>(["study_in_turkey"]);

/**
 * Manual alias overrides keyed by `portal_universities.university_key`, for the
 * cases where the portal name does not match the CRM name by string similarity.
 * Value is the canonical CRM university name (normalised the same way as CRM
 * rows before comparison).
 */
const ALIAS_MAP: Record<string, string> = {
  emu: "Eastern Mediterranean University",
};

/**
 * Generic tokens dropped during normalisation so "X University",
 * "X Üniversitesi" and "X" all collapse to the same key. Kept small and
 * deliberately conservative so distinguishing words are never removed.
 */
const GENERIC_TOKENS = new Set<string>([
  "university",
  "universities",
  "universitesi",
  "universite",
  "univeristy", // common misspelling
  "uni",
  "of",
  "the",
]);

// ---------------------------------------------------------------------------
// Normalisation + similarity
// ---------------------------------------------------------------------------

/** Turkish-aware fold + generic-word strip → space-joined significant tokens. */
export function normalizeUniName(name: string): string {
  const folded = transliterateToLatin(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

  const tokens = folded
    .split(" ")
    .filter((tok) => tok.length > 0 && !GENERIC_TOKENS.has(tok));

  return tokens.join(" ");
}

function tokenSet(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter(Boolean));
}

/** Jaccard similarity over token sets (0..1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ReconcileLinked {
  universityKey: string;
  universityName: string;
  crmUniversityId: number;
  crmName: string;
  via: "exact" | "fuzzy" | "alias";
}

export interface ReconcileUnmatched {
  universityKey: string;
  universityName: string;
  reason: "aggregator" | "no_match" | "ambiguous";
}

export interface ReconcileStale {
  universityKey: string;
  universityName: string;
  crmUniversityId: number;
  reason: "missing_crm" | "no_programs";
}

export interface ReconcileResult {
  linked: ReconcileLinked[];
  alreadyLinked: number;
  unmatched: ReconcileUnmatched[];
  stale: ReconcileStale[];
}

interface CrmCandidate {
  id: number;
  name: string;
  normalized: string;
  tokens: Set<string>;
  programCount: number;
}

// ---------------------------------------------------------------------------
// Core reconcile
// ---------------------------------------------------------------------------

/**
 * Fill `portal_universities.crm_university_id` by name-matching against CRM
 * universities. Only touches the crm_university_id column.
 *
 * @param opts.force  When true, recompute links even for rows that already have
 *                    a crm_university_id (still never wrong-links: ambiguity is
 *                    left as-is).
 */
export async function reconcilePortalUniversityCrmLinks(
  opts?: { force?: boolean },
): Promise<ReconcileResult> {
  const force = !!opts?.force;

  const portalRows = await db
    .select({
      id: portalUniversitiesTable.id,
      universityKey: portalUniversitiesTable.universityKey,
      universityName: portalUniversitiesTable.universityName,
      isMultiPortal: portalUniversitiesTable.isMultiPortal,
      crmUniversityId: portalUniversitiesTable.crmUniversityId,
    })
    .from(portalUniversitiesTable)
    .where(isNull(portalUniversitiesTable.deletedAt));

  // CRM universities with their ACTIVE program counts.
  const crmRows = await db
    .select({
      id: universitiesTable.id,
      name: universitiesTable.name,
      programCount: count(programsTable.id),
    })
    .from(universitiesTable)
    .leftJoin(
      programsTable,
      and(
        eq(programsTable.universityId, universitiesTable.id),
        eq(programsTable.isActive, true),
      ),
    )
    .where(eq(universitiesTable.isActive, true))
    .groupBy(universitiesTable.id, universitiesTable.name);

  const crmById = new Map<number, CrmCandidate>();
  const candidates: CrmCandidate[] = [];
  for (const r of crmRows) {
    const normalized = normalizeUniName(r.name);
    const cand: CrmCandidate = {
      id: r.id,
      name: r.name,
      normalized,
      tokens: tokenSet(normalized),
      programCount: Number(r.programCount) || 0,
    };
    crmById.set(r.id, cand);
    candidates.push(cand);
  }

  // Only CRM universities that actually have programs are eligible auto-link
  // targets (linking to an empty university gives fan-out nothing).
  const eligible = candidates.filter((c) => c.programCount > 0);

  const result: ReconcileResult = {
    linked: [],
    alreadyLinked: 0,
    unmatched: [],
    stale: [],
  };

  for (const row of portalRows) {
    const isAggregator =
      row.isMultiPortal || AGGREGATOR_KEYS.has(row.universityKey);

    // --- Already-linked rows: verify, never auto-overwrite unless force ---
    if (row.crmUniversityId != null && !force) {
      const crm = crmById.get(row.crmUniversityId);
      if (!crm) {
        result.stale.push({
          universityKey: row.universityKey,
          universityName: row.universityName,
          crmUniversityId: row.crmUniversityId,
          reason: "missing_crm",
        });
      } else if (crm.programCount === 0) {
        result.stale.push({
          universityKey: row.universityKey,
          universityName: row.universityName,
          crmUniversityId: row.crmUniversityId,
          reason: "no_programs",
        });
      } else {
        result.alreadyLinked++;
      }
      continue;
    }

    // Aggregators are intentionally left unlinked (unless they already carry a
    // manually-set link handled above).
    if (isAggregator) {
      result.unmatched.push({
        universityKey: row.universityKey,
        universityName: row.universityName,
        reason: "aggregator",
      });
      continue;
    }

    // --- Resolve match ---
    const aliasName = ALIAS_MAP[row.universityKey];
    const targetName = aliasName ?? row.universityName;
    const targetNorm = normalizeUniName(targetName);
    const via: "exact" | "fuzzy" | "alias" = aliasName ? "alias" : "exact";

    if (targetNorm.length === 0) {
      result.unmatched.push({
        universityKey: row.universityKey,
        universityName: row.universityName,
        reason: "no_match",
      });
      continue;
    }

    // (a) Exact normalised equality — prefer eligible (with-programs) candidates.
    const exactAll = candidates.filter((c) => c.normalized === targetNorm);
    const exactEligible = exactAll.filter((c) => c.programCount > 0);
    const exactPool = exactEligible.length > 0 ? exactEligible : exactAll;
    const distinctExactIds = new Set(exactPool.map((c) => c.id));

    let chosen: CrmCandidate | null = null;
    let matchVia: "exact" | "fuzzy" | "alias" = via;

    if (distinctExactIds.size === 1) {
      chosen = exactPool[0];
      matchVia = aliasName ? "alias" : "exact";
    } else if (distinctExactIds.size > 1) {
      result.unmatched.push({
        universityKey: row.universityKey,
        universityName: row.universityName,
        reason: "ambiguous",
      });
      continue;
    } else {
      // (b) High-threshold fuzzy over eligible candidates, with a clear winner.
      const targetTokens = tokenSet(targetNorm);
      let best: CrmCandidate | null = null;
      let bestScore = 0;
      let secondScore = 0;
      for (const c of eligible) {
        const s = jaccard(targetTokens, c.tokens);
        if (s > bestScore) {
          secondScore = bestScore;
          bestScore = s;
          best = c;
        } else if (s > secondScore) {
          secondScore = s;
        }
      }
      if (
        best &&
        bestScore >= FUZZY_THRESHOLD &&
        bestScore - secondScore >= FUZZY_MARGIN
      ) {
        chosen = best;
        matchVia = "fuzzy";
      } else {
        // (c) One-way unique containment fallback: the PORTAL token set is
        // fully contained in EXACTLY ONE eligible CRM candidate that carries at
        // most one extra token. This is deliberately one-directional (portal ⊆
        // CRM) because portals abbreviate canonical CRM names by dropping a
        // single city/prefix word (e.g. "Topkapi" ⊂ "Istanbul Topkapi"), never
        // the reverse. Guards that keep it safe:
        //   - uniqueness: a bare "Istanbul" is contained in many candidates →
        //     not unique → left unmatched.
        //   - distinctiveness: the portal name must be long enough
        //     (CONTAINMENT_MIN_LEN) so short/generic single tokens don't link.
        const containment =
          targetNorm.replace(/\s+/g, "").length >= CONTAINMENT_MIN_LEN
            ? eligible.filter((c) => {
                const a = targetTokens;
                const b = c.tokens;
                if (a.size === 0 || b.size === 0) return false;
                if (b.size - a.size > CONTAINMENT_MAX_EXTRA) return false;
                for (const x of a) if (!b.has(x)) return false;
                return true;
              })
            : [];
        if (containment.length === 1) {
          chosen = containment[0];
          matchVia = "fuzzy";
        } else {
          result.unmatched.push({
            universityKey: row.universityKey,
            universityName: row.universityName,
            reason: containment.length > 1 ? "ambiguous" : "no_match",
          });
          continue;
        }
      }
    }

    // --- Write (only crm_university_id) ---
    if (chosen) {
      if (row.crmUniversityId === chosen.id) {
        // force recompute produced the same link — treat as already linked.
        result.alreadyLinked++;
      } else {
        await db
          .update(portalUniversitiesTable)
          .set({ crmUniversityId: chosen.id })
          .where(eq(portalUniversitiesTable.id, row.id));
        result.linked.push({
          universityKey: row.universityKey,
          universityName: row.universityName,
          crmUniversityId: chosen.id,
          crmName: chosen.name,
          via: matchVia,
        });
      }
    }
  }

  console.log(
    `[PORTAL-LINK] reconcile done (force=${force}): linked=${result.linked.length} alreadyLinked=${result.alreadyLinked} unmatched=${result.unmatched.length} stale=${result.stale.length}`,
  );

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const CHECK_INTERVAL = 60 * 60 * 1000; // hourly
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startPortalUniversityLinker(): () => void {
  if (intervalHandle || initialTimer) return stopPortalUniversityLinker;
  console.log(
    `[PORTAL-LINK] Linker started, running every ${CHECK_INTERVAL / 60000} minute(s)`,
  );
  // Initial run shortly after boot (staggered from other checkers).
  initialTimer = setTimeout(() => {
    initialTimer = null;
    reconcilePortalUniversityCrmLinks().catch((err) =>
      console.error("[PORTAL-LINK] Initial reconcile error:", err),
    );
  }, 25000);
  intervalHandle = setInterval(() => {
    reconcilePortalUniversityCrmLinks().catch((err) =>
      console.error("[PORTAL-LINK] Scheduled reconcile error:", err),
    );
  }, CHECK_INTERVAL);
  return stopPortalUniversityLinker;
}

export function stopPortalUniversityLinker(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (intervalHandle) clearInterval(intervalHandle);
  initialTimer = null;
  intervalHandle = null;
}
