import { db, leadsTable, type Lead } from "@workspace/db";
import { and, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { applyLeadAssignmentRules } from "./leadAssignment";

/**
 * Generic dedup helper for public-facing lead inserts (widget, public
 * form, agent web form, website builder form).
 *
 * Three unique-key modes match the partial unique indexes installed by
 * `scripts/cleanup-lead-duplicates.ts`:
 *
 *   - `emailSource`        — `(lower(email), source)` per source string.
 *                           Used by embed widgets (`embed:<slug>`),
 *                           public website form (`website`/custom),
 *                           website builder forms (`website-form:<slug>`
 *                           or the form's `crmSource`).
 *   - `emailSourceAgent`   — `(lower(email), agent_id)` with
 *                           `source = 'web_form'`. Used by the agent
 *                           embed-token form so the same email reaching
 *                           a different agent stays a separate lead.
 *   - `emailSourceNoAgent` — `(lower(email))` with `source = 'web_form'`
 *                           AND `agent_id IS NULL` (rare fallback).
 *
 * When an existing row is reused, only non-empty incoming fields
 * overwrite stored values; status, assignedToId and agentId are left
 * untouched. Assignment rules are re-evaluated only while the row remains
 * unassigned, allowing late-arriving phone/nationality data to complete a
 * rule without ever re-routing an explicitly assigned lead.
 *
 * Race-safe: if the partial unique index rejects a concurrent insert
 * (23505) the helper re-selects the winning row and updates it.
 */

export type UniqueKey =
  | { kind: "emailSource" }
  | { kind: "emailSourceAgent"; agentId: number }
  | { kind: "emailSourceNoAgent" };

export interface LeadDedupFields {
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  phoneE164?: string | null;
  nationality?: string | null;
  country?: string | null;
  interestedProgram?: string | null;
  interestedUniversity?: string | null;
  interestedCountry?: string | null;
  notes?: string | null;
  sourcePageUrl?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmTerm?: string | null;
  utmContent?: string | null;
}

export interface LeadDedupExtras {
  branchId?: number | null;
  agentId?: number | null;
  season?: string | null;
  originType?: string;
  originEntityType?: string | null;
  originEntityId?: number | null;
  originDisplayName?: string | null;
  initialStatus?: string;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = typeof db | Tx;

function nonEmpty(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function buildUpdatePatch(fields: LeadDedupFields): Partial<typeof leadsTable.$inferInsert> {
  const patch: Partial<typeof leadsTable.$inferInsert> = {};
  const fn = nonEmpty(fields.firstName);
  const ln = nonEmpty(fields.lastName);
  const em = nonEmpty(fields.email);
  if (fn) patch.firstName = fn;
  if (ln) patch.lastName = ln;
  if (em) patch.email = em;
  if (nonEmpty(fields.phone)) patch.phone = fields.phone as string;
  if (nonEmpty(fields.phoneE164)) patch.phoneE164 = fields.phoneE164 as string;
  if (nonEmpty(fields.nationality)) patch.nationality = fields.nationality as string;
  if (nonEmpty(fields.country)) patch.country = fields.country as string;
  if (nonEmpty(fields.interestedProgram)) patch.interestedProgram = fields.interestedProgram as string;
  if (nonEmpty(fields.interestedUniversity)) patch.interestedUniversity = fields.interestedUniversity as string;
  if (nonEmpty(fields.interestedCountry)) patch.interestedCountry = fields.interestedCountry as string;
  if (nonEmpty(fields.notes)) patch.notes = fields.notes as string;
  if (nonEmpty(fields.sourcePageUrl)) patch.sourcePageUrl = fields.sourcePageUrl as string;
  if (nonEmpty(fields.utmSource)) patch.utmSource = fields.utmSource as string;
  if (nonEmpty(fields.utmMedium)) patch.utmMedium = fields.utmMedium as string;
  if (nonEmpty(fields.utmCampaign)) patch.utmCampaign = fields.utmCampaign as string;
  if (nonEmpty(fields.utmTerm)) patch.utmTerm = fields.utmTerm as string;
  if (nonEmpty(fields.utmContent)) patch.utmContent = fields.utmContent as string;
  return patch;
}

function uniqueWhere(source: string, emailNorm: string, key: UniqueKey): SQL {
  const conds: SQL[] = [
    sql`lower(${leadsTable.email}) = ${emailNorm}`,
    eq(leadsTable.source, source),
    isNull(leadsTable.deletedAt),
  ];
  if (key.kind === "emailSourceAgent") {
    conds.push(eq(leadsTable.agentId, key.agentId));
  } else if (key.kind === "emailSourceNoAgent") {
    conds.push(isNull(leadsTable.agentId));
  }
  return and(...conds)!;
}

export async function findOrUpsertPublicLead(opts: {
  source: string;
  uniqueKey: UniqueKey;
  fields: LeadDedupFields;
  extras?: LeadDedupExtras;
  ip?: string;
  tx?: DbLike;
}): Promise<{ lead: Lead; created: boolean }> {
  const conn: DbLike = opts.tx ?? db;
  const source = opts.source;
  const emailNorm = String(opts.fields.email || "").toLowerCase().trim();
  if (!emailNorm) {
    throw new Error("findOrUpsertPublicLead: email is required");
  }
  const extras = opts.extras ?? {};

  const existing = await conn.select().from(leadsTable)
    .where(uniqueWhere(source, emailNorm, opts.uniqueKey))
    .orderBy(desc(leadsTable.createdAt))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    const patch = buildUpdatePatch(opts.fields);
    if (Object.keys(patch).length === 0) {
      if (!opts.tx && row.assignedToId == null) await applyLeadAssignmentRules(row, opts.ip);
      return { lead: row, created: false };
    }
    const [updated] = await conn.update(leadsTable).set(patch).where(eq(leadsTable.id, row.id)).returning();
    const resolved = updated ?? row;
    if (!opts.tx && resolved.assignedToId == null) await applyLeadAssignmentRules(resolved, opts.ip);
    return { lead: resolved, created: false };
  }

  try {
    const insertValues: typeof leadsTable.$inferInsert = {
      firstName: String(opts.fields.firstName),
      lastName: String(opts.fields.lastName),
      email: emailNorm,
      phone: opts.fields.phone ?? null,
      phoneE164: opts.fields.phoneE164 ?? null,
      nationality: opts.fields.nationality ?? null,
      country: opts.fields.country ?? null,
      source,
      status: extras.initialStatus ?? "new",
      interestedProgram: opts.fields.interestedProgram ?? null,
      interestedUniversity: opts.fields.interestedUniversity ?? null,
      interestedCountry: opts.fields.interestedCountry ?? null,
      notes: opts.fields.notes ?? null,
      sourcePageUrl: opts.fields.sourcePageUrl ?? null,
      utmSource: opts.fields.utmSource ?? null,
      utmMedium: opts.fields.utmMedium ?? null,
      utmCampaign: opts.fields.utmCampaign ?? null,
      utmTerm: opts.fields.utmTerm ?? null,
      utmContent: opts.fields.utmContent ?? null,
      branchId: extras.branchId ?? null,
      agentId: extras.agentId ?? (opts.uniqueKey.kind === "emailSourceAgent" ? opts.uniqueKey.agentId : null),
      season: extras.season ?? undefined,
      originType: extras.originType ?? "direct",
      originEntityType: extras.originEntityType ?? null,
      originEntityId: extras.originEntityId ?? null,
      originDisplayName: extras.originDisplayName ?? null,
    };
    const [inserted] = await conn.insert(leadsTable).values(insertValues).returning();
    if (inserted && !opts.tx) {
      await applyLeadAssignmentRules(inserted, opts.ip);
    }
    return { lead: inserted, created: true };
  } catch (err: any) {
    if (err && (err.code === "23505" || /duplicate key|unique/i.test(err.message || ""))) {
      const [reFound] = await conn.select().from(leadsTable)
        .where(uniqueWhere(source, emailNorm, opts.uniqueKey))
        .orderBy(desc(leadsTable.createdAt))
        .limit(1);
      if (reFound) {
        const patch = buildUpdatePatch(opts.fields);
        if (Object.keys(patch).length === 0) {
          if (!opts.tx && reFound.assignedToId == null) await applyLeadAssignmentRules(reFound, opts.ip);
          return { lead: reFound, created: false };
        }
        const [updated] = await conn.update(leadsTable).set(patch).where(eq(leadsTable.id, reFound.id)).returning();
        const resolved = updated ?? reFound;
        if (!opts.tx && resolved.assignedToId == null) await applyLeadAssignmentRules(resolved, opts.ip);
        return { lead: resolved, created: false };
      }
    }
    throw err;
  }
}
