import { Router, type IRouter } from "express";
import { db, auditLogsTable, usersTable, studentsTable, leadsTable, applicationsTable, documentsTable, programsTable, agentsTable } from "@workspace/db";
import { sql, desc, ilike, or, eq, and, inArray, isNotNull, isNull } from "drizzle-orm";
import { requireAuth, requireRole } from "../lib/auth";
import { MANAGER_ROLES, STAFF_ROLES } from "../lib/roles";
import { checkAssignmentConsistency } from "../lib/assignmentConsistencyChecker";

const router: IRouter = Router();

async function resolveResourceNames(logs: any[]): Promise<Map<string, Map<number, string>>> {
  const resourceGroups: Record<string, Set<number>> = {};
  for (const log of logs) {
    if (!log.resourceId) continue;
    const r = (log.resource || "").toLowerCase();
    if (!resourceGroups[r]) resourceGroups[r] = new Set();
    resourceGroups[r].add(log.resourceId);
  }

  const nameMap = new Map<string, Map<number, string>>();

  if (resourceGroups["user"] && resourceGroups["user"].size > 0) {
    const ids = [...resourceGroups["user"]];
    const rows = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email }).from(usersTable).where(inArray(usersTable.id, ids));
    const m = new Map<number, string>();
    for (const r of rows) {
      const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || `User #${r.id}`;
      m.set(r.id, name);
    }
    nameMap.set("user", m);
  }

  if (resourceGroups["student"] && resourceGroups["student"].size > 0) {
    const ids = [...resourceGroups["student"]];
    const rows = await db.select({ id: studentsTable.id, firstName: studentsTable.firstName, lastName: studentsTable.lastName }).from(studentsTable).where(inArray(studentsTable.id, ids));
    const m = new Map<number, string>();
    for (const r of rows) {
      const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || `Student #${r.id}`;
      m.set(r.id, name);
    }
    nameMap.set("student", m);
  }

  if (resourceGroups["lead"] && resourceGroups["lead"].size > 0) {
    const ids = [...resourceGroups["lead"]];
    const rows = await db.select({ id: leadsTable.id, firstName: leadsTable.firstName, lastName: leadsTable.lastName }).from(leadsTable).where(inArray(leadsTable.id, ids));
    const m = new Map<number, string>();
    for (const r of rows) {
      const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || `Lead #${r.id}`;
      m.set(r.id, name);
    }
    nameMap.set("lead", m);
  }

  if (resourceGroups["document"] && resourceGroups["document"].size > 0) {
    const ids = [...resourceGroups["document"]];
    const rows = await db.select({ id: documentsTable.id, name: documentsTable.name }).from(documentsTable).where(inArray(documentsTable.id, ids));
    const m = new Map<number, string>();
    for (const r of rows) {
      m.set(r.id, r.name || `Document #${r.id}`);
    }
    nameMap.set("document", m);
  }

  if (resourceGroups["program"] && resourceGroups["program"].size > 0) {
    const ids = [...resourceGroups["program"]];
    const rows = await db.select({ id: programsTable.id, name: programsTable.name }).from(programsTable).where(inArray(programsTable.id, ids));
    const m = new Map<number, string>();
    for (const r of rows) {
      m.set(r.id, r.name || `Program #${r.id}`);
    }
    nameMap.set("program", m);
  }

  if (resourceGroups["application"] && resourceGroups["application"].size > 0) {
    const ids = [...resourceGroups["application"]];
    const rows = await db
      .select({
        id: applicationsTable.id,
        programName: applicationsTable.programName,
        studentFirstName: studentsTable.firstName,
        studentLastName: studentsTable.lastName,
      })
      .from(applicationsTable)
      .leftJoin(studentsTable, eq(applicationsTable.studentId, studentsTable.id))
      .where(inArray(applicationsTable.id, ids));
    const m = new Map<number, string>();
    for (const r of rows) {
      const studentName = [r.studentFirstName, r.studentLastName].filter(Boolean).join(" ");
      const name = studentName ? `${studentName}${r.programName ? ` — ${r.programName}` : ""}` : r.programName || `Application #${r.id}`;
      m.set(r.id, name);
    }
    nameMap.set("application", m);
  }

  const detailUserIds: Set<number> = new Set();
  const detailAgentIds: Set<number> = new Set();
  const USER_ID_KEYS = new Set(["assignedToId", "userId", "targetUserId", "authorId", "createdById", "updatedById"]);
  const AGENT_ID_KEYS = new Set(["agentId"]);
  for (const log of logs) {
    if (!log.changes) continue;
    try {
      const changes = typeof log.changes === "string" ? JSON.parse(log.changes) : log.changes;
      for (const [key, val] of Object.entries(changes)) {
        const target = USER_ID_KEYS.has(key) ? detailUserIds : AGENT_ID_KEYS.has(key) ? detailAgentIds : null;
        if (!target) continue;
        if (typeof val === "number") {
          target.add(val);
        } else if (val && typeof val === "object" && !Array.isArray(val)) {
          const v: any = val;
          for (const side of ["from", "to", "old", "new"]) {
            if (typeof v[side] === "number") target.add(v[side]);
          }
        }
      }
    } catch {}
  }
  if (detailUserIds.size > 0) {
    const ids = [...detailUserIds];
    const existing = nameMap.get("user") || new Map<number, string>();
    const missingIds = ids.filter(id => !existing.has(id));
    if (missingIds.length > 0) {
      const rows = await db.select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email }).from(usersTable).where(inArray(usersTable.id, missingIds));
      for (const r of rows) {
        const name = [r.firstName, r.lastName].filter(Boolean).join(" ") || r.email || `User #${r.id}`;
        existing.set(r.id, name);
      }
    }
    nameMap.set("user", existing);
  }
  if (detailAgentIds.size > 0) {
    const ids = [...detailAgentIds];
    const rows = await db.select({ id: agentsTable.id, firstName: agentsTable.firstName, lastName: agentsTable.lastName, companyName: agentsTable.companyName }).from(agentsTable).where(inArray(agentsTable.id, ids));
    const m = new Map<number, string>();
    for (const r of rows) {
      const personName = [r.firstName, r.lastName].filter(Boolean).join(" ");
      const name = r.companyName || personName || `Agent #${r.id}`;
      m.set(r.id, name);
    }
    nameMap.set("agent", m);
  }

  return nameMap;
}

const USER_ID_KEYS_SET = new Set([
  "assignedToId", "userId", "targetUserId", "authorId", "createdById", "updatedById",
]);
const AGENT_ID_KEYS_SET = new Set(["agentId"]);

function nameKeyFor(idKey: string): string {
  return idKey === "assignedToId" ? "assignedToName" :
         idKey === "targetUserId" ? "targetUserName" :
         idKey === "userId" ? "userName" :
         idKey === "authorId" ? "authorName" :
         idKey === "agentId" ? "agentName" :
         idKey === "createdById" ? "createdByName" :
         "updatedByName";
}

function enrichChanges(changes: string | null | Record<string, any>, userNames: Map<number, string>, agentNames: Map<number, string>): Record<string, any> | null {
  if (!changes) return null;
  let obj: any;
  try {
    obj = typeof changes === "string" ? JSON.parse(changes) : changes;
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out: Record<string, any> = { ...obj };
  for (const [key, val] of Object.entries(obj)) {
    const isUser = USER_ID_KEYS_SET.has(key);
    const isAgent = AGENT_ID_KEYS_SET.has(key);
    if (!isUser && !isAgent) continue;
    const lookup = isUser ? userNames : agentNames;
    if (typeof val === "number") {
      const name = lookup.get(val);
      if (name) out[nameKeyFor(key)] = name;
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      const v: any = val;
      const enrichedDiff: Record<string, any> = { ...v };
      for (const side of ["from", "to", "old", "new"]) {
        if (typeof v[side] === "number") {
          const name = lookup.get(v[side]);
          if (name) enrichedDiff[`${side}Name`] = name;
        }
      }
      out[key] = enrichedDiff;
    }
  }
  return out;
}

async function enrichAuditRows(data: any[]) {
  const nameMap = await resolveResourceNames(data);
  const userNames = nameMap.get("user") || new Map<number, string>();
  const agentNames = nameMap.get("agent") || new Map<number, string>();

  return data.map((log) => {
    const rKey = (log.resource || "").toLowerCase();
    const resMap = nameMap.get(rKey);
    return {
      ...log,
      resourceDisplayName: log.resourceId && resMap ? resMap.get(log.resourceId) || null : null,
      changes: enrichChanges(log.changes, userNames, agentNames),
    };
  });
}

/**
 * Staff dashboard activity feed.
 *
 * This deliberately does not reuse the manager-only global /audit feed.
 * A staff user may only see events for records currently assigned to them.
 * Document events are included only when the document belongs to one of those
 * assigned leads, students, or applications.
 */
router.get("/audit/dashboard", requireAuth, requireRole(...STAFF_ROLES), async (req, res): Promise<void> => {
  const user = req.user!;
  const requestedLimit = parseInt(String(req.query.limit ?? "20"), 10);
  const limit = Math.min(20, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 20));

  const ownedDocument = and(
    isNotNull(documentsTable.id),
    or(
      sql<boolean>`EXISTS (
        SELECT 1 FROM ${studentsTable} AS dashboard_document_student
        WHERE dashboard_document_student.id = ${documentsTable.studentId}
          AND dashboard_document_student.assigned_to_id = ${user.id}
          AND dashboard_document_student.deleted_at IS NULL
      )`,
      sql<boolean>`EXISTS (
        SELECT 1 FROM ${leadsTable} AS dashboard_document_lead
        WHERE dashboard_document_lead.id = ${documentsTable.leadId}
          AND dashboard_document_lead.assigned_to_id = ${user.id}
          AND dashboard_document_lead.deleted_at IS NULL
      )`,
      sql<boolean>`EXISTS (
        SELECT 1 FROM ${applicationsTable} AS dashboard_document_application
        WHERE dashboard_document_application.id = ${documentsTable.applicationId}
          AND dashboard_document_application.assigned_to_id = ${user.id}
          AND dashboard_document_application.deleted_at IS NULL
      )`,
    ),
  );

  const data = await db
    .select({
      id: auditLogsTable.id,
      userId: auditLogsTable.userId,
      action: auditLogsTable.action,
      resource: auditLogsTable.resource,
      resourceId: auditLogsTable.resourceId,
      changes: auditLogsTable.changes,
      createdAt: auditLogsTable.createdAt,
      userName: sql<string>`COALESCE(NULLIF(CONCAT_WS(' ', ${usersTable.firstName}, ${usersTable.lastName}), ''), 'System')`,
    })
    .from(auditLogsTable)
    .leftJoin(usersTable, eq(auditLogsTable.userId, usersTable.id))
    .leftJoin(leadsTable, and(
      eq(auditLogsTable.resource, "lead"),
      eq(auditLogsTable.resourceId, leadsTable.id),
      eq(leadsTable.assignedToId, user.id),
      isNull(leadsTable.deletedAt),
    ))
    .leftJoin(studentsTable, and(
      eq(auditLogsTable.resource, "student"),
      eq(auditLogsTable.resourceId, studentsTable.id),
      eq(studentsTable.assignedToId, user.id),
      isNull(studentsTable.deletedAt),
    ))
    .leftJoin(applicationsTable, and(
      eq(auditLogsTable.resource, "application"),
      eq(auditLogsTable.resourceId, applicationsTable.id),
      eq(applicationsTable.assignedToId, user.id),
      isNull(applicationsTable.deletedAt),
    ))
    .leftJoin(documentsTable, and(
      eq(auditLogsTable.resource, "document"),
      eq(auditLogsTable.resourceId, documentsTable.id),
      isNull(documentsTable.deletedAt),
    ))
    .where(or(
      isNotNull(leadsTable.id),
      isNotNull(studentsTable.id),
      isNotNull(applicationsTable.id),
      ownedDocument,
    ))
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limit);

  res.json({ data: await enrichAuditRows(data) });
});

router.get("/audit", requireAuth, requireRole(...MANAGER_ROLES), async (req, res): Promise<void> => {
  const user = req.user!;
  const { search, resource, resourceId, page = "1", limit = "50" } = req.query as Record<string, string>;
  const pageNum = Math.max(1, parseInt(page, 10));
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (pageNum - 1) * limitNum;

  const conditions = [];

  // Resource-scoped audit log access is admin-only (super_admin / admin).
  const isStrictAdmin = user.role === "super_admin" || user.role === "admin";
  if (resource && resourceId) {
    if (!isStrictAdmin) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const ridNum = parseInt(resourceId, 10);
    if (isNaN(ridNum)) { res.status(400).json({ error: "Invalid resourceId" }); return; }
    conditions.push(eq(auditLogsTable.resource, resource));
    conditions.push(eq(auditLogsTable.resourceId, ridNum));
  }

  if (search) {
    conditions.push(
      or(
        ilike(auditLogsTable.action, `%${search}%`),
        ilike(auditLogsTable.resource, `%${search}%`),
      )!
    );
  }

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(auditLogsTable)
    .where(where);

  const data = await db
    .select({
      id: auditLogsTable.id,
      userId: auditLogsTable.userId,
      action: auditLogsTable.action,
      resource: auditLogsTable.resource,
      resourceId: auditLogsTable.resourceId,
      changes: auditLogsTable.changes,
      ipAddress: auditLogsTable.ipAddress,
      createdAt: auditLogsTable.createdAt,
      userName: sql<string>`COALESCE(NULLIF(CONCAT_WS(' ', ${usersTable.firstName}, ${usersTable.lastName}), ''), 'System')`,
    })
    .from(auditLogsTable)
    .leftJoin(usersTable, eq(auditLogsTable.userId, usersTable.id))
    .where(where)
    .orderBy(desc(auditLogsTable.createdAt))
    .limit(limitNum)
    .offset(offset);

  const enriched = await enrichAuditRows(data);

  res.json({
    data: enriched,
    meta: {
      total: Number(count),
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(Number(count) / limitNum),
    },
  });
});

router.get("/audit/assignment-inconsistencies", requireAuth, requireRole("super_admin", "admin"), async (_req, res): Promise<void> => {
  try {
    const inconsistencies = await checkAssignmentConsistency();

    const allUserIds = new Set<number>();
    for (const inc of inconsistencies) {
      if (inc.studentAssignedToId) allUserIds.add(inc.studentAssignedToId);
      if (inc.leadAssignedToId) allUserIds.add(inc.leadAssignedToId);
      if (inc.applicationAssignedToId) allUserIds.add(inc.applicationAssignedToId);
    }

    const userNames = new Map<number, string>();
    if (allUserIds.size > 0) {
      const users = await db
        .select({ id: usersTable.id, firstName: usersTable.firstName, lastName: usersTable.lastName, email: usersTable.email })
        .from(usersTable)
        .where(inArray(usersTable.id, [...allUserIds]));
      for (const u of users) {
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || `User #${u.id}`;
        userNames.set(u.id, name);
      }
    }

    const enriched = inconsistencies.map(inc => ({
      ...inc,
      studentAssignedToName: inc.studentAssignedToId ? (userNames.get(inc.studentAssignedToId) ?? null) : null,
      leadAssignedToName: inc.leadAssignedToId != null ? (userNames.get(inc.leadAssignedToId) ?? null) : undefined,
      applicationAssignedToName: inc.applicationAssignedToId != null ? (userNames.get(inc.applicationAssignedToId) ?? null) : undefined,
    }));

    res.json({
      count: enriched.length,
      leadMismatches: enriched.filter(i => i.type === "lead_mismatch").length,
      appMismatches: enriched.filter(i => i.type === "application_mismatch").length,
      data: enriched,
    });
  } catch (err: any) {
    console.error("[audit] assignment-inconsistencies error:", err?.message || err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
