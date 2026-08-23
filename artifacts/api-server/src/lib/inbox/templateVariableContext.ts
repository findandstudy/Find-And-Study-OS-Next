import {
  applicationsTable,
  conversationsTable,
  db,
  externalContactsTable,
  leadsTable,
  studentsTable,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  buildMessageTemplateVariableContext,
  type MessageTemplateVariableContext,
} from "./templateVariables";

export type MessageTemplateEntityType = "lead" | "student" | "application";

/**
 * Resolve variables from the entity the operator actually selected. In
 * particular, an application campaign must use that application's programme,
 * university and intake rather than the student's newest application.
 */
export async function loadEntityTemplateVariableContext(
  entityType: MessageTemplateEntityType,
  entityId: number,
): Promise<MessageTemplateVariableContext> {
  if (entityType === "lead") {
    const [lead] = await db
      .select({
        firstName: leadsTable.firstName,
        lastName: leadsTable.lastName,
        interestedProgram: leadsTable.interestedProgram,
        interestedUniversity: leadsTable.interestedUniversity,
        interestedLevel: leadsTable.interestedLevel,
        convertedStudentId: leadsTable.convertedStudentId,
      })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, entityId), isNull(leadsTable.deletedAt)))
      .limit(1);
    if (!lead) return {};

    const [student] = lead.convertedStudentId
      ? await db
          .select({
            firstName: studentsTable.firstName,
            lastName: studentsTable.lastName,
            interestedLevel: studentsTable.interestedLevel,
          })
          .from(studentsTable)
          .where(and(
            eq(studentsTable.id, lead.convertedStudentId),
            isNull(studentsTable.deletedAt),
          ))
          .limit(1)
      : [null];

    const [application] = lead.convertedStudentId
      ? await db
          .select({
            programName: applicationsTable.programName,
            universityName: applicationsTable.universityName,
            deadline: applicationsTable.deadline,
            level: applicationsTable.level,
            intake: applicationsTable.intake,
          })
          .from(applicationsTable)
          .where(and(
            eq(applicationsTable.studentId, lead.convertedStudentId),
            isNull(applicationsTable.deletedAt),
          ))
          .orderBy(desc(applicationsTable.createdAt), desc(applicationsTable.id))
          .limit(1)
      : [null];

    return buildMessageTemplateVariableContext({ lead, student, application });
  }

  if (entityType === "student") {
    const [student] = await db
      .select({
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
        interestedLevel: studentsTable.interestedLevel,
      })
      .from(studentsTable)
      .where(and(eq(studentsTable.id, entityId), isNull(studentsTable.deletedAt)))
      .limit(1);
    if (!student) return {};

    const [application] = await db
      .select({
        programName: applicationsTable.programName,
        universityName: applicationsTable.universityName,
        deadline: applicationsTable.deadline,
        level: applicationsTable.level,
        intake: applicationsTable.intake,
      })
      .from(applicationsTable)
      .where(and(
        eq(applicationsTable.studentId, entityId),
        isNull(applicationsTable.deletedAt),
      ))
      .orderBy(desc(applicationsTable.createdAt), desc(applicationsTable.id))
      .limit(1);

    return buildMessageTemplateVariableContext({ student, application });
  }

  const [application] = await db
    .select({
      studentId: applicationsTable.studentId,
      programName: applicationsTable.programName,
      universityName: applicationsTable.universityName,
      deadline: applicationsTable.deadline,
      level: applicationsTable.level,
      intake: applicationsTable.intake,
    })
    .from(applicationsTable)
    .where(and(eq(applicationsTable.id, entityId), isNull(applicationsTable.deletedAt)))
    .limit(1);
  if (!application?.studentId) return {};

  const [student] = await db
    .select({
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
      interestedLevel: studentsTable.interestedLevel,
    })
    .from(studentsTable)
    .where(and(
      eq(studentsTable.id, application.studentId),
      isNull(studentsTable.deletedAt),
    ))
    .limit(1);

  return buildMessageTemplateVariableContext({ student, application });
}

/**
 * Builds the authoritative placeholder context for one external conversation.
 * The newest live application wins for programme/university/intake; lead
 * interests are the fallback before an application exists.
 */
export async function loadConversationTemplateVariableContext(
  conversationId: number,
): Promise<MessageTemplateVariableContext> {
  const [link] = await db
    .select({
      displayName: externalContactsTable.displayName,
      leadId: externalContactsTable.leadId,
      studentId: externalContactsTable.studentId,
    })
    .from(conversationsTable)
    .leftJoin(
      externalContactsTable,
      eq(conversationsTable.externalContactId, externalContactsTable.id),
    )
    .where(eq(conversationsTable.id, conversationId))
    .limit(1);

  if (!link) return {};

  const [lead] = link.leadId
    ? await db
        .select({
          firstName: leadsTable.firstName,
          lastName: leadsTable.lastName,
          interestedProgram: leadsTable.interestedProgram,
          interestedUniversity: leadsTable.interestedUniversity,
          interestedLevel: leadsTable.interestedLevel,
          convertedStudentId: leadsTable.convertedStudentId,
        })
        .from(leadsTable)
        .where(and(eq(leadsTable.id, link.leadId), isNull(leadsTable.deletedAt)))
        .limit(1)
    : [null];

  const effectiveStudentId = link.studentId ?? lead?.convertedStudentId ?? null;
  const [student] = effectiveStudentId
    ? await db
        .select({
          firstName: studentsTable.firstName,
          lastName: studentsTable.lastName,
          interestedLevel: studentsTable.interestedLevel,
        })
        .from(studentsTable)
        .where(
          and(
            eq(studentsTable.id, effectiveStudentId),
            isNull(studentsTable.deletedAt),
          ),
        )
        .limit(1)
    : [null];

  const [application] = effectiveStudentId
    ? await db
        .select({
          programName: applicationsTable.programName,
          universityName: applicationsTable.universityName,
          deadline: applicationsTable.deadline,
          level: applicationsTable.level,
          intake: applicationsTable.intake,
        })
        .from(applicationsTable)
        .where(
          and(
            eq(applicationsTable.studentId, effectiveStudentId),
            isNull(applicationsTable.deletedAt),
          ),
        )
        .orderBy(desc(applicationsTable.createdAt), desc(applicationsTable.id))
        .limit(1)
    : [null];

  return buildMessageTemplateVariableContext({
    displayName: link.displayName,
    lead,
    student,
    application,
  });
}
