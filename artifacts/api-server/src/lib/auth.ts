import { Request, Response, NextFunction } from "express";
import { db, auditLogsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getEffectivePermissionSet } from "./permissions";

export type AuthUser = {
  id: number;
  replitId: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  role: string;
  avatarUrl: string | null;
  language: string;
  isActive: boolean;
};

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (!req.user.isActive) {
    res.status(403).json({ error: "Account is pending activation. Contact your administrator." });
    return;
  }

  next();
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "Unauthorised action: Only an administrator can perform this action." });
      return;
    }
    next();
  };
}

export const AGENT_STAFF_PERMISSIONS = [
  "leads", "students", "applications", "documents",
  "course_finder", "messages", "commissions",
  "view_commission_amount", "view_service_fee",
] as const;

export function requireAgentStaffPermission(...requiredPerms: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (req.user.role !== "agent_staff") {
      next();
      return;
    }
    const [staffUser] = await db
      .select({ agentStaffPermissions: usersTable.agentStaffPermissions })
      .from(usersTable)
      .where(eq(usersTable.id, req.user.id));
    const perms = (staffUser?.agentStaffPermissions as string[] | null) || [];
    const hasAll = requiredPerms.every(p => perms.includes(p));
    if (!hasAll) {
      res.status(403).json({ error: "You do not have permission to access this resource" });
      return;
    }
    next();
  };
}

export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  next();
}

/**
 * Scope gate for API-token (Bearer) requests. Cookie/session requests are NOT
 * scope-limited here — they are governed by requireRole / requirePermission —
 * so for them this is a pass-through (no regression to session auth). For token
 * requests, every required scope must be present in req.tokenScopes.
 */
export function requireScope(...required: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.apiTokenAuth) {
      next();
      return;
    }
    const granted = req.tokenScopes ?? [];
    const ok = required.every((s) => granted.includes(s));
    if (!ok) {
      res.status(403).json({ error: "Insufficient token scope", required, granted });
      return;
    }
    next();
  };
}

const SUPER_ROLES = new Set(["super_admin"]);

/**
 * Permission gate. Super Admin bypasses. Every other role uses the canonical
 * effective-permission resolver: stored role row when present, static default
 * only when absent, then explicit per-user overrides.
 */
export function requirePermission(...required: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (SUPER_ROLES.has(req.user.role)) { next(); return; }
    try {
      const have = await getEffectivePermissionSet(req.user);
      const ok = required.every(p => have.has(p));
      if (!ok) {
        res.status(403).json({ error: "You do not have permission to perform this action" });
        return;
      }
      next();
    } catch (err) {
      console.error("[requirePermission] error:", err);
      res.status(500).json({ error: "Permission check failed" });
    }
  };
}

export function logAudit(
  userId: number | null,
  action: string,
  resource: string,
  resourceId?: number,
  changes?: object,
  ipAddress?: string
): void {
  setImmediate(async () => {
    try {
      await db.insert(auditLogsTable).values({
        userId,
        action,
        resource,
        resourceId,
        changes: changes ? JSON.stringify(changes) : null,
        ipAddress: ipAddress || null,
      });
    } catch (err) {
      console.error("[audit] Failed to write audit log:", err);
    }
  });
}
