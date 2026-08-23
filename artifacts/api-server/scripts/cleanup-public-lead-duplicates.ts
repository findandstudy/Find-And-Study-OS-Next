/**
 * One-shot cleanup for public lead duplicates from the three non-embed
 * public entry points (Task #169).
 *
 * Covers:
 *   - source = 'website'                — `/public/lead` blind insert.
 *   - source = 'web_form'               — `/public/lead/:token` (agent
 *                                         embed token). Grouped by
 *                                         (lower(email), agent_id);
 *                                         NULL agent_id is its own
 *                                         group so we don't merge an
 *                                         agent's lead into an
 *                                         agentless one.
 *   - source LIKE 'website-form:%'      — `/website-form/:slug` website
 *                                         builder forms. Grouped per
 *                                         exact source string (slug).
 *
 * Per group:
 *   1. Pick the oldest leads.id as the canonical row.
 *   2. Repoint FK references from younger rows to the canonical id:
 *        - embed_submissions.lead_id
 *        - website_form_submissions.lead_id
 *        - follow_ups.lead_id
 *        - documents.lead_id
 *        - external_contacts.lead_id
 *        - students.origin_lead_id
 *   3. Merge selected scalar columns into the canonical row, preferring
 *      keeper's non-null/non-empty value, else the most recent victim's
 *      value. Status uses the precedence:
 *      converted > won > lost > contacted > qualified > new.
 *   4. Delete the younger duplicate rows.
 *
 * Finally installs four partial unique indexes so duplicates can never
 * be re-introduced at the DB layer.
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
  label: string;
  source: string;
  email_lc: string;
  agent_id: number | null;
  keeper_id: number;
  victim_ids: number[];
  total: number;
}

async function findGroupsBySourceEquals(source: string): Promise<DupGroup[]> {
  const res: any = await db.execute(sql`
    SELECT lower(email) AS email_lc,
           source,
           MIN(id) AS keeper_id,
           array_agg(id ORDER BY id) AS all_ids,
           COUNT(*)::int AS total
    FROM leads
    WHERE email IS NOT NULL
      AND source = ${source}
      AND deleted_at IS NULL
    GROUP BY lower(email), source
    HAVING COUNT(*) > 1
    ORDER BY total DESC
  `);
  const rows: any[] = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.map((r) => ({
    label: `source=${r.source}`,
    source: String(r.source),
    email_lc: String(r.email_lc),
    agent_id: null,
    keeper_id: Number(r.keeper_id),
    victim_ids: (r.all_ids as number[]).map(Number).filter((id) => id !== Number(r.keeper_id)),
    total: Number(r.total),
  }));
}

async function findGroupsBySourceLike(pattern: string): Promise<DupGroup[]> {
  const res: any = await db.execute(sql`
    SELECT lower(email) AS email_lc,
           source,
           MIN(id) AS keeper_id,
           array_agg(id ORDER BY id) AS all_ids,
           COUNT(*)::int AS total
    FROM leads
    WHERE email IS NOT NULL
      AND source LIKE ${pattern}
      AND deleted_at IS NULL
    GROUP BY lower(email), source
    HAVING COUNT(*) > 1
    ORDER BY total DESC
  `);
  const rows: any[] = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.map((r) => ({
    label: `source=${r.source}`,
    source: String(r.source),
    email_lc: String(r.email_lc),
    agent_id: null,
    keeper_id: Number(r.keeper_id),
    victim_ids: (r.all_ids as number[]).map(Number).filter((id) => id !== Number(r.keeper_id)),
    total: Number(r.total),
  }));
}

async function findWebFormGroups(): Promise<DupGroup[]> {
  // (lower(email), agent_id) groups for source='web_form'. NULL agent_id
  // is its own group (treated distinctly via COALESCE to -1 sentinel).
  const res: any = await db.execute(sql`
    SELECT lower(email) AS email_lc,
           agent_id,
           MIN(id) AS keeper_id,
           array_agg(id ORDER BY id) AS all_ids,
           COUNT(*)::int AS total
    FROM leads
    WHERE email IS NOT NULL
      AND source = 'web_form'
      AND deleted_at IS NULL
    GROUP BY lower(email), COALESCE(agent_id, -1), agent_id
    HAVING COUNT(*) > 1
    ORDER BY total DESC
  `);
  const rows: any[] = Array.isArray(res) ? res : (res.rows ?? []);
  return rows.map((r) => ({
    label: `web_form agent_id=${r.agent_id ?? "NULL"}`,
    source: "web_form",
    email_lc: String(r.email_lc),
    agent_id: r.agent_id == null ? null : Number(r.agent_id),
    keeper_id: Number(r.keeper_id),
    victim_ids: (r.all_ids as number[]).map(Number).filter((id) => id !== Number(r.keeper_id)),
    total: Number(r.total),
  }));
}

async function repointFks(keeper: number, victims: number[]): Promise<void> {
  if (victims.length === 0) return;
  const list = numericIdList(victims);
  await db.execute(sql`UPDATE embed_submissions         SET lead_id        = ${keeper} WHERE lead_id        IN (${list})`);
  await db.execute(sql`UPDATE website_form_submissions  SET lead_id        = ${keeper} WHERE lead_id        IN (${list})`);
  await db.execute(sql`UPDATE follow_ups                SET lead_id        = ${keeper} WHERE lead_id        IN (${list})`);
  await db.execute(sql`UPDATE documents                 SET lead_id        = ${keeper} WHERE lead_id        IN (${list})`);
  await db.execute(sql`UPDATE external_contacts         SET lead_id        = ${keeper} WHERE lead_id        IN (${list})`);
  await db.execute(sql`UPDATE students                  SET origin_lead_id = ${keeper} WHERE origin_lead_id IN (${list})`);
}

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
      assigned_to_id = COALESCE(l.assigned_to_id, best.assigned_to_id),
      agent_id = COALESCE(l.agent_id, best.agent_id),
      converted_student_id = COALESCE(l.converted_student_id, best.converted_student_id),
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

async function installUniqueIndexes(): Promise<void> {
  console.log("[cleanup-public-lead-duplicates] Installing partial unique indexes...");
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_website_email_source_uniq
    ON leads (lower(email), source)
    WHERE source = 'website' AND email IS NOT NULL AND deleted_at IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_webform_email_agent_uniq
    ON leads (lower(email), agent_id)
    WHERE source = 'web_form' AND agent_id IS NOT NULL AND email IS NOT NULL AND deleted_at IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_webform_email_uniq
    ON leads (lower(email))
    WHERE source = 'web_form' AND agent_id IS NULL AND email IS NOT NULL AND deleted_at IS NULL
  `);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_websiteform_email_source_uniq
    ON leads (lower(email), source)
    WHERE source LIKE 'website-form:%' AND email IS NOT NULL AND deleted_at IS NULL
  `);
}

async function processGroups(groups: DupGroup[]): Promise<{ victims: number; deleted: number }> {
  let victims = 0;
  let deleted = 0;
  for (const g of groups) {
    victims += g.victim_ids.length;
    console.log(`  group ${g.label} rows=${g.total} keeper=${g.keeper_id} victimCount=${g.victim_ids.length}`);
    if (DRY_RUN) continue;
    await repointFks(g.keeper_id, g.victim_ids);
    await mergeScalars(g.keeper_id, g.victim_ids);
    deleted += await deleteVictims(g.victim_ids);
  }
  return { victims, deleted };
}

async function main(): Promise<void> {
  assertCleanupAuthorized();
  console.log(`[cleanup-public-lead-duplicates] mode=${DRY_RUN ? "DRY_RUN" : "LIVE"}`);

  const websiteGroups = await findGroupsBySourceEquals("website");
  console.log(`[cleanup-public-lead-duplicates] website groups: ${websiteGroups.length}`);
  const webFormGroups = await findWebFormGroups();
  console.log(`[cleanup-public-lead-duplicates] web_form groups: ${webFormGroups.length}`);
  const websiteFormGroups = await findGroupsBySourceLike("website-form:%");
  console.log(`[cleanup-public-lead-duplicates] website-form:* groups: ${websiteFormGroups.length}`);

  const all = [...websiteGroups, ...webFormGroups, ...websiteFormGroups];
  let totals = { victims: 0, deleted: 0 };
  if (all.length > 0) {
    const r = await processGroups(all);
    totals = r;
  }
  console.log(`[cleanup-public-lead-duplicates] groups=${all.length} victims=${totals.victims} deleted=${totals.deleted}`);

  if (!DRY_RUN) {
    await installUniqueIndexes();
  } else {
    console.log("[cleanup-public-lead-duplicates] DRY_RUN — skipped FK repoint, merge, delete, and unique index install");
  }
}

main()
  .then(() => { console.log("[cleanup-public-lead-duplicates] done"); process.exit(0); })
  .catch((err) => { console.error("[cleanup-public-lead-duplicates] failed:", err); process.exit(1); });
