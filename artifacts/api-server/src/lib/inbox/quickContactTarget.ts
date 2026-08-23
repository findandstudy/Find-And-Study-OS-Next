import { toE164 } from "./phone";

export interface ApplicationMessageReference {
  studentId: number | null;
  agentId: number | null;
}

export interface StudentMessageReference {
  agentId: number | null;
  phoneE164?: string | null;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
}

export interface ApplicationMessageTarget {
  studentId: number;
  agentId: number | null;
  phoneE164: string | null;
  displayName: string;
}

/**
 * An application is not a WhatsApp contact by itself. Resolve it to its
 * student while preserving application-level agency ownership when present.
 * Keeping this rule pure and shared prevents the picker and sender routes from
 * drifting apart again.
 */
export function resolveApplicationMessageTarget(
  application: ApplicationMessageReference | null | undefined,
  student: StudentMessageReference | null | undefined,
): ApplicationMessageTarget | null {
  if (!application?.studentId || !student) return null;

  const storedPhone = student.phoneE164?.trim() || student.phone?.trim() || "";
  const phoneE164 = storedPhone ? (toE164(storedPhone) || storedPhone) : null;
  const displayName = [student.firstName?.trim(), student.lastName?.trim()]
    .filter(Boolean)
    .join(" ");

  return {
    studentId: application.studentId,
    agentId: application.agentId ?? student.agentId,
    phoneE164,
    displayName,
  };
}
