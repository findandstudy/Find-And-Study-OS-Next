import { db, conversationsTable, externalContactsTable, leadsTable, studentsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { cascadeLeadAssignment, cascadeStudentAssignment } from "../leadAssignment";
import { logAudit } from "../auth";

/**
 * Single-owner rule helpers for inbox conversations.
 *
 * The CRM chain (lead → student → applications) is the authoritative owner
 * source. A conversation linked to that chain must always show the same
 * owner. `getChainOwner` resolves it (student wins over lead), and
 * `syncConversationOwner` reconciles one conversation both ways:
 *   - chain has an owner  → conversation is set to that owner (chain wins);
 *   - chain has no owner  → a conversation owner is null-filled down the chain.
 */
export async function getChainOwner(link: { leadId: number | null; studentId: number | null }): Promise<number | null> {
  if (link.studentId != null) {
    const [s] = await db
      .select({ assignedToId: studentsTable.assignedToId })
      .from(studentsTable)
      .where(and(eq(studentsTable.id, link.studentId), isNull(studentsTable.deletedAt)));
    if (s?.assignedToId != null) return s.assignedToId;
  }
  if (link.leadId != null) {
    const [l] = await db
      .select({ assignedToId: leadsTable.assignedToId })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, link.leadId), isNull(leadsTable.deletedAt)));
    if (l?.assignedToId != null) return l.assignedToId;
  }
  return null;
}

export async function loadLink(conversationId: number): Promise<{ leadId: number | null; studentId: number | null } | null> {
  const [conv] = await db
    .select({ externalContactId: conversationsTable.externalContactId })
    .from(conversationsTable)
    .where(eq(conversationsTable.id, conversationId));
  if (!conv?.externalContactId) return null;
  const [contact] = await db
    .select({ leadId: externalContactsTable.leadId, studentId: externalContactsTable.studentId })
    .from(externalContactsTable)
    .where(eq(externalContactsTable.id, conv.externalContactId));
  if (!contact) return null;
  return { leadId: contact.leadId ?? null, studentId: contact.studentId ?? null };
}

/**
 * Reconcile ONE conversation with its chain. Never throws.
 * Returns the effective owner after the sync (or null).
 */
export async function syncConversationOwner(
  conversationId: number,
  actorUserId: number | null,
  ipAddress?: string,
): Promise<number | null> {
  try {
    const [conv] = await db
      .select({ id: conversationsTable.id, assignedToId: conversationsTable.assignedToId })
      .from(conversationsTable)
      .where(eq(conversationsTable.id, conversationId));
    if (!conv) return null;
    const link = await loadLink(conversationId);
    if (!link || (link.leadId == null && link.studentId == null)) return conv.assignedToId ?? null;

    const chainOwner = await getChainOwner(link);
    if (chainOwner != null) {
      // Chain wins: conversation follows the chain owner.
      if (conv.assignedToId !== chainOwner) {
        await db
          .update(conversationsTable)
          .set({ assignedToId: chainOwner })
          .where(eq(conversationsTable.id, conversationId));
        logAudit(actorUserId, "assignment.chain_sync", "conversation", conversationId, {
          from: conv.assignedToId ?? null,
          to: chainOwner,
        }, ipAddress);
      }
      return chainOwner;
    }
    // Chain unowned: if the conversation has an owner, null-fill it down.
    if (conv.assignedToId != null) {
      if (link.leadId != null) {
        await db.transaction(async (tx) => {
          const [lead] = await tx
            .select({ id: leadsTable.id, convertedStudentId: leadsTable.convertedStudentId })
            .from(leadsTable)
            .where(and(eq(leadsTable.id, link.leadId!), isNull(leadsTable.deletedAt)));
          if (!lead) return;
          await tx.update(leadsTable).set({ assignedToId: conv.assignedToId })
            .where(and(eq(leadsTable.id, lead.id), isNull(leadsTable.assignedToId)));
          await cascadeLeadAssignment({
            leadId: lead.id,
            convertedStudentId: lead.convertedStudentId ?? null,
            newAssignedToId: conv.assignedToId,
            actorUserId,
            ipAddress,
            nullFillOnly: true,
            throwOnError: true,
            executor: tx,
          });
        });
      } else if (link.studentId != null) {
        await db.transaction(async (tx) => {
          await tx.update(studentsTable).set({ assignedToId: conv.assignedToId })
            .where(and(eq(studentsTable.id, link.studentId!), isNull(studentsTable.assignedToId)));
          await cascadeStudentAssignment({
            studentId: link.studentId!,
            newAssignedToId: conv.assignedToId,
            actorUserId,
            ipAddress,
            nullFillOnly: true,
            throwOnError: true,
            executor: tx,
          });
        });
      }
      return conv.assignedToId;
    }
    return null;
  } catch (err: any) {
    console.error(`[assignmentSync] syncConversationOwner(${conversationId}) failed:`, err?.message || err);
    return null;
  }
}

/**
 * Explicit operational reconcile: pull every linked conversation onto its
 * chain owner (chain wins). Pure SQL and idempotent, but never run at API boot.
 */
export async function reconcileConversationOwners(pool: { query: (sql: string) => Promise<{ rowCount: number | null }> }): Promise<void> {
  try {
    // Student owner wins first…
    const r1 = await pool.query(`
      UPDATE conversations c
      SET assigned_to_id = s.assigned_to_id
      FROM external_contacts ec
      JOIN students s ON s.id = ec.student_id AND s.deleted_at IS NULL
      WHERE ec.id = c.external_contact_id
        AND s.assigned_to_id IS NOT NULL
        AND c.assigned_to_id IS DISTINCT FROM s.assigned_to_id
    `);
    // …then lead owner for contacts without a student link.
    const r2 = await pool.query(`
      UPDATE conversations c
      SET assigned_to_id = l.assigned_to_id
      FROM external_contacts ec
      JOIN leads l ON l.id = ec.lead_id AND l.deleted_at IS NULL
      WHERE ec.id = c.external_contact_id
        AND ec.student_id IS NULL
        AND l.assigned_to_id IS NOT NULL
        AND c.assigned_to_id IS DISTINCT FROM l.assigned_to_id
    `);
    const fixed = (r1.rowCount || 0) + (r2.rowCount || 0);
    if (fixed > 0) {
      console.log(`[assignmentSync] Reconciled ${fixed} conversation owner(s) onto their CRM chain owner`);
    }
  } catch (err: any) {
    console.error("[assignmentSync] boot reconcile failed:", err?.message || err);
  }
}
