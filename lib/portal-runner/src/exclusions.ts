/**
 * exclusions.ts — preventive university-based nationality exclusion lookup.
 *
 * Before the worker runs a portal for a submission it checks whether the
 * student's nationality is on the university's exclusive-region list. If so the
 * portal is skipped ENTIRELY (no login/submit) and the submission is marked
 * status='exclusive_region'. Matching is case-insensitive + trimmed on both the
 * university key and the nationality. Only enabled, non-soft-deleted rules count.
 */

import { pool } from "@workspace/db";

export interface NationalityExclusion {
  excluded: boolean;
  agencyName: string | null;
}

export async function resolveNationalityExclusion(
  universityKey: string,
  nationality: string | null | undefined,
): Promise<NationalityExclusion> {
  const key = (universityKey ?? "").trim();
  const nat = (nationality ?? "").trim();
  if (!key || !nat) return { excluded: false, agencyName: null };

  const res = await pool.query<{ agency_name: string | null }>(
    `SELECT agency_name
       FROM portal_university_exclusions
      WHERE deleted_at IS NULL
        AND enabled = true
        AND lower(btrim(university_key)) = lower($1)
        AND lower(btrim(nationality))    = lower($2)
      LIMIT 1`,
    [key, nat],
  );

  if (res.rows.length === 0) return { excluded: false, agencyName: null };
  return { excluded: true, agencyName: res.rows[0].agency_name ?? null };
}
