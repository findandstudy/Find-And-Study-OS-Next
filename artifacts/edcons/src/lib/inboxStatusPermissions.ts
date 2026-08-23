export type InboxStatusEntityType = "lead" | "student" | "application";

const STATUS_PERMISSION: Record<InboxStatusEntityType, string> = {
  lead: "leads.change_stage",
  student: "students.change_stage",
  application: "applications.change_stage",
};

const STATUS_ADMIN_ROLES = new Set(["super_admin", "admin", "manager"]);

export function inboxStatusPermission(entityType: InboxStatusEntityType): string {
  return STATUS_PERMISSION[entityType];
}

export function canChangeInboxStatus(
  role: string | null | undefined,
  permissions: readonly string[] | null | undefined,
  entityType: InboxStatusEntityType,
): boolean {
  if (!role) return false;
  if (STATUS_ADMIN_ROLES.has(role)) return true;
  return (permissions ?? []).includes(inboxStatusPermission(entityType));
}
