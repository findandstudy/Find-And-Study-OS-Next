import { db, channelAccountsTable, integrationsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { decryptConfig } from "../encryption";
import { ObjectStorageService } from "../objectStorage";
import {
  configuredInboxMediaHosts,
  resolveLocalInboxStorageKey,
} from "./mediaSource";

/**
 * Single source of truth for Zernio outbound sends.
 *
 * Both the manual staff reply (routes/inbox.ts) and the AI bot auto-reply
 * (lib/inbox/botAutoReply.ts) MUST send through here for Zernio-hosted
 * conversations. The historical bug: bot replies went through the direct
 * Meta Graph API senders with a Zernio-hosted account → Zernio/WhatsApp
 * rejected with "The account is not registered".
 */

export interface ZernioAttachment {
  url: string;
  type?: string;
  name?: string;
  /** Render an OGG/Opus audio attachment as a WhatsApp push-to-talk bubble. */
  voiceNote?: boolean;
}

export interface ZernioSendParams {
  /** Zernio conversation id (conversations.external_thread_id). */
  externalThreadId: string;
  /** Zernio account id (channel_accounts.external_account_id). */
  externalAccountId: string;
  text?: string;
  attachments?: ZernioAttachment[];
}

export interface ZernioSendOutcome {
  /** True when at least one payload (text or attachment) was accepted. */
  ok: boolean;
  /** Set when any payload failed — can coexist with ok=true (partial send). */
  error?: string;
  externalMessageId?: string;
}

// Test injection seam — unit tests replace the network call.
let __zernioSendOverride: ((params: ZernioSendParams) => Promise<ZernioSendOutcome>) | null = null;
export function __setZernioSendOverrideForTests(
  fn: ((params: ZernioSendParams) => Promise<ZernioSendOutcome>) | null,
): void {
  __zernioSendOverride = fn;
}

/**
 * Resolve the conversation's channel account IF it is Zernio-hosted.
 * Returns null when the account is absent or belongs to another provider —
 * callers then fall back to the direct channel senders.
 */
export async function resolveZernioAccount(
  channelAccountId: number | null | undefined,
): Promise<{ id: number; externalAccountId: string } | null> {
  if (channelAccountId == null) return null;
  const [acct] = await db
    .select()
    .from(channelAccountsTable)
    .where(
      and(
        eq(channelAccountsTable.id, channelAccountId),
        eq(channelAccountsTable.provider, "zernio"),
      ),
    );
  if (!acct || !acct.externalAccountId) return null;
  return { id: acct.id, externalAccountId: acct.externalAccountId };
}

// Test injection seam — unit tests bypass the DB-backed integrations read.
let __zernioApiKeyOverride: string | null = null;
export function __setZernioApiKeyOverrideForTests(key: string | null): void {
  __zernioApiKeyOverride = key;
}

/** Read the (encrypted) Zernio API key from the integrations row. */
export async function getZernioApiKey(): Promise<string | null> {
  if (__zernioApiKeyOverride) return __zernioApiKeyOverride;
  const [row] = await db
    .select()
    .from(integrationsTable)
    .where(eq(integrationsTable.key, "zernio"));
  if (!row) return null;
  const cfg = decryptConfig(row.config as Record<string, any>) as { apiKey?: string };
  return cfg.apiKey || null;
}

/** Never log the raw API key — only enough to correlate log lines by eye. */
function maskApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

/**
 * Send a text and/or attachments to a Zernio conversation.
 * Text goes first; each attachment is a separate POST (Zernio API shape).
 * `ok` mirrors "anything was delivered"; `error` carries the first failure so
 * a partial send is reported as sent-with-error (same semantics the manual
 * inbox route always had).
 *
 * STRICT CONTRACT (do not weaken): a send is only ever considered successful
 * when Zernio replies 2xx AND the response body contains a `messageId`. A 2xx
 * with no `messageId` is treated as a failure — Zernio has historically
 * returned 2xx for payloads it silently dropped (e.g. unreachable
 * attachmentUrl), which previously caused messages to be marked "sent" while
 * nothing was actually delivered. Every request/response is logged in full
 * (API key masked) so a persistent contract mismatch is diagnosable from logs
 * alone.
 */
export async function sendViaZernio(params: ZernioSendParams): Promise<ZernioSendOutcome> {
  if (__zernioSendOverride) return __zernioSendOverride(params);

  const apiKey = await getZernioApiKey();
  if (!apiKey) return { ok: false, error: "zernio_api_key_not_configured" };
  if (!params.externalThreadId) return { ok: false, error: "zernio_no_external_thread" };

  const url = `https://zernio.com/api/v1/inbox/conversations/${encodeURIComponent(params.externalThreadId)}/messages`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  let ok = false;
  let error: string | undefined;
  let externalMessageId: string | undefined;

  try {
    const text = params.text?.trim();
    if (text) {
      console.log("[ZERNIO] text send request:", JSON.stringify({
        url,
        accountId: params.externalAccountId,
        externalThreadId: params.externalThreadId,
        textLength: text.length,
        auth: `Bearer ${maskApiKey(apiKey)}`,
      }));
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: params.externalAccountId, message: text }),
      });
      const bodyText = await resp.text().catch(() => "");
      console.log(`[ZERNIO] text send response (${resp.status}):`, bodyText);
      if (resp.ok) {
        let data: any = {};
        try { data = JSON.parse(bodyText); } catch { /* non-JSON body */ }
        const messageId = data?.data?.messageId
          ? String(data.data.messageId)
          : data?.messageId
            ? String(data.messageId)
            : undefined;
        if (messageId) {
          ok = true;
          externalMessageId = messageId;
        } else {
          error = `Zernio text send returned ${resp.status} but no messageId in response: ${bodyText}`;
          console.error("[ZERNIO] " + error);
        }
      } else {
        error = `Zernio text send failed (${resp.status}): ${bodyText}`;
        console.error("[ZERNIO] " + error);
      }
    }
    if (params.attachments?.length && !error) {
      for (const att of params.attachments) {
        const outcome = await sendZernioAttachment(url, apiKey, params.externalAccountId, att);
        if (outcome.ok) {
          ok = true;
          if (!externalMessageId && outcome.externalMessageId) {
            externalMessageId = outcome.externalMessageId;
          }
        } else {
          error = outcome.error;
          break;
        }
      }
    }
  } catch (err: any) {
    error = `Zernio send error: ${err?.message || "Unknown"}`;
    console.error("[ZERNIO] send exception:", err?.stack || err);
  }

  return { ok, error, externalMessageId };
}

// ── Template send via Zernio (BROADCAST flow) ───────────────────────────────
//
// Zernio's inbox messages endpoint ONLY accepts free text ({accountId,
// message}) — posting a Meta Cloud API-shaped template body returns
// 400 "Message, attachment, or interactive content is required".
// Per Zernio docs the ONLY way to send an approved WhatsApp template (even to
// a single recipient) is the 3-step broadcast flow:
//   1. POST /api/v1/broadcasts { profileId, accountId, platform, name, template }
//   2. POST /api/v1/broadcasts/{id}/recipients { phones: [E.164] }
//   3. POST /api/v1/broadcasts/{id}/send → { sent, failed }

/** In-memory cache for resolved Zernio profile ids (broadcasts need them). */
const _profileIdCache = new Map<string, { id: string; fetchedAt: number }>();
const PROFILE_ID_TTL_MS = 60 * 60 * 1000; // 1h — profiles virtually never change

export function __clearZernioProfileCacheForTests(): void {
  _profileIdCache.clear();
}

/**
 * Resolve the Zernio profile that OWNS the selected WhatsApp account.
 *
 * A Zernio broadcast requires a matching profileId + accountId pair. Picking
 * the default profile is unsafe when the tenant has WhatsApp accounts under
 * multiple Zernio profiles: the template may be approved on the shared WABA,
 * yet Zernio rejects the broadcast because accountId belongs to another
 * profile.
 *
 * When externalAccountId is supplied we resolve its populated profileId from
 * GET /api/v1/accounts and fail closed if that exact relationship cannot be
 * proven. The legacy default-profile lookup remains available only for callers
 * that do not have an account id.
 */
export async function resolveZernioProfileId(
  apiKey: string,
  externalAccountId?: string | null,
): Promise<{ id: string | null; error?: string }> {
  const requestedAccountId = externalAccountId?.trim() || null;
  // Zernio is configured through one tenant-wide API key. Keep credentials
  // out of cache keys; the account id alone is the stable ownership key.
  const cacheKey = requestedAccountId || "__default__";
  const cached = _profileIdCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PROFILE_ID_TTL_MS) {
    return { id: cached.id };
  }

  if (requestedAccountId) {
    const accountsUrl = "https://zernio.com/api/v1/accounts?platform=whatsapp&includeOverLimit=true";
    try {
      console.log("[ZERNIO] resolve account profile request:", JSON.stringify({
        url: accountsUrl,
        accountId: requestedAccountId,
        auth: `Bearer ${maskApiKey(apiKey)}`,
      }));
      const resp = await fetch(accountsUrl, { headers: { Authorization: `Bearer ${apiKey}` } });
      const bodyText = await resp.text().catch(() => "");
      if (!resp.ok) {
        console.error(`[ZERNIO] resolve account profile failed (${resp.status})`);
        return { id: null, error: `Zernio hesabının bağlı olduğu profil çözümlenemedi (HTTP ${resp.status})` };
      }

      let data: any = {};
      try { data = JSON.parse(bodyText); } catch { /* non-JSON */ }
      const accounts: any[] = Array.isArray(data)
        ? data
        : Array.isArray(data?.accounts)
          ? data.accounts
          : Array.isArray(data?.data?.accounts)
            ? data.data.accounts
            : Array.isArray(data?.data)
              ? data.data
              : [];
      console.log("[ZERNIO] resolve account profile response:", JSON.stringify({
        status: resp.status,
        accountCount: accounts.length,
        requestedAccountFound: accounts.some((account) =>
          String(account?._id ?? account?.id ?? account?.accountId ?? "") === requestedAccountId),
      }));

      const account = accounts.find((candidate) =>
        String(candidate?._id ?? candidate?.id ?? candidate?.accountId ?? "") === requestedAccountId);
      if (!account) {
        return {
          id: null,
          error: "Zernio hesabının bağlı olduğu profil çözümlenemedi (seçilen WhatsApp hesabı bulunamadı)",
        };
      }

      const rawProfile = account?.profileId ?? account?.profile;
      const id =
        typeof rawProfile === "string"
          ? rawProfile
          : rawProfile?._id
            ? String(rawProfile._id)
            : rawProfile?.id
              ? String(rawProfile.id)
              : null;
      if (!id) {
        return {
          id: null,
          error: "Zernio hesabının bağlı olduğu profil çözümlenemedi (hesapta profileId alanı yok)",
        };
      }

      _profileIdCache.set(cacheKey, { id, fetchedAt: Date.now() });
      return { id };
    } catch (err: any) {
      return {
        id: null,
        error: `Zernio hesabının bağlı olduğu profil çözümlenemedi: ${err?.message || "bilinmeyen hata"}`,
      };
    }
  }

  const url = "https://zernio.com/api/v1/profiles";
  try {
    console.log("[ZERNIO] resolve profile request:", JSON.stringify({ url, auth: `Bearer ${maskApiKey(apiKey)}` }));
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    const bodyText = await resp.text().catch(() => "");
    console.log(`[ZERNIO] resolve profile response (${resp.status}):`, bodyText.slice(0, 600));
    if (!resp.ok) {
      return { id: null, error: `Zernio profili çözümlenemedi (HTTP ${resp.status})` };
    }
    let data: any = {};
    try { data = JSON.parse(bodyText); } catch { /* non-JSON */ }
    const profiles: any[] = Array.isArray(data) ? data : (data?.profiles || data?.data || []);
    if (!Array.isArray(profiles) || profiles.length === 0) {
      return { id: null, error: "Zernio profili çözümlenemedi (hesapta profil bulunamadı)" };
    }
    const chosen = profiles.find((p) => p?.isDefault === true) || profiles[0];
    const id = chosen?._id ? String(chosen._id) : chosen?.id ? String(chosen.id) : null;
    if (!id) return { id: null, error: "Zernio profili çözümlenemedi (profil id alanı yok)" };
    _profileIdCache.set(cacheKey, { id, fetchedAt: Date.now() });
    return { id };
  } catch (err: any) {
    return { id: null, error: `Zernio profili çözümlenemedi: ${err?.message || "bilinmeyen hata"}` };
  }
}

/** One entry of Zernio's broadcast variableMapping. */
export interface ZernioVariableMapping {
  field: "name" | "phone" | "email" | "company" | "custom";
  customValue?: string;
}

export interface ZernioTemplateSendParams {
  /** Zernio account id (channel_accounts.external_account_id). */
  externalAccountId: string;
  templateName: string;
  language: string;
  /** Recipient phone in E.164 (leading +). */
  toPhoneE164: string;
  /**
   * Positional template parameters ({{1}}, {{2}}, …). Mapped to Zernio's
   * variableMapping as { "<n>": { field: "custom", customValue } }.
   * The CALLER must validate the count against the template's placeholder
   * count BEFORE calling (Meta rejects mismatches with error 132000).
   */
  parameters?: string[];
  /** Human-readable label (student name / phone) for the broadcast name. */
  recipientLabel?: string;
}

export interface ZernioTemplateSendOutcome extends ZernioSendOutcome {
  /** Zernio broadcast id — persisted in message metadata for webhook matching. */
  broadcastId?: string;
  /** Result of the final send step, when it was reached. */
  sent?: number;
  failed?: number;
}

/** Turn a raw step failure into a human-readable (Turkish) user message. */
function humanizeZernioTemplateError(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes("131047") || s.includes("24 hour") || s.includes("24-hour") || s.includes("re-engagement")) {
    return "Template gönderilemedi: 24 saat kuralı — müşteri son 24 saat içinde yazmadığı için yalnızca onaylı template gönderilebilir; template'in Meta onayının geçerli olduğundan emin olun.";
  }
  if (s.includes("not approved") || s.includes("132001") || s.includes("template not found") || s.includes("does not exist")) {
    return "Template gönderilemedi: template Meta tarafından onaylı değil veya bu isim/dilde bulunamadı.";
  }
  if (s.includes("132000") || s.includes("parameter")) {
    return "Template gönderilemedi: parametre sayısı template ile uyuşmuyor.";
  }
  return `Template gönderilemedi: ${raw}`;
}

/**
 * Send a WhatsApp template to a single recipient through Zernio's broadcast
 * flow (create → add recipient → send). This must be used instead of the
 * direct Meta Graph API for Zernio-hosted numbers.
 *
 * STRICT CONTRACT: only a send step that reports sent >= 1 and failed === 0
 * counts as delivered — `{ sent: 0, failed: 1 }` is a failure.
 */
export async function sendZernioTemplate(params: ZernioTemplateSendParams): Promise<ZernioTemplateSendOutcome> {
  const apiKey = await getZernioApiKey();
  if (!apiKey) return { ok: false, error: "Template gönderilemedi: Zernio API anahtarı yapılandırılmamış." };
  if (!params.toPhoneE164 || !params.toPhoneE164.startsWith("+")) {
    return { ok: false, error: "Template gönderilemedi: alıcının E.164 formatında telefon numarası yok." };
  }

  const profile = await resolveZernioProfileId(apiKey, params.externalAccountId);
  if (!profile.id) {
    return { ok: false, error: `Template gönderilemedi: ${profile.error || "Zernio profili çözümlenemedi"}` };
  }

  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const baseUrl = "https://zernio.com/api/v1/broadcasts";

  // Readable name so the broadcast is identifiable in the Zernio panel.
  const label = (params.recipientLabel || params.toPhoneE164).slice(0, 60);
  const broadcastName = `CRM template — ${params.templateName} — ${label} — ${new Date().toISOString()}`;

  const variableMapping =
    params.parameters && params.parameters.length > 0
      ? Object.fromEntries(
          params.parameters.map((p, i) => [String(i + 1), { field: "custom", customValue: p } satisfies ZernioVariableMapping]),
        )
      : undefined;

  try {
    // ── Step 1: create broadcast ─────────────────────────────────────────
    const createBody = {
      profileId: profile.id,
      accountId: params.externalAccountId,
      platform: "whatsapp",
      name: broadcastName,
      template: {
        name: params.templateName,
        language: params.language,
        ...(variableMapping ? { variableMapping } : {}),
      },
    };
    console.log("[ZERNIO] broadcast create request:", JSON.stringify({
      url: baseUrl,
      profileId: profile.id,
      accountId: params.externalAccountId,
      templateName: params.templateName,
      language: params.language,
      paramCount: params.parameters?.length ?? 0,
      broadcastName,
      auth: `Bearer ${maskApiKey(apiKey)}`,
    }));
    const createResp = await fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(createBody) });
    const createText = await createResp.text().catch(() => "");
    console.log(`[ZERNIO] broadcast create response (${createResp.status}):`, createText.slice(0, 600));
    if (!createResp.ok) {
      console.error(`[ZERNIO] broadcast create failed (${createResp.status}):`, createText.slice(0, 600));
      return { ok: false, error: humanizeZernioTemplateError(`broadcast oluşturulamadı (HTTP ${createResp.status}) — ${createText.slice(0, 300)}`) };
    }
    let createData: any = {};
    try { createData = JSON.parse(createText); } catch { /* non-JSON */ }
    const broadcastId: string | undefined =
      createData?.broadcast?.id ?? createData?.broadcast?._id ?? createData?.id ?? createData?._id ?? undefined;
    if (!broadcastId) {
      console.error("[ZERNIO] broadcast create returned no id:", createText.slice(0, 300));
      return { ok: false, error: "Template gönderilemedi: broadcast oluşturulamadı (Zernio yanıtında broadcast id yok)." };
    }

    // ── Step 2: add recipient ────────────────────────────────────────────
    const recUrl = `${baseUrl}/${encodeURIComponent(String(broadcastId))}/recipients`;
    console.log("[ZERNIO] broadcast recipients request:", JSON.stringify({ url: recUrl, recipientCount: 1 }));
    const recResp = await fetch(recUrl, { method: "POST", headers, body: JSON.stringify({ phones: [params.toPhoneE164] }) });
    const recText = await recResp.text().catch(() => "");
    console.log(`[ZERNIO] broadcast recipients response (${recResp.status}):`, recText.slice(0, 600));
    if (!recResp.ok) {
      console.error(`[ZERNIO] broadcast recipients failed (${recResp.status}):`, recText.slice(0, 600));
      return {
        ok: false,
        broadcastId: String(broadcastId),
        error: humanizeZernioTemplateError(`alıcı eklenemedi (HTTP ${recResp.status}) — ${recText.slice(0, 300)}`),
      };
    }

    // ── Step 3: send ─────────────────────────────────────────────────────
    const sendUrl = `${baseUrl}/${encodeURIComponent(String(broadcastId))}/send`;
    console.log("[ZERNIO] broadcast send request:", JSON.stringify({ url: sendUrl }));
    const sendResp = await fetch(sendUrl, { method: "POST", headers, body: JSON.stringify({}) });
    const sendText = await sendResp.text().catch(() => "");
    console.log(`[ZERNIO] broadcast send response (${sendResp.status}):`, sendText.slice(0, 600));
    if (!sendResp.ok) {
      console.error(`[ZERNIO] broadcast send failed (${sendResp.status}):`, sendText.slice(0, 600));
      return {
        ok: false,
        broadcastId: String(broadcastId),
        error: humanizeZernioTemplateError(`gönderilemedi (HTTP ${sendResp.status}) — ${sendText.slice(0, 300)}`),
      };
    }
    let sendData: any = {};
    try { sendData = JSON.parse(sendText); } catch { /* non-JSON */ }
    const sent = Number(sendData?.sent ?? sendData?.data?.sent ?? 0);
    const failed = Number(sendData?.failed ?? sendData?.data?.failed ?? 0);

    // {sent:0, failed:1} (or any zero-sent outcome) must NOT be marked sent.
    if (sent < 1 || failed > 0) {
      console.error(`[ZERNIO] broadcast send reported sent=${sent} failed=${failed} for broadcast ${broadcastId}`);
      return {
        ok: false,
        broadcastId: String(broadcastId),
        sent,
        failed,
        error: humanizeZernioTemplateError(`gönderilemedi (Zernio raporu: sent=${sent}, failed=${failed})`),
      };
    }

    return { ok: true, broadcastId: String(broadcastId), sent, failed };
  } catch (err: any) {
    console.error("[ZERNIO] template broadcast exception:", err?.stack || err);
    return { ok: false, error: `Template gönderilemedi: ${err?.message || "bilinmeyen hata"}` };
  }
}

// ── Attachment upload (2-step) ────────────────────────────────────────────────
// Step 1: POST https://zernio.com/api/v1/media/upload-direct with the file
//   bytes as multipart/form-data (field name "file") → { url, filename,
//   contentType, size }.  The returned `url` is publicly accessible.
// Step 2: POST the conversation messages endpoint as JSON with
//   { accountId, message?, attachmentUrl: <url>, attachmentType: <type> }.
//
// The old approach (posting multipart directly to the messages endpoint) let
// Zernio return 200 with no messageId while silently dropping the attachment.
// Now a missing messageId on the send step still marks the message failed, but
// we should never reach that branch if upload-direct succeeded.

let _storage: ObjectStorageService | null = null;
function getStorage(): ObjectStorageService {
  if (!_storage) _storage = new ObjectStorageService();
  return _storage;
}

/**
 * The inbox composer builds attachment URLs as
 * `${origin}/api/storage/public-objects/${objectPath}` where `objectPath` is
 * the value returned by the upload-URL endpoint — which already carries a
 * leading `/objects/` prefix meant for the AUTHENTICATED `/storage/objects/*`
 * route, not this public one. That produces keys like
 * `/objects/inbox/<uuid>` (with a stray leading slash, i.e. a `//` in the
 * full URL) instead of the real on-disk key `inbox/<uuid>`. Normalize away
 * both artifacts here so we resolve to the same key the storage layer
 * actually used when writing the file.
 */
/**
 * Load the attachment bytes. Attachments uploaded from the inbox composer have
 * legacy public-object URLs or the authenticated object URL; we read those
 * straight from our own storage (no HTTP round-trip). Anything else is fetched
 * over HTTP as a best effort.
 */
async function downloadAttachmentBytes(
  attUrl: string,
  apiKey?: string,
): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const filePath = resolveLocalInboxStorageKey(
      attUrl,
      configuredInboxMediaHosts(["apply.findandstudy.com"]),
    );
    if (filePath) {
      console.log("[ZERNIO] resolving attachment storage key:", { filePath });
      const storage = getStorage();
      const file = await storage
        .getObjectEntityFile(`/objects/${filePath}`)
        .catch(() => storage.searchPublicObject(filePath));
      if (!file) {
        console.warn("[ZERNIO] attachment object not found in storage:", filePath);
        return null;
      }
      const [buf] = await file.download();
      const [meta] = await file.getMetadata();
      return { buf, contentType: meta.contentType || "application/octet-stream" };
    }
    // External URL. Zernio-hosted media requires the Bearer key (forwarded
    // attachments reference zernio.com URLs); everything else is fetched
    // without credentials.
    let isZernioHost = false;
    try {
      const u = new URL(attUrl);
      isZernioHost = u.protocol === "https:" && u.hostname === "zernio.com";
    } catch { /* not a valid absolute URL — plain fetch will fail below */ }
    const resp = await fetch(attUrl, {
      headers: isZernioHost && apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      redirect: "follow",
    });
    if (!resp.ok) {
      console.warn(`[ZERNIO] attachment fetch failed (${resp.status}) for external URL`);
      return null;
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    return { buf, contentType: resp.headers.get("content-type") || "application/octet-stream" };
  } catch (err: any) {
    console.warn("[ZERNIO] attachment byte load error:", err?.message || err);
    return null;
  }
}

/** Map MIME type to the Zernio attachmentType enum. */
function mimeToZernioAttachmentType(contentType: string): string {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  return "file";
}

/**
 * Voice notes use Zernio's official multipart `voiceNote=true` endpoint.
 * Zernio transcodes browser-native recordings to WhatsApp OGG/Opus.
 *
 * Other attachments use two-step delivery:
 *   1. Upload the raw bytes to /v1/media/upload-direct (multipart, field "file")
 *      → Zernio returns { url, filename, contentType, size }; the url is public.
 *   2. POST the conversation messages endpoint as JSON with attachmentUrl + attachmentType.
 *
 * STRICT CONTRACT: only a 2xx messages response that contains a `messageId`
 * counts as delivered. upload-direct failure → immediate failed, no send attempt.
 */
async function sendZernioAttachment(
  messagesUrl: string,
  apiKey: string,
  externalAccountId: string,
  att: ZernioAttachment,
): Promise<ZernioSendOutcome> {
  const name = att.name || "attachment";
  const bytes = await downloadAttachmentBytes(att.url, apiKey);

  if (!bytes) {
    const error = `Zernio attachment bytes unavailable for "${name}" (source url: ${att.url})`;
    console.error("[ZERNIO] " + error);
    return { ok: false, error };
  }

  if (att.voiceNote) {
    const voiceForm = new FormData();
    voiceForm.append("accountId", externalAccountId);
    voiceForm.append(
      "attachment",
      new Blob([new Uint8Array(bytes.buf)], { type: bytes.contentType }),
      name,
    );
    voiceForm.append("voiceNote", "true");

    console.log("[ZERNIO] send-voice-note request:", JSON.stringify({
      messagesUrl,
      fileName: name,
      fileSize: bytes.buf.length,
      contentType: bytes.contentType,
      voiceNote: true,
      auth: `Bearer ${maskApiKey(apiKey)}`,
    }));

    const voiceResp = await fetch(messagesUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: voiceForm,
    });
    const voiceBodyText = await voiceResp.text().catch(() => "");
    console.log(`[ZERNIO] send-voice-note response (${voiceResp.status}):`, voiceBodyText);

    if (!voiceResp.ok) {
      const error = `Zernio send-voice-note failed (${voiceResp.status}): ${voiceBodyText}`;
      console.error("[ZERNIO] " + error);
      return { ok: false, error };
    }

    let voiceData: any = {};
    try { voiceData = JSON.parse(voiceBodyText); } catch { /* non-JSON */ }
    const voiceMessageId = voiceData?.data?.messageId
      ? String(voiceData.data.messageId)
      : voiceData?.messageId
        ? String(voiceData.messageId)
        : undefined;
    if (voiceMessageId) {
      return { ok: true, externalMessageId: voiceMessageId };
    }

    const error = `Zernio send-voice-note returned ${voiceResp.status} but no messageId in response: ${voiceBodyText}`;
    console.error("[ZERNIO] " + error);
    return { ok: false, error };
  }

  // ── Step 1: upload-direct ────────────────────────────────────────────────
  const uploadUrl = "https://zernio.com/api/v1/media/upload-direct";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes.buf)], { type: bytes.contentType }), name);
  form.append("contentType", bytes.contentType);

  console.log("[ZERNIO] upload-direct request:", JSON.stringify({
    uploadUrl,
    fileName: name,
    fileSize: bytes.buf.length,
    contentType: bytes.contentType,
    auth: `Bearer ${maskApiKey(apiKey)}`,
  }));

  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` }, // no Content-Type — fetch sets the boundary
    body: form,
  });
  const uploadBodyText = await uploadResp.text().catch(() => "");
  console.log(`[ZERNIO] upload-direct response (${uploadResp.status}):`, uploadBodyText);

  if (!uploadResp.ok) {
    const error = `Zernio upload-direct failed (${uploadResp.status}): ${uploadBodyText}`;
    console.error("[ZERNIO] " + error);
    return { ok: false, error };
  }

  let uploadData: any = {};
  try { uploadData = JSON.parse(uploadBodyText); } catch { /* non-JSON */ }
  const publicUrl: string | undefined = uploadData?.url;
  if (!publicUrl) {
    const error = `Zernio upload-direct returned ${uploadResp.status} but no url in response: ${uploadBodyText}`;
    console.error("[ZERNIO] " + error);
    return { ok: false, error };
  }

  // ── Step 2: send-inbox-message via JSON ──────────────────────────────────
  const attachmentType = mimeToZernioAttachmentType(uploadData?.contentType || bytes.contentType);
  const sendBody: Record<string, string | boolean> = {
    accountId: externalAccountId,
    attachmentUrl: publicUrl,
    attachmentType,
  };
  if (attachmentType === "file" && name) {
    sendBody.attachmentName = name;
  }
  console.log("[ZERNIO] send-attachment request:", JSON.stringify({
    messagesUrl,
    attachmentUrl: publicUrl,
    attachmentType,
    attachmentName: sendBody.attachmentName,
    auth: `Bearer ${maskApiKey(apiKey)}`,
  }));

  const sendResp = await fetch(messagesUrl, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(sendBody),
  });
  const sendBodyText = await sendResp.text().catch(() => "");
  console.log(`[ZERNIO] send-attachment response (${sendResp.status}):`, sendBodyText);

  if (!sendResp.ok) {
    const error = `Zernio send-attachment failed (${sendResp.status}): ${sendBodyText}`;
    console.error("[ZERNIO] " + error);
    return { ok: false, error };
  }

  let sendData: any = {};
  try { sendData = JSON.parse(sendBodyText); } catch { /* non-JSON */ }
  const messageId = sendData?.data?.messageId
    ? String(sendData.data.messageId)
    : sendData?.messageId
      ? String(sendData.messageId)
      : undefined;
  if (messageId) {
    return { ok: true, externalMessageId: messageId };
  }

  const error = `Zernio send-attachment returned ${sendResp.status} but no messageId in response: ${sendBodyText}`;
  console.error("[ZERNIO] " + error);
  return { ok: false, error };
}
