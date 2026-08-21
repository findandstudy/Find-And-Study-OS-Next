import { Router, type IRouter } from "express";
import { db, usersTable, rolesTable, studentsTable, softDelete, agentsTable, branchesTable } from "@workspace/db";
import { eq, ilike, or, sql, and, isNull, desc, inArray } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { writeAudit } from "../lib/auditLog";
import { ADMIN_ROLES, MANAGER_ROLES, STAFF_ROLES, AGENT_ROLES, requiresDirectBranch } from "../lib/roles";
import { getVisibleBranchIds } from "../lib/branchScope";
import { toE164 } from "../lib/inbox/phone";
import { dispatchAgentProfileChangedNotif } from "../lib/agentProfileNotif";
import { createSession, deleteSessionsForUser, getSession, getSessionId, SESSION_TTL, SESSION_COOKIE, type SessionData } from "../lib/replitAuth";
import { getSessionCookieOptions } from "../lib/cookieOptions";
import { evaluateLegacyUserImpersonation } from "../lib/impersonationPolicy";
import { validatePassword } from "../lib/passwordPolicy";
import { parsePaginationParams, buildPageMeta } from "@workspace/pagination";
import { z } from "zod";
import { validate, getValidated } from "../middlewares/validate";

const createUserBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  firstName: z.string().trim().min(1),
  lastName: z.string().trim().min(1),
  role: z.string().min(1),
  phone: z.string().trim().optional().nullable(),
  language: z.string().trim().optional(),
  password: z.string().optional(),
  avatarUrl: z.string().trim().optional().nullable(),
  branchId: z.number().int().positive().optional().nullable(),
});

const branchIdBodySchema = z.number().int().positive().nullable();

const router: IRouter = Router();

const ALLOWED_PATCH_FIELDS = ["email", "firstName", "lastName", "phone", "language", "avatarUrl", "startDate", "homeAddress", "passportNumber", "contractUrl", "passportUrl", "emergencyContactName", "emergencyContactPhone"];
const ADMIN_PATCH_FIELDS = [...ALLOWED_PATCH_FIELDS, "role", "isActive", "permissionOverrides", "branchId"];

async function canAssignActiveBranch(actorId: number, actorRole: string, branchId: number): Promise<boolean> {
  const [branch] = await db
    .select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(eq(branchesTable.id, branchId), isNull(branchesTable.archivedAt)));
  if (!branch) return false;
  if (actorRole === "super_admin") return true;
  const visibleBranchIds = await getVisibleBranchIds(actorId, actorRole);
  return visibleBranchIds !== null && visibleBranchIds.includes(branchId);
}

router.get("/users", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const asStr = (v: unknown): string => (Array.isArray(v) ? v.join(",") : v == null ? "" : String(v));
  const role = asStr(req.query.role);
  const roles = asStr(req.query.roles);
  const search = asStr(req.query.search);
  const pageParams = parsePaginationParams(req, { defaultLimit: 50, maxLimit: "large" });

  const conditions = [isNull(usersTable.deletedAt)];
  if (role) conditions.push(eq(usersTable.role, role));
  if (roles) {
    const roleList = roles.split(",").map((r) => r.trim()).filter(Boolean);
    if (roleList.length > 0) conditions.push(inArray(usersTable.role, roleList));
  }
  if (search) {
    const searchCond = or(
      ilike(usersTable.firstName, `%${search}%`),
      ilike(usersTable.lastName, `%${search}%`),
      ilike(usersTable.email, `%${search}%`)
    );
    if (searchCond) conditions.push(searchCond);
  }

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(usersTable).where(whereClause);

  // Non-manager staff (staff/consultant/editor/accountant) may read a minimal
  // directory — id, name, role, active flag, avatar — so they can see WHO a
  // lead/student/application is assigned to. Contact details (email, phone) and
  // permission settings remain restricted to managers/admins.
  const isManager = MANAGER_ROLES.includes(req.user!.role);
  const data = isManager
    ? await db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          role: usersTable.role,
          phone: usersTable.phone,
          language: usersTable.language,
          isActive: usersTable.isActive,
          avatarUrl: usersTable.avatarUrl,
          branchId: usersTable.branchId,
          branchName: branchesTable.name,
          permissionOverrides: usersTable.permissionOverrides,
          createdAt: usersTable.createdAt,
        })
        .from(usersTable)
        .leftJoin(branchesTable, eq(usersTable.branchId, branchesTable.id))
        .where(whereClause)
        .orderBy(desc(usersTable.createdAt), desc(usersTable.id))
        .limit(pageParams.limit)
        .offset(pageParams.offset)
    : await db
        .select({
          id: usersTable.id,
          email: usersTable.email,
          firstName: usersTable.firstName,
          lastName: usersTable.lastName,
          role: usersTable.role,
          isActive: usersTable.isActive,
          avatarUrl: usersTable.avatarUrl,
        })
        .from(usersTable)
        .where(whereClause)
        .orderBy(desc(usersTable.createdAt), desc(usersTable.id))
        .limit(pageParams.limit)
        .offset(pageParams.offset);

  res.json({ data, meta: buildPageMeta(Number(count), pageParams) });
});

router.post("/users", requireAuth, requireRole(...ADMIN_ROLES), validate({ body: createUserBodySchema }), async (req, res): Promise<void> => {
  const { email: normalizedEmail, firstName, lastName, role, phone, language, password, avatarUrl, branchId } =
    getValidated<{ body: typeof createUserBodySchema }>(req).body;

  const BUILTIN_ROLES = ["super_admin", "admin", "manager", "staff", "consultant", "editor", "accountant", "student", "agent", "sub_agent", "pending"];
  const dbRoles = await db.select({ name: rolesTable.name }).from(rolesTable);
  const validRoles = [...new Set([...BUILTIN_ROLES, ...dbRoles.map(r => r.name)])];
  if (!validRoles.includes(role)) {
    res.status(400).json({ error: "Invalid role" });
    return;
  }

  if (requiresDirectBranch(role) && branchId == null) {
    res.status(400).json({
      code: "USER_BRANCH_REQUIRED",
      error: "A branch is required for this staff role.",
    });
    return;
  }
  if (branchId != null && !(await canAssignActiveBranch(req.user!.id, req.user!.role, branchId))) {
    res.status(403).json({
      code: "BRANCH_ASSIGNMENT_FORBIDDEN",
      error: "The selected branch is unavailable or outside your branch scope.",
    });
    return;
  }

  const [existingUser] = await db.select().from(usersTable).where(and(eq(usersTable.email, normalizedEmail), isNull(usersTable.deletedAt)));
  if (existingUser) {
    if (existingUser.role !== role) {
      res.status(409).json({ error: `This email is already in use by a ${existingUser.role} account. Same email cannot be used across different roles.` });
    } else {
      res.status(409).json({ error: "A user with this email already exists" });
    }
    return;
  }

  let passwordHash: string | undefined;
  if (password) {
    const pwd = validatePassword(password);
    if (!pwd.ok) {
      res.status(400).json({ error: pwd.message });
      return;
    }
    passwordHash = await bcrypt.hash(pwd.value, 10);
  }

  const [user] = await db
    .insert(usersTable)
    .values({
      email: normalizedEmail,
      firstName, lastName, role,
      phone: phone || null,
      language: language || "en",
      avatarUrl: avatarUrl || null,
      branchId: branchId ?? null,
      isActive: true,
      emailVerified: true,
      passwordHash: passwordHash || null,
    })
    .returning();
  await logAudit(req.user!.id, "create_user", "user", user.id, { role, branchId: branchId ?? null }, req.ip);
  const { passwordHash: _ph, replitId: _ri, ...safeNewUser } = user as any;
  res.status(201).json(safeNewUser);
});

router.get("/users/:id", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const { replitId: _r, passwordHash: _p, ...safeUser } = user as any;
  res.json(safeUser);
});

router.patch("/users/:id", requireAuth, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const isAdmin = ADMIN_ROLES.includes(req.user!.role as any);
  const isSelf = req.user!.id === id;

  if (!isAdmin && !isSelf) {
    res.status(403).json({ error: "Insufficient permissions" });
    return;
  }

  // SEC-002: prevent non-super_admin from modifying a super_admin account
  const [targetCheck] = await db.select({ role: usersTable.role, branchId: usersTable.branchId })
    .from(usersTable).where(eq(usersTable.id, id));
  if (!targetCheck) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  if (req.user!.role !== "super_admin") {
    if (targetCheck?.role === "super_admin") {
      res.status(403).json({ error: "Only a super administrator may modify another super administrator account." });
      return;
    }
  }

  const AGENT_IMMUTABLE_ROLES = ["agent", "sub_agent"];
  if (!isAdmin && AGENT_IMMUTABLE_ROLES.includes(req.user!.role)) {
    const IMMUTABLE_FIELDS = ["email", "firstName", "lastName"];
    const attempted = IMMUTABLE_FIELDS.filter(f => req.body[f] !== undefined);
    if (attempted.length > 0) {
      await writeAudit({
        userId: req.user!.id,
        action: "profile_immutable_field_change_denied",
        resource: "user",
        resourceId: id,
        changes: { attempted },
        ipAddress: req.ip ?? null,
      });
      res.status(403).json({ error: "Email, first name and last name can only be changed by an admin." });
      return;
    }
  }

  const allowedFields = isAdmin ? ADMIN_PATCH_FIELDS : ALLOWED_PATCH_FIELDS;
  const updates: Record<string, unknown> = {};
  for (const key of allowedFields) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (!isAdmin && updates.role !== undefined) {
    delete updates.role;
  }

  if (updates.role !== undefined) {
    const BUILTIN = ["super_admin", "admin", "manager", "staff", "consultant", "editor", "accountant", "student", "agent", "sub_agent", "pending"];
    const dbR = await db.select({ name: rolesTable.name }).from(rolesTable);
    const valid = [...new Set([...BUILTIN, ...dbR.map(r => r.name)])];
    if (!valid.includes(updates.role as string)) {
      res.status(400).json({ error: "Invalid role" });
      return;
    }
  }


  if (updates.branchId !== undefined) {
    const parsedBranchId = branchIdBodySchema.safeParse(updates.branchId);
    if (!parsedBranchId.success) {
      res.status(400).json({ error: "branchId must be a positive integer or null" });
      return;
    }
    updates.branchId = parsedBranchId.data;
  }

  const branchAssignmentChanged = updates.role !== undefined || updates.branchId !== undefined;
  if (branchAssignmentChanged) {
    const finalRole = (updates.role as string | undefined) ?? targetCheck.role;
    const finalBranchId = updates.branchId !== undefined
      ? updates.branchId as number | null
      : targetCheck.branchId;
    if (requiresDirectBranch(finalRole) && finalBranchId == null) {
      res.status(400).json({
        code: "USER_BRANCH_REQUIRED",
        error: "A branch is required for this staff role.",
      });
      return;
    }
    if (finalBranchId != null && updates.branchId !== undefined &&
        !(await canAssignActiveBranch(req.user!.id, req.user!.role, finalBranchId))) {
      res.status(403).json({
        code: "BRANCH_ASSIGNMENT_FORBIDDEN",
        error: "The selected branch is unavailable or outside your branch scope.",
      });
      return;
    }
  }

  if (updates.permissionOverrides !== undefined) {
    const po = updates.permissionOverrides;
    if (po === null) {
      updates.permissionOverrides = null;
    } else if (typeof po !== "object" || Array.isArray(po)) {
      res.status(400).json({ error: "permissionOverrides must be an object" });
      return;
    } else {
      const cleaned: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(po as Record<string, unknown>)) {
        if (typeof v === "boolean") cleaned[k] = v;
      }
      updates.permissionOverrides = cleaned;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  let oldPhone: string | null = null;
  if (updates.phone !== undefined) {
    const [pre] = await db.select({ phone: usersTable.phone, role: usersTable.role }).from(usersTable).where(eq(usersTable.id, id));
    if (pre && AGENT_ROLES.includes(pre.role as any)) oldPhone = pre.phone ?? null;
  }
  let user: any = null;
  let syncedAgentId: number | null = null;
  await db.transaction(async (tx) => {
    const [u] = await tx.update(usersTable).set(updates).where(eq(usersTable.id, id)).returning();
    if (!u) return;
    user = u;
    if (updates.phone !== undefined && AGENT_ROLES.includes(u.role as any)) {
      const phoneE164 = toE164(u.phone ?? null);
      const [agentRow] = await tx.update(agentsTable)
        .set({ phone: u.phone ?? null, phoneE164 })
        .where(eq(agentsTable.userId, u.id))
        .returning({ id: agentsTable.id });
      syncedAgentId = agentRow?.id ?? null;
    }
  });
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  await logAudit(req.user!.id, "update_user", "user", id, updates, req.ip);
  if (updates.phone !== undefined && AGENT_ROLES.includes(user.role as any) && syncedAgentId !== null) {
    await writeAudit({
      userId: req.user!.id,
      action: "agent_profile_field_changed",
      resource: "agent_profile",
      resourceId: syncedAgentId,
      changes: { phone: { from: oldPhone, to: user.phone ?? null } },
      ipAddress: req.ip ?? null,
    });
    try {
      const [agentInfo] = await db.select({
        id: agentsTable.id,
        firstName: agentsTable.firstName,
        lastName: agentsTable.lastName,
        companyName: agentsTable.companyName,
      }).from(agentsTable).where(eq(agentsTable.id, syncedAgentId));
      if (agentInfo) {
        const agentName = `${agentInfo.firstName ?? ""} ${agentInfo.lastName ?? ""}`.trim() || agentInfo.companyName || `Agent #${agentInfo.id}`;
        await dispatchAgentProfileChangedNotif({
          agentId: agentInfo.id,
          agentName,
          changedFields: { phone: { from: oldPhone, to: user.phone ?? null } },
          actorUserId: req.user!.id,
          actionUrl: `/staff/agents/${agentInfo.id}`,
        });
      }
    } catch (err) {
      console.error("[users/patch] phone notification failed:", err);
    }
  }
  const { passwordHash: _ph2, replitId: _ri2, ...safePatchUser } = user as any;
  res.json(safePatchUser);
});

router.delete("/users/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (req.user!.id === id) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }
  const [existing] = await db.select({ id: usersTable.id, email: usersTable.email })
    .from(usersTable)
    .where(and(eq(usersTable.id, id), isNull(usersTable.deletedAt)));
  if (!existing) { res.status(404).json({ error: "User not found" }); return; }

  // Soft-delete: set deletedAt/deletedBy, deactivate, and free the email so
  // a fresh account can reuse the same address. Original is preserved with a
  // `<id>__deleted_<email>` prefix for forensic reference and to keep the
  // unique index satisfied.
  const renamedEmail = existing.email
    ? `${id}__deleted_${existing.email}`.slice(0, 255)
    : null;
  await db.update(usersTable).set({
    deletedAt: sql`now()`,
    deletedBy: req.user!.id,
    isActive: false,
    email: renamedEmail,
  }).where(eq(usersTable.id, id));
  await logAudit(req.user!.id, "delete_user", "user", id, { soft: true }, req.ip);
  res.sendStatus(204);
});

// Hard-delete (purge) — super_admin only. Drops the row entirely; only run
// after audit / commission references have been re-attributed.
router.post("/users/:id/purge", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  if (req.user!.id === id) {
    res.status(400).json({ error: "Cannot purge your own account" });
    return;
  }
  const result = await db.delete(usersTable).where(eq(usersTable.id, id));
  await logAudit(req.user!.id, "purge_user", "user", id, { hard: true }, req.ip);
  res.json({ success: true, deleted: result.rowCount ?? 0 });
});

router.post("/users/:id/set-password", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { password } = req.body;
  const pwd = validatePassword(password);
  if (!pwd.ok) {
    res.status(400).json({ error: pwd.message });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const hash = await bcrypt.hash(pwd.value, 10);
  await db.update(usersTable).set({ passwordHash: hash, passwordResetToken: null, passwordResetExpires: null }).where(eq(usersTable.id, id));
  await deleteSessionsForUser(id);
  await logAudit(req.user!.id, "auth.set_password", "user", id, { adminInitiated: true }, req.ip);
  res.json({ success: true });
});

router.get("/users/me/profile", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id));
  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  const { passwordHash: _ph, replitId: _rid, ...safe } = user as Record<string, unknown>;
  res.json(safe);
});

router.post("/users/me/change-password", requireAuth, async (req, res): Promise<void> => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    res.status(400).json({ error: "Current and new password are required" });
    return;
  }
  const pwd = validatePassword(newPassword);
  if (!pwd.ok) {
    res.status(400).json({ error: pwd.message });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user!.id));
  if (!user || !user.passwordHash) {
    res.status(400).json({ error: "Cannot change password" });
    return;
  }
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) {
    res.status(400).json({ error: "Current password is incorrect" });
    return;
  }
  const hash = await bcrypt.hash(pwd.value, 10);
  await db.update(usersTable).set({ passwordHash: hash, passwordResetToken: null, passwordResetExpires: null }).where(eq(usersTable.id, req.user!.id));
  // Revoke every OTHER session for this user so a changed password logs out any
  // other device (or a stolen cookie). Keep the caller's current session so the
  // user who just changed their password stays signed in.
  await deleteSessionsForUser(req.user!.id, getSessionId(req));
  await logAudit(req.user!.id, "auth.change_password", "user", req.user!.id, {}, req.ip);
  res.json({ success: true });
});

router.post("/users/:id/impersonate", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [targetUser] = await db.select().from(usersTable).where(eq(usersTable.id, id));
  if (!targetUser) { res.status(404).json({ error: "User not found" }); return; }

  const currentSid = req.cookies[SESSION_COOKIE];
  if (!currentSid) { res.status(400).json({ error: "Session cookie required for impersonation" }); return; }
  const currentSession = await getSession(currentSid);
  if (!currentSession || currentSession.originalSid) {
    await logAudit(req.user!.id, "auth.impersonate.denied", "user", id, {
      reason: currentSession ? "nested_impersonation" : "invalid_session",
      targetRole: targetUser.role,
    }, req.ip);
    res.status(403).json({ error: "Impersonation cannot be started from this session" });
    return;
  }

  let targetBranchIds = targetUser.branchId == null ? [] : [targetUser.branchId];
  if (targetBranchIds.length === 0 && targetUser.role === "student") {
    const studentRows = await db
      .select({ branchId: studentsTable.branchId })
      .from(studentsTable)
      .where(and(eq(studentsTable.userId, targetUser.id), isNull(studentsTable.deletedAt)));
    targetBranchIds = Array.from(new Set(
      studentRows
        .map((student) => student.branchId)
        .filter((branchId): branchId is number => branchId != null),
    ));
  }
  const visibleBranchIds = await getVisibleBranchIds(
    req.user!.id,
    req.user!.role,
    req.user!,
  );
  const decision = evaluateLegacyUserImpersonation(
    { id: req.user!.id, role: req.user!.role, visibleBranchIds },
    {
      id: targetUser.id,
      role: targetUser.role,
      branchIds: targetBranchIds,
      isActive: targetUser.isActive,
      isDeleted: targetUser.deletedAt != null,
    },
  );
  if (!decision.allowed) {
    await logAudit(req.user!.id, "auth.impersonate.denied", "user", id, {
      reason: decision.reason,
      targetRole: targetUser.role,
      targetBranchIds,
    }, req.ip);
    res.status(403).json({ error: "Impersonation is not permitted for this target" });
    return;
  }

  const sessionData: SessionData = {
    user: {
      id: targetUser.id,
      replitId: targetUser.replitId || `impersonated-${targetUser.id}`,
      email: targetUser.email,
      firstName: targetUser.firstName,
      lastName: targetUser.lastName,
      role: targetUser.role,
      avatarUrl: targetUser.avatarUrl,
      language: targetUser.language,
      isActive: targetUser.isActive,
      emailVerified: targetUser.emailVerified,
    },
    access_token: `impersonation-${Date.now()}`,
    originalSid: currentSid,
  };

  const sid = await createSession(sessionData);
  res.cookie(SESSION_COOKIE, sid, getSessionCookieOptions(req, SESSION_TTL));
  await logAudit(req.user!.id, "auth.impersonate.start", "user", id, {
    targetRole: targetUser.role,
    targetBranchIds,
    policyReason: decision.reason,
  }, req.ip);
  let redirectTo = "/staff";
  if (ADMIN_ROLES.includes(targetUser.role as any)) redirectTo = "/admin";
  else if (targetUser.role === "student") redirectTo = "/student";
  else if (["agent", "sub_agent", "agent_staff"].includes(targetUser.role)) redirectTo = "/agent";
  else if (STAFF_ROLES.includes(targetUser.role as any)) redirectTo = "/staff";
  res.json({ success: true, redirectTo, role: targetUser.role });
});

export default router;
