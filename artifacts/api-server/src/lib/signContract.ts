import { db, contractTemplatesTable, signingSessionsTable, signedContractsTable, agentsTable } from "@workspace/db";
import { and, eq, isNull, desc } from "drizzle-orm";
import { buildFinalSignedContractHtml, contractNumber } from "./contractRenderer";
import { buildSignedPdf } from "./contractPdf";
import { ObjectStorageService } from "./objectStorage";
import { writeAudit } from "./auditLog";
import { getAppBaseUrl } from "./email";
import { withRenderLock } from "./renderLock";

// Convert the canonical /objects/<entityId> key returned by uploadBuffer into a
// browser-openable URL served by GET /api/storage/objects/*path (requireAuth).
export function objectKeyToStorageUrl(pdfObjectKey: string): string {
  let p = pdfObjectKey;
  if (p.startsWith("/objects/")) p = p.slice("/objects/".length);
  else if (p.startsWith("objects/")) p = p.slice("objects/".length);
  return `${getAppBaseUrl()}/api/storage/objects/${p}`;
}

// Read-time resolution of an agent's *current* signed contract. An agent can
// accumulate multiple signed_contracts over time: an admin "resend" creates a
// brand-new signing session (often isPrimaryOnboarding=false) plus a new
// signed_contract. The agent's authoritative contract is always the most
// recently signed one. Endpoints resolve this at read time so that neither a
// stale agents.contractUrl (locked to an earlier contract) nor a
// primary-onboarding-only session lookup can surface a superseded/broken PDF.
export async function loadNewestSignedContractForAgent(agentId: number) {
  const [row] = await db
    .select({ signed: signedContractsTable, session: signingSessionsTable })
    .from(signedContractsTable)
    .innerJoin(signingSessionsTable, eq(signedContractsTable.signingSessionId, signingSessionsTable.id))
    .where(eq(signedContractsTable.agentId, agentId))
    .orderBy(desc(signedContractsTable.signedAt), desc(signedContractsTable.id))
    .limit(1);
  return row ?? null;
}

// Browser-openable URL of the agent's newest signed contract PDF, or null when
// the agent has no signed contract yet or its PDF has not been rendered.
export async function getNewestSignedContractUrl(agentId: number): Promise<string | null> {
  const row = await loadNewestSignedContractForAgent(agentId);
  if (!row?.signed.pdfObjectKey) return null;
  return objectKeyToStorageUrl(row.signed.pdfObjectKey);
}

const objectStorage = new ObjectStorageService();

export type FinalizeSignResult =
  | { ok: true; signedContractId: number }
  | { ok: false; status: number; error: string };

// First 8 bytes of every PNG file (magic number).
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

export type SignatureValidation =
  | { ok: true; base64: string; bytes: Buffer }
  | { ok: false; status: number; error: string };

/**
 * Normalize and validate an incoming signature image. Accepts either bare
 * base64 or a legacy "data:image/...;base64,<...>" data URL (older clients sent
 * the latter for small signatures). Decodes the base64 and enforces that the
 * bytes are a real PNG (magic number) of bounded size — a prior bug let an
 * invalid value ("AAAA") through and corrupted a signed contract record.
 */
export function validateSignatureImage(input: string): SignatureValidation {
  const base64 = input.replace(/^data:image\/[a-z+]+;base64,/i, "");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { ok: false, status: 400, error: "Invalid PNG" };
  }
  if (bytes.length > MAX_SIGNATURE_BYTES) {
    return { ok: false, status: 400, error: "Signature image too large" };
  }
  return { ok: true, base64, bytes };
}

/**
 * Finalize a signing session: render PDF, store, atomically flip status to
 * signed, insert signed_contracts row, email the signer the PDF link.
 *
 * Used by both the public token-based signing flow and the authenticated
 * agent onboarding signing flow.
 */
export async function finalizeSign(opts: {
  sessionId: number;
  signatureImagePngBase64: string;
  signerName: string | null;
  signerIp: string | null;
  signerUserAgent: string | null;
  pdfDownloadUrl?: string;
  triggerUserId?: number | null;
}): Promise<FinalizeSignResult> {
  const [session] = await db.select().from(signingSessionsTable).where(eq(signingSessionsTable.id, opts.sessionId));
  if (!session) return { ok: false, status: 404, error: "Session not found" };
  if (session.status === "signed") return { ok: false, status: 409, error: "Already signed" };
  if (session.status === "revoked") return { ok: false, status: 410, error: "Session revoked" };
  if (session.status === "expired") return { ok: false, status: 410, error: "Session expired" };
  if (new Date(session.expiresAt).getTime() < Date.now()) {
    try {
      await db.update(signingSessionsTable).set({ status: "expired" }).where(and(
        eq(signingSessionsTable.id, session.id), eq(signingSessionsTable.status, session.status),
      ));
    } catch {}
    return { ok: false, status: 410, error: "Session expired" };
  }

  const [template] = await db.select().from(contractTemplatesTable).where(eq(contractTemplatesTable.id, session.templateId));
  if (!template) return { ok: false, status: 404, error: "Template missing" };

  const signedAt = new Date();
  const finalSignerName = opts.signerName ? opts.signerName.slice(0, 200) : (session.signerName || null);

  // Store the signature as a base64 string directly in the DB row. Previously
  // the signature was uploaded to GCS here, but the GCS upload (up to 30 s) was
  // OOM-killing the resource-constrained autoscale instance mid-request, which
  // made the edge proxy return an opaque HTML "403 Forbidden" page instead of
  // completing the sign. Storing base64 in the DB is a pure DB write (<50 ms)
  // and eliminates the GCS I/O from the sign hot path entirely.
  // The GCS upload now happens lazily inside ensureSignedContractPdf() the first
  // time someone downloads the PDF, together with the Chromium render.
  const sigCheck = validateSignatureImage(opts.signatureImagePngBase64);
  if (!sigCheck.ok) return sigCheck;
  const signatureBase64 = sigCheck.base64;

  type Outcome = { ok: true; row: typeof signedContractsTable.$inferSelect } | { ok: false; status: number; error: string };
  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const [statusUpdate] = await tx.update(signingSessionsTable).set({
        status: "signed", signedAt, signerName: finalSignerName,
      }).where(and(
        eq(signingSessionsTable.id, session.id),
        eq(signingSessionsTable.status, session.status),
      )).returning({ id: signingSessionsTable.id });
      if (!statusUpdate) return { ok: false, status: 409, error: "Session state changed" };
      const [row] = await tx.insert(signedContractsTable).values({
        signingSessionId: session.id,
        agentId: session.agentId,
        templateId: template.id,
        subjectType: session.subjectType,
        subjectId: session.subjectId,
        subjectLabel: session.subjectLabel,
        pdfObjectKey: null,
        signatureImageObjectKey: null,
        signatureImageBase64: signatureBase64,
        evidenceHash: null,
        signerEmail: session.signerEmail,
        signerName: finalSignerName,
        signerIp: opts.signerIp,
        signerUserAgent: opts.signerUserAgent,
        signedAt,
      }).returning();
      return { ok: true, row };
    });
  } catch (txErr: any) {
    if (txErr?.code === "23505") return { ok: false, status: 409, error: "Already signed" };
    console.error("[signContract] tx failed:", txErr);
    return { ok: false, status: 500, error: "Failed to complete signing" };
  }
  if (!outcome.ok) return outcome;
  const signed = outcome.row;

  // NOTE: PDF delivery (rendering the signed PDF, emailing it as an attachment
  // to the signer AND all admins, and populating agents.contractUrl) is handled
  // out-of-band by the signed-contract delivery worker (see
  // lib/signedContractDelivery.ts). We deliberately leave emailedAt = NULL here
  // so the worker picks this row up. Keeping delivery off the sign hot path
  // avoids running headless Chromium on a user-blocking request, which OOM-kills
  // the autoscale instance and surfaces as an opaque edge-proxy 403.

  await writeAudit({
    userId: opts.triggerUserId ?? session.createdByUserId ?? null,
    action: "contract.signed",
    resource: "signed_contract",
    resourceId: signed.id,
    changes: {
      sessionId: session.id, templateId: template.id, agentId: session.agentId,
      signerEmail: session.signerEmail,
      isPrimaryOnboarding: session.isPrimaryOnboarding,
    },
    ipAddress: opts.signerIp,
  });

  // NOTE: we deliberately do NOT render the PDF here. The sign hot path must
  // stay lightweight (signature upload + DB commit). Headless Chromium is run
  // lazily on the first download via ensureSignedContractPdf(). Autoscale does
  // not support fire-and-forget background work after the response is sent — a
  // post-response Chromium render destabilizes the instance and made the sign
  // POST itself surface as an opaque edge-proxy "403 Forbidden".
  return { ok: true, signedContractId: signed.id };
}

export async function readObjectBuffer(key: string): Promise<Buffer | null> {
  try {
    let p = key;
    if (p.startsWith("/objects/")) p = p.slice("/objects/".length);
    if (p.startsWith("objects/")) p = p.slice("objects/".length);
    const file = await objectStorage.getObjectEntityFile(`/objects/${p}`);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      file.createReadStream()
        .on("data", (c: Buffer) => chunks.push(c))
        .on("end", () => resolve())
        .on("error", reject);
    });
    return Buffer.concat(chunks);
  } catch (err) {
    console.error("[ensureSignedContractPdf] failed to read signature image:", err);
    return null;
  }
}

/**
 * Lazily render + store the signed contract PDF the first time it is accessed.
 * Signing itself no longer renders a PDF (headless Chromium is too heavy for the
 * autoscale request path and was crashing the instance), so the heavy work
 * happens here, on download. Idempotent: returns immediately once a PDF object
 * key has been stored. All inputs needed to reconstruct the document (template,
 * intake data, signer identity, signed timestamp, signature image) are persisted
 * at sign time, so the regenerated PDF is deterministic.
 */
export async function ensureSignedContractPdf(
  signedContractId: number,
): Promise<{ pdfObjectKey: string; evidenceHash: string }> {
  const [row] = await db.select().from(signedContractsTable).where(eq(signedContractsTable.id, signedContractId));
  if (!row) throw new Error("Signed contract not found");
  if (row.pdfObjectKey && row.evidenceHash) {
    return { pdfObjectKey: row.pdfObjectKey, evidenceHash: row.evidenceHash };
  }

  const [session] = await db.select().from(signingSessionsTable).where(eq(signingSessionsTable.id, row.signingSessionId));
  const [template] = await db.select().from(contractTemplatesTable).where(eq(contractTemplatesTable.id, row.templateId));
  if (!template) throw new Error("Template missing");
  const resolvedTemplate = {
    ...template,
    version: session?.templateVersionSnapshot ?? template.version,
    name: session?.templateNameSnapshot ?? template.name,
    language: session?.templateLanguageSnapshot ?? template.language,
    entityType: session?.templateEntityTypeSnapshot ?? template.entityType,
    bodyHtml: session?.templateBodyHtmlSnapshot ?? template.bodyHtml,
    intakeSchema: session?.templateIntakeSchemaSnapshot ?? template.intakeSchema,
    signingPageConfig: session?.templateSigningPageConfigSnapshot ?? template.signingPageConfig,
  };
  let agent: typeof agentsTable.$inferSelect | null = null;
  if (row.agentId) {
    const [a] = await db.select().from(agentsTable).where(eq(agentsTable.id, row.agentId));
    agent = a || null;
  }

  // Signature source: new sign attempts store base64 directly in the DB row
  // (signatureImageBase64) to avoid a GCS upload on the hot sign path. Older
  // rows that were signed before this change have a GCS object key instead. The
  // logic below handles both transparently.
  // Fail hard if neither source is available: generating a PDF with no signature
  // would persist an "unsigned" document as if it were validly signed.
  let signatureBase64: string;
  if (row.signatureImageBase64) {
    signatureBase64 = row.signatureImageBase64;
  } else if (row.signatureImageObjectKey) {
    const sigBuf = await readObjectBuffer(row.signatureImageObjectKey);
    if (!sigBuf) {
      throw new Error(`Signature image could not be read for signed_contract ${row.id}; refusing to generate unsigned PDF`);
    }
    signatureBase64 = sigBuf.toString("base64");
  } else {
    throw new Error(`Signature image missing for signed_contract ${row.id}; refusing to generate unsigned PDF`);
  }

  // For rows that only have the base64 in the DB (no GCS object key yet),
  // upload the signature to GCS now so the object storage stays the authoritative
  // store for binary assets and future renders can skip the DB column.
  // This is a best-effort background step: failure is logged but does NOT abort
  // the PDF render — the base64 column is still there for next time.
  if (!row.signatureImageObjectKey && row.signatureImageBase64) {
    try {
      const sigBytes = Buffer.from(row.signatureImageBase64, "base64");
      const uploadedKey = await objectStorage.uploadBuffer({
        subdir: "signed-contracts",
        filename: `signature-${row.signingSessionId}.png`,
        buffer: sigBytes,
        contentType: "image/png",
      });
      await db.update(signedContractsTable)
        .set({ signatureImageObjectKey: uploadedKey })
        .where(and(eq(signedContractsTable.id, row.id), isNull(signedContractsTable.signatureImageObjectKey)));
    } catch (uploadErr) {
      console.warn(`[ensureSignedContractPdf] background signature GCS upload failed for signed_contract ${row.id} (non-fatal):`, uploadErr);
    }
  }

  const signedAt = row.signedAt ? new Date(row.signedAt) : new Date();
  // Single shared final-render path: every signed-PDF producer (this delivery
  // worker, the legacy backfill sweep, and the admin force-regenerate, which all
  // reach this function) funnels through buildFinalSignedContractHtml. That one
  // function is the only place that stamps the main-agency seal
  // ({{main_agency_signature}}) and the canonical contract number
  // ({{contract_number}}) into the FINAL document, so no path can render a signed
  // PDF that is missing either. The number is derived from contractNumber() —
  // the identical source used for the download filename — so the body and the
  // filename can never disagree.
  const renderedHtml = buildFinalSignedContractHtml({
    bodyHtml: resolvedTemplate.bodyHtml,
    templateLanguage: resolvedTemplate.language,
    signingPageConfig: resolvedTemplate.signingPageConfig,
    agent,
    intakeData: (session?.intakeData as any) || null,
    signerEmail: row.signerEmail,
    signerName: row.signerName,
    signedAt,
    signatureBase64,
    contractNumber: contractNumber(row.signingSessionId, signedAt),
  });

  // Serialize the heavy render: only one headless Chromium runs at a time across
  // the instance (see withRenderLock). The lock also lets concurrent downloads of
  // the same contract skip the work once the winner has finished, by re-checking
  // the stored key inside the lock.
  return withRenderLock(async () => {
    const [latest] = await db.select().from(signedContractsTable).where(eq(signedContractsTable.id, row.id));
    if (latest?.pdfObjectKey && latest.evidenceHash) {
      return { pdfObjectKey: latest.pdfObjectKey, evidenceHash: latest.evidenceHash };
    }

    // buildSignedPdf self-bounds its render with an internal timeout that closes
    // the browser on expiry, so the lock is held only until Chromium has actually
    // exited — a timed-out render frees its memory before the next one starts.
    const built = await buildSignedPdf({
      templateName: resolvedTemplate.name,
      bodyHtml: renderedHtml,
      signerEmail: row.signerEmail,
      signerName: row.signerName,
      signerIp: row.signerIp,
      signerUserAgent: row.signerUserAgent,
      signedAt,
    });

    const pdfObjectKey = await objectStorage.uploadBuffer({
      subdir: "signed-contracts",
      filename: `contract-${row.signingSessionId}.pdf`,
      buffer: Buffer.from(built.pdfBytes),
      contentType: "application/pdf",
    });
    // Compare-and-set: only the first concurrent generator wins. If a parallel
    // request already filled pdfObjectKey, this update affects 0 rows; we then
    // return the winner's key and discard our freshly uploaded duplicate object.
    const updated = await db.update(signedContractsTable)
      .set({ pdfObjectKey, evidenceHash: built.evidenceHash })
      .where(and(eq(signedContractsTable.id, row.id), isNull(signedContractsTable.pdfObjectKey)))
      .returning({ id: signedContractsTable.id });

    let finalPdfObjectKey = pdfObjectKey;
    let finalEvidenceHash = built.evidenceHash;

    if (updated.length === 0) {
      const [fresh] = await db.select().from(signedContractsTable).where(eq(signedContractsTable.id, row.id));
      if (fresh?.pdfObjectKey && fresh.evidenceHash) {
        console.warn(`[ensureSignedContractPdf] race for signed_contract ${row.id}; discarding duplicate object ${pdfObjectKey}`);
        finalPdfObjectKey = fresh.pdfObjectKey;
        finalEvidenceHash = fresh.evidenceHash;
      }
    }

    // Lazy contractUrl hydration: set agents.contractUrl on the first successful
    // PDF render so the agent's Account "Contract" tile and the staff Agents page
    // contract link work as soon as someone first downloads the PDF. The delivery
    // worker sets contractStartDate/contractEndDate without the PDF; this fills
    // in contractUrl.
    //
    // Only the agent's MOST RECENT signed_contract is allowed to set contractUrl.
    // An earlier `isNull(contractUrl)` guard permanently locked the agent to the
    // first contract that rendered — so when an agent re-signs (resend creates a
    // new signing session + signed_contract), the new contract's render became a
    // no-op and the agent stayed pointed at the stale (possibly broken) PDF.
    // Gating on "is this the newest signed_contract for the agent" lets a re-sign
    // win while preventing a late download of an OLD contract's PDF from clobbering
    // the URL back to a superseded contract.
    if (row.agentId) {
      try {
        const [newest] = await db
          .select({ id: signedContractsTable.id })
          .from(signedContractsTable)
          .where(eq(signedContractsTable.agentId, row.agentId))
          .orderBy(desc(signedContractsTable.signedAt), desc(signedContractsTable.id))
          .limit(1);
        if (newest?.id === row.id) {
          const storageUrl = objectKeyToStorageUrl(finalPdfObjectKey);
          const startDate = row.signedAt ? new Date(row.signedAt) : new Date();
          const endDate = new Date(startDate);
          endDate.setFullYear(endDate.getFullYear() + 1);
          await db.update(agentsTable)
            .set({ contractUrl: storageUrl, contractStartDate: startDate, contractEndDate: endDate })
            .where(eq(agentsTable.id, row.agentId));
        }
      } catch (agentErr) {
        // Non-fatal: contractUrl is cosmetic. Log and continue — the PDF is
        // already stored and will be downloadable; the tile link just won't
        // appear until the next successful render (or a manual admin update).
        console.error(`[ensureSignedContractPdf] failed to set contractUrl for agent ${row.agentId}:`, agentErr);
      }
    }

    return { pdfObjectKey: finalPdfObjectKey, evidenceHash: finalEvidenceHash };
  });
}
