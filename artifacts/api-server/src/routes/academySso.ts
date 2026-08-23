import { Router, type Request, type Response } from "express";
import crypto from "crypto";
import { requireAuth, requireRole } from "../lib/auth";
import { userHasPermission } from "../lib/permissions";
import { db, agentsTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router = Router();

async function resolveCompanyName(userId: number, role: string): Promise<string | null> {
  try {
    if (role === "agent_staff") {
      const [staffUser] = await db
        .select({ managingAgentId: usersTable.managingAgentId })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      if (!staffUser?.managingAgentId) return null;
      const [agent] = await db
        .select({ companyName: agentsTable.companyName })
        .from(agentsTable)
        .where(eq(agentsTable.id, staffUser.managingAgentId));
      return agent?.companyName ?? null;
    }
    const [agent] = await db
      .select({ companyName: agentsTable.companyName })
      .from(agentsTable)
      .where(eq(agentsTable.userId, userId));
    return agent?.companyName ?? null;
  } catch {
    return null;
  }
}

function signHs256(payload: Record<string, unknown>, secret: string): string {
  const b64 = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + 120, jti: crypto.randomUUID(), ...payload };
  const data = b64({ alg: "HS256", typ: "JWT" }) + "." + b64(body);
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return data + "." + sig;
}

router.get("/academy-sso", requireAuth, requireRole("super_admin", "admin", "manager", "agent", "sub_agent", "agent_staff", "staff", "consultant", "accountant", "editor"), async (req: Request, res: Response) => {
  const secret = process.env.SSO_SHARED_SECRET;
  if (!secret) {
    res.status(500).send("SSO not configured");
    return;
  }
  const u = req.user!;
  if (!u.email) {
    res.status(400).send("email required");
    return;
  }

  // Access gate: fetch fresh user row (session may not carry new columns).
  const [freshUser] = await db
    .select({ agentStaffPermissions: usersTable.agentStaffPermissions })
    .from(usersTable)
    .where(eq(usersTable.id, u.id));

  const allowed = u.role === "agent_staff"
    ? Array.isArray(freshUser?.agentStaffPermissions) && (freshUser.agentStaffPermissions as string[]).includes("academy")
    : await userHasPermission(u, "academy.access");

  if (!allowed) {
    res.status(403).send("Academy access not granted");
    return;
  }

  const company = await resolveCompanyName(u.id, u.role);
  const token = signHs256(
    {
      email: u.email,
      name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email,
      company: company,
      phone: (u as any).phone ?? null,
      sub: String(u.id),
    },
    secret,
  );
  res.redirect(
    "https://academy.findandstudy.com/api/sso?token=" + encodeURIComponent(token),
  );
});

export default router;
