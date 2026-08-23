import express, { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getRateLimitIp, getClientIp } from "../lib/clientIp";
import crypto from "crypto";
import { db, agentsTable, usersTable, signingSessionsTable, signedContractsTable, contractTemplatesTable, settingsTable, emailVerificationCodesTable } from "@workspace/db";
import { and, eq, gt, desc, ilike } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth";
import { MANAGER_ROLES } from "../lib/roles";
import { writeAudit } from "../lib/auditLog";
import { sendEmail, buildContractSignRequestEmail, buildAgentOnboardingEmail, getAppBaseUrl } from "../lib/email";
import { createSigningToken } from "../lib/signingTokens";
import { hasContractCompanySignature } from "../lib/contractBranding";
import { resolveContractTemplateBranding } from "../lib/contractTemplateBranding";
import { finalizeSign, loadNewestSignedContractForAgent } from "../lib/signContract";
import { agentIntakeDefaults, signedContractFilename } from "../lib/contractRenderer";
import { RateLimiterPostgres } from "rate-limiter-flexible";
import { pool } from "@workspace/db";
import bcrypt from "bcryptjs";
import { validatePassword } from "../lib/passwordPolicy";
import { createSession, deleteSessionsForUser, getSessionId, SESSION_COOKIE, SESSION_TTL, type SessionData, type SessionUser } from "../lib/replitAuth";
import { isTrustedOrigin } from "../lib/requestOrigin";
import { getSessionCookieOptions } from "../lib/cookieOptions";

const router: IRouter = Router();

// Contract signing carries the signer's signature as a base64 PNG (drawn or
// uploaded). app.ts skips the global 1 MB JSON parser for the sign paths, so the
// sign routes must install their own parser. 3 MB comfortably covers the route's
// own 2 MB (decoded) signature validation (~2.8 M base64 chars) plus the JSON
// envelope, all enforced precisely by validateSignatureImage() in finalizeSign().
const signBodyParser = express.json({ limit: "3mb" });

const AGENT_ROLES = ["agent", "sub_agent", "agent_staff"];

const rateLimiter = new RateLimiterPostgres({
  storeClient: pool,
  storeType: "pool",
  tableName: "rate_limits",
  points: 5,
  duration: 900,
});

function generateVerificationCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

/**
 * URL-safe one-time onboarding token. Embedded in the email CTA so the
 * verify link does not leak the human-friendly 6-digit code via URL logs,
 * referrers, or screenshots. Stored alongside the code; either one (token
 * or code+email) can complete verification.
 */
function generateOnboardingToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

async function buildOnboardingVerificationCodeEmail(firstName: string, code: string, email: string, token: string): Promise<{ subject: string; html: string; text: string }> {
  const baseUrl = getAppBaseUrl();
  const verifyUrl = `${baseUrl}/agent/onboarding?token=${encodeURIComponent(token)}`;
  return buildAgentOnboardingEmail({ firstName, email, code, verifyUrl });
}

async function loadAgentForUser(userId: number, userRole: string) {
  if (userRole === "agent_staff") {
    const [staffUser] = await db.select({ managingAgentId: usersTable.managingAgentId }).from(usersTable).where(eq(usersTable.id, userId));
    if (!staffUser?.managingAgentId) return null;
    const [a] = await db.select().from(agentsTable).where(eq(agentsTable.id, staffUser.managingAgentId));
    return a || null;
  }
  const [a] = await db.select().from(agentsTable).where(eq(agentsTable.userId, userId));
  return a || null;
}

async function loadOnboardingSession(agentId: number) {
  const [s] = await db.select().from(signingSessionsTable)
    .where(and(eq(signingSessionsTable.agentId, agentId), eq(signingSessionsTable.isPrimaryOnboarding, true)))
    .orderBy(desc(signingSessionsTable.createdAt))
    .limit(1);
  return s || null;
}

/**
 * The primary onboarding contract becomes *mandatory* (non-dismissible, portal
 * blocked) once the calendar day of its deadline arrives. Before that day the
 * agent may postpone signing ("Later") and keep using the portal, while a
 * reminder popup is shown on every login.
 */
function isOnboardingContractMandatory(session: typeof signingSessionsTable.$inferSelect | null): boolean {
  if (!session) return false;
  if (session.status === "signed" || session.status === "expired" || session.status === "revoked") return false;
  const deadline = new Date(session.expiresAt);
  if (isNaN(deadline.getTime())) return true; // unparseable deadline: force signing to be safe
  const startOfDeadlineDay = new Date(deadline);
  startOfDeadlineDay.setHours(0, 0, 0, 0);
  return Date.now() >= startOfDeadlineDay.getTime();
}

async function lazyExpire(session: typeof signingSessionsTable.$inferSelect) {
  if (!session) return session;
  const isPastDue = new Date(session.expiresAt).getTime() < Date.now();
  if (isPastDue && (session.status === "intake_pending" || session.status === "review_pending")) {
    try {
      await db.update(signingSessionsTable).set({ status: "expired" }).where(and(
        eq(signingSessionsTable.id, session.id),
        eq(signingSessionsTable.status, session.status),
      ));
      return { ...session, status: "expired" as const };
    } catch {}
  }
  return session;
}

/**
 * GET /api/agents/me/onboarding-status
 * Returns the gate state for the current agent: emailVerified flag plus
 * a snapshot of their primary onboarding signing session (if any).
 */
router.get("/agents/me/onboarding-status", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!AGENT_ROLES.includes(req.user!.role)) {
    res.json({ requiresOnboarding: false, emailVerified: true, contractStatus: "n/a" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id));
  const agent = await loadAgentForUser(req.user!.id, req.user!.role);
  if (!agent) {
    res.json({
      requiresOnboarding: !user?.emailVerified,
      emailVerified: !!user?.emailVerified,
      email: user?.email || null,
      contractStatus: "none",
    });
    return;
  }
  let session = await loadOnboardingSession(agent.id);
  if (session) session = await lazyExpire(session);
  // Enforce admin-sent contract deadlines on every panel navigation: expires
  // past-due sessions and suspends the account when a deadline is missed.
  try { await syncAdminContracts(agent); } catch (err) { console.error("[onboarding-status] admin contract sync:", err); }

  // Authoritative signed detection. An agent counts as signed whenever they
  // have ANY signing_sessions row with status='signed', resolved to the
  // globally-newest signed contract across ALL sessions — the same resolution
  // used by /api/contracts/me, /api/contracts/me/pdf and /api/agents/me. This
  // must NOT key off PDF presence (pdf_object_key/evidence_hash) or
  // agents.contract_url: the regenerate flow legitimately NULLs those cache
  // fields, and clearing them must never make a signed agent look unsigned and
  // re-trigger the onboarding gate/banner. Resolving across all sessions also
  // covers a re-sign that lands on a LATER (non-primary) session, which
  // loadOnboardingSession does not return.
  const newestSigned = await loadNewestSignedContractForAgent(agent.id);

  let contractStatus: "none" | "pending" | "signed" | "expired" | "revoked" = "none";
  if (newestSigned) {
    contractStatus = "signed";
    session = newestSigned.session;
  } else if (session) {
    if (session.status === "signed") contractStatus = "signed";
    else if (session.status === "expired") contractStatus = "expired";
    else if (session.status === "revoked") contractStatus = "revoked";
    else contractStatus = "pending";
  }
  const passwordSet = !!user?.passwordHash;
  res.json({
    requiresOnboarding: !user?.emailVerified || !passwordSet || (contractStatus !== "signed" && contractStatus !== "none"),
    emailVerified: !!user?.emailVerified,
    passwordSet,
    email: user?.email || null,
    contractStatus,
    contractMandatory: contractStatus === "pending" ? isOnboardingContractMandatory(session) : false,
    sessionId: session?.id ?? null,
    expiresAt: session?.expiresAt ?? null,
    templateId: session?.templateId ?? null,
    isPrimaryOnboarding: !!session?.isPrimaryOnboarding,
  });
});

/**
 * POST /api/agents/me/resend-verification — generates a new 6-digit code,
 * invalidates older codes, emails the agent.
 */
router.post("/agents/me/resend-verification", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const ip = getRateLimitIp(req);
  try {
    await rateLimiter.consume(`agent-resend:${ip}`);
    await rateLimiter.consume(`agent-resend:${req.user!.id}`);
  } catch {
    res.status(429).json({ error: "Too many attempts. Please wait before requesting again." });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id));
  if (!user || !user.email) { res.status(404).json({ error: "User not found" }); return; }
  if (user.emailVerified) { res.status(400).json({ error: "Email already verified" }); return; }

  const normalizedEmail = user.email.toLowerCase().trim();
  await db.update(emailVerificationCodesTable)
    .set({ used: true })
    .where(and(eq(emailVerificationCodesTable.email, normalizedEmail), eq(emailVerificationCodesTable.used, false)));

  const code = generateVerificationCode();
  const token = generateOnboardingToken();
  await db.insert(emailVerificationCodesTable).values({
    email: normalizedEmail, code, token, expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  try {
    const email = await buildOnboardingVerificationCodeEmail(user.firstName || "Agent", code, normalizedEmail, token);
    await sendEmail(normalizedEmail, email);
  } catch (err) {
    console.error("[agent-onboarding] resend code email failed:", err);
  }
  await writeAudit({
    userId: req.user!.id,
    action: "agent.email_verification_sent",
    resource: "user",
    resourceId: req.user!.id,
    changes: { resent: true },
    ipAddress: req.ip,
  });
  res.json({ success: true });
});

/**
 * POST /api/agents/me/verify-email — confirms the 6-digit code, flips
 * users.emailVerified=true, refreshes the session payload.
 */
router.post("/agents/me/verify-email", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const { code } = req.body || {};
  if (!code || typeof code !== "string") { res.status(400).json({ error: "Code is required" }); return; }
  const ip = getRateLimitIp(req);
  try {
    await rateLimiter.consume(`agent-verify:${ip}`);
    await rateLimiter.consume(`agent-verify:${req.user!.id}`);
  } catch {
    res.status(429).json({ error: "Too many attempts. Please request a new code." });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id));
  if (!user?.email) { res.status(404).json({ error: "User not found" }); return; }
  if (user.emailVerified) { res.json({ success: true, alreadyVerified: true }); return; }
  const normalizedEmail = user.email.toLowerCase().trim();
  const [record] = await db.select().from(emailVerificationCodesTable).where(and(
    eq(emailVerificationCodesTable.email, normalizedEmail),
    eq(emailVerificationCodesTable.code, code.trim()),
    eq(emailVerificationCodesTable.used, false),
    gt(emailVerificationCodesTable.expiresAt, new Date()),
  ));
  if (!record) { res.status(400).json({ error: "Invalid or expired verification code" }); return; }
  await db.update(emailVerificationCodesTable).set({ used: true }).where(eq(emailVerificationCodesTable.email, normalizedEmail));
  await db.update(usersTable).set({ emailVerified: true, isActive: true }).where(eq(usersTable.id, user.id));
  // Refresh in-memory session user so the next request sees the flag.
  if (req.user) (req.user as any).emailVerified = true;
  await writeAudit({
    userId: user.id, action: "agent.email_verified", resource: "user", resourceId: user.id, ipAddress: req.ip,
  });
  res.json({ success: true });
});

/**
 * POST /api/agents/onboarding/verify-with-link — public, no auth required.
 * Hit when the agent clicks the verify button in their welcome email
 * (`{ token }` body) OR enters their 6-digit code manually on the public
 * onboarding page (`{ email, code }` body). Validates the credential,
 * marks the user verified+active, and creates a logged-in session so the
 * agent can immediately set their password.
 *
 * Returns a uniform error on any failure to prevent account enumeration.
 */
router.post("/agents/onboarding/verify-with-link", async (req: Request, res: Response): Promise<void> => {
  const body = (req.body || {}) as { token?: string; email?: string; code?: string };
  const tokenInput = typeof body.token === "string" ? body.token.trim() : "";
  const emailInput = typeof body.email === "string" ? body.email.toLowerCase().trim() : "";
  const codeInput = typeof body.code === "string" ? body.code.trim() : "";

  if (!tokenInput && !(emailInput && codeInput)) {
    res.status(400).json({ error: "Token or email+code is required" });
    return;
  }

  // This endpoint is intentionally unauthenticated and CSRF-exempt (it is hit
  // before any session/CSRF cookie exists) yet it MINTS a logged-in session.
  // Without an origin check that combination allows login CSRF: a cross-site
  // auto-submitting form could silently bind the victim's browser to the
  // attacker's account. Require a trusted same-site Origin/Referer before
  // doing any work. The legitimate flow always runs from the app's own page,
  // so the header is present and matches.
  if (!isTrustedOrigin(req)) {
    res.status(403).json({ error: "Invalid request origin" });
    return;
  }

  const ip = getRateLimitIp(req);
  try {
    await rateLimiter.consume(`agent-verify-link:${ip}`);
  } catch {
    res.status(429).json({ error: "Too many attempts. Please try again later." });
    return;
  }

  // Uniform error to prevent enumeration of which emails exist / are verified
  // and to avoid leaking which arm (token vs code) failed.
  const INVALID = { status: 400, body: { error: "Invalid or expired link. Request a new code on the verification page." } };

  // Look up the verification record by token first (preferred), then fall
  // back to email+code. ALWAYS require a valid, unused, unexpired record —
  // never bypass on emailVerified=true (that would allow anyone who knows a
  // verified agent's email to mint a session without a credential).
  let record:
    | { id: number; email: string }
    | undefined;
  if (tokenInput) {
    const [r] = await db.select({ id: emailVerificationCodesTable.id, email: emailVerificationCodesTable.email })
      .from(emailVerificationCodesTable)
      .where(and(
        eq(emailVerificationCodesTable.token, tokenInput),
        eq(emailVerificationCodesTable.used, false),
        gt(emailVerificationCodesTable.expiresAt, new Date()),
      ));
    record = r;
  } else {
    const [r] = await db.select({ id: emailVerificationCodesTable.id, email: emailVerificationCodesTable.email })
      .from(emailVerificationCodesTable)
      .where(and(
        eq(emailVerificationCodesTable.email, emailInput),
        eq(emailVerificationCodesTable.code, codeInput),
        eq(emailVerificationCodesTable.used, false),
        gt(emailVerificationCodesTable.expiresAt, new Date()),
      ));
    record = r;
  }
  if (!record) { res.status(INVALID.status).json(INVALID.body); return; }

  // The verification code row stores the lowercase address. Older agent
  // user rows may still have mixed-case emails (created before the
  // normalization fix in agents.ts POST), so look up case-insensitively
  // to keep legacy accounts able to verify.
  const normalizedEmail = record.email;
  const [user] = await db.select().from(usersTable).where(ilike(usersTable.email, normalizedEmail));
  if (!user || !AGENT_ROLES.includes(user.role)) {
    res.status(INVALID.status).json(INVALID.body);
    return;
  }
  // Burn the matched record (and any other unused codes for this email) so
  // it cannot be replayed.
  await db.update(emailVerificationCodesTable).set({ used: true })
    .where(and(eq(emailVerificationCodesTable.email, normalizedEmail), eq(emailVerificationCodesTable.used, false)));
  if (!user.emailVerified || !user.isActive) {
    await db.update(usersTable).set({ emailVerified: true, isActive: true }).where(eq(usersTable.id, user.id));
  }
  const sessionUser: SessionUser = {
    id: user.id,
    replitId: user.replitId || `local-${user.id}`,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    role: user.role,
    avatarUrl: user.avatarUrl,
    language: user.language,
    isActive: true,
    emailVerified: true,
    phone: user.phone,
  };
  const sessionData: SessionData = {
    user: sessionUser,
    access_token: `local-${crypto.randomBytes(16).toString("hex")}`,
  };
  const sid = await createSession(sessionData, user.id);
  res.cookie(SESSION_COOKIE, sid, getSessionCookieOptions(req, SESSION_TTL));
  await writeAudit({
    userId: user.id, action: "agent.email_verified", resource: "user", resourceId: user.id,
    changes: { via: "link" }, ipAddress: req.ip,
  });
  res.json({
    success: true,
    user: sessionUser,
    passwordSet: !!user.passwordHash,
  });
});

/**
 * POST /api/agents/onboarding/resend-public — public, no auth. Lets a user
 * whose token/code expired request a fresh one without first having to log in
 * (which they cannot do because their password isn't set yet). Always returns
 * a generic success response to prevent enumeration; the email is only
 * actually sent when the address belongs to an unverified agent.
 */
router.post("/agents/onboarding/resend-public", async (req: Request, res: Response): Promise<void> => {
  const { email } = (req.body || {}) as { email?: string };
  if (!email || typeof email !== "string") {
    res.status(400).json({ error: "Email is required" });
    return;
  }
  const ip = getRateLimitIp(req);
  const normalizedEmail = email.toLowerCase().trim();
  try {
    await rateLimiter.consume(`agent-resend-pub:${ip}`);
    await rateLimiter.consume(`agent-resend-pub:${normalizedEmail}`);
  } catch {
    res.status(429).json({ error: "Too many attempts. Please wait a few minutes before requesting again." });
    return;
  }
  // Generic success — do not reveal whether the address exists or is verified.
  const GENERIC_OK = { success: true };
  // Case-insensitive — see comment in verify-with-link above.
  const [user] = await db.select().from(usersTable).where(ilike(usersTable.email, normalizedEmail));
  if (!user || !AGENT_ROLES.includes(user.role) || user.emailVerified) {
    res.json(GENERIC_OK);
    return;
  }
  await db.update(emailVerificationCodesTable).set({ used: true })
    .where(and(eq(emailVerificationCodesTable.email, normalizedEmail), eq(emailVerificationCodesTable.used, false)));
  const code = generateVerificationCode();
  const token = generateOnboardingToken();
  await db.insert(emailVerificationCodesTable).values({
    email: normalizedEmail, code, token, expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });
  try {
    const emailContent = await buildOnboardingVerificationCodeEmail(user.firstName || "Agent", code, normalizedEmail, token);
    await sendEmail(normalizedEmail, emailContent);
  } catch (err) {
    console.error("[agent-onboarding] public resend email failed:", err);
  }
  await writeAudit({
    userId: user.id, action: "agent.email_verification_sent", resource: "user", resourceId: user.id,
    changes: { resentPublic: true }, ipAddress: req.ip,
  });
  res.json(GENERIC_OK);
});

/**
 * POST /api/agents/me/set-password — authenticated agent who has not yet set
 * a password chooses one. Refuses to overwrite an existing password (use the
 * standard /auth/set-password reset flow for that).
 */
router.post("/agents/me/set-password", requireAuth, async (req: Request, res: Response): Promise<void> => {
  if (!AGENT_ROLES.includes(req.user!.role)) {
    res.status(403).json({ error: "Only agents may use this endpoint" });
    return;
  }
  const ip = getRateLimitIp(req);
  try {
    await rateLimiter.consume(`agent-setpw:${ip}`);
    await rateLimiter.consume(`agent-setpw:${req.user!.id}`);
  } catch {
    res.status(429).json({ error: "Too many attempts. Please wait before trying again." });
    return;
  }
  const { password } = req.body || {};
  const pwd = validatePassword(password);
  if (!pwd.ok) { res.status(400).json({ error: pwd.message }); return; }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (!user.emailVerified) { res.status(400).json({ error: "Email must be verified first" }); return; }
  if (user.passwordHash) {
    res.status(400).json({ error: "Password already set. Use the password reset flow to change it." });
    return;
  }
  const hash = await bcrypt.hash(pwd.value, 10);
  await db.update(usersTable).set({ passwordHash: hash, isActive: true, passwordResetToken: null, passwordResetExpires: null }).where(eq(usersTable.id, user.id));
  // Setting a password is a credential change: revoke every other session for
  // this user so a previously-stolen cookie cannot survive it. Keep the
  // caller's current session so the agent stays logged in to finish onboarding.
  await deleteSessionsForUser(user.id, getSessionId(req));
  await writeAudit({
    userId: user.id, action: "auth.set_password", resource: "user", resourceId: user.id,
    changes: { via: "agent_onboarding" }, ipAddress: req.ip,
  });
  res.json({ success: true });
});

/**
 * GET /api/contracts/me — primary onboarding session info plus rendered
 * preview HTML for the review step. Returns the signed PDF link if signed.
 */
router.get("/contracts/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const agent = await loadAgentForUser(req.user!.id, req.user!.role);
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }
  let session = await loadOnboardingSession(agent.id);
  if (!session) { res.json({ data: null }); return; }
  session = await lazyExpire(session);

  // Read-time resolution: if the agent has re-signed via a resend, the newest
  // signed_contract lives on a LATER session (often isPrimaryOnboarding=false)
  // that loadOnboardingSession does not return. loadNewestSignedContractForAgent
  // returns the agent's globally-newest signed contract (ORDER BY signed_at DESC,
  // id DESC over ALL sessions, including the primary one). So when the primary
  // onboarding session is signed and the newest signed contract belongs to a
  // DIFFERENT session, that newer session is by definition the authoritative one
  // — surface it. Using session identity (rather than a timestamp `>` compare)
  // keeps this consistent with /contracts/me/pdf and /agents/me, which both stream
  // the same globally-newest record (avoids an equal-timestamp tie-break skew).
  const newest = await loadNewestSignedContractForAgent(agent.id);
  if (session.status === "signed" && newest && newest.session.id !== session.id) {
    session = newest.session;
  }

  const [template] = await db.select().from(contractTemplatesTable).where(eq(contractTemplatesTable.id, session.templateId));
  let signedContract: typeof signedContractsTable.$inferSelect | null = null;
  if (session.status === "signed") {
    const [s] = await db.select().from(signedContractsTable).where(eq(signedContractsTable.signingSessionId, session.id));
    signedContract = s || null;
  }
  let previewHtml: string | null = null;
  if (template && (session.status === "review_pending" || session.status === "intake_pending")) {
    try {
      const { renderTemplate, buildAgentContext, cleanupSignatureImages, documentShell } = await import("../lib/contractRenderer");
      const ctx = buildAgentContext(agent, (session.intakeData as any) || null, {
        signerEmail: session.signerEmail, signerName: session.signerName || undefined,
      });
      const rendered = renderTemplate(template.bodyHtml, ctx);
      // Strip empty <img src=""> placeholders left by the unfilled
      // {{signature}} / {{main_agency_signature}} variables. Without this
      // the agent dashboard preview shows broken-image icons inside the
      // signature boxes before signing. Public signing routes already do
      // this; we mirror their behavior here. Empty placeholderText keeps
      // the signature boxes visually blank in the pre-sign preview.
      // Wrap in the shared documentShell() so the preview carries the same
      // template <style> blocks + A4 page framing the final signed PDF uses,
      // rendered by the client in a sandboxed iframe (mirrors public signing).
      previewHtml = documentShell(cleanupSignatureImages(rendered, ""));
    } catch (err) {
      console.error("[contracts/me] preview render failed:", err);
    }
  }
  res.json({
    data: {
      sessionId: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      isPrimaryOnboarding: session.isPrimaryOnboarding,
      signerEmail: session.signerEmail,
      signerName: session.signerName,
      mode: session.mode,
      intakeData: session.intakeData || null,
      // Defaults from the agent record so the intake form opens pre-filled. The
      // client seeds each field as: saved intake answer ?? agent default.
      intakeDefaults: agentIntakeDefaults(agent),
      template: template ? {
        id: template.id,
        name: template.name,
        language: template.language,
        entityType: template.entityType,
        intakeSchema: template.intakeSchema || null,
      } : null,
      previewHtml,
      // Agent-scoped download endpoint — the admin /api/contracts/signed/:id/pdf
      // requires contracts.view (manager+ only), which agents lack.
      signedPdfUrl: signedContract ? `/api/contracts/me/pdf` : null,
      signedAt: signedContract?.signedAt ?? null,
    },
  });
});

/**
 * POST /api/contracts/me/intake — the authenticated agent submits their
 * pre-contract "Agency Information" answers for their primary onboarding
 * session and advances it from intake_pending → review_pending. The email is
 * always forced to the agent's own account address (any client-supplied email
 * is ignored), and there is NO separate email verification step. Operates only
 * on the agent's own session.
 */
router.post("/contracts/me/intake", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const agent = await loadAgentForUser(req.user!.id, req.user!.role);
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }
  let session = await loadOnboardingSession(agent.id);
  if (!session) { res.status(404).json({ error: "No onboarding session found" }); return; }
  session = await lazyExpire(session);
  if (session.status === "signed" || session.status === "revoked") {
    res.status(409).json({ error: "Session already finalized" }); return;
  }
  if (session.status === "expired") {
    res.status(410).json({ error: "This contract link has expired", code: "expired" }); return;
  }

  const intakeRaw = req.body?.intake;
  if (!intakeRaw || typeof intakeRaw !== "object" || Array.isArray(intakeRaw)) {
    res.status(400).json({ error: "intake object is required" }); return;
  }
  // Cap field count and value length to prevent abuse (mirrors public intake).
  const cleaned: Record<string, string> = {};
  let count = 0;
  for (const [k, v] of Object.entries(intakeRaw)) {
    if (count >= 50) break;
    const key = String(k).slice(0, 80);
    const val = v == null ? "" : String(v).slice(0, 2000);
    cleaned[key] = val;
    count++;
  }
  // Force the contact email to the agent's own account address — agents never
  // verify or edit it in this flow.
  const ownEmail = (session.signerEmail || agent.email || "").toLowerCase().trim();
  if (ownEmail) {
    for (const k of Object.keys(cleaned)) {
      if (/email/i.test(k)) cleaned[k] = ownEmail;
    }
  }

  await db.update(signingSessionsTable).set({
    intakeData: cleaned,
    status: "review_pending",
    signerName: cleaned.signerName || cleaned.fullName || cleaned.contactName || session.signerName,
  }).where(eq(signingSessionsTable.id, session.id));

  await writeAudit({
    userId: req.user!.id,
    action: "agent.contract_intake_submitted",
    resource: "signing_session",
    resourceId: session.id,
    changes: { agentId: agent.id, fields: Object.keys(cleaned) },
    ipAddress: req.ip,
  });
  res.json({ data: { success: true } });
});

/**
 * GET /api/contracts/me/pdf — stream the signed PDF for the authenticated
 * agent's own signed contract. Authorisation is by ownership: the contract's
 * agentId must match the agent record bound to the current user. This is
 * the agent-side counterpart of the admin-only /api/contracts/signed/:id/pdf.
 */
router.get("/contracts/me/pdf", requireAuth, async (req: Request, res: Response): Promise<void> => {
  try {
    const agent = await loadAgentForUser(req.user!.id, req.user!.role);
    if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }
    // Stream the agent's NEWEST signed contract (across all sessions), not just
    // the primary onboarding session's — a resend re-sign produces a newer
    // signed_contract on a later session, and that is the authoritative one.
    const newest = await loadNewestSignedContractForAgent(agent.id);
    if (!newest) {
      res.status(404).json({ error: "Signed contract not available" });
      return;
    }
    const signed = newest.signed;
    if (signed.agentId !== agent.id) { res.status(403).json({ error: "Forbidden" }); return; }
    const pdfKey = signed.pdfObjectKey;
    if (!pdfKey) {
      // PDF not yet rendered. The signed-contract delivery worker generates it
      // off the request path (no Chromium here — synchronous render was the
      // autoscale OOM root cause). Tell the client to retry shortly.
      res.setHeader("Retry-After", "30");
      res.status(202).json({ status: "pending", message: "PDF is being generated. Please try again in a moment.", retryAfter: 30 });
      return;
    }
    const { ObjectStorageService } = await import("../lib/objectStorage");
    const svc = new ObjectStorageService();
    let normalizedPath = pdfKey;
    if (normalizedPath.startsWith("/objects/")) normalizedPath = normalizedPath.slice("/objects/".length);
    if (normalizedPath.startsWith("objects/")) normalizedPath = normalizedPath.slice("objects/".length);
    const file = await svc.getObjectEntityFile(`/objects/${normalizedPath}`);
    // Same contractNumber() source as the document body's {{contract_number}}
    // (e.g. FAS-2026-00025_signed.pdf), shared with the admin + public download
    // paths. Fallback order (signedAt -> createdAt) is identical everywhere so
    // the filename's year can never drift between routes for the same contract.
    const filename = signedContractFilename(
      signed.signingSessionId,
      signed.signedAt ? new Date(signed.signedAt) : (signed.createdAt ? new Date(signed.createdAt) : undefined),
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    await svc.streamObjectToResponse(req, res, file, {
      contentType: "application/pdf",
      cacheControl: "private, no-store",
    });
  } catch (err) {
    console.error("[contracts/me/pdf]:", err);
    if (!res.headersSent) res.status(500).json({ error: "Failed to download signed contract" });
  }
});

/**
 * POST /api/contracts/me/sign — agent draws their signature in the dashboard
 * and finalizes the primary onboarding session (no token).
 */
router.post("/contracts/me/sign", signBodyParser, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const signStart = Date.now();
  console.log(`[contracts/sign] start user=${req.user!.id} rss=${Math.round(process.memoryUsage().rss / (1024 * 1024))}MB`);
  const agent = await loadAgentForUser(req.user!.id, req.user!.role);
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }
  const session = await loadOnboardingSession(agent.id);
  if (!session) { res.status(404).json({ error: "No onboarding session found" }); return; }
  // The agency-information intake must be completed first: a session that still
  // carries intake_pending may not be signed (otherwise a direct API call could
  // skip the "Your Details" step the template requires).
  if (session.status === "intake_pending") {
    res.status(409).json({ error: "Please complete the agency information step before signing", code: "intake_required" }); return;
  }

  const { signatureImagePngBase64, signerName } = req.body || {};
  if (!signatureImagePngBase64 || typeof signatureImagePngBase64 !== "string") {
    res.status(400).json({ error: "signatureImagePngBase64 is required" }); return;
  }
  if (signatureImagePngBase64.length > 2_800_000) {
    res.status(413).json({ error: "Signature image too large" }); return;
  }
  const signerIp = getClientIp(req);
  const ua = (req.headers["user-agent"] as string) || null;

  let result;
  try {
    result = await finalizeSign({
      sessionId: session.id,
      signatureImagePngBase64,
      signerName: signerName ? String(signerName) : (session.signerName || null),
      signerIp,
      signerUserAgent: ua,
      triggerUserId: req.user!.id,
    });
  } catch (err) {
    // Without this, an unexpected throw in finalizeSign would become an
    // unhandled rejection: the request hangs and the edge proxy eventually
    // returns its own opaque "403 Forbidden" HTML page instead of a usable
    // error. Convert it into a clean JSON 500 so the agent sees a real message.
    const errMs = Date.now() - signStart;
    const errRss = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.error(`[contracts/sign] error user=${req.user!.id} ms=${errMs} rss=${errRss}MB`, err);
    res.status(500).json({ error: "Sözleşme imzalanamadı. Lütfen tekrar deneyin." });
    return;
  }
  if (!result.ok) {
    const rejMs = Date.now() - signStart;
    const rejRss = Math.round(process.memoryUsage().rss / (1024 * 1024));
    console.log(`[contracts/sign] rejected user=${req.user!.id} status=${result.status} ms=${rejMs} rss=${rejRss}MB`);
    res.status(result.status).json({ error: result.error }); return;
  }
  const doneMs = Date.now() - signStart;
  const doneRss = Math.round(process.memoryUsage().rss / (1024 * 1024));
  console.log(`[contracts/sign] done user=${req.user!.id} signedContractId=${result.signedContractId} ms=${doneMs} rss=${doneRss}MB`);
  res.json({ data: { signedContractId: result.signedContractId } });
});

const ADMIN_PENDING_STATUSES = ["review_pending", "intake_pending"];

/**
 * Enforce admin-sent (non-onboarding) contract deadlines for an agent. Expires
 * any past-due unsigned session and, when a deadline was missed, suspends the
 * agent's user account (isActive=false) — requireAuth then blocks them until an
 * administrator reactivates the account. Returns the sessions still pending
 * (unsigned and not yet expired). Error-safe so it never breaks its callers.
 */
async function syncAdminContracts(agent: typeof agentsTable.$inferSelect) {
  // agent_staff and sub_agent users should never receive admin-driven contracts
  if (agent.userId) {
    const [linkedUser] = await db.select({ role: usersTable.role }).from(usersTable).where(eq(usersTable.id, agent.userId));
    if (linkedUser && (linkedUser.role === "agent_staff" || linkedUser.role === "sub_agent")) {
      return [];
    }
  }
  const rows = await db.select().from(signingSessionsTable).where(and(
    eq(signingSessionsTable.agentId, agent.id),
    eq(signingSessionsTable.isPrimaryOnboarding, false),
    eq(signingSessionsTable.mode, "admin_driven"),
  ));
  const now = Date.now();
  let missedDeadline = false;
  const pending: typeof rows = [];
  for (const s of rows) {
    if (!ADMIN_PENDING_STATUSES.includes(s.status)) continue;
    if (new Date(s.expiresAt).getTime() < now) {
      // Conditionally expire only if still in the same pending status; if the
      // session was signed concurrently the predicate won't match and no row is
      // returned, so we must NOT count it as a missed deadline (avoids
      // suspending an account whose contract was actually signed in time).
      try {
        const expired = await db.update(signingSessionsTable)
          .set({ status: "expired" })
          .where(and(
            eq(signingSessionsTable.id, s.id),
            eq(signingSessionsTable.status, s.status),
          ))
          .returning({ id: signingSessionsTable.id });
        if (expired.length > 0) missedDeadline = true;
      } catch {}
    } else {
      pending.push(s);
    }
  }
  if (missedDeadline && agent.userId) {
    try {
      await db.update(usersTable).set({ isActive: false }).where(eq(usersTable.id, agent.userId));
    } catch {}
  }
  return pending;
}

/**
 * GET /api/contracts/me/pending — admin-sent (non-onboarding) contracts the
 * authenticated agent still needs to sign, each with its signing deadline.
 * Enforces the deadline (suspends the account on miss) as a side effect.
 */
router.get("/contracts/me/pending", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const agent = await loadAgentForUser(req.user!.id, req.user!.role);
  if (!agent) { res.json({ data: [] }); return; }
  const pending = await syncAdminContracts(agent);
  const data: Array<{ sessionId: number; status: string; expiresAt: Date; templateName: string | null }> = [];
  for (const s of pending) {
    const [tpl] = await db.select({ name: contractTemplatesTable.name })
      .from(contractTemplatesTable).where(eq(contractTemplatesTable.id, s.templateId));
    data.push({ sessionId: s.id, status: s.status, expiresAt: s.expiresAt, templateName: tpl?.name ?? null });
  }
  res.json({ data });
});

/**
 * GET /api/contracts/me/session/:id — agent-scoped detail (with rendered
 * preview HTML) for one of the agent's own non-onboarding signing sessions.
 */
router.get("/contracts/me/session/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const agent = await loadAgentForUser(req.user!.id, req.user!.role);
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }
  const sid = parseInt(String(req.params.id), 10);
  if (!sid) { res.status(400).json({ error: "Invalid session id" }); return; }
  let [session] = await db.select().from(signingSessionsTable).where(eq(signingSessionsTable.id, sid));
  if (!session || session.agentId !== agent.id || session.isPrimaryOnboarding) {
    res.status(404).json({ error: "Contract not found" }); return;
  }
  session = await lazyExpire(session);
  const [template] = await db.select().from(contractTemplatesTable).where(eq(contractTemplatesTable.id, session.templateId));
  let previewHtml: string | null = null;
  if (template && (session.status === "review_pending" || session.status === "intake_pending")) {
    try {
      const { renderTemplate, buildAgentContext, cleanupSignatureImages, documentShell } = await import("../lib/contractRenderer");
      const ctx = buildAgentContext(agent, (session.intakeData as any) || null, {
        signerEmail: session.signerEmail, signerName: session.signerName || undefined,
      });
      previewHtml = documentShell(cleanupSignatureImages(renderTemplate(template.bodyHtml, ctx), ""));
    } catch (err) {
      console.error("[contracts/me/session] preview render failed:", err);
    }
  }
  res.json({
    data: {
      sessionId: session.id,
      status: session.status,
      expiresAt: session.expiresAt,
      isPrimaryOnboarding: session.isPrimaryOnboarding,
      signerEmail: session.signerEmail,
      signerName: session.signerName,
      template: template ? { id: template.id, name: template.name, language: template.language, entityType: template.entityType } : null,
      previewHtml,
    },
  });
});

/**
 * POST /api/contracts/me/session/:id/sign — agent draws their signature in the
 * dashboard and finalizes one of their own non-onboarding signing sessions.
 */
router.post("/contracts/me/session/:id/sign", signBodyParser, requireAuth, async (req: Request, res: Response): Promise<void> => {
  const agent = await loadAgentForUser(req.user!.id, req.user!.role);
  if (!agent) { res.status(404).json({ error: "Agent profile not found" }); return; }
  const sid = parseInt(String(req.params.id), 10);
  if (!sid) { res.status(400).json({ error: "Invalid session id" }); return; }
  const [session] = await db.select().from(signingSessionsTable).where(eq(signingSessionsTable.id, sid));
  if (!session || session.agentId !== agent.id || session.isPrimaryOnboarding) {
    res.status(404).json({ error: "Contract not found" }); return;
  }
  const { signatureImagePngBase64, signerName } = req.body || {};
  if (!signatureImagePngBase64 || typeof signatureImagePngBase64 !== "string") {
    res.status(400).json({ error: "signatureImagePngBase64 is required" }); return;
  }
  if (signatureImagePngBase64.length > 2_800_000) {
    res.status(413).json({ error: "Signature image too large" }); return;
  }
  const signerIp = getClientIp(req);
  const ua = (req.headers["user-agent"] as string) || null;
  let result;
  try {
    result = await finalizeSign({
      sessionId: session.id,
      signatureImagePngBase64,
      signerName: signerName ? String(signerName) : (session.signerName || null),
      signerIp,
      signerUserAgent: ua,
      triggerUserId: req.user!.id,
    });
  } catch (err) {
    // Without this, an unexpected throw in finalizeSign would become an
    // unhandled rejection: the request hangs and the edge proxy eventually
    // returns its own opaque "403 Forbidden" HTML page instead of a usable
    // error. Convert it into a clean JSON 500 so the agent sees a real message.
    console.error("[contracts/sign] finalizeSign threw:", err);
    res.status(500).json({ error: "Sözleşme imzalanamadı. Lütfen tekrar deneyin." });
    return;
  }
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.json({ data: { signedContractId: result.signedContractId } });
});

/**
 * POST /api/contracts/agent/:agentId/resend-onboarding — admin reissues a
 * primary onboarding session for an agent whose previous session expired or
 * was revoked. Reuses the originally assigned template if any.
 */
router.post("/contracts/agent/:agentId/resend-onboarding", requireAuth, requireRole(...MANAGER_ROLES), async (req: Request, res: Response): Promise<void> => {
  const agentId = parseInt(String(req.params.agentId), 10);
  if (!agentId) { res.status(400).json({ error: "Invalid agent id" }); return; }
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.id, agentId));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  if (!agent.email) { res.status(400).json({ error: "Agent has no email on file" }); return; }

  // Pick template: explicit body, then agent's assignment, then strict (lang, entityType).
  let templateId: number | null = req.body?.templateId ? parseInt(req.body.templateId, 10) : null;
  if (!templateId && agent.assignedContractTemplateId) templateId = agent.assignedContractTemplateId;
  let template: typeof contractTemplatesTable.$inferSelect | undefined;
  if (templateId) {
    [template] = await db.select().from(contractTemplatesTable).where(eq(contractTemplatesTable.id, templateId));
  }
  if (!template) {
    const lang = agent.preferredContractLanguage || "en";
    const entityType = agent.entityType === "individual" ? "individual" : "company";
    [template] = await db.select().from(contractTemplatesTable)
      .where(and(eq(contractTemplatesTable.language, lang), eq(contractTemplatesTable.entityType, entityType), eq(contractTemplatesTable.isActive, true)))
      .orderBy(desc(contractTemplatesTable.version)).limit(1);
  }
  if (!template) { res.status(404).json({ error: "No matching contract template found" }); return; }

  const templateBrandingSnapshot = await resolveContractTemplateBranding(template);
  if (!hasContractCompanySignature(templateBrandingSnapshot)) {
    res.status(409).json({
      error: "Selected contract template has no official company signature. Configure one in Contract Brand Profiles before resending.",
    });
    return;
  }

  const [settings] = await db.select({ days: settingsTable.defaultSigningDeadlineDays }).from(settingsTable);
  const days = Math.max(1, Math.min(365, settings?.days || 14));
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const { rawToken, tokenHash } = createSigningToken();
  const signerName = `${agent.firstName || ""} ${agent.lastName || ""}`.trim() || agent.businessName || null;
  const [session] = await db.insert(signingSessionsTable).values({
    templateId: template.id,
    templateVersionSnapshot: template.version,
    templateNameSnapshot: template.name,
    templateLanguageSnapshot: template.language,
    templateEntityTypeSnapshot: template.entityType,
    templateBodyHtmlSnapshot: template.bodyHtml,
    templateIntakeSchemaSnapshot: template.intakeSchema,
    templateSigningPageConfigSnapshot: templateBrandingSnapshot,
    agentId: agent.id,
    tokenHash,
    mode: "admin_driven",
    status: "review_pending",
    intakeData: null,
    signerEmail: agent.email,
    signerName,
    expiresAt,
    isPrimaryOnboarding: true,
    createdByUserId: req.user!.id,
  }).returning();

  // Persist the assigned template id on the agent for future re-issues.
  if (agent.assignedContractTemplateId !== template.id) {
    await db.update(agentsTable).set({ assignedContractTemplateId: template.id }).where(eq(agentsTable.id, agent.id));
  }

  const baseUrl = getAppBaseUrl();
  try {
    const email = await buildContractSignRequestEmail({
      signerName,
      agentName: agent.businessName || null,
      templateName: template.name,
      signUrl: `${baseUrl}/agent`,
      expiresAt,
      selfFill: false,
    });
    await sendEmail(agent.email, email);
  } catch (err) {
    console.error("[agent-onboarding] resend email failed:", err);
  }
  await writeAudit({
    userId: req.user!.id,
    action: "agent.contract_resent_after_expiry",
    resource: "signing_session",
    resourceId: session.id,
    changes: { agentId: agent.id, templateId: template.id, expiresAt: expiresAt.toISOString() },
    ipAddress: req.ip,
  });
  res.status(201).json({ data: { sessionId: session.id, expiresAt, signUrlIfNeeded: `${baseUrl}/sign/${rawToken}` } });
});

export default router;

// ————————————————————————————————————————————————————————————————————————————
// Helpers exported for the gate middleware in routes/index.ts and the agents
// POST handler that creates the initial verification code + signing session.
// ————————————————————————————————————————————————————————————————————————————

export const ONBOARDING_HELPERS = {
  generateVerificationCode,
  generateOnboardingToken,
  buildOnboardingVerificationCodeEmail,
  loadAgentForUser,
  loadOnboardingSession,
  lazyExpire,
  isOnboardingContractMandatory,
};
