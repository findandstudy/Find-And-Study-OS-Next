import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { readFileSync, readdirSync, statfsSync, statSync } from "fs";
import { resolve } from "path";
import { requireAuth, requireRole } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";

const router: IRouter = Router();

let cachedVersion: string | undefined;
function getVersion(): string {
  if (!cachedVersion) {
    try {
      const pkg = JSON.parse(
        readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf-8")
      );
      cachedVersion = pkg.version ?? "0.0.0";
    } catch {
      cachedVersion = "0.0.0";
    }
  }
  return cachedVersion!;
}

router.get("/healthz", (_req, res) => {
  res.json({ status: "ok", releaseId: process.env.RELEASE_ID || "unknown" });
});

// Deployment healthchecks probe GET /api directly. Keep this endpoint
// DB-independent so a slow database connection at boot doesn't make the
// platform kill an otherwise healthy instance (DB health is on /health).
router.get("/", (_req, res) => {
  res.json({ status: "ok", uptime: Math.floor(process.uptime()) });
});

router.get("/health", async (_req, res) => {
  let dbConnected = false;
  try {
    await pool.query("SELECT 1");
    dbConnected = true;
  } catch {
    dbConnected = false;
  }

  const status = dbConnected ? "ok" : "degraded";

  res.status(dbConnected ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    dbConnected,
    version: getVersion(),
    releaseId: process.env.RELEASE_ID || "unknown",
  });
});

type HealthIssue = {
  key: string;
  severity: "warning" | "critical";
  message: string;
  count: number;
};

function readStorageHealth() {
  try {
    const stats = statfsSync(process.cwd());
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    return {
      available: true,
      totalBytes,
      freeBytes,
      freePercent: totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 1000) / 10 : null,
    };
  } catch {
    return { available: false, totalBytes: null, freeBytes: null, freePercent: null };
  }
}

function readBackupHealth() {
  const backupDir = process.env.BACKUP_DIR || "/opt/findandstudy/backups";
  try {
    const files = readdirSync(backupDir)
      .filter((name) => /\.(?:dump|backup|sql(?:\.gz)?)$/i.test(name))
      .map((name) => statSync(resolve(backupDir, name)))
      .filter((stat) => stat.isFile())
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const latest = files[0];
    return {
      available: true,
      count: files.length,
      latestAt: latest ? latest.mtime.toISOString() : null,
      latestSizeBytes: latest?.size ?? null,
      latestAgeHours: latest ? Math.round(((Date.now() - latest.mtimeMs) / 3_600_000) * 10) / 10 : null,
    };
  } catch {
    return { available: false, count: null, latestAt: null, latestSizeBytes: null, latestAgeHours: null };
  }
}

// Operational health is intentionally separate from the public liveness probes.
// It is read-only, admin-scoped and never returns credentials, payloads, prompts,
// webhook bodies or student data.
router.get(
  "/admin/system-health",
  requireAuth,
  requireRole(...ADMIN_ROLES),
  async (_req, res): Promise<void> => {
    const startedAt = Date.now();
    try {
      const [tokenResult, aiResult, webhookResult, portalResult] = await Promise.all([
        pool.query(`
          SELECT
            count(*) FILTER (WHERE revoked_at IS NULL AND expires_at IS NULL)::int AS no_expiry,
            count(*) FILTER (WHERE revoked_at IS NULL AND expires_at <= now())::int AS expired,
            count(*) FILTER (
              WHERE revoked_at IS NULL AND expires_at > now()
                AND expires_at <= now() + interval '7 days'
            )::int AS expiring_soon
          FROM api_tokens
        `),
        pool.query(`
          SELECT
            count(*) FILTER (WHERE status = 'error')::int AS failed,
            count(*) FILTER (WHERE status = 'rate_limited')::int AS rate_limited
          FROM ai_persona_runs
          WHERE created_at >= now() - interval '24 hours'
        `),
        pool.query(`
          WITH grouped AS (
            SELECT resource, count(*)::int AS n
            FROM audit_logs
            WHERE action = 'webhook_auth_failed'
              AND created_at >= now() - interval '24 hours'
            GROUP BY resource
          )
          SELECT
            coalesce(sum(n), 0)::int AS auth_failures,
            coalesce(sum(n) FILTER (WHERE resource LIKE '%:verify'), 0)::int AS verification_probes,
            coalesce(sum(n) FILTER (WHERE resource NOT LIKE '%:verify'), 0)::int AS delivery_failures,
            coalesce(jsonb_object_agg(resource, n), '{}'::jsonb) AS by_resource
          FROM grouped
        `),
        pool.query(`
          SELECT
            count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'running')::int AS running,
            count(*) FILTER (
              WHERE status = 'running' AND locked_at < now() - interval '20 minutes'
            )::int AS stale_running,
            count(*) FILTER (
              WHERE status = 'failed' AND updated_at >= now() - interval '24 hours'
            )::int AS failed_24h
          FROM portal_submissions
          WHERE deleted_at IS NULL
        `),
      ]);

      const tokens = tokenResult.rows[0] ?? {};
      const ai = aiResult.rows[0] ?? {};
      const webhooks = webhookResult.rows[0] ?? {};
      const portal = portalResult.rows[0] ?? {};
      const storage = readStorageHealth();
      const backups = readBackupHealth();
      const issues: HealthIssue[] = [];
      const addIssue = (key: string, severity: HealthIssue["severity"], message: string, value: unknown) => {
        const count = Number(value ?? 0);
        if (count > 0) issues.push({ key, severity, message, count });
      };

      addIssue("tokens.no_expiry", "critical", "Active API tokens without an expiry must be rotated", tokens.no_expiry);
      addIssue("tokens.expired", "critical", "Expired API tokens should be revoked", tokens.expired);
      addIssue("tokens.expiring_soon", "warning", "API tokens expire within seven days", tokens.expiring_soon);
      addIssue("ai.failed", "warning", "AI runs failed during the last 24 hours", ai.failed);
      addIssue("ai.rate_limited", "warning", "AI runs were rate limited during the last 24 hours", ai.rate_limited);
      addIssue("webhooks.delivery_auth_failed", "critical", "Signed webhook deliveries failed authentication during the last 24 hours", webhooks.delivery_failures);
      if (Number(webhooks.verification_probes ?? 0) >= 100) {
        addIssue("webhooks.verification_probes", "warning", "High volume of rejected webhook verification probes", webhooks.verification_probes);
      }
      addIssue("portal.stale_running", "critical", "Portal submissions appear stuck in running state", portal.stale_running);
      addIssue("portal.failed", "warning", "Portal submissions failed during the last 24 hours", portal.failed_24h);
      if (storage.available && storage.freePercent != null) {
        if (storage.freePercent < 10) addIssue("storage.disk_free", "critical", "Server disk free space is below 10%", 1);
        else if (storage.freePercent < 20) addIssue("storage.disk_free", "warning", "Server disk free space is below 20%", 1);
      } else {
        addIssue("storage.unavailable", "warning", "Server disk metrics could not be read", 1);
      }
      if (!backups.available || backups.count === 0) {
        addIssue("backups.unavailable", "critical", "No readable database backup was found", 1);
      } else if (backups.latestAgeHours != null && backups.latestAgeHours > 168) {
        addIssue("backups.stale", "critical", "Latest readable database backup is older than seven days", 1);
      } else if (backups.latestAgeHours != null && backups.latestAgeHours > 48) {
        addIssue("backups.stale", "warning", "Latest readable database backup is older than 48 hours", 1);
      }

      const status = issues.some((issue) => issue.severity === "critical")
        ? "critical"
        : issues.length > 0
          ? "warning"
          : "healthy";

      res.json({
        status,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        releaseId: process.env.RELEASE_ID || "unknown",
        metrics: {
          apiTokens: tokens,
          aiRuns24h: ai,
          webhook24h: webhooks,
          portalSubmissions: portal,
          storage,
          backups,
        },
        issues,
      });
    } catch (error) {
      console.error("[system-health] read-only health query failed", error);
      res.status(503).json({
        status: "critical",
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        issues: [{
          key: "health.query_failed",
          severity: "critical",
          message: "Operational health data could not be read",
          count: 1,
        }],
      });
    }
  },
);

export default router;
