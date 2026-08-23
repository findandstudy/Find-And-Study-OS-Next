import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db, apiTokensTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { ADMIN_ROLES } from "../lib/roles";
import { generateToken, validateScopes, AVAILABLE_SCOPES } from "../lib/apiToken";
import { getClientIp } from "../lib/clientIp";

const router: IRouter = Router();

const DEFAULT_TOKEN_LIFETIME_DAYS = 30;
const MAX_TOKEN_LIFETIME_DAYS = 90;

function tokenExpiry(raw: unknown): { expiresAt?: Date; error?: string } {
  const now = Date.now();
  const parsed = raw == null || raw === ""
    ? new Date(now + DEFAULT_TOKEN_LIFETIME_DAYS * 86_400_000)
    : new Date(String(raw));
  if (isNaN(parsed.getTime())) return { error: "expiresAt is not a valid date" };
  if (parsed.getTime() <= now) return { error: "expiresAt must be in the future" };
  if (parsed.getTime() > now + MAX_TOKEN_LIFETIME_DAYS * 86_400_000) {
    return { error: `expiresAt cannot be more than ${MAX_TOKEN_LIFETIME_DAYS} days in the future` };
  }
  return { expiresAt: parsed };
}

// API tokens may only be managed from an interactive (cookie) session. A token
// must never be able to mint or revoke further tokens — that would let a leaked
// token bootstrap persistent, broader access. Block Bearer-authed requests.
function blockTokenAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.apiTokenAuth) {
    res.status(403).json({ error: "API tokens cannot manage API tokens" });
    return;
  }
  next();
}

// Non-secret projection — never returns token_hash. Each row a caller can see is
// scoped to their own user_id.
function publicToken(t: typeof apiTokensTable.$inferSelect) {
  return {
    id: t.id,
    name: t.name,
    prefix: t.tokenPrefix,
    scopes: (t.scopes as string[] | null) ?? [],
    lastUsedAt: t.lastUsedAt,
    expiresAt: t.expiresAt,
    revokedAt: t.revokedAt,
    createdAt: t.createdAt,
  };
}

// List of scopes a token may hold, for the management UI.
router.get("/api-tokens/scopes", requireAuth, requireRole(...ADMIN_ROLES), blockTokenAuth, async (_req, res): Promise<void> => {
  res.json({ data: AVAILABLE_SCOPES });
});

// List the current user's own tokens (most recent first).
router.get("/api-tokens", requireAuth, requireRole(...ADMIN_ROLES), blockTokenAuth, async (req, res): Promise<void> => {
  const rows = await db
    .select()
    .from(apiTokensTable)
    .where(eq(apiTokensTable.userId, req.user!.id))
    .orderBy(desc(apiTokensTable.createdAt), desc(apiTokensTable.id));
  res.json({ data: rows.map(publicToken) });
});

// Create a token. The plain value is returned exactly once in this response and
// can never be retrieved again.
router.post("/api-tokens", requireAuth, requireRole(...ADMIN_ROLES), blockTokenAuth, async (req, res): Promise<void> => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  if (name.length > 100) {
    res.status(400).json({ error: "name must be 100 characters or fewer" });
    return;
  }

  const rawScopes = req.body?.scopes;
  if (!Array.isArray(rawScopes) || rawScopes.length === 0) {
    res.status(400).json({ error: "scopes must be a non-empty array" });
    return;
  }
  if (!rawScopes.every((s) => typeof s === "string")) {
    res.status(400).json({ error: "scopes must be strings" });
    return;
  }
  const scopes = Array.from(new Set(rawScopes as string[]));
  const { valid, invalid } = validateScopes(scopes);
  if (!valid) {
    res.status(400).json({ error: "Unknown scope(s)", invalid });
    return;
  }

  const expiry = tokenExpiry(req.body?.expiresAt);
  if (expiry.error || !expiry.expiresAt) {
    res.status(400).json({ error: expiry.error || "expiresAt is required" });
    return;
  }
  const expiresAt = expiry.expiresAt;

  const { plain, prefix, hash } = generateToken();
  const [row] = await db
    .insert(apiTokensTable)
    .values({
      userId: req.user!.id,
      name,
      tokenHash: hash,
      tokenPrefix: prefix,
      scopes,
      expiresAt,
      createdBy: req.user!.id,
    })
    .returning();

  logAudit(req.user!.id, "create", "api_token", row.id, { name, scopes, expiresAt }, getClientIp(req) ?? undefined);

  // `token` is the only time the plain value is ever exposed.
  res.status(201).json({ token: plain, ...publicToken(row) });
});

// Revoke a token (soft — keeps the row for audit/last-used history). Only the
// owner may revoke their own token; revoking an already-revoked token is a no-op
// returning the current state.
router.post("/api-tokens/:id/revoke", requireAuth, requireRole(...ADMIN_ROLES), blockTokenAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [existing] = await db
    .select()
    .from(apiTokensTable)
    .where(and(eq(apiTokensTable.id, id), eq(apiTokensTable.userId, req.user!.id)));
  if (!existing) {
    res.status(404).json({ error: "Token not found" });
    return;
  }
  if (existing.revokedAt) {
    res.json(publicToken(existing));
    return;
  }
  const [updated] = await db
    .update(apiTokensTable)
    .set({ revokedAt: new Date() })
    .where(eq(apiTokensTable.id, id))
    .returning();

  logAudit(req.user!.id, "revoke", "api_token", id, { name: existing.name }, getClientIp(req) ?? undefined);

  res.json(publicToken(updated));
});

// Atomically replace an active token. The old token is revoked in the same
// transaction that creates its replacement, so rotation cannot leave two
// indefinitely active credentials. The new plain token is returned once.
router.post("/api-tokens/:id/rotate", requireAuth, requireRole(...ADMIN_ROLES), blockTokenAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const expiry = tokenExpiry(req.body?.expiresAt);
  if (expiry.error || !expiry.expiresAt) {
    res.status(400).json({ error: expiry.error || "expiresAt is required" });
    return;
  }
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(apiTokensTable)
      .where(and(eq(apiTokensTable.id, id), eq(apiTokensTable.userId, req.user!.id)));
    if (!existing || existing.revokedAt) return null;
    const generated = generateToken();
    const [replacement] = await tx
      .insert(apiTokensTable)
      .values({
        userId: existing.userId,
        name: `${existing.name} (rotated)`.slice(0, 100),
        tokenHash: generated.hash,
        tokenPrefix: generated.prefix,
        scopes: (existing.scopes as string[] | null) ?? [],
        expiresAt: expiry.expiresAt,
        createdBy: req.user!.id,
      })
      .returning();
    await tx.update(apiTokensTable).set({ revokedAt: new Date() }).where(eq(apiTokensTable.id, existing.id));
    return { plain: generated.plain, replacement, previous: existing };
  });
  if (!result) {
    res.status(404).json({ error: "Active token not found" });
    return;
  }
  logAudit(req.user!.id, "rotate", "api_token", result.replacement.id, {
    previousTokenId: result.previous.id,
    expiresAt: result.replacement.expiresAt,
  }, getClientIp(req) ?? undefined);
  res.status(201).json({ token: result.plain, ...publicToken(result.replacement) });
});

export default router;
