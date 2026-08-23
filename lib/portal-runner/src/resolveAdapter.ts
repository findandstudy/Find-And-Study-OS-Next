/**
 * resolveAdapter.ts — single source of truth for "which adapter runs a given
 * university's portal submission".
 *
 * Routing rules (in priority order):
 *   1. MEMBERSHIP JUNCTION (Phase 3) — if the university's catalog id
 *      (portal_universities.crm_university_id) has an ENABLED row in
 *      portal_account_universities, the submission is routed THROUGH that
 *      multi-portal account: the account's adapterKey is used, routedVia is the
 *      account's portal key, and memberUniversityId is the catalog id (so the
 *      runner can load member-level program overrides).
 *   2. routes_via (Phase 2, legacy fallback) — a portal_universities row may
 *      have `routes_via` set to a multi-portal company's `university_key`.
 *   3. OWN ADAPTER — when neither applies the university uses its own adapter;
 *      behaviour is IDENTICAL to before this feature existed (no override).
 *
 * `routedVia` is non-null ONLY when an actual redirect happened, so callers can
 * preserve the legacy (NULL) path byte-for-byte by only overriding the adapter
 * when `routedVia` is set. `memberUniversityId` is non-null ONLY on a junction
 * match (rule 1) — the routes_via fallback leaves it null, keeping Phase 2
 * program-mapping behaviour unchanged.
 */

import { pool } from "@workspace/db";

export interface ResolvedAdapter {
  /** Effective adapter key to run (multi-portal account's when routed). */
  adapterKey: string;
  /** The multi-portal account's universityKey if routed, else null. */
  routedVia: string | null;
  /**
   * The member catalog university id when routed via the membership junction,
   * else null. Used to load member-level program overrides.
   */
  memberUniversityId: number | null;
}

/**
 * Resolves the effective adapter key for a submission's universityKey.
 *
 * Falls back to the universityKey itself when no portal_universities row is
 * found (backward-compatible with adapterByKey/adapterForUniversity lookup).
 */
export async function resolveAdapterKey(
  universityKey: string,
): Promise<ResolvedAdapter> {
  try {
    const own = await pool.query<{
      adapter_key: string;
      routes_via: string | null;
      crm_university_id: number | null;
    }>(
      `SELECT adapter_key, routes_via, crm_university_id
         FROM portal_universities
        WHERE university_key = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [universityKey],
    );

    const ownRow = own.rows[0];
    if (!ownRow) {
      return { adapterKey: universityKey, routedVia: null, memberUniversityId: null };
    }

    // ----- Rule 1: membership junction (catalog id → multi-portal account) ----
    if (ownRow.crm_university_id != null) {
      const member = await pool.query<{ portal_key: string }>(
        `SELECT portal_key
           FROM portal_account_universities
          WHERE catalog_university_id = $1 AND enabled = true
          LIMIT 1`,
        [ownRow.crm_university_id],
      );
      const memberRow = member.rows[0];
      if (memberRow && memberRow.portal_key !== universityKey) {
        const account = await pool.query<{ adapter_key: string }>(
          `SELECT adapter_key
             FROM portal_universities
            WHERE university_key = $1 AND deleted_at IS NULL
            LIMIT 1`,
          [memberRow.portal_key],
        );
        const accountRow = account.rows[0];
        if (accountRow) {
          return {
            adapterKey: accountRow.adapter_key,
            routedVia: memberRow.portal_key,
            memberUniversityId: ownRow.crm_university_id,
          };
        }
        // Dangling account (removed) — fall through to own/routes_via.
      }
    }

    // ----- Rule 2: routes_via (Phase 2 legacy fallback) ----------------------
    if (!ownRow.routes_via) {
      return {
        adapterKey: ownRow.adapter_key,
        routedVia: null,
        memberUniversityId: null,
      };
    }

    const company = await pool.query<{ adapter_key: string }>(
      `SELECT adapter_key
         FROM portal_universities
        WHERE university_key = $1 AND deleted_at IS NULL
        LIMIT 1`,
      [ownRow.routes_via],
    );

    const companyRow = company.rows[0];
    if (!companyRow) {
      // Dangling routes_via (company removed) — fail safe to own adapter,
      // exactly as the legacy NULL path would behave.
      return {
        adapterKey: ownRow.adapter_key,
        routedVia: null,
        memberUniversityId: null,
      };
    }

    return {
      adapterKey: companyRow.adapter_key,
      routedVia: ownRow.routes_via,
      memberUniversityId: null,
    };
  } catch {
    return { adapterKey: universityKey, routedVia: null, memberUniversityId: null };
  }
}

/**
 * Loads the live "Members" list for a multi-portal account (aggregator),
 * keyed by the account's OWN university_key (portal_account_universities.portal_key)
 * — the same key resolveAdapterKey returns as `routedVia`.
 *
 * This is the DB source of truth the panel's Members tab edits directly: adding
 * or removing a row here takes effect on the very next submission, no code
 * change needed. Returns catalog `universities.name` values (the canonical
 * name adapters already fuzzy-match against). Fails safe to [] on any DB error
 * so a transient failure degrades to the adapter's static fallback list rather
 * than throwing mid-submission.
 */
export async function loadAggregatorMemberNames(portalKey: string): Promise<string[]> {
  try {
    const res = await pool.query<{ name: string }>(
      `SELECT u.name
         FROM portal_account_universities pau
         JOIN universities u ON u.id = pau.catalog_university_id
        WHERE pau.portal_key = $1 AND pau.enabled = true`,
      [portalKey],
    );
    return res.rows.map((r) => r.name).filter((n): n is string => !!n && n.trim().length > 0);
  } catch {
    return [];
  }
}
