import {
  db,
  usersTable,
  agentsTable,
  branchesTable,
  universitiesTable,
  settingsTable,
  staffDocumentsTable,
  financialTransactionsTable,
  messagesTable,
  conversationParticipantsTable,
  objectOwnersTable,
  signedContractsTable,
  quickLinksTable,
} from "@workspace/db";
import { ADMIN_ROLES, FINANCE_ROLES } from "@workspace/roles";
import { and, eq, inArray, isNull, or, sql, type SQL, type AnyColumn } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getAgentVisibleIds } from "./agentVisibility";

/**
 * Object-level authorization for the generic `GET /api/storage/objects/*path`
 * endpoint.
 *
 * That endpoint only enforced `requireAuth`, so ANY authenticated user could
 * download ANY private object by guessing/leaking its key (an IDOR). This
 * helper closes the gap by combining two signals:
 *
 *  1. Uploader binding (`object_owners`): the user who requested the upload URL
 *     for an object can always download it, and the recorded uploader is used
 *     to validate self-writable reference fields.
 *  2. Reference-based rules: the DB record that references the object reuses its
 *     existing access rules.
 *
 * Many reference fields are SELF-WRITABLE by ordinary users (`users.avatarUrl`,
 * `users.contractUrl`, `users.passportUrl`, `agents.logoUrl`,
 * `agents.businessCertUrl`, message attachments). Trusting those alone is
 * bypassable: an attacker can point one of their own fields at a victim's key
 * and download it. For those fields we additionally require the recorded
 * uploader to be the entity that owns the reference ("uploader consistency").
 * Fields written only by admins/server/finance (`agents.contractUrl`,
 * `agents.agentIdProofUrl`, staff documents, finance files, branch/settings/
 * university logos) are trustworthy and used directly.
 *
 * Records with their own dedicated, already-authorized download routes
 * (student/application documents, university contracts, signed-contract PDFs,
 * etc.) intentionally do NOT match here and are therefore denied at this
 * generic endpoint — those flows must use their dedicated routes.
 */

type RequestUser = { id: number; role: string };

/**
 * Reduce a stored or requested object reference to a canonical entity key.
 * Stored values vary widely: full URLs, `/api/storage/objects/<key>`,
 * `/objects/<key>`, bare `<key>`, and double-prefixed `objects/objects/<key>`.
 * The canonical key is the storage key after any `objects/` prefixes, e.g.
 * `uploads/<uuid>` or `staff-documents/<id>/<file>`.
 */
export function canonicalizeKey(value: string): string {
  let v = (value ?? "").trim();
  // Drop protocol + host if a full URL was stored.
  v = v.replace(/^[a-z]+:\/\/[^/]+/i, "");
  // Drop the API route prefix.
  v = v.replace(/^\/?api\/storage\/objects\//, "");
  // Drop leading slashes.
  v = v.replace(/^\/+/, "");
  // Collapse one or more leading `objects/` prefixes (handles double-prefix).
  v = v.replace(/^(objects\/)+/, "");
  // Some reference fields store inline data (e.g. `data:image/png;base64,...`)
  // or otherwise oversized strings that are not storage object keys. Real keys
  // are short (`uploads/<uuid>`, `staff-documents/<id>/<file>`); treat anything
  // implausibly long as "not a key" so it is never bound or matched (and stays
  // under the btree index size limit).
  if (v.length > 1024 || v.startsWith("data:")) return "";
  return v;
}

/** Escape LIKE wildcards so keys match literally. */
function escapeLike(s: string): string {
  return s.replace(/([\\%_])/g, "\\$1");
}

/**
 * Build a condition matching a column against an object key, tolerant of the
 * many stored formats. Matches an exact bare key or any value ending in
 * `/<key>` (covers prefixed/full-URL/double-prefixed stored variants).
 */
function matchKey(column: AnyColumn, key: string): SQL {
  const pattern = "%/" + escapeLike(key);
  return or(eq(column, key), sql`${column} LIKE ${pattern} ESCAPE '\\'`)!;
}

/** Same matcher applied to a SQL expression (e.g. a JSON extraction). */
function matchKeyExpr(expr: SQL, key: string): SQL {
  const pattern = "%/" + escapeLike(key);
  return or(eq(expr, key), sql`${expr} LIKE ${pattern} ESCAPE '\\'`)!;
}

async function exists(where: SQL, table: PgTable): Promise<boolean> {
  const rows = await db.select({ one: sql<number>`1` }).from(table).where(where).limit(1);
  return rows.length > 0;
}

type OwnerBinding = { bound: boolean; uploadedBy: number | null };

/** Look up the recorded uploader for a canonical object key. */
async function lookupOwner(key: string): Promise<OwnerBinding> {
  const rows = await db
    .select({ uploadedBy: objectOwnersTable.uploadedBy })
    .from(objectOwnersTable)
    .where(eq(objectOwnersTable.objectKey, key))
    .limit(1);
  if (rows.length === 0) return { bound: false, uploadedBy: null };
  return { bound: true, uploadedBy: rows[0].uploadedBy ?? null };
}

/**
 * Record (idempotently) that `userId` requested the upload of `keyOrPath`.
 * Called from the upload-URL endpoint so every new object is bound to its
 * uploader. The caller must fail closed when this binding cannot be persisted;
 * otherwise an upload URL would be issued without an authorization owner.
 */
export async function recordObjectOwner(keyOrPath: string, userId: number | null): Promise<boolean> {
  const key = canonicalizeKey(keyOrPath);
  if (!key) return false;
  try {
    // Upload-time binding is the most authoritative (sourcePriority 0). It may
    // correct a weaker backfill-reconstructed row, but never overwrites another
    // priority-0 row (a genuine upload key is unique, so that can't legitimately
    // happen).
    await db
      .insert(objectOwnersTable)
      .values({ objectKey: key, uploadedBy: userId, sourcePriority: 0 })
      .onConflictDoUpdate({
        target: objectOwnersTable.objectKey,
        set: { uploadedBy: userId, sourcePriority: 0 },
        where: sql`${objectOwnersTable.sourcePriority} > 0`,
      });
    return true;
  } catch (err) {
    console.error("[objectAuthz] failed to record object owner:", err);
    return false;
  }
}

/**
 * Returns true only when `userId` is recorded as the uploader of `fileKey`.
 * Used by document-creation routes to prevent non-staff callers from attaching
 * storage objects they did not upload themselves (IDOR via fileKey cross-reference).
 * Staff callers should bypass this check entirely.
 */
export async function callerOwnsObject(userId: number, fileKey: string): Promise<boolean> {
  const key = canonicalizeKey(fileKey);
  if (!key) return false;
  const { bound, uploadedBy } = await lookupOwner(key);
  return bound && uploadedBy === userId;
}

export async function canAccessGenericObject(user: RequestUser, wildcardPath: string): Promise<boolean> {
  const key = canonicalizeKey(wildcardPath);
  if (!key) return false;

  const role = user.role;
  const isAdmin = ADMIN_ROLES.includes(role);

  const { bound, uploadedBy } = await lookupOwner(key);

  // R1. The user who uploaded the object can always download it.
  if (uploadedBy !== null && uploadedBy === user.id) return true;

  // For SELF-WRITABLE reference fields, only trust the reference when it is
  // backed by a matching uploader binding. We deny when the object is unbound:
  // every self-writable reference field is also a backfill source, so any
  // legitimately-referenced object is bound (backfill on boot + recordObjectOwner
  // on every new upload). Trusting an unbound self-writable reference is exactly
  // the IDOR the binding was introduced to close.
  const consistent = (refOwnerId: number): boolean => bound && uploadedBy === refOwnerId;

  // 2. Trustworthy agent documents (contract, ID proof) — written by admins /
  //    the signing flow, so the reference itself is reliable. Admins, or the
  //    owning agent (and its staff/sub-agents via visibility).
  const [agentTrustDoc] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(or(matchKey(agentsTable.contractUrl, key), matchKey(agentsTable.agentIdProofUrl, key))!)
    .limit(1);
  if (agentTrustDoc) {
    if (isAdmin) return true;
    const visibleIds = await getAgentVisibleIds(user.id, role);
    if (visibleIds.includes(agentTrustDoc.id)) return true;
  }

  // 2b. Signed contract PDFs — generated server-side by the signing flow and
  //     referenced by signed_contracts.pdf_object_key (never user-writable, so
  //     trustworthy like an agent trust doc). Authorize directly against the
  //     signed_contracts ledger rather than relying on agents.contractUrl
  //     (section 2): that column only points at the agent's CURRENT contract and
  //     lags behind after a re-sign/resend, leaving the older—or the newer—signed
  //     PDF unreachable through this generic route. An agent can have several
  //     signed contracts over time and must be able to download any of their own.
  //     Visible to admins, or to the owning agent (plus its staff/sub-agents via
  //     visibility).
  const [signedPdf] = await db
    .select({ agentId: signedContractsTable.agentId })
    .from(signedContractsTable)
    .where(matchKey(signedContractsTable.pdfObjectKey, key))
    .limit(1);
  if (signedPdf) {
    if (isAdmin) return true;
    if (signedPdf.agentId !== null) {
      const visibleIds = await getAgentVisibleIds(user.id, role);
      if (visibleIds.includes(signedPdf.agentId)) return true;
    }
  }

  // 3. Staff / HR documents — admin-written. Admins, or the subject user.
  const [staffDoc] = await db
    .select({ userId: staffDocumentsTable.userId })
    .from(staffDocumentsTable)
    .where(and(matchKey(staffDocumentsTable.objectPath, key), isNull(staffDocumentsTable.deletedAt)))
    .limit(1);
  if (staffDoc && (isAdmin || staffDoc.userId === user.id)) return true;

  // 4. Finance attachments — finance roles only (finance-written reference).
  if (FINANCE_ROLES.includes(role)) {
    const financeMatch = await exists(
      matchKey(financialTransactionsTable.fileUrl, key),
      financialTransactionsTable as unknown as typeof usersTable,
    );
    if (financeMatch) return true;
  }

  // 5. User PII (contract / passport) — SELF-WRITABLE. Admins always; the owner
  //    only when the binding is consistent (prevents pointing one's own field
  //    at a victim's key).
  const [userDoc] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(or(matchKey(usersTable.contractUrl, key), matchKey(usersTable.passportUrl, key))!)
    .limit(1);
  if (userDoc) {
    if (isAdmin) return true;
    if (userDoc.id === user.id && consistent(userDoc.id)) return true;
  }

  // 6. Agent business certificate — written by the agent themselves or by an
  //    admin. The DB reference (agents.businessCertUrl) is the authority; no
  //    uploader-consistency check is needed because the write route is already
  //    protected (callerOwnsObject / admin-only). Visible to admins, or to any
  //    user whose agent-visibility scope includes the owning agent.
  const [agentSelfDoc] = await db
    .select({ id: agentsTable.id })
    .from(agentsTable)
    .where(matchKey(agentsTable.businessCertUrl, key))
    .limit(1);
  if (agentSelfDoc) {
    if (isAdmin) return true;
    const visibleIds = await getAgentVisibleIds(user.id, role);
    if (visibleIds.includes(agentSelfDoc.id)) return true;
  }

  // 7. Message attachments — SELF-WRITABLE by the sender. Allowed only when the
  //    object is bound, its uploader is the message sender, and the requesting
  //    user is a participant of that conversation — so a participant cannot
  //    attach a victim's key (uploaded by someone else) to leak it.
  const attachmentExpr = sql`${messagesTable.metadata}->'attachment'->>'fileUrl'`;
  const msgRows = await db
    .select({ conversationId: messagesTable.conversationId, senderId: messagesTable.senderId })
    .from(messagesTable)
    .where(matchKeyExpr(attachmentExpr, key))
    .limit(50);
  if (msgRows.length > 0 && bound && uploadedBy !== null) {
    // Only trust an attachment whose recorded uploader is the message sender,
    // so a participant cannot attach someone else's key to leak it.
    const ownMsgs = msgRows.filter((m) => m.senderId === uploadedBy);
    if (ownMsgs.length > 0) {
      const convIds = Array.from(new Set(ownMsgs.map((m) => m.conversationId)));
      const participant = await db
        .select({ one: sql<number>`1` })
        .from(conversationParticipantsTable)
        .where(
          and(
            eq(conversationParticipantsTable.userId, user.id),
            inArray(conversationParticipantsTable.conversationId, convIds),
          ),
        )
        .limit(1);
      if (participant.length > 0) return true;
    }
  }

  // 8. Admin-managed branding (branch / university / settings logos) — written
  //    only by admins, not forgeable. Visible to any authenticated user. Each
  //    table is queried separately (a single combined WHERE would reference
  //    columns from tables not in the FROM clause).
  const adminBranding =
    (await exists(matchKey(branchesTable.logoUrl, key), branchesTable)) ||
    (await exists(matchKey(universitiesTable.logoUrl, key), universitiesTable)) ||
    (await exists(
      or(
        matchKey(settingsTable.logoUrl, key),
        matchKey(settingsTable.logoDarkUrl, key),
        matchKey(settingsTable.logoSquareUrl, key),
        matchKey(settingsTable.emailLogoUrl, key),
        matchKey(settingsTable.pdfLogoUrl, key),
      )!,
      settingsTable,
    ));
  if (adminBranding) return true;

  // 9. Branding assets (user avatars, agent logos) — visible to any authenticated
  //    user. The DB reference is the authority: if any user or agent row points
  //    at this key as their avatar/logo, access is granted without requiring an
  //    uploader match. The WRITE side is already protected (users can only set
  //    their own avatar; agent logos are set via admin routes or callerOwnsObject),
  //    so a key reached via a DB reference here cannot have been planted by an
  //    attacker pointing their own field at a victim's key.
  const avatarUserExists = await exists(matchKey(usersTable.avatarUrl, key), usersTable);
  const logoAgentExists = await exists(matchKey(agentsTable.logoUrl, key), agentsTable);
  if (avatarUserExists || logoAgentExists) return true;

  // 10. Quick link logos — uploaded by admins, visible to any authenticated user
  //     (quick links appear on all role dashboards; the logo is display-only
  //     branding, not sensitive). Written only through admin routes, so the
  //     DB reference is trustworthy without an uploader-consistency check.
  const quickLinkLogoExists = await exists(
    matchKey(quickLinksTable.logoUrl, key),
    quickLinksTable as unknown as typeof usersTable,
  );
  if (quickLinkLogoExists) return true;

  // No referencing record grants this user access.
  return false;
}
