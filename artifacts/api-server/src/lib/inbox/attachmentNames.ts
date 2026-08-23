import { db, messagesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getZernioApiKey } from "./zernioSend";

/**
 * Parse a filename out of a Content-Disposition header value.
 * Supports RFC 5987 `filename*=UTF-8''...` (preferred) and the plain
 * `filename="..."` form. Returns null when no usable filename is present.
 */
export function parseContentDispositionFilename(header: string | null | undefined): string | null {
  if (!header) return null;
  try {
    // RFC 5987: filename*=UTF-8''encoded-name
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
    if (star?.[1]) {
      const decoded = decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ""));
      if (decoded.trim()) return sanitizeFilename(decoded.trim());
    }
    // Plain: filename="name.ext" or filename=name.ext
    const plain = /filename\s*=\s*"([^"]+)"/.exec(header) ?? /filename\s*=\s*([^;]+)/.exec(header);
    if (plain?.[1]) {
      const val = plain[1].trim().replace(/^["']|["']$/g, "").trim();
      if (val) return sanitizeFilename(val);
    }
  } catch {
    // decodeURIComponent can throw on malformed input — treat as no name.
  }
  return null;
}

function sanitizeFilename(name: string): string | null {
  // Strip any path components and control characters; keep it short.
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!clean) return null;
  return clean.slice(0, 200);
}

/**
 * Idempotently persist a discovered attachment name/size onto
 * message.metadata. `index` addresses the SAME combined list the UI and the
 * media proxy use: [metadata.attachment (if any), ...metadata.attachments].
 * Existing name/size values are never overwritten. Any error is swallowed —
 * this must never break the caller (media proxy / backfill).
 */
export async function persistAttachmentMeta(
  messageId: number,
  index: number,
  found: { name?: string | null; size?: number | null },
): Promise<void> {
  if (!found.name && !found.size) return;
  try {
    // Read-modify-write under a row lock so two concurrent writers (media
    // proxy + backfill workers) can't overwrite each other's metadata edits.
    await db.transaction(async (tx) => {
      const [msg] = await tx
        .select({ metadata: messagesTable.metadata })
        .from(messagesTable)
        .where(eq(messagesTable.id, messageId))
        .for("update");
      if (!msg) return;
      const meta = (msg.metadata ?? {}) as Record<string, any>;
      const hasSingle = !!meta.attachment;
      let target: Record<string, any> | undefined;
      if (hasSingle && index === 0) {
        target = meta.attachment;
      } else {
        const arrIdx = hasSingle ? index - 1 : index;
        if (Array.isArray(meta.attachments)) target = meta.attachments[arrIdx];
      }
      if (!target) return;
      let changed = false;
      if (found.name && !(typeof target.name === "string" && target.name.trim())) {
        target.name = found.name;
        changed = true;
      }
      if (found.size && Number.isFinite(found.size) && found.size > 0 && !target.fileSize && !target.size) {
        target.fileSize = found.size;
        changed = true;
      }
      if (!changed) return;
      await tx.update(messagesTable).set({ metadata: meta }).where(eq(messagesTable.id, messageId));
    });
  } catch (err: any) {
    console.error(`[attachmentNames] persist failed for message ${messageId}[${index}]:`, err?.message || err);
  }
}

// Attempted (messageId:index) pairs this process has already probed, so a
// conversation being reopened doesn't re-hit upstream for attachments whose
// name genuinely isn't available.
const attempted = new Set<string>();
const MAX_ATTEMPT_CACHE = 5000;

/**
 * Backfill names/sizes for old Zernio attachments of one conversation.
 * Fire-and-forget from the conversation-detail route: fetches upstream
 * HEADERS only (body cancelled immediately), max `CONCURRENCY` in flight,
 * silently skips on any failure. Idempotent — attachments that already have
 * a name are never touched.
 */
export async function backfillConversationAttachmentNames(conversationId: number): Promise<void> {
  const CONCURRENCY = 2;
  const MAX_PER_RUN = 10;
  try {
    const apiKey = await getZernioApiKey();
    if (!apiKey) return;

    const rows = await db
      .select({ id: messagesTable.id, metadata: messagesTable.metadata })
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, conversationId));

    type Job = { messageId: number; index: number; url: string };
    const jobs: Job[] = [];
    for (const row of rows) {
      const meta = (row.metadata ?? {}) as Record<string, any>;
      const all: Record<string, any>[] = [
        ...(meta.attachment ? [meta.attachment] : []),
        ...(Array.isArray(meta.attachments) ? meta.attachments : []),
      ];
      all.forEach((att, index) => {
        if (!att || typeof att !== "object") return;
        if (typeof att.name === "string" && att.name.trim()) return;
        if (att.type === "image") return; // images render inline; name matters for docs
        const url = String(att.url ?? att.fileUrl ?? "");
        let parsed: URL;
        try { parsed = new URL(url); } catch { return; }
        if (parsed.protocol !== "https:" || parsed.hostname !== "zernio.com") return;
        const key = `${row.id}:${index}`;
        if (attempted.has(key)) return;
        jobs.push({ messageId: row.id, index, url });
      });
      if (jobs.length >= MAX_PER_RUN) break;
    }
    if (jobs.length === 0) return;

    const queue = jobs.slice(0, MAX_PER_RUN);
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const job = queue.shift();
        if (!job) return;
        const key = `${job.messageId}:${job.index}`;
        if (attempted.has(key)) continue;
        if (attempted.size > MAX_ATTEMPT_CACHE) attempted.clear();
        attempted.add(key);
        try {
          const upstream = await fetch(job.url, {
            headers: { Authorization: `Bearer ${apiKey}` },
            redirect: "follow",
          });
          const name = parseContentDispositionFilename(upstream.headers.get("content-disposition"));
          const sizeRaw = Number(upstream.headers.get("content-length"));
          const size = Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : null;
          // We only need headers — drop the body without downloading it.
          try { await upstream.body?.cancel(); } catch { /* ignore */ }
          if (upstream.ok && (name || size)) {
            await persistAttachmentMeta(job.messageId, job.index, { name, size });
          }
        } catch {
          // Silent: backfill must never surface errors.
        }
      }
    });
    await Promise.all(workers);
  } catch (err: any) {
    console.error(`[attachmentNames] backfill failed for conversation ${conversationId}:`, err?.message || err);
  }
}
