import { Router, type IRouter } from "express";
import {
  db,
  rolesTable,
  usersTable,
  PERMISSION_CATEGORIES,
  getAllPermissions,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth, requireRole, logAudit } from "../lib/auth";
import { validate, getValidated } from "../middlewares/validate";
import { ADMIN_ROLES } from "../lib/roles";

const createRoleBodySchema = z.object({
  name: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  description: z.string().trim().optional().nullable(),
  color: z.string().trim().optional(),
  permissions: z.array(z.string()).optional(),
});

const patchRoleBodySchema = z.object({
  name: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  description: z.string().trim().optional().nullable(),
  color: z.string().trim().optional(),
  permissions: z.array(z.string()).optional(),
}).refine(obj => Object.keys(obj).length > 0, { message: "No valid fields to update" });

const router: IRouter = Router();

router.get("/roles", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  const roles = await db.select().from(rolesTable).orderBy(rolesTable.id);
  res.json({ data: roles });
});

router.get("/roles/permissions-schema", requireAuth, requireRole(...ADMIN_ROLES), async (_req, res): Promise<void> => {
  res.json({ data: PERMISSION_CATEGORIES });
});

router.get("/roles/:id", requireAuth, requireRole(...ADMIN_ROLES), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [role] = await db.select().from(rolesTable).where(eq(rolesTable.id, id));
  if (!role) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  res.json(role);
});

router.post("/roles", requireAuth, requireRole("super_admin"), validate({ body: createRoleBodySchema }), async (req, res): Promise<void> => {
  const { name, displayName, description, color, permissions } = getValidated<{ body: typeof createRoleBodySchema }>(req).body;

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");

  const existingRole = await db.select().from(rolesTable).where(eq(rolesTable.name, slug));
  if (existingRole.length > 0) {
    res.status(409).json({ error: "Role name already exists" });
    return;
  }

  const allPerms = getAllPermissions();
  const validPerms = (permissions || []).filter((p: string) => allPerms.includes(p));

  const [role] = await db
    .insert(rolesTable)
    .values({
      name: slug,
      displayName,
      description: description || null,
      color: color || "blue",
      isSystem: false,
      permissions: validPerms,
    })
    .returning();

  await logAudit(req.user!.id, "create_role", "role", role.id, {
    name: slug,
    permissions: validPerms,
  }, req.ip);
  res.status(201).json(role);
});

router.patch("/roles/:id", requireAuth, requireRole("super_admin"), validate({ body: patchRoleBodySchema }), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [existing] = await db.select().from(rolesTable).where(eq(rolesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Role not found" });
    return;
  }

  const body = getValidated<{ body: typeof patchRoleBodySchema }>(req).body;
  const updates: Record<string, unknown> = {};
  if (body.displayName !== undefined) updates.displayName = body.displayName;
  if (body.description !== undefined) updates.description = body.description;
  if (body.color !== undefined) updates.color = body.color;
  if (body.permissions !== undefined) {
    const allPerms = getAllPermissions();
    updates.permissions = body.permissions.filter((p) => allPerms.includes(p));
  }
  if (!existing.isSystem && body.name !== undefined) {
    updates.name = body.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No valid fields to update" });
    return;
  }

  const [role] = await db.update(rolesTable).set(updates).where(eq(rolesTable.id, id)).returning();
  await logAudit(req.user!.id, "update_role", "role", id, updates, req.ip);
  res.json(role);
});

router.delete("/roles/:id", requireAuth, requireRole("super_admin"), async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [existing] = await db.select().from(rolesTable).where(eq(rolesTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Role not found" });
    return;
  }
  if (existing.isSystem) {
    res.status(400).json({ error: "Cannot delete system roles" });
    return;
  }

  const [{ count: assignedCount }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(usersTable)
    .where(eq(usersTable.role, existing.name));
  if (Number(assignedCount) > 0) {
    res.status(400).json({ error: `Cannot delete role — ${assignedCount} user(s) are still assigned to it. Reassign them first.` });
    return;
  }

  await db.delete(rolesTable).where(eq(rolesTable.id, id));
  await logAudit(req.user!.id, "delete_role", "role", id, { name: existing.name }, req.ip);
  res.sendStatus(204);
});

export default router;
