import { db, auditLogsTable } from "@workspace/db";

export async function writeAudit(opts: {
  userId?: number | null;
  action: string;
  resource: string;
  resourceId?: number | null;
  changes?: Record<string, any> | null;
  ipAddress?: string | null;
}): Promise<void> {
  try {
    await db.insert(auditLogsTable).values({
      userId: opts.userId ?? null,
      action: opts.action,
      resource: opts.resource,
      resourceId: opts.resourceId ?? null,
      changes: opts.changes ? JSON.stringify(opts.changes) : null,
      ipAddress: opts.ipAddress ?? null,
    });
  } catch (err) {
    console.error("[AUDIT] Failed to write audit log:", err);
  }
}
