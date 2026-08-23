// Sohbet Kalite Puanlama — API routes (Faz 1).
//
// Visibility model: admin/manager roles see everything. Other staff see ONLY
// their own scores, and only when the aiAgentConfig.quality.selfVisible
// toggle is ON (default OFF). Agents/students never see quality data.
import { Router, type IRouter, type Request, type Response } from "express";
import { pool } from "@workspace/db";
import { ADMIN_ROLES, STAFF_ROLES, isAdminRole } from "@workspace/roles";
import { requireAuth, requireRole } from "../lib/auth";
import { getAiAgentConfig, writeAiAgentConfig } from "../lib/inbox/aiAgentConfig";
import { runQualityBatch } from "../lib/inbox/qualityScoring";
import { buildWorkbookBuffer, XLSX_CONTENT_TYPE } from "../lib/exportImportExcel";

const router: IRouter = Router();

function parseDays(raw: unknown, fallback = 30): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 365);
}

/**
 * Resolve which user ids the requester may see.
 * Returns "all" for admins/managers, a user id for self-visible staff,
 * or null when the requester may see nothing (→ 403).
 */
async function resolveScope(req: Request): Promise<"all" | number | null> {
  const user = (req as any).user;
  if (!user) return null;
  if (isAdminRole(user.role)) return "all";
  const cfg = (await getAiAgentConfig()).quality;
  if (cfg.selfVisible && STAFF_ROLES.includes(user.role)) return user.id;
  return null;
}

// ── Settings ────────────────────────────────────────────────────────────────

router.get("/quality/settings", requireAuth, requireRole(...STAFF_ROLES), async (req: Request, res: Response): Promise<void> => {
  const cfg = (await getAiAgentConfig()).quality;
  const user = (req as any).user;
  if (isAdminRole(user.role)) {
    res.json(cfg);
    return;
  }
  // Non-admin staff only learn whether they can see their own scores.
  res.json({ selfVisible: cfg.selfVisible });
});

router.patch("/quality/settings", requireAuth, requireRole(...ADMIN_ROLES), async (req: Request, res: Response): Promise<void> => {
  const allowed = ["enabled", "model", "minStaffMessages", "idleHours", "batchSize", "runHourUtc", "selfVisible"] as const;
  const patch: Record<string, unknown> = {};
  for (const k of allowed) {
    if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  }
  try {
    const updated = await writeAiAgentConfig({ quality: patch as any });
    res.json(updated.quality);
  } catch (err: any) {
    res.status(400).json({ error: "INVALID_QUALITY_SETTINGS", message: String(err?.message || err) });
  }
});

// ── Staff summary (ranking + trend + dim breakdown) ─────────────────────────

router.get("/quality/staff-summary", requireAuth, requireRole(...STAFF_ROLES), async (req: Request, res: Response): Promise<void> => {
  const scope = await resolveScope(req);
  if (scope === null) { res.status(403).json({ error: "QUALITY_NOT_VISIBLE" }); return; }
  const days = parseDays(req.query.days);
  const params: unknown[] = [String(days)];
  let userFilter = "";
  if (scope !== "all") { params.push(scope); userFilter = `AND q.user_id = $${params.length}`; }

  const { rows } = await pool.query(
    `
    SELECT
      q.user_id,
      u.first_name, u.last_name, u.email, u.role,
      COUNT(*)::int AS conversation_count,
      ROUND(AVG(q.overall))::int AS avg_overall,
      ROUND(AVG(q.accuracy)::numeric, 2)::float AS avg_accuracy,
      ROUND(AVG(q.completeness)::numeric, 2)::float AS avg_completeness,
      ROUND(AVG(q.speed)::numeric, 2)::float AS avg_speed,
      ROUND(AVG(q.tone)::numeric, 2)::float AS avg_tone,
      ROUND(AVG(q.outcome)::numeric, 2)::float AS avg_outcome,
      ROUND(AVG(q.overall) FILTER (WHERE q.scored_at >= NOW() - ($1 || ' days')::interval / 2))::int AS recent_half_avg,
      ROUND(AVG(q.overall) FILTER (WHERE q.scored_at <  NOW() - ($1 || ' days')::interval / 2))::int AS earlier_half_avg
    FROM conversation_quality_scores q
    JOIN users u ON u.id = q.user_id
    WHERE q.scored_at >= NOW() - ($1 || ' days')::interval
    ${userFilter}
    GROUP BY q.user_id, u.first_name, u.last_name, u.email, u.role
    ORDER BY avg_overall DESC
    `,
    params,
  );

  res.json({
    days,
    staff: rows.map((r: any) => {
      const recent = r.recent_half_avg == null ? null : Number(r.recent_half_avg);
      const earlier = r.earlier_half_avg == null ? null : Number(r.earlier_half_avg);
      let trend: "up" | "down" | "flat" = "flat";
      if (recent != null && earlier != null) {
        if (recent - earlier >= 3) trend = "up";
        else if (earlier - recent >= 3) trend = "down";
      }
      return {
        userId: Number(r.user_id),
        firstName: r.first_name,
        lastName: r.last_name,
        email: r.email,
        role: r.role,
        conversationCount: Number(r.conversation_count),
        avgOverall: Number(r.avg_overall),
        dims: {
          accuracy: Number(r.avg_accuracy),
          completeness: Number(r.avg_completeness),
          speed: Number(r.avg_speed),
          tone: Number(r.avg_tone),
          outcome: Number(r.avg_outcome),
        },
        trend,
        recentHalfAvg: recent,
        earlierHalfAvg: earlier,
      };
    }),
  });
});

// ── Scored conversations (source list + coaching queue) ─────────────────────

router.get("/quality/conversations", requireAuth, requireRole(...STAFF_ROLES), async (req: Request, res: Response): Promise<void> => {
  const scope = await resolveScope(req);
  if (scope === null) { res.status(403).json({ error: "QUALITY_NOT_VISIBLE" }); return; }
  const days = parseDays(req.query.days);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const order = req.query.order === "asc" ? "ASC" : "DESC"; // asc == worst first (coaching queue)
  const maxOverallRaw = Number(req.query.maxOverall);
  const maxOverall = Number.isFinite(maxOverallRaw) ? Math.min(Math.max(maxOverallRaw, 0), 100) : null;

  const params: unknown[] = [String(days)];
  const conds: string[] = [`q.scored_at >= NOW() - ($1 || ' days')::interval`];
  let requestedUser = req.query.userId != null ? Number(req.query.userId) : null;
  if (scope !== "all") {
    if (requestedUser != null && requestedUser !== scope) {
      res.status(403).json({ error: "QUALITY_NOT_VISIBLE" });
      return;
    }
    requestedUser = scope;
  }
  if (requestedUser != null && Number.isFinite(requestedUser)) {
    params.push(requestedUser);
    conds.push(`q.user_id = $${params.length}`);
  }
  if (maxOverall != null) {
    params.push(maxOverall);
    conds.push(`q.overall <= $${params.length}`);
  }
  params.push(limit, offset);

  const { rows } = await pool.query(
    `
    SELECT q.*, u.first_name, u.last_name,
           c.title AS conversation_title, c.channel, c.last_message_at,
           COUNT(*) OVER()::int AS total_count
    FROM conversation_quality_scores q
    JOIN users u ON u.id = q.user_id
    JOIN conversations c ON c.id = q.conversation_id
    WHERE ${conds.join(" AND ")}
    ORDER BY q.overall ${order}, q.scored_at DESC, q.id ${order}
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params,
  );

  res.json({
    total: rows.length ? Number(rows[0].total_count) : 0,
    data: rows.map((r: any) => ({
      id: Number(r.id),
      conversationId: Number(r.conversation_id),
      conversationTitle: r.conversation_title,
      channel: r.channel,
      lastMessageAt: r.last_message_at,
      userId: Number(r.user_id),
      firstName: r.first_name,
      lastName: r.last_name,
      accuracy: Number(r.accuracy),
      completeness: Number(r.completeness),
      speed: Number(r.speed),
      tone: Number(r.tone),
      outcome: Number(r.outcome),
      overall: Number(r.overall),
      rationales: r.rationales,
      topic: r.topic,
      language: r.language,
      staffMessageCount: Number(r.staff_message_count),
      avgReplySeconds: r.avg_reply_seconds == null ? null : Number(r.avg_reply_seconds),
      scoredAt: r.scored_at,
    })),
  });
});

// ── Topic analysis ───────────────────────────────────────────────────────────

router.get("/quality/topics", requireAuth, requireRole(...ADMIN_ROLES), async (req: Request, res: Response): Promise<void> => {
  const days = parseDays(req.query.days);
  const params: unknown[] = [String(days)];
  let langFilter = "";
  const lang = typeof req.query.language === "string" && req.query.language.trim() ? req.query.language.trim().toLowerCase() : null;
  if (lang) { params.push(lang); langFilter = `AND q.language = $${params.length}`; }

  const { rows } = await pool.query(
    `
    SELECT COALESCE(NULLIF(TRIM(q.topic), ''), 'diğer') AS topic,
           COUNT(*)::int AS count,
           ROUND(AVG(q.overall))::int AS avg_overall
    FROM conversation_quality_scores q
    WHERE q.scored_at >= NOW() - ($1 || ' days')::interval
    ${langFilter}
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 50
    `,
    params,
  );
  const { rows: langs } = await pool.query(
    `SELECT DISTINCT language FROM conversation_quality_scores WHERE language IS NOT NULL ORDER BY language`,
  );
  res.json({
    days,
    language: lang,
    languages: langs.map((l: any) => l.language),
    topics: rows.map((r: any) => ({ topic: r.topic, count: Number(r.count), avgOverall: Number(r.avg_overall) })),
  });
});

// ── Team trend (daily averages) ──────────────────────────────────────────────

router.get("/quality/team-trend", requireAuth, requireRole(...ADMIN_ROLES), async (req: Request, res: Response): Promise<void> => {
  const days = parseDays(req.query.days);
  const { rows } = await pool.query(
    `
    SELECT TO_CHAR(q.scored_at::date, 'YYYY-MM-DD') AS day,
           COUNT(*)::int AS count,
           ROUND(AVG(q.overall))::int AS avg_overall
    FROM conversation_quality_scores q
    WHERE q.scored_at >= NOW() - ($1 || ' days')::interval
    GROUP BY 1
    ORDER BY 1
    `,
    [String(days)],
  );
  res.json({ days, trend: rows.map((r: any) => ({ day: r.day, count: Number(r.count), avgOverall: Number(r.avg_overall) })) });
});

// ── Excel export ─────────────────────────────────────────────────────────────

router.get("/quality/export.xlsx", requireAuth, requireRole(...ADMIN_ROLES), async (req: Request, res: Response): Promise<void> => {
  const days = parseDays(req.query.days);
  const { rows } = await pool.query(
    `
    SELECT q.*, u.first_name, u.last_name, u.email, c.title AS conversation_title, c.channel
    FROM conversation_quality_scores q
    JOIN users u ON u.id = q.user_id
    JOIN conversations c ON c.id = q.conversation_id
    WHERE q.scored_at >= NOW() - ($1 || ' days')::interval
    ORDER BY q.scored_at DESC
    LIMIT 5000
    `,
    [String(days)],
  );
  const col = (key: string, header: string, kind: "string" | "number" = "string") => ({ key, header, kind });
  const buffer = await buildWorkbookBuffer({
    sheets: [
      {
        name: "QualityScores",
        columns: [
          col("conversationId", "Conversation ID", "number"),
          col("staff", "Staff"),
          col("email", "Email"),
          col("channel", "Channel"),
          col("topic", "Topic"),
          col("language", "Language"),
          col("accuracy", "Accuracy", "number"),
          col("completeness", "Completeness", "number"),
          col("speed", "Speed", "number"),
          col("tone", "Tone", "number"),
          col("outcome", "Outcome", "number"),
          col("overall", "Overall", "number"),
          col("avgReplySeconds", "Avg Reply (s)", "number"),
          col("staffMessageCount", "Staff Msg Count", "number"),
          col("scoredAt", "Scored At"),
        ],
        rows: rows.map((r: any) => ({
          conversationId: Number(r.conversation_id),
          staff: [r.first_name, r.last_name].filter(Boolean).join(" "),
          email: r.email,
          channel: r.channel,
          topic: r.topic,
          language: r.language,
          accuracy: Number(r.accuracy),
          completeness: Number(r.completeness),
          speed: Number(r.speed),
          tone: Number(r.tone),
          outcome: Number(r.outcome),
          overall: Number(r.overall),
          avgReplySeconds: r.avg_reply_seconds == null ? null : Number(r.avg_reply_seconds),
          staffMessageCount: Number(r.staff_message_count),
          scoredAt: r.scored_at ? new Date(r.scored_at).toISOString() : null,
        })),
      },
    ],
    meta: { kind: "quality_scores", version: "1", days: String(days) },
  });
  res.setHeader("Content-Type", XLSX_CONTENT_TYPE);
  res.setHeader("Content-Disposition", `attachment; filename="quality-scores-${days}d.xlsx"`);
  res.send(buffer);
});

// ── Manual batch trigger (admin) ─────────────────────────────────────────────

router.post("/quality/run-batch", requireAuth, requireRole(...ADMIN_ROLES), async (req: Request, res: Response): Promise<void> => {
  const limitRaw = Number(req.body?.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : undefined;
  try {
    const result = await runQualityBatch({ limit });
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: "QUALITY_BATCH_FAILED", message: String(err?.message || err) });
  }
});

export default router;
