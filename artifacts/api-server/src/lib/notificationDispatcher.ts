import { db, notificationRulesTable, notificationsTable, usersTable, integrationsTable, settingsTable } from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { sendEmail, buildNotificationEmail } from "./email";
import { notificationBus } from "./notificationBus";
import { decryptConfig } from "./encryption";
import { sendWhatsAppText, type WhatsAppConfig } from "./inbox/channels/whatsapp";
import { invalidateNotificationCounts } from "./notificationCountCache";
import { notificationPriority } from "./notificationPriority";

// ---------------------------------------------------------------------------
// Cached settings helper — suppress_automation_app_notifications
// ---------------------------------------------------------------------------
let _suppressCache: { value: boolean; expiresAt: number } | null = null;
const SUPPRESS_CACHE_TTL_MS = 60_000;

async function getSuppressAutomationAppNotifications(): Promise<boolean> {
  if (_suppressCache && Date.now() < _suppressCache.expiresAt) return _suppressCache.value;
  const [row] = await db.select({ v: settingsTable.suppressAutomationAppNotifications }).from(settingsTable).limit(1);
  const value = row?.v ?? true;
  _suppressCache = { value, expiresAt: Date.now() + SUPPRESS_CACHE_TTL_MS };
  return value;
}

export function invalidateSuppressAutomationCache(): void {
  _suppressCache = null;
}

interface DispatchContext {
  event: string;
  title: string;
  body: string;
  actionUrl?: string;
  icon?: string;
  recipientUserIds?: number[];
  actorUserId?: number;
  data?: Record<string, unknown>;
  emailOverride?: {
    subject: string;
    html: string;
    text: string;
  };
  templateVars?: Record<string, string>;
  createdSource?: string | null;
  /**
   * When set, the notification system also delivers an email to this external
   * (non-user) address — provided the rule is active AND "email" is in channels.
   * Used for transactional emails to signers who are not internal users.
   */
  externalEmail?: string;
  /**
   * Fallback email builder used when no custom template body is configured for
   * the rule. Only called when externalEmail is set and the rule/channels allow it.
   */
  externalEmailFallback?: () => Promise<{ subject: string; html: string; text: string }>;
}

interface LangTemplate {
  subject?: string;
  body?: string;
}

interface NotificationTemplate extends LangTemplate {
  translations?: Record<string, LangTemplate>;
}

/**
 * Resolve a notification template into the best subject/body for a recipient's
 * language. Fallback chain: requested language → legacy top-level (default) →
 * English → Turkish. Returns null when no usable template content exists, so
 * the caller can fall back to the generic title/body.
 */
function resolveTemplate(
  template: NotificationTemplate | undefined,
  lang: string | null | undefined
): LangTemplate | null {
  if (!template) return null;
  const translations = template.translations || {};
  const topLevel: LangTemplate | undefined =
    template.subject || template.body
      ? { subject: template.subject, body: template.body }
      : undefined;
  // Resolve subject and body INDEPENDENTLY through the chain so that a
  // language entry with only one field (e.g. body) still falls back to the
  // chain for the missing field instead of dropping to the generic title/body.
  const chain: (LangTemplate | undefined)[] = [
    lang ? translations[lang] : undefined,
    topLevel,
    translations["en"],
    translations["tr"],
  ];
  let subject: string | undefined;
  let body: string | undefined;
  for (const c of chain) {
    if (!c) continue;
    if (subject === undefined && c.subject) subject = c.subject;
    if (body === undefined && c.body) body = c.body;
    if (subject !== undefined && body !== undefined) break;
  }
  if (subject === undefined && body === undefined) return null;
  return { subject, body };
}

function replaceVars(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value || "");
  }
  return result;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Convert an admin-authored notification body to HTML for email. If the body
 * already contains HTML tags it is treated as trusted rich markup and rendered
 * as-is; otherwise plain text is escaped and newlines become <br>.
 */
function bodyToHtml(body: string): string {
  const hasTags = /<[a-z][\s\S]*>/i.test(body);
  if (hasTags) return body;
  return escapeHtml(body).replace(/\n/g, "<br>");
}

/**
 * Render an admin-authored template body to HTML with variable substitution.
 * When the body is rich HTML the author's markup is trusted, but interpolated
 * variable values (e.g. a user-controlled senderName) are HTML-escaped to
 * prevent markup/HTML injection into outgoing emails. Plain-text bodies are
 * substituted first, then fully escaped with newlines converted to <br>.
 */
function renderBodyHtml(body: string, vars: Record<string, string>): string {
  const hasTags = /<[a-z][\s\S]*>/i.test(body);
  if (hasTags) {
    const safeVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(vars)) safeVars[k] = escapeHtml(v || "");
    return replaceVars(body, safeVars);
  }
  return escapeHtml(replaceVars(body, vars)).replace(/\n/g, "<br>");
}

/** Strip HTML tags for channels that only support plain text (e.g. WhatsApp). */
function stripHtml(body: string): string {
  return body
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let waConfigCache: { config: WhatsAppConfig | null; fetchedAt: number } | null = null;
const WA_CONFIG_TTL = 60_000;

async function getWhatsAppConfig(): Promise<WhatsAppConfig | null> {
  if (waConfigCache && Date.now() - waConfigCache.fetchedAt < WA_CONFIG_TTL) {
    return waConfigCache.config;
  }
  try {
    const [row] = await db
      .select()
      .from(integrationsTable)
      .where(eq(integrationsTable.key, "whatsapp"));
    const config = row?.config
      ? (decryptConfig(row.config as Record<string, any>) as WhatsAppConfig)
      : null;
    waConfigCache = { config, fetchedAt: Date.now() };
    return config;
  } catch (err) {
    console.error("[NOTIFY] Failed to load WhatsApp config:", err);
    return null;
  }
}

export async function dispatchNotification(ctx: DispatchContext): Promise<void> {
  try {
    if (ctx.event.startsWith("application.") && ctx.createdSource === "automation") {
      if (await getSuppressAutomationAppNotifications()) return;
    }

    const [rule] = await db.select().from(notificationRulesTable)
      .where(and(eq(notificationRulesTable.event, ctx.event), eq(notificationRulesTable.isActive, true)));

    if (!rule) return;

    const channels = (rule.channels as string[]) || ["in_app"];
    const recipientType = rule.recipientType;
    const recipientRoles = (rule.recipientRoles as string[]) || [];
    const template = (rule.template as NotificationTemplate) || undefined;
    const vars = ctx.templateVars || {};

    let userIds: number[] = [];

    // When the caller provides explicit recipients (e.g., the assigned staff
    // for an assigned conversation), honor them exclusively and do NOT expand
    // with role-based fanout. Otherwise apply the rule's recipientType.
    if (ctx.recipientUserIds && ctx.recipientUserIds.length > 0) {
      userIds = [...ctx.recipientUserIds];
    } else if (recipientType === "role" && recipientRoles.length > 0) {
      const users = await db.select({ id: usersTable.id })
        .from(usersTable)
        .where(and(
          inArray(usersTable.role, recipientRoles),
          eq(usersTable.isActive, true)
        ));
      userIds = users.map(u => u.id);
    } else if (recipientType === "all") {
      const users = await db.select({ id: usersTable.id })
        .from(usersTable)
        .where(eq(usersTable.isActive, true));
      userIds = users.map(u => u.id);
    } else if (recipientType === "assigned" || recipientType === "owner" || recipientType === "specific") {
      if (recipientRoles.length > 0) {
        const users = await db.select({ id: usersTable.id })
          .from(usersTable)
          .where(and(
            inArray(usersTable.role, recipientRoles),
            eq(usersTable.isActive, true)
          ));
        userIds = users.map(u => u.id);
      }
    }

    if (ctx.actorUserId) {
      userIds = userIds.filter(id => id !== ctx.actorUserId);
    }

    if (userIds.length === 0 && !ctx.externalEmail) return;

    if (channels.includes("in_app")) {
      // Batched insert + parallel pg_notify so the notification list and the
      // recipient's badge update without 15 s polling.
      try {
        const inserted = await db.insert(notificationsTable).values(
          userIds.map(userId => ({
            userId,
            type: ctx.event,
            title: ctx.title,
            body: ctx.body,
            icon: ctx.icon,
            actionUrl: ctx.actionUrl,
            data: ctx.data || {},
            channel: "in_app",
          }))
        ).returning({ id: notificationsTable.id, userId: notificationsTable.userId });
        invalidateNotificationCounts(inserted.map(row => row.userId));
        for (const row of inserted) {
          notificationBus.publish({
            userId: row.userId,
            notificationId: row.id,
            type: ctx.event,
            title: ctx.title,
            body: ctx.body || null,
            data: ctx.data || {},
            priority: notificationPriority(ctx.event),
          });
        }
      } catch (err) {
        console.error(`[NOTIFY] Failed to create in-app notifications:`, err);
      }
    }

    // Email and WhatsApp deliveries are fire-and-forget: they do NOT block the
    // caller (e.g. webhook handler) so that SMTP rate-limits or slow WA API
    // calls never stall the request path. The in_app DB insert above is
    // always awaited — tests that check notification counts rely on it.
    if (channels.includes("email")) {
      (async () => {
        try {
          const users = await db.select({ id: usersTable.id, email: usersTable.email, language: usersTable.language })
            .from(usersTable)
            .where(and(
              inArray(usersTable.id, userIds),
              eq(usersTable.isActive, true)
            ));

          for (const user of users) {
            if (!user.email) continue;
            try {
              let emailContent = ctx.emailOverride;
              if (!emailContent) {
                const localized = resolveTemplate(template, user.language);
                const subject = localized?.subject
                  ? replaceVars(localized.subject, vars)
                  : ctx.title;
                const bodyHtml = localized?.body
                  ? renderBodyHtml(localized.body, vars)
                  : bodyToHtml(ctx.body);
                emailContent = await buildNotificationEmail({
                  subject,
                  bodyHtml,
                  actionUrl: ctx.actionUrl,
                  actionLabel: "View Details",
                  subtitle: "Notification",
                });
              }
              await sendEmail(user.email, emailContent);
            } catch (err) {
              console.error("[NOTIFY] Failed to send user email:", err);
            }
          }
        } catch (err) {
          console.error(`[NOTIFY] Email dispatch error for ${ctx.event}:`, err);
        }
      })();
    }

    // WhatsApp: actually deliver through the configured WA Cloud integration.
    // Free-form text only reaches users inside Meta's 24h customer-care window;
    // outside it, the API call is made but Meta may reject delivery. Approved
    // template (HSM) messaging is a separate concern. In development (without
    // ALLOW_LIVE_INTEGRATIONS) sendWhatsAppText returns a simulated success.
    if (channels.includes("whatsapp")) {
      (async () => {
        try {
          const waUsers = await db
            .select({ id: usersTable.id, phoneE164: usersTable.phoneE164, language: usersTable.language })
            .from(usersTable)
            .where(and(
              inArray(usersTable.id, userIds),
              eq(usersTable.isActive, true)
            ));
          const recipients = waUsers.filter(u => u.phoneE164);
          if (recipients.length > 0) {
            const config = await getWhatsAppConfig();
            if (!config) {
              console.error(`[NOTIFY] WhatsApp channel enabled for ${ctx.event} but no integration configured`);
            } else {
              for (const user of recipients) {
                try {
                  const localized = resolveTemplate(template, user.language);
                  const rawBody = localized?.body
                    ? replaceVars(localized.body, vars)
                    : ctx.body;
                  const text = stripHtml(rawBody) || ctx.title;
                  const result = await sendWhatsAppText({
                    config,
                    toPhoneE164: user.phoneE164!,
                    text,
                  });
                  if (!result.ok) {
                    console.error(`[NOTIFY] WhatsApp send failed to user ${user.id}: ${result.error}`);
                  }
                } catch (err) {
                  console.error(`[NOTIFY] WhatsApp send error to user ${user.id}:`, err);
                }
              }
            }
          }
        } catch (err) {
          console.error(`[NOTIFY] WhatsApp dispatch error for ${ctx.event}:`, err);
        }
      })();
    }

    // External email delivery — for transactional emails to non-user recipients
    // (e.g. external signers). Only sent when externalEmail is provided, the rule
    // is active (already guarded above via `if (!rule) return`), and "email" is
    // in the rule's channels. Honors isActive and channels like internal delivery.
    if (ctx.externalEmail && channels.includes("email")) {
      const externalEmailAddr = ctx.externalEmail;
      (async () => {
        try {
          const localized = resolveTemplate(template, null);
          let emailContent: { subject: string; html: string; text: string };
          if (localized?.subject || localized?.body) {
            const subject = localized.subject
              ? replaceVars(localized.subject, vars)
              : ctx.title;
            const bodyHtml = localized.body
              ? renderBodyHtml(localized.body, vars)
              : bodyToHtml(ctx.body);
            emailContent = await buildNotificationEmail({ subject, bodyHtml });
          } else if (ctx.externalEmailFallback) {
            emailContent = await ctx.externalEmailFallback();
          } else {
            emailContent = await buildNotificationEmail({
              subject: ctx.title,
              bodyHtml: bodyToHtml(ctx.body),
            });
          }
          await sendEmail(externalEmailAddr, emailContent);
        } catch (err) {
          console.error(`[NOTIFY] External email dispatch error for ${ctx.event}:`, err);
        }
      })();
    }
  } catch (err) {
    console.error(`[NOTIFY] Dispatch error for ${ctx.event}:`, err);
  }
}
