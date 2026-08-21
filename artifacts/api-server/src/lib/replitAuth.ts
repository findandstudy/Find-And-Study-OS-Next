import crypto from "crypto";
import { type Request, type Response } from "express";
import { db, sessionsTable } from "@workspace/db";
import { eq, asc, and, sql } from "drizzle-orm";
import { getClearCookieOptions } from "./cookieOptions";
import {
  getBoundedSessionExpiry,
  isAbsoluteSessionExpired,
  resolveSessionIssuedAt,
} from "./sessionLifetime";

export const SESSION_COOKIE = "sid";

/**
 * Idle timeout: session expires 8 hours after the last authenticated request.
 *
 * The previous 30-minute window caused frequent "Authentication required"
 * 401s when a tab sat in the background long enough for the browser to
 * throttle the activity-tracker heartbeat (or when the laptop slept).
 * 8 hours covers a normal staff workday while still bounding stolen-cookie
 * exposure; the session is also slid forward on every authenticated
 * request via authMiddleware, so active users never get logged out.
 */
export const IDLE_TIMEOUT = 8 * 60 * 60 * 1000;

/** Backward-compatible alias — do not remove (imported by routes). */
export const SESSION_TTL = IDLE_TIMEOUT;

/** Maximum concurrent sessions allowed per user. */
export const MAX_SESSIONS_PER_USER = 3;

export interface SessionUser {
  id: number;
  replitId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  avatarUrl: string | null;
  language: string;
  isActive: boolean;
  emailVerified: boolean;
  phone?: string | null;
  agentStaffPermissions?: string[];
  /**
   * Request-local authorization context populated from the already-fetched
   * users row. These properties are defined as non-enumerable by the auth
   * middleware, so they are available to server-side guards without becoming
   * part of session or API response payloads.
   */
  effectivePermissions?: string[];
  branchId?: number | null;
  managingAgentId?: number | null;
}

export interface SessionData {
  user: SessionUser;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  /** Server-issued epoch milliseconds used for the non-sliding hard timeout. */
  issued_at?: number;
  /**
   * If this session was created via impersonation, this points to the
   * original (admin) session id so the user can return to it.
   */
  originalSid?: string;
}

/**
 * Create a new session.
 *
 * If `userId` is supplied:
 *   - Counts active sessions belonging to that user.
 *   - Deletes the oldest session(s) so at most MAX_SESSIONS_PER_USER - 1
 *     remain before inserting the new one (ensuring max = MAX_SESSIONS_PER_USER).
 *
 * Impersonation sessions (userId = undefined) bypass the limit and are not
 * counted toward any user's quota.
 */
export async function createSession(
  data: SessionData,
  userId?: number,
): Promise<string> {
  if (userId !== undefined) {
    const existing = await db
      .select({ sid: sessionsTable.sid })
      .from(sessionsTable)
      .where(
        and(
          eq(sessionsTable.userId, userId),
          sql`${sessionsTable.expire} > NOW()`,
        ),
      )
      .orderBy(asc(sessionsTable.expire));

    const overflow = existing.length - (MAX_SESSIONS_PER_USER - 1);
    if (overflow > 0) {
      const toDelete = existing.slice(0, overflow);
      for (const s of toDelete) {
        await deleteSession(s.sid);
      }
    }
  }

  const sid = crypto.randomBytes(32).toString("hex");
  const issuedAt = resolveSessionIssuedAt(data.issued_at);
  const storedData: SessionData = { ...data, issued_at: issuedAt };
  await db.insert(sessionsTable).values({
    sid,
    sess: storedData as unknown as Record<string, unknown>,
    expire: new Date(getBoundedSessionExpiry(issuedAt, IDLE_TIMEOUT)),
    userId: userId ?? null,
  });
  return sid;
}

export async function getSession(sid: string): Promise<SessionData | null> {
  const [row] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.sid, sid));

  if (!row || row.expire < new Date()) {
    if (row) await deleteSession(sid);
    return null;
  }
  const data = row.sess as unknown as SessionData;
  const issuedAt = resolveSessionIssuedAt(data.issued_at);
  if (isAbsoluteSessionExpired(issuedAt)) {
    await deleteSession(sid);
    return null;
  }
  if (data.issued_at !== issuedAt) {
    // One-time compatibility upgrade for sessions created before absolute
    // lifetime tracking. Their 24-hour clock starts at first observation.
    data.issued_at = issuedAt;
    await db.update(sessionsTable)
      .set({ sess: data as unknown as Record<string, unknown> })
      .where(eq(sessionsTable.sid, sid));
  }
  return data;
}

/**
 * Slide the session expiry forward by IDLE_TIMEOUT.
 * Calls are process-locally throttled so a busy browser does not turn every
 * authenticated request into a PostgreSQL write. User status/role is still
 * read on every request by authMiddleware, preserving immediate revocation.
 */
const SESSION_TOUCH_INTERVAL = 5 * 60 * 1000;
const MAX_TRACKED_SESSION_TOUCHES = 10_000;
const recentSessionTouches = new Map<string, number>();

export async function touchSession(sid: string, issuedAt: number): Promise<void> {
  const now = Date.now();
  const lastTouch = recentSessionTouches.get(sid) ?? 0;
  if (now - lastTouch < SESSION_TOUCH_INTERVAL) return;

  // Mark before the asynchronous write to collapse concurrent requests for
  // the same session. A failed write is removed so the next request retries.
  recentSessionTouches.set(sid, now);
  if (recentSessionTouches.size > MAX_TRACKED_SESSION_TOUCHES) {
    const cutoff = now - SESSION_TOUCH_INTERVAL;
    for (const [trackedSid, touchedAt] of recentSessionTouches) {
      if (touchedAt < cutoff) recentSessionTouches.delete(trackedSid);
      if (recentSessionTouches.size <= MAX_TRACKED_SESSION_TOUCHES) break;
    }
  }

  try {
    await db
      .update(sessionsTable)
      .set({ expire: new Date(getBoundedSessionExpiry(issuedAt, IDLE_TIMEOUT)) })
      .where(eq(sessionsTable.sid, sid));
  } catch (error) {
    recentSessionTouches.delete(sid);
    throw error;
  }
}

export async function updateSession(
  sid: string,
  data: SessionData,
): Promise<void> {
  const current = await getSession(sid);
  if (!current) return;
  const issuedAt = resolveSessionIssuedAt(data.issued_at ?? current.issued_at);
  const storedData: SessionData = { ...data, issued_at: issuedAt };
  await db
    .update(sessionsTable)
    .set({
      sess: storedData as unknown as Record<string, unknown>,
      expire: new Date(getBoundedSessionExpiry(issuedAt, IDLE_TIMEOUT)),
    })
    .where(eq(sessionsTable.sid, sid));
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

/**
 * Revoke every server-side session that authenticates AS the given user,
 * optionally preserving one session (the caller's current session).
 *
 * Matches both ordinary sessions (where the `user_id` column is set) and
 * impersonation sessions (where `user_id` is null but the session payload's
 * `user.id` identifies the impersonated account), so a password change/reset
 * truly closes the recovery boundary and a stolen cookie cannot survive it.
 */
export async function deleteSessionsForUser(
  userId: number,
  exceptSid?: string,
): Promise<void> {
  const matchesUser = sql`(${sessionsTable.userId} = ${userId} OR (${sessionsTable.sess}->'user'->>'id')::int = ${userId})`;
  const where = exceptSid
    ? and(matchesUser, sql`${sessionsTable.sid} <> ${exceptSid}`)
    : matchesUser;
  await db.delete(sessionsTable).where(where);
}

export async function clearSession(
  res: Response,
  sid?: string,
  req?: Request,
): Promise<void> {
  if (sid) await deleteSession(sid);
  // When req is unavailable (e.g. background callers), fall back to a
  // synthesized request shape so we still match what was likely set.
  const reqLike = req ?? ({
    secure: process.env.NODE_ENV === "production",
    headers: {},
  } as Request);
  res.clearCookie(SESSION_COOKIE, getClearCookieOptions(reqLike));
}

export function getSessionId(req: Request): string | undefined {
  const authHeader = req.headers["authorization"];
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }
  return req.cookies?.[SESSION_COOKIE];
}
