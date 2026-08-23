---
name: edcons deleting a user (agent/staff) — FK blockers
description: Why deleting a users row 500s, which FKs block it, and the safe delete pattern
---

# Deleting a `users` row hits FK blockers

Most tables reference `usersTable.id` with `ON DELETE SET NULL` or `CASCADE`, so they don't block a user delete. A few do NOT and throw a 23503 FK violation, 500ing the request:

- `conversations.createdById`, `messages.senderId`, `broadcasts.sentById`, `messageTemplates.createdById` — nullable, **no ON DELETE rule** → must SET NULL first.
- `notes.authorId`, `applicationStageDocuments.uploadedBy` — **NOT NULL + ON DELETE RESTRICT** → can't null; reassign to the acting admin to preserve the content.
- `audit_logs.userId` is `set null` (does NOT block) — don't confuse with notes.

**Symptom that triggered this:** admin deleting an agent from the Agents list got "HTTP 500" but the agent was still gone. Cause: the handler deleted the `agents` row and the linked `users` row as TWO separate auto-committed statements. Agent-row FKs are all set-null/cascade so it deleted fine; the user delete then 500'd → partial state.

**Pattern (in agents.ts):** wrap agent + user removal in `db.transaction`; before deleting users call `clearUserReferencesAndDelete(tx, userIds, actingUserId)` which nulls the nullable message FKs and reassigns the restrict ones, then deletes the users. Applies to BOTH single `DELETE /agents/:id` and `POST /agents/bulk-delete`. **Why:** atomicity removes the "error but it deleted anyway" split state, and clearing the blockers lets the user actually delete.

**Caveat:** any NEW table that references `usersTable.id` without set-null/cascade must be added to the helper or it will reintroduce this 500. Sub-agent/staff delete paths (DELETE /agents/me/sub-agents/:id, /agents/me/staff/:id) delete users too and share this risk if those users ever accrue the blocking refs.
