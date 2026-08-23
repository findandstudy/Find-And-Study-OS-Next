import { Router, type IRouter } from "express";
import {
  db,
  leadsTable,
  studentsTable,
  applicationsTable,
  agentsTable,
  documentsTable,
  commissionsTable,
  pipelineStagesTable,
  channelAccountsTable,
  usersTable,
} from "@workspace/db";
import { sql, eq, and, isNull, inArray, or, gte, ne, notInArray } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth";
import { STAFF_ROLES, ADMIN_ROLES, AGENT_ROLES } from "../lib/roles";
import { isAgentRole, isAdminRole } from "../lib/roles";
import { getAgentVisibleIds, getAgentRecord } from "../lib/agentVisibility";
import { z } from "zod";
import { validate, getValidated } from "../middlewares/validate";

const router: IRouter = Router();

router.get("/stats/overview", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), async (req, res): Promise<void> => {
  const user = req.user!;
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(user.role);
  const isAgent = isAgentRole(user.role);

  const seasonParam = typeof req.query.season === "string" && req.query.season ? req.query.season : null;
  const seasonLead = seasonParam ? eq(leadsTable.season, seasonParam) : undefined;
  const seasonStudent = seasonParam ? eq(studentsTable.season, seasonParam) : undefined;
  const seasonApp = seasonParam ? eq(applicationsTable.season, seasonParam) : undefined;

  const wonStages = await db
    .select({ key: pipelineStagesTable.key })
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.entityType, "application"), eq(pipelineStagesTable.variant, "won")));
  const wonKeys = wonStages.map(s => s.key);

  const lostStages = await db
    .select({ key: pipelineStagesTable.key })
    .from(pipelineStagesTable)
    .where(and(eq(pipelineStagesTable.entityType, "application"), eq(pipelineStagesTable.variant, "lost")));
  const lostKeys = lostStages.map(s => s.key);
  const terminalKeys = [...wonKeys, ...lostKeys];

  let leadFilter = and(isNull(leadsTable.deletedAt), seasonLead)!;
  let studentFilter = and(isNull(studentsTable.deletedAt), seasonStudent)!;
  let appFilter = and(isNull(applicationsTable.deletedAt), seasonApp)!;

  if (isAgent) {
    const agentIds = await getAgentVisibleIds(user.id, user.role);
    if (agentIds.length === 0) {
      res.json({ totalLeads: 0, totalStudents: 0, totalApplications: 0, activeApplications: 0, enrolledStudents: 0, monthlyRevenue: 0 });
      return;
    }
    leadFilter = and(isNull(leadsTable.deletedAt), inArray(leadsTable.agentId, agentIds), seasonLead)!;
    studentFilter = and(isNull(studentsTable.deletedAt), inArray(studentsTable.agentId, agentIds), seasonStudent)!;
    appFilter = and(isNull(applicationsTable.deletedAt), inArray(applicationsTable.agentId, agentIds), seasonApp)!;
  } else if (!isAdmin) {
    leadFilter = and(isNull(leadsTable.deletedAt), or(eq(leadsTable.assignedToId, user.id), isNull(leadsTable.assignedToId)), seasonLead)!;
    studentFilter = and(isNull(studentsTable.deletedAt), or(eq(studentsTable.assignedToId, user.id), isNull(studentsTable.assignedToId)), seasonStudent)!;
    appFilter = and(isNull(applicationsTable.deletedAt), or(eq(applicationsTable.assignedToId, user.id), isNull(applicationsTable.assignedToId)), seasonApp)!;
  }

  const [[{ leads }], [{ students }], [{ applications }]] = await Promise.all([
    db.select({ leads: sql<number>`count(*)` }).from(leadsTable).where(leadFilter),
    db.select({ students: sql<number>`count(*)` }).from(studentsTable).where(studentFilter),
    db.select({ applications: sql<number>`count(*)` }).from(applicationsTable).where(appFilter),
  ]);

  let activeApps = Number(applications);
  if (terminalKeys.length > 0) {
    const terminalSql = sql`stage NOT IN (${sql.join(terminalKeys.map(k => sql`${k}`), sql`, `)})`;
    if (isAgent) {
      const agentIds = await getAgentVisibleIds(user.id, user.role);
      const [{ active }] = await db
        .select({ active: sql<number>`count(*)` })
        .from(applicationsTable)
        .where(and(isNull(applicationsTable.deletedAt), inArray(applicationsTable.agentId, agentIds), terminalSql, seasonApp));
      activeApps = Number(active);
    } else if (!isAdmin) {
      const [{ active }] = await db
        .select({ active: sql<number>`count(*)` })
        .from(applicationsTable)
        .where(and(isNull(applicationsTable.deletedAt), or(eq(applicationsTable.assignedToId, user.id), isNull(applicationsTable.assignedToId)), terminalSql, seasonApp));
      activeApps = Number(active);
    } else {
      const [{ active }] = await db
        .select({ active: sql<number>`count(*)` })
        .from(applicationsTable)
        .where(and(isNull(applicationsTable.deletedAt), terminalSql, seasonApp));
      activeApps = Number(active);
    }
  }

  let enrolledStudents = 0;
  if (wonKeys.length > 0) {
    if (isAgent) {
      const agentIds = await getAgentVisibleIds(user.id, user.role);
      const [{ enrolled }] = await db
        .select({ enrolled: sql<number>`count(DISTINCT student_id)` })
        .from(applicationsTable)
        .where(and(isNull(applicationsTable.deletedAt), inArray(applicationsTable.stage, wonKeys), inArray(applicationsTable.agentId, agentIds), seasonApp));
      enrolledStudents = Number(enrolled);
    } else if (!isAdmin) {
      const [{ enrolled }] = await db
        .select({ enrolled: sql<number>`count(DISTINCT student_id)` })
        .from(applicationsTable)
        .where(and(isNull(applicationsTable.deletedAt), inArray(applicationsTable.stage, wonKeys), or(eq(applicationsTable.assignedToId, user.id), isNull(applicationsTable.assignedToId)), seasonApp));
      enrolledStudents = Number(enrolled);
    } else {
      const [{ enrolled }] = await db
        .select({ enrolled: sql<number>`count(DISTINCT student_id)` })
        .from(applicationsTable)
        .where(and(isNull(applicationsTable.deletedAt), inArray(applicationsTable.stage, wonKeys), seasonApp));
      enrolledStudents = Number(enrolled);
    }
  }

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

  let isSubAgentUser = false;
  if (isAgent) {
    const agentRec = await getAgentRecord(user.id, user.role);
    isSubAgentUser = user.role === "sub_agent" || !!agentRec?.parentAgentId;
  }

  const revenuePeriodSql = seasonParam
    ? sql`season = ${seasonParam}`
    : sql`confirmed_at >= ${monthStart} AND confirmed_at < ${monthEnd}`;
  let revenueFilter = sql`status IN ('confirmed','collected_partial','collected_full','settled') AND ${revenuePeriodSql}`;
  if (isAgent) {
    const agentIds = await getAgentVisibleIds(user.id, user.role);
    const idCol = isSubAgentUser ? sql`sub_agent_id` : sql`agent_id`;
    revenueFilter = sql`status IN ('confirmed','collected_partial','collected_full','settled') AND ${revenuePeriodSql} AND ${idCol} IN (${sql.join(agentIds.map(id => sql`${id}`), sql`, `)})`;
  }

  const revenueRows = await db
    .select({
      currency: sql<string>`coalesce(currency, 'USD')`,
      universityCommissionAmount: commissionsTable.universityCommissionAmount,
      agentCommissionAmount: commissionsTable.agentCommissionAmount,
      subAgentCommissionAmount: commissionsTable.subAgentCommissionAmount,
    })
    .from(commissionsTable)
    .where(revenueFilter);

  const SUPPORTED = ["USD", "EUR", "GBP", "TRY", "AED"] as const;
  const monthlyRevenueByCurrency: Record<string, number> = {};
  const toN = (v: any) => parseFloat(String(v ?? 0)) || 0;
  for (const r of revenueRows) {
    const raw = String(r.currency || "USD").toUpperCase();
    const cur = (SUPPORTED as readonly string[]).includes(raw) ? raw : "USD";
    const uAmt = toN(r.universityCommissionAmount);
    const aAmt = toN(r.agentCommissionAmount);
    const saAmt = toN(r.subAgentCommissionAmount);
    const val = isAgent
      ? (isSubAgentUser ? saAmt : (aAmt - saAmt))
      : (uAmt - aAmt);
    monthlyRevenueByCurrency[cur] = (monthlyRevenueByCurrency[cur] || 0) + val;
  }
  const monthlyRevenue = Object.values(monthlyRevenueByCurrency).reduce((s, v) => s + v, 0);

  res.json({
    totalLeads: Number(leads),
    totalStudents: Number(students),
    totalApplications: Number(applications),
    activeApplications: activeApps,
    enrolledStudents: enrolledStudents,
    monthlyRevenue,
    monthlyRevenueByCurrency,
  });
});

router.get("/stats/growth", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), async (req, res): Promise<void> => {
  const user = req.user!;
  const isAdmin = (ADMIN_ROLES as readonly string[]).includes(user.role);
  const isAgent = isAgentRole(user.role);

  const seasonParam = typeof req.query.season === "string" && /^\d{4}$/.test(req.query.season) ? req.query.season : null;
  const seasonYear = seasonParam ? parseInt(seasonParam, 10) : NaN;

  const now = new Date();
  const months: { name: string; start: string; end: string }[] = [];
  if (Number.isFinite(seasonYear)) {
    for (let m = 0; m < 12; m++) {
      const d = new Date(seasonYear, m, 1);
      const start = d.toISOString();
      const end = new Date(seasonYear, m + 1, 1).toISOString();
      const name = d.toLocaleString("en-US", { month: "short" });
      months.push({ name, start, end });
    }
  } else {
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const start = d.toISOString();
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).toISOString();
      const name = d.toLocaleString("en-US", { month: "short" });
      months.push({ name, start, end });
    }
  }

  let agentIds: number[] = [];
  if (isAgent) {
    agentIds = await getAgentVisibleIds(user.id, user.role);
    if (agentIds.length === 0) {
      res.json(months.map(m => ({ name: m.name, leads: 0, students: 0, applications: 0 })));
      return;
    }
  }

  const result = await Promise.all(months.map(async (m) => {
    const dateFilter = sql`created_at >= ${m.start} AND created_at < ${m.end}`;

    let leadQ, studentQ, appQ;

    if (isAgent) {
      const agentFilter = sql`agent_id IN (${sql.join(agentIds.map(id => sql`${id}`), sql`, `)})`;
      leadQ = db.select({ c: sql<number>`count(*)` }).from(leadsTable).where(and(isNull(leadsTable.deletedAt), sql`${dateFilter} AND ${agentFilter}`));
      studentQ = db.select({ c: sql<number>`count(*)` }).from(studentsTable).where(and(isNull(studentsTable.deletedAt), sql`${dateFilter} AND ${agentFilter}`));
      appQ = db.select({ c: sql<number>`count(*)` }).from(applicationsTable).where(and(isNull(applicationsTable.deletedAt), sql`${dateFilter} AND ${agentFilter}`));
    } else if (!isAdmin) {
      const staffFilter = or(eq(leadsTable.assignedToId, user.id), isNull(leadsTable.assignedToId));
      const studentStaffFilter = or(eq(studentsTable.assignedToId, user.id), isNull(studentsTable.assignedToId));
      const appStaffFilter = or(eq(applicationsTable.assignedToId, user.id), isNull(applicationsTable.assignedToId));
      leadQ = db.select({ c: sql<number>`count(*)` }).from(leadsTable).where(and(isNull(leadsTable.deletedAt), sql`${dateFilter}`, staffFilter));
      studentQ = db.select({ c: sql<number>`count(*)` }).from(studentsTable).where(and(isNull(studentsTable.deletedAt), sql`${dateFilter}`, studentStaffFilter));
      appQ = db.select({ c: sql<number>`count(*)` }).from(applicationsTable).where(and(isNull(applicationsTable.deletedAt), sql`${dateFilter}`, appStaffFilter));
    } else {
      leadQ = db.select({ c: sql<number>`count(*)` }).from(leadsTable).where(and(isNull(leadsTable.deletedAt), sql`${dateFilter}`));
      studentQ = db.select({ c: sql<number>`count(*)` }).from(studentsTable).where(and(isNull(studentsTable.deletedAt), sql`${dateFilter}`));
      appQ = db.select({ c: sql<number>`count(*)` }).from(applicationsTable).where(and(isNull(applicationsTable.deletedAt), sql`${dateFilter}`));
    }

    const [[{ c: leadCount }], [{ c: studentCount }], [{ c: appCount }]] = await Promise.all([leadQ, studentQ, appQ]);
    return { name: m.name, leads: Number(leadCount), students: Number(studentCount), applications: Number(appCount) };
  }));

  res.json(result);
});

const kommoQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  staffId: z.coerce.number().int().positive().optional(),
});

const emptyWorkMetrics = () => ({
  created: 0,
  scheduled: 0,
  completed: 0,
  open: 0,
  pending: 0,
  overdue: 0,
  completionRate: 0,
  onTimeRate: 0,
});

router.get("/stats/kommo-summary", requireAuth, requireRole(...STAFF_ROLES, ...AGENT_ROLES), validate({ query: kommoQuerySchema }), async (req, res): Promise<void> => {
  const user = req.user!;
  const { from: fromStr, to: toStr, staffId: rawStaffId } = getValidated<{ query: typeof kommoQuerySchema }>(req).query;

  const to = toStr ? new Date(toStr) : new Date();
  const from = fromStr ? new Date(fromStr) : new Date(new Date().setHours(0, 0, 0, 0));
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    res.status(400).json({ error: "Invalid from/to date" });
    return;
  }
  if (from >= to) {
    res.status(400).json({ error: "from must be before to" });
    return;
  }

  const isAdmin = isAdminRole(user.role);
  const isAgent = isAgentRole(user.role);

  let staffFilter: number | null = null;
  let agentIds: number[] = [];
  let visibleMessageUserIds: number[] = [];

  if (isAdmin) {
    staffFilter = rawStaffId ?? null;
  } else if (isAgent) {
    agentIds = await getAgentVisibleIds(user.id, user.role);
    if (agentIds.length === 0) {
      res.json({
        avgReplyTime: 0,
        medianReplyTime: 0,
        longestAwaiting: 0,
        awaitingReplyCount: 0,
        replySamples: 0,
        activeLeads: 0,
        wonLeads: 0,
        lostLeads: 0,
        incomingMessages: 0,
        outgoingMessages: 0,
        channels: [],
        tasks: emptyWorkMetrics(),
        followUps: emptyWorkMetrics(),
      });
      return;
    }
    const [agentUsers, agentStaffUsers] = await Promise.all([
      db
        .select({ id: agentsTable.userId })
        .from(agentsTable)
        .where(inArray(agentsTable.id, agentIds)),
      db
        .select({ id: usersTable.id })
        .from(usersTable)
        .where(inArray(usersTable.managingAgentId, agentIds)),
    ]);
    visibleMessageUserIds = Array.from(new Set([
      ...agentUsers.map((row) => row.id).filter((id): id is number => id !== null),
      ...agentStaffUsers.map((row) => row.id),
    ]));
  } else {
    staffFilter = user.id;
  }

  const dateFrom = from.toISOString();
  const dateTo = to.toISOString();

  const wonLeadStatus = "won";
  const lostLeadStatus = "lost";

  let leadWhere = isNull(leadsTable.deletedAt);
  let leadWhereWon = and(isNull(leadsTable.deletedAt), eq(leadsTable.status, wonLeadStatus));
  let leadWhereLost = and(isNull(leadsTable.deletedAt), eq(leadsTable.status, lostLeadStatus));
  let leadWhereActive = and(isNull(leadsTable.deletedAt), ne(leadsTable.status, wonLeadStatus), ne(leadsTable.status, lostLeadStatus));

  if (isAgent) {
    const agentFilter = inArray(leadsTable.agentId, agentIds);
    leadWhere = and(isNull(leadsTable.deletedAt), agentFilter)!;
    leadWhereWon = and(isNull(leadsTable.deletedAt), agentFilter, eq(leadsTable.status, wonLeadStatus))!;
    leadWhereLost = and(isNull(leadsTable.deletedAt), agentFilter, eq(leadsTable.status, lostLeadStatus))!;
    leadWhereActive = and(isNull(leadsTable.deletedAt), agentFilter, ne(leadsTable.status, wonLeadStatus), ne(leadsTable.status, lostLeadStatus))!;
  } else if (staffFilter !== null) {
    leadWhere = and(isNull(leadsTable.deletedAt), eq(leadsTable.assignedToId, staffFilter))!;
    leadWhereWon = and(isNull(leadsTable.deletedAt), eq(leadsTable.assignedToId, staffFilter), eq(leadsTable.status, wonLeadStatus))!;
    leadWhereLost = and(isNull(leadsTable.deletedAt), eq(leadsTable.assignedToId, staffFilter), eq(leadsTable.status, lostLeadStatus))!;
    leadWhereActive = and(isNull(leadsTable.deletedAt), eq(leadsTable.assignedToId, staffFilter), ne(leadsTable.status, wonLeadStatus), ne(leadsTable.status, lostLeadStatus))!;
  }

  const [[{ active }], [{ won }], [{ lost }]] = await Promise.all([
    db.select({ active: sql<number>`count(*)` }).from(leadsTable).where(leadWhereActive),
    db.select({ won: sql<number>`count(*)` }).from(leadsTable).where(leadWhereWon),
    db.select({ lost: sql<number>`count(*)` }).from(leadsTable).where(leadWhereLost),
  ]);

  // Staff attribution model:
  //   - incoming = conversations currently assigned to that staff member;
  //   - outgoing = messages actually authored by that staff member;
  //   - All Staff excludes sender-less AI/system outbound messages so the
  //     performance panel cannot credit automation to humans.
  const messageScopeSql = staffFilter !== null
    ? sql`AND (
        (m.direction = 'inbound' AND c.assigned_to_id = ${staffFilter})
        OR (m.direction = 'outbound' AND m.sender_id = ${staffFilter})
      )`
    : isAgent
      ? visibleMessageUserIds.length > 0
        ? sql`AND (
            (m.direction = 'inbound' AND (
              c.assigned_to_id IN (${sql.join(visibleMessageUserIds.map((id) => sql`${id}`), sql`, `)})
              OR c.created_by_id IN (${sql.join(visibleMessageUserIds.map((id) => sql`${id}`), sql`, `)})
            ))
            OR (m.direction = 'outbound' AND m.sender_id IN (${sql.join(visibleMessageUserIds.map((id) => sql`${id}`), sql`, `)}))
          )`
        : sql`AND false`
      : sql`AND (m.direction = 'inbound' OR (m.direction = 'outbound' AND m.sender_id IS NOT NULL))`;

  const msgCountResult = await db.execute<{
    incoming: string | number | null;
    outgoing: string | number | null;
  }>(sql`
    SELECT
      COALESCE(SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END), 0) AS incoming,
      COALESCE(SUM(CASE WHEN m.direction = 'outbound' THEN 1 ELSE 0 END), 0) AS outgoing
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.created_at >= ${dateFrom}
      AND m.created_at <= ${dateTo}
      ${messageScopeSql}
  `);
  const msgCounts = (((msgCountResult as any).rows ?? msgCountResult) as any[])?.[0] ?? {};

  // Per-channel breakdown uses the exact same ownership predicate as totals.
  const channelResult = await db.execute<{
    channel: string | null;
    incoming: string | number | null;
    outgoing: string | number | null;
  }>(sql`
    SELECT
      COALESCE(m.channel, 'other') AS channel,
      COALESCE(SUM(CASE WHEN m.direction = 'inbound' THEN 1 ELSE 0 END), 0) AS incoming,
      COALESCE(SUM(CASE WHEN m.direction = 'outbound' THEN 1 ELSE 0 END), 0) AS outgoing
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.created_at >= ${dateFrom}
      AND m.created_at <= ${dateTo}
      ${messageScopeSql}
    GROUP BY COALESCE(m.channel, 'other')
  `);
  const channelRows = (((channelResult as any).rows ?? channelResult) as any[]) ?? [];

  // "Connected" = an active channel_accounts row exists for that channel.
  const connectedRows = await db.select({ channel: channelAccountsTable.channel })
    .from(channelAccountsTable)
    .where(eq(channelAccountsTable.isActive, true))
    .groupBy(channelAccountsTable.channel);
  const connectedSet = new Set(connectedRows.map((r) => String(r.channel)));

  const channels = channelRows.map((r) => ({
    channel: String(r.channel ?? "other"),
    incoming: Number(r.incoming ?? 0),
    outgoing: Number(r.outgoing ?? 0),
    connected: connectedSet.has(String(r.channel)),
  }));
  // Include connected-but-silent channels so the UI can show them as 0/0 connected.
  for (const ch of connectedSet) {
    if (!channels.some((c) => c.channel === ch)) {
      channels.push({ channel: ch, incoming: 0, outgoing: 0, connected: true });
    }
  }

  const replyOwnerSql = staffFilter !== null
    ? sql`AND p.first_reply_sender_id = ${staffFilter}`
    : isAgent
      ? visibleMessageUserIds.length > 0
        ? sql`AND p.first_reply_sender_id IN (${sql.join(visibleMessageUserIds.map((id) => sql`${id}`), sql`, `)})`
        : sql`AND false`
      : sql`AND p.first_reply_sender_id IS NOT NULL`;
  const awaitingOwnerSql = staffFilter !== null
    ? sql`AND c.assigned_to_id = ${staffFilter}`
    : isAgent
      ? visibleMessageUserIds.length > 0
        ? sql`AND (
            c.assigned_to_id IN (${sql.join(visibleMessageUserIds.map((id) => sql`${id}`), sql`, `)})
            OR c.created_by_id IN (${sql.join(visibleMessageUserIds.map((id) => sql`${id}`), sql`, `)})
          )`
        : sql`AND false`
      : sql``;

  // One response sample per sender-backed human reply. It is paired with the
  // first inbound message received after that conversation's previous human
  // reply. This treats consecutive customer messages as one turn and prevents
  // sender-less bot/system messages from ending that turn or being credited to
  // a staff member. Current waiting conversations use the same human-only rule.
  const replyRows = await db.execute<{
    avg_reply_seconds: string | null;
    median_reply_seconds: string | null;
    reply_samples: string | number | null;
    longest_awaiting_seconds: string | null;
    awaiting_reply_count: string | number | null;
  }>(sql`
    WITH human_replies AS (
      SELECT
        m.id,
        m.conversation_id,
        m.sender_id,
        m.created_at,
        LAG(m.created_at) OVER (
          PARTITION BY m.conversation_id
          ORDER BY m.created_at, m.id
        ) AS previous_reply_at,
        LAG(m.id) OVER (
          PARTITION BY m.conversation_id
          ORDER BY m.created_at, m.id
        ) AS previous_reply_id
      FROM messages m
      WHERE m.direction = 'outbound'
        AND m.sender_id IS NOT NULL
    ),
    pairs AS (
      SELECT
        hr.conversation_id,
        inbound.created_at AS inbound_at,
        hr.created_at AS first_reply_at,
        hr.sender_id AS first_reply_sender_id,
        EXTRACT(EPOCH FROM (hr.created_at - inbound.created_at)) AS reply_seconds
      FROM human_replies hr
      JOIN LATERAL (
        SELECT mi.created_at
        FROM messages mi
        WHERE mi.conversation_id = hr.conversation_id
          AND mi.direction = 'inbound'
          AND (mi.created_at, mi.id) < (hr.created_at, hr.id)
          AND (
            hr.previous_reply_at IS NULL
            OR (mi.created_at, mi.id) > (hr.previous_reply_at, hr.previous_reply_id)
          )
        ORDER BY mi.created_at ASC, mi.id ASC
        LIMIT 1
      ) inbound ON true
      WHERE hr.created_at >= ${from}
        AND hr.created_at <= ${to}
    ),
    reply_stats AS (
      SELECT
        AVG(p.reply_seconds) AS avg_reply_seconds,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY p.reply_seconds) AS median_reply_seconds,
        COUNT(*) AS reply_samples
      FROM pairs p
      WHERE p.first_reply_at IS NOT NULL ${replyOwnerSql}
    ),
    current_conversation_turns AS (
      SELECT
        c.id AS conversation_id,
        c.assigned_to_id,
        c.created_by_id,
        last_human.created_at AS human_reply_at,
        last_human.id AS human_reply_id,
        first_unanswered.created_at AS inbound_at,
        first_unanswered.id AS inbound_id
      FROM conversations c
      LEFT JOIN LATERAL (
        SELECT mo.id, mo.created_at
        FROM messages mo
        WHERE mo.conversation_id = c.id
          AND mo.direction = 'outbound'
          AND mo.sender_id IS NOT NULL
        ORDER BY mo.created_at DESC, mo.id DESC
        LIMIT 1
      ) last_human ON true
      LEFT JOIN LATERAL (
        SELECT mi.id, mi.created_at
        FROM messages mi
        WHERE mi.conversation_id = c.id
          AND mi.direction = 'inbound'
          AND (
            last_human.created_at IS NULL
            OR (mi.created_at, mi.id) > (last_human.created_at, last_human.id)
          )
        ORDER BY mi.created_at ASC, mi.id ASC
        LIMIT 1
      ) first_unanswered ON true
      WHERE COALESCE(c.status, 'open') = 'open'
    ),
    awaiting_stats AS (
      SELECT
        MAX(EXTRACT(EPOCH FROM (now() - c.inbound_at))) AS longest_awaiting_seconds,
        COUNT(*) AS awaiting_reply_count
      FROM current_conversation_turns c
      WHERE c.inbound_at IS NOT NULL
        ${awaitingOwnerSql}
    )
    SELECT *
    FROM reply_stats
    CROSS JOIN awaiting_stats
  `);

  const replyRow = ((replyRows as any).rows ?? (replyRows as any))?.[0] ?? {};
  const avgReplyTime = replyRow.avg_reply_seconds != null ? Math.round(Number(replyRow.avg_reply_seconds)) : 0;
  const medianReplyTime = replyRow.median_reply_seconds != null ? Math.round(Number(replyRow.median_reply_seconds)) : 0;
  const longestAwaiting = replyRow.longest_awaiting_seconds != null
    ? Math.max(0, Math.round(Number(replyRow.longest_awaiting_seconds)))
    : 0;
  const replySamples = Number(replyRow.reply_samples ?? 0);
  const awaitingReplyCount = Number(replyRow.awaiting_reply_count ?? 0);

  const workOwnerIds = staffFilter !== null
    ? [staffFilter]
    : isAgent
      ? visibleMessageUserIds
      : [];
  const taskOwnerSql = workOwnerIds.length > 0
    ? sql`AND t.assigned_to IN (${sql.join(workOwnerIds.map((id) => sql`${id}`), sql`, `)})`
    : isAgent
      ? sql`AND false`
      : sql``;
  const followUpOwnerSql = workOwnerIds.length > 0
    ? sql`AND COALESCE(f.assigned_to_id, f.created_by_id) IN (${sql.join(workOwnerIds.map((id) => sql`${id}`), sql`, `)})`
    : isAgent
      ? sql`AND false`
      : sql``;

  const [taskResult, followUpResult] = await Promise.all([
    db.execute(sql`
      WITH scoped_tasks AS (
        SELECT
          t.*,
          CASE
            WHEN t.due_date ~ '^\\d{4}-\\d{2}-\\d{2}$' THEN t.due_date::date
            ELSE NULL
          END AS due_on
        FROM tasks t
        WHERE t.archived_at IS NULL
          ${taskOwnerSql}
      )
      SELECT
        COUNT(*) FILTER (WHERE created_at >= ${from} AND created_at <= ${to}) AS created,
        COUNT(*) FILTER (WHERE completed_at >= ${from} AND completed_at <= ${to}) AS completed,
        COUNT(*) FILTER (WHERE status <> 'done') AS open,
        COUNT(*) FILTER (WHERE status <> 'done' AND due_on < (now() AT TIME ZONE 'Europe/Istanbul')::date) AS overdue,
        COUNT(*) FILTER (
          WHERE due_on >= (${dateFrom}::timestamptz AT TIME ZONE 'Europe/Istanbul')::date
            AND due_on <= (${dateTo}::timestamptz AT TIME ZONE 'Europe/Istanbul')::date
        ) AS due_in_period,
        COUNT(*) FILTER (
          WHERE status = 'done'
            AND due_on >= (${dateFrom}::timestamptz AT TIME ZONE 'Europe/Istanbul')::date
            AND due_on <= (${dateTo}::timestamptz AT TIME ZONE 'Europe/Istanbul')::date
        ) AS completed_due,
        COUNT(*) FILTER (
          WHERE status = 'done'
            AND completed_at IS NOT NULL
            AND completed_at < ((due_on + 1)::timestamp AT TIME ZONE 'Europe/Istanbul')
            AND due_on >= (${dateFrom}::timestamptz AT TIME ZONE 'Europe/Istanbul')::date
            AND due_on <= (${dateTo}::timestamptz AT TIME ZONE 'Europe/Istanbul')::date
        ) AS on_time
      FROM scoped_tasks
    `),
    db.execute(sql`
      WITH scoped_followups AS (
        SELECT f.*
        FROM follow_ups f
        WHERE true
          ${followUpOwnerSql}
      )
      SELECT
        COUNT(*) FILTER (WHERE scheduled_at >= ${from} AND scheduled_at <= ${to}) AS scheduled,
        COUNT(*) FILTER (WHERE completed_at >= ${from} AND completed_at <= ${to}) AS completed,
        COUNT(*) FILTER (WHERE completed = false) AS pending,
        COUNT(*) FILTER (WHERE completed = false AND scheduled_at < now()) AS overdue,
        COUNT(*) FILTER (
          WHERE completed = true
            AND scheduled_at >= ${from}
            AND scheduled_at <= ${to}
        ) AS completed_scheduled,
        COUNT(*) FILTER (
          WHERE completed = true
            AND completed_at IS NOT NULL
            AND completed_at <= scheduled_at
            AND scheduled_at >= ${from}
            AND scheduled_at <= ${to}
        ) AS on_time
      FROM scoped_followups
    `),
  ]);

  const taskRow = (((taskResult as any).rows ?? taskResult) as any[])?.[0] ?? {};
  const followUpRow = (((followUpResult as any).rows ?? followUpResult) as any[])?.[0] ?? {};
  const percentage = (numerator: unknown, denominator: unknown): number => {
    const n = Number(numerator ?? 0);
    const d = Number(denominator ?? 0);
    return d > 0 ? Math.round((n / d) * 100) : 0;
  };
  const tasks = {
    created: Number(taskRow.created ?? 0),
    completed: Number(taskRow.completed ?? 0),
    open: Number(taskRow.open ?? 0),
    overdue: Number(taskRow.overdue ?? 0),
    completionRate: percentage(taskRow.completed_due, taskRow.due_in_period),
    onTimeRate: percentage(taskRow.on_time, taskRow.completed_due),
  };
  const followUps = {
    scheduled: Number(followUpRow.scheduled ?? 0),
    completed: Number(followUpRow.completed ?? 0),
    pending: Number(followUpRow.pending ?? 0),
    overdue: Number(followUpRow.overdue ?? 0),
    completionRate: percentage(followUpRow.completed_scheduled, followUpRow.scheduled),
    onTimeRate: percentage(followUpRow.on_time, followUpRow.completed_scheduled),
  };

  res.json({
    avgReplyTime,
    medianReplyTime,
    longestAwaiting,
    awaitingReplyCount,
    replySamples,
    activeLeads: Number(active),
    wonLeads: Number(won),
    lostLeads: Number(lost),
    incomingMessages: Number(msgCounts.incoming ?? 0),
    outgoingMessages: Number(msgCounts.outgoing ?? 0),
    channels,
    tasks,
    followUps,
  });
});

export default router;
