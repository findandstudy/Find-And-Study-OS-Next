import { db, channelAccountsTable } from "@workspace/db";
import { and, asc, desc, eq } from "drizzle-orm";
import { getZernioApiKey } from "./zernioSend";

/**
 * Zernio WhatsApp Template Management proxy.
 *
 * Lists, creates and deletes Meta-approved WhatsApp message templates through
 * the Zernio API (rather than talking to the Meta Graph API directly — the
 * account is registered/hosted on Zernio, same reasoning as zernioSend.ts).
 *
 * Confirmed Zernio endpoints (from openapi at docs.zernio.com/api/openapi):
 *   GET    /v1/whatsapp/templates?accountId=...            → list
 *   POST   /v1/whatsapp/templates                          → create
 *   DELETE /v1/whatsapp/templates/{templateName}?accountId=... → delete
 */

const ZERNIO_BASE = "https://zernio.com/api/v1/whatsapp";

export interface ZernioTemplateComponent {
  type: string;
  text?: string;
  format?: string;
  example?: Record<string, unknown>;
  buttons?: Array<Record<string, any>>;
}

export interface ZernioQuickReplyButton {
  text: string;
}

export interface NormalizedZernioTemplate {
  name: string;
  language: string;
  category: string;
  status: string;
  components: ZernioTemplateComponent[];
  bodyText: string;
  variableCount: number;
}

function normalizeLanguage(value: string | undefined | null): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

/**
 * Resolve the exact provider-side approved template that may be sent.
 *
 * The local message_templates table is a cross-account cache, so its
 * approvalStatus cannot prove that a template exists on a particular
 * WhatsApp number. Zernio/Meta is the source of truth. Prefer an exact
 * language match; only accept a base-language match when it is unique, and
 * return the provider language so callers do not send `en` to an `en_US`
 * template (or vice versa).
 */
export function findApprovedZernioTemplate(
  templates: NormalizedZernioTemplate[],
  templateName: string,
  preferredLanguage?: string | null,
): NormalizedZernioTemplate | null {
  const normalizedName = String(templateName || "").trim().toLowerCase();
  if (!normalizedName) return null;

  const approved = templates.filter((template) =>
    template.status === "approved" &&
    String(template.name || "").trim().toLowerCase() === normalizedName
  );
  if (approved.length === 0) return null;

  const requestedLanguage = normalizeLanguage(preferredLanguage);
  if (requestedLanguage) {
    const exact = approved.find((template) => normalizeLanguage(template.language) === requestedLanguage);
    if (exact) return exact;

    const requestedBase = requestedLanguage.split("_")[0];
    const baseMatches = approved.filter(
      (template) => normalizeLanguage(template.language).split("_")[0] === requestedBase,
    );
    if (baseMatches.length === 1) return baseMatches[0];
  }

  return approved.length === 1 ? approved[0] : null;
}

function extractBodyText(components: any[]): string {
  const body = components?.find((c) => String(c?.type).toUpperCase() === "BODY");
  return body?.text || "";
}

function countVariables(text: string): number {
  const matches = text.match(/\{\{\s*\d+\s*\}\}/g);
  return matches ? new Set(matches).size : 0;
}

function normalizeStatus(raw: string | undefined | null): string {
  const s = String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "pending_deletion" || s.includes("pending_delet")) return "pending_deletion";
  if (s === "in_appeal" || s === "appeal") return "in_appeal";
  if (s.includes("approve")) return "approved";
  if (s.includes("reject")) return "rejected";
  if (s.includes("pause")) return "paused";
  if (s.includes("disable")) return "disabled";
  if (s.includes("pending") || s.includes("review") || s.includes("submitted")) return "pending";
  return s || "unknown";
}

function normalizeTemplate(raw: any): NormalizedZernioTemplate {
  const components = Array.isArray(raw?.components) ? raw.components : [];
  const bodyText = extractBodyText(components) || raw?.body || "";
  return {
    name: raw?.name || raw?.templateName || "",
    language: raw?.language || raw?.lang || "en",
    category: (raw?.category || "utility").toLowerCase(),
    status: normalizeStatus(raw?.status),
    components,
    bodyText,
    variableCount: countVariables(bodyText),
  };
}

/**
 * Resolve an active Zernio-hosted WhatsApp channel account.
 *
 * Explicit account ids always win for existing conversations. When callers do
 * not have an account id (for example, a brand-new outbound conversation), use
 * the configured default and then a stable id fallback.
 */
export async function resolveZernioWhatsAppAccount(
  channelAccountId?: number | null,
): Promise<{
  id: number;
  externalAccountId: string;
  displayName: string;
  isDefault: boolean;
} | null> {
  const conditions = [
    eq(channelAccountsTable.provider, "zernio"),
    eq(channelAccountsTable.channel, "whatsapp"),
    eq(channelAccountsTable.isActive, true),
  ];
  if (channelAccountId != null) conditions.push(eq(channelAccountsTable.id, channelAccountId));
  const [acct] = await db
    .select()
    .from(channelAccountsTable)
    .where(and(...conditions))
    .orderBy(desc(channelAccountsTable.isDefault), asc(channelAccountsTable.id))
    .limit(1);
  if (!acct || !acct.externalAccountId) return null;
  return {
    id: acct.id,
    externalAccountId: acct.externalAccountId,
    displayName: acct.displayName,
    isDefault: acct.isDefault,
  };
}

export interface ZernioTemplateListOutcome {
  ok: boolean;
  templates: NormalizedZernioTemplate[];
  error?: string;
}

export async function listZernioWhatsAppTemplates(externalAccountId: string): Promise<ZernioTemplateListOutcome> {
  const apiKey = await getZernioApiKey();
  if (!apiKey) return { ok: false, templates: [], error: "zernio_api_key_not_configured" };

  // Correct endpoint: GET /v1/whatsapp/templates?accountId=...
  const url = `${ZERNIO_BASE}/templates?accountId=${encodeURIComponent(externalAccountId)}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const bodyText = await resp.text().catch(() => "");
    if (!resp.ok) {
      console.error(`[ZERNIO] list templates failed (${resp.status}):`, bodyText.slice(0, 600));
      return { ok: false, templates: [], error: `Zernio template list failed (${resp.status}): ${bodyText.slice(0, 200)}` };
    }
    let data: any = {};
    try { data = JSON.parse(bodyText); } catch { /* non-JSON */ }
    // Zernio response: { success: true, templates: [...] }
    const rawList: any[] = Array.isArray(data) ? data : (data?.templates || data?.data || []);
    return { ok: true, templates: rawList.map(normalizeTemplate) };
  } catch (err: any) {
    console.error("[ZERNIO] list templates error:", err?.message || err);
    return { ok: false, templates: [], error: `Zernio template list error: ${err?.message || "Unknown"}` };
  }
}

export type ZernioTemplateAvailabilityOutcome =
  | { ok: true; template: NormalizedZernioTemplate }
  | { ok: false; reason: "provider_unavailable" | "not_approved"; error?: string };

/** Fail-closed provider proof for one template on one WhatsApp account. */
export async function resolveApprovedZernioTemplate(params: {
  externalAccountId: string;
  templateName: string;
  preferredLanguage?: string | null;
}): Promise<ZernioTemplateAvailabilityOutcome> {
  const outcome = await listZernioWhatsAppTemplates(params.externalAccountId);
  if (!outcome.ok) {
    return {
      ok: false,
      reason: "provider_unavailable",
      error: outcome.error || "whatsapp_template_list_failed",
    };
  }

  const template = findApprovedZernioTemplate(
    outcome.templates,
    params.templateName,
    params.preferredLanguage,
  );
  if (!template) return { ok: false, reason: "not_approved" };
  return { ok: true, template };
}

export interface ZernioTemplateCreateParams {
  externalAccountId: string;
  mode: "custom" | "library";
  name: string;
  language: string;
  category?: string;
  bodyText?: string;
  footerText?: string;
  bodyExamples?: string[];
  quickReplyButtons?: ZernioQuickReplyButton[];
  libraryTemplateName?: string;
}

export interface ZernioTemplateCreateOutcome {
  ok: boolean;
  status?: string;
  error?: string;
  raw?: any;
}

export function buildZernioTemplateComponents(
  params: Pick<
    ZernioTemplateCreateParams,
    "mode" | "bodyText" | "footerText" | "bodyExamples" | "quickReplyButtons"
  >,
): ZernioTemplateComponent[] {
  if (params.mode !== "custom") return [];

  const components: ZernioTemplateComponent[] = [];
  const bodyComponent: ZernioTemplateComponent = {
    // Zernio's OpenAPI discriminator values are lowercase. Meta's own Graph
    // payloads are commonly shown with uppercase component names, but sending
    // those values to Zernio is rejected before the template reaches Meta.
    type: "body",
    text: params.bodyText || "",
  };
  if (params.bodyExamples?.length) {
    bodyComponent.example = { body_text: [params.bodyExamples] };
  }
  components.push(bodyComponent);
  if (params.footerText) components.push({ type: "footer", text: params.footerText });
  if (params.quickReplyButtons?.length) {
    components.push({
      type: "buttons",
      buttons: params.quickReplyButtons.map((button) => ({
        type: "quick_reply",
        text: button.text,
      })),
    });
  }
  return components;
}

export async function createZernioWhatsAppTemplate(
  params: ZernioTemplateCreateParams,
): Promise<ZernioTemplateCreateOutcome> {
  const apiKey = await getZernioApiKey();
  if (!apiKey) return { ok: false, error: "zernio_api_key_not_configured" };

  // Correct endpoint: POST /v1/whatsapp/templates
  const url = `${ZERNIO_BASE}/templates`;
  const components = buildZernioTemplateComponents(params);

  // WhatsApp template names: lowercase alphanumeric + underscores only.
  const normalizedName = params.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

  const body: Record<string, any> =
    params.mode === "library"
      ? {
          accountId: params.externalAccountId,
          name: normalizedName,
          language: params.language,
          category: String(params.category || "UTILITY").toUpperCase(),
          libraryTemplateName: params.libraryTemplateName,
        }
      : {
          accountId: params.externalAccountId,
          name: normalizedName,
          language: params.language,
          category: String(params.category || "UTILITY").toUpperCase(),
          components,
        };

  console.log("[ZERNIO create body]", JSON.stringify(body));

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const bodyText = await resp.text().catch(() => "");
    let data: any = {};
    try { data = JSON.parse(bodyText); } catch { /* non-JSON */ }
    if (!resp.ok) {
      console.error(`[ZERNIO] create template failed (${resp.status}):`, bodyText.slice(0, 600));
      return { ok: false, error: data?.error || data?.message || `Zernio template create failed (${resp.status}): ${bodyText.slice(0, 200)}`, raw: data };
    }
    return { ok: true, status: normalizeStatus(data?.status), raw: data };
  } catch (err: any) {
    console.error("[ZERNIO] create template error:", err?.message || err);
    return { ok: false, error: `Zernio template create error: ${err?.message || "Unknown"}` };
  }
}

export interface ZernioTemplateDeleteOutcome {
  ok: boolean;
  /** True when Zernio no longer has the template and the local cache is stale. */
  notFound?: boolean;
  error?: string;
}

export interface WhatsAppTemplateDeleteDecision {
  ok: boolean;
  /** The local cache may be removed even though Zernio could not confirm deletion. */
  localOnly?: boolean;
  remoteNotFound?: boolean;
  error?: string;
}

/**
 * An "unknown" row is not authoritative remote state. It is commonly a stale
 * local cache entry left by an older/renamed Meta template. Allow the exact
 * local row to be removed when Zernio management is unavailable, while keeping
 * approved/pending/rejected rows fail-closed.
 */
export function decideWhatsAppTemplateDeletion(params: {
  localApprovalStatus?: string | null;
  hasExactLocalTemplate: boolean;
  remoteOutcome: ZernioTemplateDeleteOutcome;
}): WhatsAppTemplateDeleteDecision {
  if (params.remoteOutcome.ok) {
    return {
      ok: true,
      localOnly: false,
      remoteNotFound: params.remoteOutcome.notFound === true,
    };
  }

  const normalizedStatus = String(params.localApprovalStatus || "unknown")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (params.hasExactLocalTemplate && normalizedStatus === "unknown") {
    return {
      ok: true,
      localOnly: true,
      remoteNotFound: false,
    };
  }

  return {
    ok: false,
    error: params.remoteOutcome.error || "Failed to delete WhatsApp template from Zernio",
  };
}

export async function deleteZernioWhatsAppTemplate(
  externalAccountId: string,
  templateName: string,
): Promise<ZernioTemplateDeleteOutcome> {
  const apiKey = await getZernioApiKey();
  if (!apiKey) return { ok: false, error: "zernio_api_key_not_configured" };

  // Correct endpoint: DELETE /v1/whatsapp/templates/{templateName}?accountId=...
  const url = `${ZERNIO_BASE}/templates/${encodeURIComponent(templateName)}?accountId=${encodeURIComponent(externalAccountId)}`;
  try {
    const resp = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const bodyText = await resp.text().catch(() => "");
    if (!resp.ok) {
      let data: any = {};
      try { data = JSON.parse(bodyText); } catch { /* non-JSON */ }
      console.error(`[ZERNIO] delete template failed (${resp.status}):`, bodyText.slice(0, 600));
      const remoteMessage = String(data?.error || data?.message || bodyText).toLowerCase();
      const isMissingRemote =
        resp.status === 404 ||
        remoteMessage.includes("not found") ||
        remoteMessage.includes("does not exist") ||
        remoteMessage.includes("unknown template");
      if (isMissingRemote) {
        return { ok: true, notFound: true };
      }
      return { ok: false, error: data?.error || data?.message || `Zernio template delete failed (${resp.status}): ${bodyText.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err: any) {
    console.error("[ZERNIO] delete template error:", err?.message || err);
    return { ok: false, error: `Zernio template delete error: ${err?.message || "Unknown"}` };
  }
}
