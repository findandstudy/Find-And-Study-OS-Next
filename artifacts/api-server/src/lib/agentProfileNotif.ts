import { db, notificationsTable, usersTable } from "@workspace/db";
import { and, inArray, eq } from "drizzle-orm";
import { notificationBus } from "./notificationBus";
import { invalidateNotificationCounts } from "./notificationCountCache";

const AGENT_PROFILE_NOTIF: Record<string, { title: string; body: string }> = {
  en: { title: "Agent profile updated", body: "{{agentName}} updated their profile: {{fields}}" },
  tr: { title: "Acente profili güncellendi", body: "{{agentName}} profilini güncelledi: {{fields}}" },
  ar: { title: "تم تحديث ملف الوكيل", body: "{{agentName}} قام بتحديث ملفه الشخصي: {{fields}}" },
  fr: { title: "Profil de l'agent mis à jour", body: "{{agentName}} a mis à jour son profil : {{fields}}" },
  ru: { title: "Профиль агента обновлён", body: "{{agentName}} обновил профиль: {{fields}}" },
  fa: { title: "پروفایل نماینده به‌روز شد", body: "{{agentName}} پروفایل خود را به‌روز کرد: {{fields}}" },
  zh: { title: "代理商档案已更新", body: "{{agentName}} 更新了档案：{{fields}}" },
  hi: { title: "एजेंट प्रोफ़ाइल अपडेट किया गया", body: "{{agentName}} ने अपना प्रोफ़ाइल अपडेट किया: {{fields}}" },
  es: { title: "Perfil del agente actualizado", body: "{{agentName}} actualizó su perfil: {{fields}}" },
  id: { title: "Profil agen diperbarui", body: "{{agentName}} memperbarui profilnya: {{fields}}" },
};

export function formatFieldChanges(changedFields: Record<string, { from: unknown; to: unknown }>): string {
  return Object.entries(changedFields).map(([key, { from, to }]) => {
    if (key === "logoUrl" || key === "businessCertUrl") {
      const hasNew = to != null && String(to).trim().length > 0;
      return `${key}: [${hasNew ? "updated" : "removed"}]`;
    }
    const fromStr = from != null && String(from).trim() !== "" ? `'${from}'` : "\u2014";
    const toStr = to != null && String(to).trim() !== "" ? `'${to}'` : "\u2014";
    return `${key}: ${fromStr} \u2192 ${toStr}`;
  }).join(", ");
}

export async function dispatchAgentProfileChangedNotif(opts: {
  agentId: number;
  agentName: string;
  changedFields: Record<string, { from: unknown; to: unknown }>;
  actorUserId: number;
  actionUrl: string;
}): Promise<void> {
  const adminUsers = await db
    .select({ id: usersTable.id, language: usersTable.language })
    .from(usersTable)
    .where(and(inArray(usersTable.role, ["super_admin", "admin"]), eq(usersTable.isActive, true)));
  if (adminUsers.length === 0) return;

  const fieldsFormatted = formatFieldChanges(opts.changedFields);
  const notifValues = adminUsers.map(u => {
    const lang = (u.language ?? "en") as string;
    const tmpl = AGENT_PROFILE_NOTIF[lang] ?? AGENT_PROFILE_NOTIF.en;
    const title = tmpl.title;
    const body = tmpl.body
      .replace("{{agentName}}", opts.agentName)
      .replace("{{fields}}", fieldsFormatted);
    return {
      userId: u.id,
      type: "agent.profile_changed",
      title,
      body,
      icon: "Users",
      actionUrl: opts.actionUrl,
      data: { agentId: opts.agentId, fields: Object.keys(opts.changedFields), actorUserId: opts.actorUserId } as Record<string, unknown>,
      channel: "in_app",
    };
  });

  const inserted = await db
    .insert(notificationsTable)
    .values(notifValues)
    .returning({ id: notificationsTable.id, userId: notificationsTable.userId, title: notificationsTable.title });
  invalidateNotificationCounts(inserted.map(row => row.userId));
  for (const row of inserted) {
    notificationBus.publish({ userId: row.userId, notificationId: row.id, type: "agent.profile_changed", title: row.title });
  }
}
