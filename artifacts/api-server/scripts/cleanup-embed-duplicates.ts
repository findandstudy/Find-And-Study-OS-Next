/**
 * One-shot cleanup for widget lead duplicates.
 *
 * Symptoms (production, May 2026):
 *   - leads.source ILIKE 'embed:%'
 *   - same (lower(email), source) appears multiple times
 *   - each click of "Continue" on the embed widget Step-1 created a new row
 *
 * What this script does, per (lower(email), source) group:
 *   1. Pick the oldest leads.id as the canonical row.
 *   2. Repoint all FK references from younger rows to the canonical id:
 *        - embed_submissions.lead_id
 *        - follow_ups.lead_id
 *        - documents.lead_id
 *        - external_contacts.lead_id
 *        - students.origin_lead_id
 *   3. Merge selected scalar columns into the canonical row, preferring
 *      non-null/non-empty values. "converted" status wins over "new".
 *   4. Delete the younger duplicate rows.
 *
 * Finally it installs a partial unique index so this class of duplicate
 * cannot be re-introduced at the DB layer.
 *
 * Idempotent: re-running this script after a clean DB does nothing.
 * Dry-run: pass DRY_RUN=1 to print the plan without writing.
 * Live mode additionally requires ALLOW_DESTRUCTIVE_DATA_CLEANUP=true.
 */
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const CLEANUP_FLAG = "ALLOW_DESTRUCTIVE_DATA_CLEANUP";

function assertCleanupAuthorized(): void {
  if (!DRY_RUN && process.env[CLEANUP_FLAG] !== "true") {
    throw new Error(`${CLEANUP_FLAG}=true is required for live cleanup`);
  }
}

function numericIdList(ids: number[]) {
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
    throw new Error("Cleanup received an invalid database identifier");
  }
  return sql.join(ids.map((id) => sql`${id}`), sql.raw(", "));
}

interface DupGroup {
  email_lc: string;
  source: string;
  keeper_id: number;
  victim_ids: number[];
  total: number;
}

async function findDuplicateGroups(): Promise<DupGroup[]> {
  const res: any = await db.execute(sql`
    SELECT lower(email) AS email_lc,
           source,
           MIN(id) AS keeper_id,
           array_agg(id ORDER BY id) AS all_ids,
           COUNT(*)::int AS total
    FROM leads
    WHERE email IS NOT NULL
      AND source ILIKE 'embed:%'
      AND deleted_at IS NULL
    GROUP BY lower(email), source
    HAVING COUNT(*) > 1
    ORDER BY total DESC
  `);
  const rows: any[] = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.map((r) => ({
    email_lc: String(r.email_lc),
    source: String(r.source),
    keeper_id: Number(r.keeper_id),
    victim_ids: (r.all_ids as number[]).map(Number).filter((id) => id !== Number(r.keeper_id)),
    total: Number(r.total),
  }));
}

async function repointFks(keeper: number, victims: number[]): Promise<void> {
  if (victims.length === 0) return;
  const list = numericIdList(victims);
  await db.execute(sql`UPDATE embed_submissions SET lead_id = ${keeper} WHERE lead_id IN (${list})`);
  await db.execute(sql`UPDATE follow_ups       SET lead_id = ${keeper} WHERE lead_id IN (${list})`);
  await db.execute(sql`UPDATE documents        SET lead_id = ${keeper} WHERE lead_id IN (${list})`);
  await db.execute(sql`UPDATE external_contacts SET lead_id = ${keeper} WHERE lead_id IN (${list})`);
  await db.execute(sql`UPDATE students         SET origin_lead_id = ${keeper} WHERE origin_lead_id IN (${list})`);
}

/**
 * Merge scalar columns from victims into the keeper row, preferring the
 * keeper's existing non-null value, else the most recent victim's value.
 * Status: "converted" or "lost" wins over "new" so we don't downgrade.
 */
async function mergeScalars(keeper: number, victims: number[]): Promise<void> {
  if (victims.length === 0) return;
  const list = numericIdList(victims);
  await db.execute(sql`
    WITH best AS (
      SELECT
        (SELECT phone FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(phone,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS phone,
        (SELECT phone_e164 FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(phone_e164,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS phone_e164,
        (SELECT nationality FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(nationality,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS nationality,
        (SELECT country FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(country,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS country,
        (SELECT interested_program FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(interested_program,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS interested_program,
        (SELECT interested_country FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(interested_country,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS interested_country,
        (SELECT notes FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(notes,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS notes,
        (SELECT utm_source FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(utm_source,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS utm_source,
        (SELECT utm_medium FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(utm_medium,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS utm_medium,
        (SELECT utm_campaign FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(utm_campaign,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS utm_campaign,
        (SELECT utm_term FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(utm_term,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS utm_term,
        (SELECT utm_content FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(utm_content,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS utm_content,
        (SELECT source_page_url FROM leads WHERE id IN (${list}, ${keeper}) AND NULLIF(source_page_url,'') IS NOT NULL ORDER BY id DESC LIMIT 1) AS source_page_url,
        (SELECT assigned_to_id FROM leads WHERE id IN (${list}, ${keeper}) AND assigned_to_id IS NOT NULL ORDER BY id ASC LIMIT 1) AS assigned_to_id,
        (SELECT agent_id FROM leads WHERE id IN (${list}, ${keeper}) AND agent_id IS NOT NULL ORDER BY id ASC LIMIT 1) AS agent_id,
        (SELECT converted_student_id FROM leads WHERE id IN (${list}, ${keeper}) AND converted_student_id IS NOT NULL ORDER BY id ASC LIMIT 1) AS converted_student_id,
        (
          SELECT status FROM leads WHERE id IN (${list}, ${keeper})
          ORDER BY CASE LOWER(COALESCE(status,'new'))
            WHEN 'converted' THEN 1
            WHEN 'won' THEN 2
            WHEN 'lost' THEN 3
            WHEN 'contacted' THEN 4
            WHEN 'qualified' THEN 5
            WHEN 'new' THEN 9
            ELSE 8
          END LIMIT 1
        ) AS status
    )
    UPDATE leads l SET
      phone = COALESCE(NULLIF(l.phone,''), best.phone),
      phone_e164 = COALESCE(l.phone_e164, best.phone_e164),
      nationality = COALESCE(NULLIF(l.nationality,''), best.nationality),
      country = COALESCE(NULLIF(l.country,''), best.country),
      interested_program = COALESCE(NULLIF(l.interested_program,''), best.interested_program),
      interested_country = COALESCE(NULLIF(l.interested_country,''), best.interested_country),
      notes = COALESCE(NULLIF(l.notes,''), best.notes),
      utm_source = COALESCE(NULLIF(l.utm_source,''), best.utm_source),
      utm_medium = COALESCE(NULLIF(l.utm_medium,''), best.utm_medium),
      utm_campaign = COALESCE(NULLIF(l.utm_campaign,''), best.utm_campaign),
      utm_term = COALESCE(NULLIF(l.utm_term,''), best.utm_term),
      utm_content = COALESCE(NULLIF(l.utm_content,''), best.utm_content),
      source_page_url = COALESCE(NULLIF(l.source_page_url,''), best.source_page_url),
      assigned_to_id = COALESCE(NULLIF(l.assigned_to_id,''), best.assigned_to_id),
      agent_id = COALESCE(NULLIF(l.agent_id,''), best.agent_id),
      converted_student_id = COALESCE(NULLIF(l.converted_student_id,''), best.converted_student_id),
      status = best.status,
      updated_at = now()
    FROM best
    WHERE l.id = ${keeper}
  `);
}

async function deleteVictims(victims: number[]): Promise<number> {
  if (victims.length === 0) return 0;
  const list = numericIdList(victims);
  const res: any = await db.execute(sql`DELETE FROM leads WHERE id IN (${list})`);
  return Number(res?.rowCount ?? victims.length);
}

async function installUniqueIndex(): Promise<void> {
  console.log("[cleanup-embed-duplicates] Installing partial unique index leads_embed_email_source_uniq...");
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_embed_email_source_uniq
    ON leads (lower(email), source)
    WHERE source ILIKE 'embed:%' AND email IS NOT NULL AND deleted_at IS NULL
  `);
}

async function main(): Promise<void> {
  assertCleanupAuthorized();
  console.log(`[cleanup-embed-duplicates] mode=${DRY_RUN ? "DRY_RUN" : "LIVE"}`);
  const groups = await findDuplicateGroups();
  console.log(`[cleanup-embed-duplicates] duplicate groups found: ${groups.length}`);
  if (groups.length === 0) {
    if (!DRY_RUN) await installUniqueIndex();
    return;
  }

  let totalVictims = 0;
  let totalDeleted = 0;
  for (const g of groups) {
    totalVictims += g.victim_ids.length;
    console.log(`  group source=${g.source} rows=${g.total} keeper=${g.keeper_id} victimCount=${g.victim_ids.length}`);
    if (DRY_RUN) continue;
    await repointFks(g.keeper_id, g.victim_ids);
    await mergeScalars(g.keeper_id, g.victim_ids);
    totalDeleted += await deleteVictims(g.victim_ids);
  }
  console.log(`[cleanup-embed-duplicates] groups=${groups.length} victims=${totalVictims} deleted=${totalDeleted}`);

  if (!DRY_RUN) {
    await installUniqueIndex();
  } else {
    console.log("[cleanup-embed-duplicates] DRY_RUN — skipped FK repoint, merge, delete, and unique index install");
  }
}

main()
  .then(() => { console.log("[cleanup-embed-duplicates] done"); process.exit(0); })
  .catch((err) => { console.error("[cleanup-embed-duplicates] failed:", err); process.exit(1); });
