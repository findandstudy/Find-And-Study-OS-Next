export type MessageTemplateVariableKey =
  | "studentName"
  | "firstName"
  | "lastName"
  | "programName"
  | "universityName"
  | "deadline"
  | "level"
  | "intake";

export type MessageTemplateVariableContext = Partial<
  Record<MessageTemplateVariableKey, string | null | undefined>
>;

export interface MessageTemplateContextSources {
  displayName?: string | null;
  lead?: {
    firstName?: string | null;
    lastName?: string | null;
    interestedProgram?: string | null;
    interestedUniversity?: string | null;
    interestedLevel?: string | null;
  } | null;
  student?: {
    firstName?: string | null;
    lastName?: string | null;
    interestedLevel?: string | null;
  } | null;
  application?: {
    programName?: string | null;
    universityName?: string | null;
    deadline?: string | null;
    level?: string | null;
    intake?: string | null;
  } | null;
}

const VARIABLE_ALIASES: Record<string, MessageTemplateVariableKey> = {
  studentname: "studentName",
  fullname: "studentName",
  name: "studentName",
  firstname: "firstName",
  lastname: "lastName",
  program: "programName",
  programname: "programName",
  university: "universityName",
  universityname: "universityName",
  deadline: "deadline",
  offerdeadline: "deadline",
  offerletterdeadline: "deadline",
  paymentdeadline: "deadline",
  level: "level",
  studylevel: "level",
  intake: "intake",
};

const NAMED_PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g;

function cleanContextValue(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function contextFullName(
  firstName: string | null | undefined,
  lastName: string | null | undefined,
): string | undefined {
  return cleanContextValue(
    [cleanContextValue(firstName), cleanContextValue(lastName)]
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Pure priority model shared by the database loader and regression tests.
 * A linked student is authoritative; the lead/contact remain safe fallbacks.
 */
export function buildMessageTemplateVariableContext(
  sources: MessageTemplateContextSources,
): MessageTemplateVariableContext {
  const { displayName, lead, student, application } = sources;
  const firstName =
    cleanContextValue(student?.firstName) ?? cleanContextValue(lead?.firstName);
  const lastName =
    cleanContextValue(student?.lastName) ?? cleanContextValue(lead?.lastName);

  return {
    studentName:
      contextFullName(student?.firstName, student?.lastName) ??
      contextFullName(lead?.firstName, lead?.lastName) ??
      cleanContextValue(displayName),
    firstName,
    lastName,
    programName:
      cleanContextValue(application?.programName) ??
      cleanContextValue(lead?.interestedProgram),
    universityName:
      cleanContextValue(application?.universityName) ??
      cleanContextValue(lead?.interestedUniversity),
    deadline: cleanContextValue(application?.deadline),
    level:
      cleanContextValue(application?.level) ??
      cleanContextValue(student?.interestedLevel) ??
      cleanContextValue(lead?.interestedLevel),
    intake: cleanContextValue(application?.intake),
  };
}

function normalizeVariableName(value: string): string {
  return value.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

export function canonicalMessageTemplateVariable(
  value: string,
): MessageTemplateVariableKey | null {
  return VARIABLE_ALIASES[normalizeVariableName(value)] ?? null;
}

export function extractNamedMessageTemplateVariables(content: string): string[] {
  const variables: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(NAMED_PLACEHOLDER_RE)) {
    const raw = match[1];
    const canonical = canonicalMessageTemplateVariable(raw) ?? raw;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      variables.push(canonical);
    }
  }
  return variables;
}

export function resolveNamedMessageTemplateVariables(
  content: string,
  context: MessageTemplateVariableContext,
): {
  content: string;
  resolvedVariables: MessageTemplateVariableKey[];
  missingVariables: string[];
} {
  const resolvedVariables = new Set<MessageTemplateVariableKey>();
  const missingVariables = new Set<string>();

  const resolvedContent = content.replace(
    NAMED_PLACEHOLDER_RE,
    (placeholder, rawVariable: string) => {
      const canonical = canonicalMessageTemplateVariable(rawVariable);
      if (!canonical) {
        missingVariables.add(rawVariable);
        return placeholder;
      }
      const value = context[canonical];
      const normalizedValue = typeof value === "string" ? value.trim() : "";
      if (!normalizedValue) {
        missingVariables.add(canonical);
        return placeholder;
      }
      resolvedVariables.add(canonical);
      return normalizedValue;
    },
  );

  return {
    content: resolvedContent,
    resolvedVariables: [...resolvedVariables],
    missingVariables: [...missingVariables],
  };
}
