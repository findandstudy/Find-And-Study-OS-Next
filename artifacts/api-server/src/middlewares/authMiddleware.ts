import { type Request, type Response, type NextFunction } from "express";
import { db, usersTable, rolesTable, DEFAULT_ROLE_PERMISSIONS } from "@workspace/db";
import { eq } from "drizzle-orm";
import {
  clearSession,
  getSessionId,
  getSession,
  touchSession,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionUser,
} from "../lib/replitAuth";
import { getSessionCookieOptions } from "../lib/cookieOptions";
import { extractBearerToken, lookupApiToken } from "../lib/apiTokenAuth";
import { applyPermissionOverrides } from "../lib/permissions";
import { verifyStudentPhotoSignature } from "@workspace/portal-adapters";
import { getRemainingSessionCookieTtl, resolveSessionIssuedAt } from "../lib/sessionLifetime";

declare global {
  namespace Express {
    interface Request {
      isAuthenticated(): this is AuthedRequest;
      user?: SessionUser | undefined;
      // Scopes granted to the API token that authenticated this request.
      // Undefined for cookie/session requests (those are gated by role/perms).
      tokenScopes?: string[] | undefined;
      // True when the request authenticated via an "Authorization: Bearer"
      // API token rather than a session cookie. Used to bypass CSRF and to
      // switch on scope enforcement.
      apiTokenAuth?: boolean | undefined;
    }

    interface AuthedRequest {
      user: SessionUser;
    }
  }
}

// Only Super Admin bypasses the versioned/configured role package. Admin must
// receive the same effective permission projection as every other role.
const ADMINISH_ROLES = new Set(["super_admin"]);

async function resolveRolePerms(
  role: string,
  permissionsFromAuthQuery?: unknown,
): Promise<string[]> {
  if (permissionsFromAuthQuery !== undefined) {
    return permissionsFromAuthQuery === null
      ? ((DEFAULT_ROLE_PERMISSIONS as Record<string, string[]>)[role] ?? [])
      : ((permissionsFromAuthQuery as string[] | null) ?? []);
  }

  const [row] = await db.select({ permissions: rolesTable.permissions })
    .from(rolesTable)
    .where(eq(rolesTable.name, role));
  return row
    ? ((row.permissions as string[] | null) ?? [])
    : ((DEFAULT_ROLE_PERMISSIONS as Record<string, string[]>)[role] ?? []);
}

/**
 * Populate `user.agentStaffPermissions` with the effective permission set for
 * the user's role (sourced from the request's fresh auth query) unioned with any
 * per-user agent_staff permissions already stored on the DB row.
 *
 * This is what the frontend `canSee(perm)` check consults for sidebar menu
 * visibility — without this, staff/consultant/accountant roles would always
 * see an empty set and therefore no gated menu items.
 *
 * Skipped only for super_admin (the sole all-permission short-circuit).
 * Never throws — on error the existing session value is preserved unchanged.
 */
async function enrichWithEffectivePerms(
  user: SessionUser,
  dbUser: typeof usersTable.$inferSelect,
  permissionsFromAuthQuery?: unknown,
): Promise<void> {
  // Reuse authorization fields from the users row that fetchDbUser already
  // loaded for this request. Keeping them non-enumerable prevents accidental
  // expansion of the public session/auth response contract.
  Object.defineProperties(user, {
    branchId: { value: dbUser.branchId, enumerable: false, configurable: true },
    managingAgentId: { value: dbUser.managingAgentId, enumerable: false, configurable: true },
  });

  if (ADMINISH_ROLES.has(user.role)) return;
  try {
    const rolePerms = await resolveRolePerms(user.role, permissionsFromAuthQuery);
    const effective = applyPermissionOverrides(
      rolePerms,
      dbUser.permissionOverrides as Record<string, boolean> | null,
    );
    Object.defineProperty(user, "effectivePermissions", {
      value: Array.from(effective),
      enumerable: false,
      configurable: true,
    });

    // Union: role-level perms ∪ per-user agent_staff column (for agent_staff rows)
    const own = Array.isArray(dbUser.agentStaffPermissions)
      ? (dbUser.agentStaffPermissions as string[])
      : [];
    user.agentStaffPermissions = Array.from(new Set([...rolePerms, ...own]));
  } catch {
    // Preserve whatever buildSessionUser already set on error.
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function fetchDbUser(id: number): Promise<{
  dbUser: typeof usersTable.$inferSelect;
  rolePermissions: unknown;
} | null> {
  const [row] = await db
    .select({
      dbUser: usersTable,
      rolePermissions: rolesTable.permissions,
    })
    .from(usersTable)
    .leftJoin(rolesTable, eq(usersTable.role, rolesTable.name))
    .where(eq(usersTable.id, id));
  if (!row) return null;
  return {
    dbUser: row.dbUser,
    // null means there is no stored role row and the static default applies.
    rolePermissions: row.rolePermissions ?? null,
  };
}

function buildSessionUser(dbUser: typeof usersTable.$inferSelect): SessionUser {
  const result: SessionUser = {
    id: dbUser.id,
    replitId: dbUser.replitId || `local-${dbUser.id}`,
    email: dbUser.email,
    firstName: dbUser.firstName,
    lastName: dbUser.lastName,
    role: dbUser.role,
    avatarUrl: dbUser.avatarUrl,
    language: dbUser.language,
    isActive: dbUser.isActive,
    emailVerified: dbUser.emailVerified,
    phone: dbUser.phone,
  };
  if (dbUser.role === "agent_staff") {
    // Always emit the field for agent_staff (even when the DB column is null)
    // so the frontend never sees `undefined` and mis-renders Access Denied.
    result.agentStaffPermissions = Array.isArray(dbUser.agentStaffPermissions)
      ? (dbUser.agentStaffPermissions as string[])
      : [];
  }
  return result;
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  req.isAuthenticated = function (this: Request) {
    return this.user != null;
  } as Request["isAuthenticated"];

  // Bearer API token takes precedence over the session cookie when present.
  // A malformed/unknown/expired/revoked token is rejected outright (401) rather
  // than silently falling back to session auth, which would be surprising and
  // could mask a bad credential.
  const bearer = extractBearerToken(req.headers.authorization);
  if (bearer) {
    const result = await lookupApiToken(bearer);
    if (!result) {
      res.status(401).json({ error: "Invalid or expired API token" });
      return;
    }
    req.user = buildSessionUser(result.dbUser);
    await enrichWithEffectivePerms(req.user, result.dbUser);
    req.tokenScopes = result.scopes;
    req.apiTokenAuth = true;
    next();
    return;
  }

  // A valid HMAC-signed student-photo URL is already an auth-free bearer URL.
  // Do not perform the session/user/permission lookup for each list avatar;
  // the photo route independently verifies the same signature again before it
  // reads any bytes. Unsigned or malformed paths continue through normal auth.
  // Explicit API bearer tokens retain precedence (and their fail-closed rules).
  const signedPhotoMatch = req.method === "GET"
    ? req.path.match(/^\/api\/students\/(\d+)\/photo(?:\/thumbnail)?$/)
    : null;
  if (signedPhotoMatch) {
    const studentId = Number(signedPhotoMatch[1]);
    const exp = Number(req.query.exp);
    const sig = typeof req.query.sig === "string" ? req.query.sig : "";
    if (verifyStudentPhotoSignature(studentId, exp, sig)) {
      next();
      return;
    }
  }

  const sid = getSessionId(req);
  if (!sid) {
    next();
    return;
  }

  const session = await getSession(sid);
  if (!session?.user?.id) {
    await clearSession(res, sid, req);
    next();
    return;
  }

  const authUserRow = await fetchDbUser(session.user.id);
  if (!authUserRow) {
    await clearSession(res, sid, req);
    next();
    return;
  }
  const { dbUser, rolePermissions } = authUserRow;

  // a) Soft-deleted account
  if (dbUser.deletedAt !== null) {
    await clearSession(res, sid, req);
    res.status(401).json({ error: "Account not found" });
    return;
  }

  // b) Deactivated account
  if (dbUser.isActive === false) {
    await clearSession(res, sid, req);
    res.status(403).json({ error: "Account deactivated" });
    return;
  }

  // c) Unverified email — only enforced for students. Staff, admin, agent and
  // other internal roles are onboarded by an administrator and are allowed in
  // even without confirming their email address (matches the behaviour of the
  // frontend EmailVerificationGuard, which also only blocks the student role).
  if (dbUser.emailVerified === false && dbUser.role === "student") {
    await clearSession(res, sid, req);
    res.status(403).json({ error: "Email not verified" });
    return;
  }

  req.user = buildSessionUser(dbUser);
  await enrichWithEffectivePerms(req.user, dbUser, rolePermissions);

  // The helper throttles PostgreSQL writes to once per session per five
  // minutes while user status/role remains checked on every request.
  setImmediate(() => {
    touchSession(sid, resolveSessionIssuedAt(session.issued_at)).catch(() => {});
  });

  // Slide the BROWSER cookie expiry forward to match the server-side session.
  // Without this, the cookie's maxAge is fixed at login time (30 min) and
  // disappears even though the user is actively using the app — leading to
  // unexpected 401 "Authentication required" errors on the next mutation.
  const remainingCookieTtl = getRemainingSessionCookieTtl(
    resolveSessionIssuedAt(session.issued_at),
    SESSION_TTL,
  );
  res.cookie(SESSION_COOKIE, sid, getSessionCookieOptions(req, remainingCookieTtl));

  next();
}
