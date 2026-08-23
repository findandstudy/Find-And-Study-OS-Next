import { Router, type IRouter, type Request, type Response } from "express";
import { getRateLimitIp } from "../lib/clientIp";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { z } from "zod";
import { toLatinUpper, normalizePhoneField } from "../lib/textNormalize";
import { db, usersTable, emailVerificationCodesTable, studentsTable, leadsTable } from "@workspace/db";
import { getEffectivePermissionSet } from "../lib/permissions";
import { eq, and, gt, sql, isNotNull, isNull } from "drizzle-orm";
import { sendEmail } from "../lib/email";
import { directOrigin } from "../lib/originHelper";
import { applyLeadAssignmentRules } from "../lib/leadAssignment";
import { toE164 } from "../lib/inbox/phone";
import {
  clearSession,
  getSession,
  getSessionId,
  createSession,
  deleteSessionsForUser,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
  type SessionUser,
} from "../lib/replitAuth";
import { getSessionCookieOptions } from "../lib/cookieOptions";
import { PasswordSchema } from "../lib/passwordPolicy";
import { logAudit } from "../lib/auth";
import { validate, getValidated } from "../middlewares/validate";
import { consumeEmailVerificationToken, issueEmailVerificationToken } from "../lib/emailVerificationToken";

const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

import { RateLimiterPostgres } from "rate-limiter-flexible";
import { pool } from "@workspace/db";

const router: IRouter = Router();

const rateLimiter = new RateLimiterPostgres({
  storeClient: pool,
  storeType: "pool",
  tableName: "rate_limits",
  points: 5,
  duration: 900,
});

// Login brute-force protection: 5 failed attempts per 15 minutes per IP and
// per email. Successful logins reset both counters so a legitimate user is
// never locked out of their own account by their own activity.
const loginRateLimiter = new RateLimiterPostgres({
  storeClient: pool,
  storeType: "pool",
  tableName: "rate_limits",
  keyPrefix: "login",
  points: 5,
  duration: 900,
});

function setSessionCookie(req: Request, res: Response, sid: string) {
  res.cookie(SESSION_COOKIE, sid, getSessionCookieOptions(req, SESSION_TTL));
}

function buildSessionUser(user: Record<string, unknown>): SessionUser {
  const result: SessionUser = {
    id: user.id as number,
    replitId: (user.replitId as string) || `local-${user.id}`,
    email: user.email as string | null,
    firstName: user.firstName as string | null,
    lastName: user.lastName as string | null,
    role: user.role as string,
    avatarUrl: user.avatarUrl as string | null,
    language: user.language as string,
    isActive: user.isActive as boolean,
    emailVerified: user.emailVerified as boolean,
    phone: user.phone as string | null,
  };
  // Emit effective permissions for ALL roles (staff, consultant, agent_staff, ...) so the
  // frontend sidebar can gate menus. authMiddleware populates user.agentStaffPermissions
  // from the role's effective permission set. Admins rely on isAdmin instead.
  result.agentStaffPermissions = Array.isArray(user.agentStaffPermissions)
    ? (user.agentStaffPermissions as string[])
    : [];
  return result;
}

function generateVerificationCode(): string {
  return crypto.randomInt(100000, 999999).toString();
}

function buildVerificationCodeEmail(firstName: string, code: string): { subject: string; html: string; text: string } {
  const subject = "Your Verification Code — Find And Study OS";
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1);">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px;text-align:center;">
      <h1 style="margin:0;color:#fff;font-size:24px;">Find And Study OS</h1>
      <p style="margin:8px 0 0;color:rgba(255,255,255,.8);font-size:14px;">Email Verification</p>
    </div>
    <div style="padding:32px;">
      <h2 style="margin:0 0 16px;color:#111827;font-size:20px;">Verify Your Email</h2>
      <p style="margin:0 0 24px;color:#374151;font-size:15px;line-height:1.6;">
        Hi ${firstName}, use the code below to verify your email address. This code expires in 15 minutes.
      </p>
      <div style="text-align:center;margin:0 0 24px;">
        <div style="display:inline-block;background:#f0f0ff;border:2px solid #6366f1;border-radius:12px;padding:16px 32px;letter-spacing:8px;font-size:32px;font-weight:700;color:#6366f1;">${code}</div>
      </div>
      <p style="margin:0 0 8px;color:#6b7280;font-size:13px;text-align:center;">
        If you did not create an account, you can safely ignore this email.
      </p>
    </div>
  </div>
</body>
</html>`;
  const text = `Hi ${firstName},\n\nYour verification code is: ${code}\n\nThis code expires in 15 minutes.\nIf you did not create an account, you can safely ignore this email.`;
  return { subject, html, text };
}

router.get("/auth/me", async (req: Request, res: Response) => {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  // authMiddleware has already refreshed the user row and effective permission
  // context for this request. Rebuilding the public shape from that value avoids
  // a second users-table lookup on every /auth/me poll.
  const userData = buildSessionUser(req.user as unknown as Record<string, unknown>);

  const sid = req.cookies?.sid;
  let isImpersonating = false;
  let originalUserId: number | null = null;
  if (sid) {
    const sess = await getSession(sid);
    const origSid = sess?.originalSid;
    if (origSid) {
      isImpersonating = true;
      try {
        const origSess = await getSession(origSid);
        if (origSess?.user?.id) originalUserId = origSess.user.id;
      } catch {}
    }
  }

  const permissions = Array.from(
    await getEffectivePermissionSet(req.user)
  );

  res.json({ ...userData, permissions, isImpersonating, originalUserId });
});

router.post("/auth/login", validate({ body: loginBodySchema }), async (req: Request, res: Response) => {
  try {
    const { email: normalizedEmail, password } = getValidated<{ body: typeof loginBodySchema }>(req).body;
    const ip = getRateLimitIp(req);
    const ipKey = `ip:${ip}`;
    const emailKey = `email:${normalizedEmail}`;

    try {
      await loginRateLimiter.consume(ipKey);
      await loginRateLimiter.consume(emailKey);
    } catch {
      res.status(429).json({ error: "Too many login attempts. Please try again in a few minutes." });
      return;
    }

    const maskedEmail = normalizedEmail.replace(/(.{2}).*(@.*)/, "$1***$2");
    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail));
    if (!user || !user.passwordHash) {
      logAudit(null, "auth.login.failure", "user", undefined, { email: maskedEmail, reason: "no_user_or_no_password" }, ip);
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      logAudit(user.id, "auth.login.failure", "user", user.id, { email: maskedEmail, reason: "bad_password" }, ip);
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }

    if (!user.isActive) {
      const isPublicApplyPendingVerification = user.createdFromSource === "public_apply" && !user.emailVerified && user.passwordHash;
      if (!isPublicApplyPendingVerification) {
        logAudit(user.id, "auth.login.failure", "user", user.id, { email: maskedEmail, reason: "deactivated" }, ip);
        res.status(403).json({ error: "Your account has been deactivated. Please contact an administrator." });
        return;
      }
    }

    const sessionUser = buildSessionUser(user);
    const sessionData: SessionData = {
      user: sessionUser,
      access_token: `local-${crypto.randomBytes(16).toString("hex")}`,
    };

    const sid = await createSession(sessionData, user.id);
    setSessionCookie(req, res, sid);
    // Reset both buckets on successful login so legitimate users are never
    // locked out by their own past failed attempts.
    try {
      await Promise.all([
        loginRateLimiter.delete(ipKey),
        loginRateLimiter.delete(emailKey),
      ]);
    } catch (err) {
      console.error("[auth/login] failed to reset rate-limit buckets:", err);
    }
    logAudit(user.id, "auth.login.success", "user", user.id, { email: maskedEmail }, ip);
    const loginPermissions = Array.from(
      await getEffectivePermissionSet({ id: sessionUser.id, role: sessionUser.role })
    );
    res.json({ user: { ...sessionUser, permissions: loginPermissions } });
  } catch (err) {
    console.error("[auth/login] error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Server is temporarily unavailable. Please try again in a moment." });
    }
  }
});

router.post("/auth/register", async (req: Request, res: Response) => {
  const { email, password, firstName, lastName, phone } = req.body;

  if (!email || !password || !firstName || !lastName) {
    res.status(400).json({ error: "All fields are required" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const ip = getRateLimitIp(req);
  try {
    await rateLimiter.consume(`register:${ip}`);
  } catch {
    res.status(429).json({ error: "Too many registration attempts. Please try again later." });
    return;
  }

  const pwdResult = PasswordSchema.safeParse(password);
  if (!pwdResult.success) {
    res.status(400).json({ error: pwdResult.error.errors[0]?.message || "Invalid password" });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail));
  if (existing) {
    if (existing.role !== "student") {
      res.status(409).json({ error: "This email is already in use by a staff/admin account" });
      return;
    }

    const [archivedStudent] = await db.select().from(studentsTable).where(and(eq(studentsTable.userId, existing.id), isNotNull(studentsTable.deletedAt)));
    if (archivedStudent) {
      const hash = await bcrypt.hash(password, 10);
      await db.update(usersTable).set({ passwordHash: hash, isActive: false, emailVerified: false, firstName: toLatinUpper(firstName.trim()), lastName: toLatinUpper(lastName.trim()), phone: phone ? normalizePhoneField(phone) : null }).where(eq(usersTable.id, existing.id));
      await db.update(studentsTable).set({ deletedAt: null }).where(eq(studentsTable.id, archivedStudent.id));

      const code = generateVerificationCode();
      await db.insert(emailVerificationCodesTable).values({ email: normalizedEmail, code, expiresAt: new Date(Date.now() + 15 * 60 * 1000) });
      console.log(`[EMAIL VERIFICATION] Archived student restored, code sent to ${normalizedEmail.replace(/(.{2}).*(@.*)/, "$1***$2")}`);
      try {
        const emailContent = buildVerificationCodeEmail(firstName.trim(), code);
        await sendEmail(normalizedEmail, emailContent);
      } catch (err) {
        console.error("[EMAIL VERIFICATION] Failed to send verification email:", err);
      }
      res.status(201).json({ message: "Account restored. Please verify your email.", requiresVerification: true, email: normalizedEmail });
      return;
    }

    res.status(409).json({ error: "An account with this email already exists" });
    return;
  }

  const [archivedStudentByEmail] = await db.select().from(studentsTable).where(and(eq(studentsTable.email, normalizedEmail), isNotNull(studentsTable.deletedAt)));

  const hash = await bcrypt.hash(password, 10);
  const [user] = await db.insert(usersTable).values({
    email: normalizedEmail,
    firstName: toLatinUpper(firstName.trim()),
    lastName: toLatinUpper(lastName.trim()),
    phone: phone ? normalizePhoneField(phone) : null,
    passwordHash: hash,
    role: "student",
    isActive: false,
    emailVerified: false,
    language: "en",
  }).returning();

  if (archivedStudentByEmail) {
    await db.update(studentsTable).set({ deletedAt: null, userId: user.id }).where(eq(studentsTable.id, archivedStudentByEmail.id));
    console.log(`[AUTH REGISTER] Restored archived student #${archivedStudentByEmail.id} for new user #${user.id}`);
  }

  const code = generateVerificationCode();
  await db.insert(emailVerificationCodesTable).values({
    email: normalizedEmail,
    code,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });

  console.log(`[EMAIL VERIFICATION] Code sent to ${normalizedEmail.replace(/(.{2}).*(@.*)/, "$1***$2")}`);

  try {
    const emailContent = buildVerificationCodeEmail(firstName.trim(), code);
    await sendEmail(normalizedEmail, emailContent);
  } catch (err) {
    console.error("[EMAIL VERIFICATION] Failed to send verification email:", err);
  }

  res.status(201).json({
    message: "Account created. Please verify your email.",
    requiresVerification: true,
    email: normalizedEmail,
  });
});

router.post("/auth/verify-email", async (req: Request, res: Response) => {
  const { email, code } = req.body;
  if (!email || !code) {
    res.status(400).json({ error: "Email and verification code are required" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const ip = getRateLimitIp(req);
  try {
    await rateLimiter.consume(`verify:${ip}`);
    await rateLimiter.consume(`verify:${normalizedEmail}`);
  } catch {
    res.status(429).json({ error: "Too many verification attempts. Please request a new code." });
    return;
  }

  const [verificationRecord] = await db
    .select()
    .from(emailVerificationCodesTable)
    .where(
      and(
        eq(emailVerificationCodesTable.email, normalizedEmail),
        eq(emailVerificationCodesTable.code, code.trim()),
        eq(emailVerificationCodesTable.used, false),
        gt(emailVerificationCodesTable.expiresAt, new Date()),
      )
    );

  if (!verificationRecord) {
    res.status(400).json({ error: "Invalid or expired verification code" });
    return;
  }

  await db
    .update(emailVerificationCodesTable)
    .set({ used: true })
    .where(eq(emailVerificationCodesTable.email, normalizedEmail));

  const [user] = await db
    .update(usersTable)
    .set({ emailVerified: true, isActive: true })
    .where(eq(usersTable.email, normalizedEmail))
    .returning();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Create a CRM Lead so the staff can see this newly-confirmed registration
  // in the leads list. Skip if the user already has a non-deleted lead with
  // the same email (e.g. they came in through a different funnel first).
  if (user.role === "student" && user.email) {
    try {
      const [existingLead] = await db
        .select({ id: leadsTable.id })
        .from(leadsTable)
        .where(and(eq(leadsTable.email, user.email), isNull(leadsTable.deletedAt)))
        .limit(1);
      if (!existingLead) {
        const phone = user.phone ? normalizePhoneField(user.phone).slice(0, 30) : null;
        const [createdLead] = await db.insert(leadsTable).values({
          firstName: toLatinUpper((user.firstName || "").trim()).slice(0, 100) || "STUDENT",
          lastName: toLatinUpper((user.lastName || "").trim()).slice(0, 100) || "REGISTRATION",
          email: user.email.slice(0, 255),
          phone,
          phoneE164: toE164(phone),
          source: "student_registration",
          status: "new",
          ...directOrigin(),
        }).returning();
        if (createdLead) await applyLeadAssignmentRules(createdLead, req.ip);
      }
    } catch (err) {
      console.error("[AUTH VERIFY-EMAIL] Failed to create lead for verified registration:", err);
    }
  }

  const sessionUser = buildSessionUser(user);
  const sessionData: SessionData = {
    user: sessionUser,
    access_token: `local-${crypto.randomBytes(16).toString("hex")}`,
  };

  const sid = await createSession(sessionData, user.id);
  setSessionCookie(req, res, sid);
  logAudit(user.id, "auth.email_verify", "user", user.id, {}, req.ip);
  res.json({ user: sessionUser, verified: true });
});

router.post("/auth/resend-code", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const ip = getRateLimitIp(req);
  try {
    await rateLimiter.consume(`resend:${ip}`);
    await rateLimiter.consume(`resend:${normalizedEmail}`);
  } catch {
    res.status(429).json({ error: "Too many resend attempts. Please wait before requesting a new code." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail));
  if (!user) {
    res.json({ message: "If an account exists, a new code has been sent." });
    return;
  }

  if (user.emailVerified) {
    res.status(400).json({ error: "Email is already verified" });
    return;
  }

  await db
    .update(emailVerificationCodesTable)
    .set({ used: true })
    .where(and(eq(emailVerificationCodesTable.email, normalizedEmail), eq(emailVerificationCodesTable.used, false)));

  const code = generateVerificationCode();
  await db.insert(emailVerificationCodesTable).values({
    email: normalizedEmail,
    code,
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
  });

  console.log(`[EMAIL VERIFICATION] New code sent to ${normalizedEmail.replace(/(.{2}).*(@.*)/, "$1***$2")}`);

  try {
    const emailContent = buildVerificationCodeEmail(user.firstName || "Student", code);
    await sendEmail(normalizedEmail, emailContent);
  } catch (err) {
    console.error("[EMAIL VERIFICATION] Failed to send verification email:", err);
  }

  res.json({ message: "A new verification code has been sent to your email." });
});

router.post("/auth/forgot-password", async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  const normalizedEmail = email.toLowerCase().trim();

  const ip = getRateLimitIp(req);
  try {
    await rateLimiter.consume(`forgot:${ip}`);
    await rateLimiter.consume(`forgot:${normalizedEmail}`);
  } catch {
    res.status(429).json({ error: "Too many reset requests. Please try again later." });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, normalizedEmail));

  if (!user) {
    res.json({ message: "If an account with that email exists, a password reset link has been sent." });
    return;
  }

  const { generateSecureToken, buildPasswordResetEmail, sendEmail, getAppBaseUrl } = await import("../lib/email");
  const resetToken = generateSecureToken();
  const tokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");
  const resetExpires = new Date(Date.now() + 60 * 60 * 1000);

  await db
    .update(usersTable)
    .set({ passwordResetToken: tokenHash, passwordResetExpires: resetExpires })
    .where(eq(usersTable.id, user.id));

  const baseUrl = getAppBaseUrl();
  const resetUrl = `${baseUrl}/login?token=${resetToken}`;

  const emailContent = await buildPasswordResetEmail({
    firstName: user.firstName || "User",
    resetUrl,
  });
  await sendEmail(user.email || normalizedEmail, emailContent);

  console.log(`[PASSWORD RESET] Reset email sent to ${normalizedEmail.replace(/(.{2}).*(@.*)/, "$1***$2")}`);

  logAudit(user.id, "auth.password_reset.request", "user", user.id, { email: normalizedEmail.replace(/(.{2}).*(@.*)/, "$1***$2") }, req.ip);
  res.json({ message: "If an account with that email exists, a password reset link has been sent." });
});

router.post("/auth/set-password", async (req: Request, res: Response) => {
  const { token, password } = req.body;
  if (!token || !password) {
    res.status(400).json({ error: "Token and password are required" });
    return;
  }

  const pwdResult = PasswordSchema.safeParse(password);
  if (!pwdResult.success) {
    res.status(400).json({ error: pwdResult.error.errors[0]?.message || "Invalid password" });
    return;
  }

  const ip = getRateLimitIp(req);
  try {
    await rateLimiter.consume(`set-password:${ip}`);
  } catch {
    res.status(429).json({ error: "Too many attempts. Please try again later." });
    return;
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const [user] = await db
    .select()
    .from(usersTable)
    .where(
      and(
        eq(usersTable.passwordResetToken, tokenHash),
        gt(usersTable.passwordResetExpires, new Date()),
      )
    );

  if (!user) {
    res.status(400).json({ error: "Invalid or expired link. Please request a new one." });
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await db
    .update(usersTable)
    .set({
      passwordHash: hash,
      passwordResetToken: null,
      passwordResetExpires: null,
      ...(user.emailVerified ? { isActive: true } : {}),
    })
    .where(eq(usersTable.id, user.id));

  // Password reset is the account-recovery boundary after a suspected
  // compromise. Revoke ALL existing sessions for this user so any session a
  // thief still holds is killed; the user re-authenticates with the new
  // password. The reset itself is unauthenticated (email-link driven), so
  // there is no current session to preserve.
  await deleteSessionsForUser(user.id);

  logAudit(user.id, "auth.set_password", "user", user.id, {}, req.ip);
  logAudit(user.id, "auth.password_reset.complete", "user", user.id, {}, req.ip);
  res.json({ success: true, message: user.emailVerified ? "Password has been set. You can now log in." : "Password has been set. Please verify your email to activate your account." });
});

router.get("/auth/verify-email-token/:token", async (req: Request, res: Response) => {
  const ip = getRateLimitIp(req);
  try {
    await rateLimiter.consume(`verify-token:${ip}`);
  } catch {
    res.redirect("/login?verifyError=invalid");
    return;
  }

  const { token } = req.params;
  if (!token) {
    res.status(400).json({ error: "Token is required" });
    return;
  }

  const verifiedEmail = await consumeEmailVerificationToken(String(token));
  let [user] = verifiedEmail
    ? await db.select().from(usersTable).where(eq(usersTable.email, verifiedEmail))
    : [];

  // Transitional compatibility for links issued before hashed, expiring link
  // tokens were introduced. Restrict this fallback to recently created users;
  // older accounts must request a new verification link.
  if (!user) {
    [user] = await db
      .select()
      .from(usersTable)
      .where(and(
        eq(usersTable.emailVerificationToken, String(token)),
        gt(usersTable.createdAt, new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)),
      ));
  }

  if (!user) {
    res.redirect("/login?verifyError=invalid");
    return;
  }

  await db
    .update(usersTable)
    .set({
      emailVerified: true,
      emailVerificationToken: null,
      ...(user.passwordHash ? { isActive: true } : {}),
    })
    .where(eq(usersTable.id, user.id));

  logAudit(user.id, "auth.email_verify", "user", user.id, { method: "token" }, req.ip);
  res.redirect("/login?verified=true");
});

router.post("/auth/resend-verification-email", async (req: Request, res: Response) => {
  const emailParam = req.body?.email?.toLowerCase?.()?.trim?.();

  if (!req.user && !emailParam) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const ip = getRateLimitIp(req);
  const rateLimitKey = req.user ? `resend-verify:${req.user.id}` : `resend-verify:${emailParam}`;
  try {
    await rateLimiter.consume(`resend-verify:${ip}`);
    await rateLimiter.consume(rateLimitKey);
  } catch {
    res.status(429).json({ error: "Too many attempts. Please wait before requesting again." });
    return;
  }

  const [user] = req.user
    ? await db.select().from(usersTable).where(eq(usersTable.id, req.user.id))
    : await db.select().from(usersTable).where(eq(usersTable.email, emailParam));
  if (!user || user.emailVerified) {
    res.json({ message: "If the email is registered and unverified, a verification link has been sent." });
    return;
  }

  const { generateSecureToken, buildVerificationEmail, sendEmail, getAppBaseUrl } = await import("../lib/email");

  const verificationToken = await issueEmailVerificationToken(user.email || "");
  // Clear legacy raw tokens once a new hashed, expiring link is issued.
  await db.update(usersTable)
    .set({ emailVerificationToken: null })
    .where(eq(usersTable.id, user.id));

  const baseUrl = getAppBaseUrl();
  const verifyEmailUrl = `${baseUrl}/api/auth/verify-email-token/${verificationToken}`;

  const emailContent = await buildVerificationEmail({
    firstName: user.firstName || "Student",
    verifyEmailUrl,
  });
  await sendEmail(user.email || "", emailContent);

  res.json({ message: "If the email is registered and unverified, a verification link has been sent." });
});

async function handleLogout(req: Request, res: Response) {
  const sid = getSessionId(req);
  if (req.user) {
    logAudit(req.user.id, "auth.logout", "user", req.user.id, {}, req.ip);
  }
  await clearSession(res, sid, req);
  res.redirect("/login");
}

router.get("/auth/logout", handleLogout);
router.post("/auth/logout", handleLogout);

export default router;
