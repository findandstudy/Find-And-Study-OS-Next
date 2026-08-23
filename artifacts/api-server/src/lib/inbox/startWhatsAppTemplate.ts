import {
  applicationsTable,
  channelAccountsTable,
  conversationsTable,
  db,
  externalContactsTable,
  leadsTable,
  messagesTable,
  messageTemplatesTable,
  studentsTable,
} from "@workspace/db";
import { ADMIN_ROLES, isAgentRole } from "@workspace/roles";
import { and, desc, eq, inArray, isNotNull, isNull, type SQL } from "drizzle-orm";
import type { AuthUser } from "../auth";
import { logAudit } from "../auth";
import { getAgentVisibleIds } from "../agentVisibility";
import { isAgentSourcedAndBlockedForStaff } from "../rbac/agentSourceScope";
import { inboxBus } from "./eventBus";
import { toE164 } from "./phone";
import { resolveApplicationMessageTarget } from "./quickContactTarget";
import { sendZernioTemplate } from "./zernioSend";
import {
  resolveApprovedZernioTemplate,
  resolveZernioWhatsAppAccount,
} from "./zernioTemplates";
import {
  loadEntityTemplateVariableContext,
  type MessageTemplateEntityType,
} from "./templateVariableContext";
import {
  canonicalMessageTemplateVariable,
  extractNamedMessageTemplateVariables,
  resolveNamedMessageTemplateVariables,
  type MessageTemplateVariableContext,
} from "./templateVariables";
import { syncConversationOwner } from "./assignmentSync";

export class WhatsAppTemplateSendError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
    public readonly conversationId?: number,
    public readonly messageId?: number,
  ) {
    super(detail || code);
    this.name = "WhatsAppTemplateSendError";
  }
}

export interface WhatsAppTemplateSendResult {
  conversationId: number;
  alreadyExists: boolean;
  messageId: number;
  channelAccountId: number;
  renderedContent: string;
  externalMessageId: string | null;
  providerBroadcastId: string | null;
  variables: Record<string, string>;
}

interface EntityTarget {
  entityType: MessageTemplateEntityType;
  entityId: number;
  agentId: number | null | undefined;
  phoneE164: string;
  displayName: string;
  resolvedStudentId: number | null;
  contactCondition: SQL;
}

export interface WhatsAppEntitySnapshot {
  entityType: MessageTemplateEntityType;
  entityId: number;
  agentId: number | null | undefined;
  phoneE164: string;
  displayName: string;
  resolvedStudentId: number | null;
}

interface EntityWhatsAppTarget {
  id: number;
  externalAccountId: string;
  displayName: string;
  isDefault: boolean;
  conversationId: number | null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function assertEntityAccess(actor: AuthUser, agentId: number | null | undefined): Promise<void> {
  if ((ADMIN_ROLES as readonly string[]).includes(actor.role)) return;
  if (isAgentRole(actor.role)) {
    const visibleAgentIds = await getAgentVisibleIds(actor.id, actor.role);
    if (agentId == null || !visibleAgentIds.includes(agentId)) {
      throw new WhatsAppTemplateSendError(404, "entity_not_found");
    }
    return;
  }
  if (isAgentSourcedAndBlockedForStaff(actor, agentId)) {
    throw new WhatsAppTemplateSendError(404, "entity_not_found");
  }
}

async function loadEntityTarget(
  actor: AuthUser,
  entityType: MessageTemplateEntityType,
  entityId: number,
): Promise<EntityTarget> {
  if (entityType === "lead") {
    const [row] = await db
      .select({
        agentId: leadsTable.agentId,
        phoneE164: leadsTable.phoneE164,
        phone: leadsTable.phone,
        firstName: leadsTable.firstName,
        lastName: leadsTable.lastName,
      })
      .from(leadsTable)
      .where(and(eq(leadsTable.id, entityId), isNull(leadsTable.deletedAt)))
      .limit(1);
    if (!row) throw new WhatsAppTemplateSendError(404, "entity_not_found");
    await assertEntityAccess(actor, row.agentId);
    const phoneE164 = toE164(cleanText(row.phoneE164) || cleanText(row.phone));
    if (!phoneE164) {
      throw new WhatsAppTemplateSendError(422, "no_phone", "Entity has no valid E.164 phone number");
    }
    return {
      entityType,
      entityId,
      agentId: row.agentId,
      phoneE164,
      displayName: `${row.firstName || ""} ${row.lastName || ""}`.trim(),
      resolvedStudentId: null,
      contactCondition: eq(externalContactsTable.leadId, entityId),
    };
  }

  if (entityType === "student") {
    const [row] = await db
      .select({
        agentId: studentsTable.agentId,
        phoneE164: studentsTable.phoneE164,
        phone: studentsTable.phone,
        firstName: studentsTable.firstName,
        lastName: studentsTable.lastName,
      })
      .from(studentsTable)
      .where(and(eq(studentsTable.id, entityId), isNull(studentsTable.deletedAt)))
      .limit(1);
    if (!row) throw new WhatsAppTemplateSendError(404, "entity_not_found");
    await assertEntityAccess(actor, row.agentId);
    const phoneE164 = toE164(cleanText(row.phoneE164) || cleanText(row.phone));
    if (!phoneE164) {
      throw new WhatsAppTemplateSendError(422, "no_phone", "Entity has no valid E.164 phone number");
    }
    return {
      entityType,
      entityId,
      agentId: row.agentId,
      phoneE164,
      displayName: `${row.firstName || ""} ${row.lastName || ""}`.trim(),
      resolvedStudentId: entityId,
      contactCondition: eq(externalContactsTable.studentId, entityId),
    };
  }

  const [application] = await db
    .select({ studentId: applicationsTable.studentId, agentId: applicationsTable.agentId })
    .from(applicationsTable)
    .where(and(eq(applicationsTable.id, entityId), isNull(applicationsTable.deletedAt)))
    .limit(1);
  if (!application?.studentId) throw new WhatsAppTemplateSendError(404, "entity_not_found");

  const [student] = await db
    .select({
      agentId: studentsTable.agentId,
      phoneE164: studentsTable.phoneE164,
      phone: studentsTable.phone,
      firstName: studentsTable.firstName,
      lastName: studentsTable.lastName,
    })
    .from(studentsTable)
    .where(and(eq(studentsTable.id, application.studentId), isNull(studentsTable.deletedAt)))
    .limit(1);
  const target = resolveApplicationMessageTarget(application, student);
  if (!target) throw new WhatsAppTemplateSendError(404, "entity_not_found");
  await assertEntityAccess(actor, target.agentId);
  if (!target.phoneE164 || !toE164(target.phoneE164)) {
    throw new WhatsAppTemplateSendError(422, "no_phone", "Entity has no valid E.164 phone number");
  }
  return {
    entityType,
    entityId,
    agentId: target.agentId,
    phoneE164: toE164(target.phoneE164)!,
    displayName: target.displayName,
    resolvedStudentId: target.studentId,
    contactCondition: eq(externalContactsTable.studentId, target.studentId),
  };
}

/**
 * Resolve and authorize a CRM recipient without selecting a provider account
 * or sending anything. Campaign creation uses this to freeze the intended
 * audience before a background worker begins delivery.
 */
export async function loadWhatsAppEntitySnapshot(
  actor: AuthUser,
  entityType: MessageTemplateEntityType,
  entityId: number,
): Promise<WhatsAppEntitySnapshot> {
  const target = await loadEntityTarget(actor, entityType, entityId);
  return {
    entityType: target.entityType,
    entityId: target.entityId,
    agentId: target.agentId,
    phoneE164: target.phoneE164,
    displayName: target.displayName,
    resolvedStudentId: target.resolvedStudentId,
  };
}

async function resolveEntityWhatsAppTarget(contactCondition: SQL, channelAccountId?: number): Promise<EntityWhatsAppTarget | null> {
  if (channelAccountId) {
    const [selected] = await db
      .select({
        id: channelAccountsTable.id,
        externalAccountId: channelAccountsTable.externalAccountId,
        displayName: channelAccountsTable.displayName,
        isDefault: channelAccountsTable.isDefault,
      })
      .from(channelAccountsTable)
      .where(and(
        eq(channelAccountsTable.id, channelAccountId),
        eq(channelAccountsTable.channel, "whatsapp"),
        eq(channelAccountsTable.provider, "zernio"),
        eq(channelAccountsTable.isActive, true),
      ))
      .limit(1);
    if (!selected?.externalAccountId) return null;

    const contacts = await db
      .select({ id: externalContactsTable.id })
      .from(externalContactsTable)
      .where(and(eq(externalContactsTable.channel, "whatsapp"), contactCondition));
    const contactIds = contacts.map((contact) => contact.id);
    const [conversation] = contactIds.length > 0
      ? await db.select({ id: conversationsTable.id })
          .from(conversationsTable)
          .where(and(
            inArray(conversationsTable.externalContactId, contactIds),
            eq(conversationsTable.channel, "whatsapp"),
            eq(conversationsTable.channelAccountId, selected.id),
            isNotNull(conversationsTable.externalThreadId),
          ))
          .orderBy(desc(conversationsTable.lastMessageAt))
          .limit(1)
      : [];
    return { ...selected, externalAccountId: selected.externalAccountId, conversationId: conversation?.id ?? null };
  }
  const contacts = await db
    .select({ id: externalContactsTable.id })
    .from(externalContactsTable)
    .where(and(eq(externalContactsTable.channel, "whatsapp"), contactCondition));
  const contactIds = contacts.map((contact) => contact.id);

  if (contactIds.length > 0) {
    const [existing] = await db
      .select({
        conversationId: conversationsTable.id,
        id: channelAccountsTable.id,
        externalAccountId: channelAccountsTable.externalAccountId,
        displayName: channelAccountsTable.displayName,
        isDefault: channelAccountsTable.isDefault,
      })
      .from(conversationsTable)
      .innerJoin(channelAccountsTable, eq(conversationsTable.channelAccountId, channelAccountsTable.id))
      .where(and(
        inArray(conversationsTable.externalContactId, contactIds),
        eq(conversationsTable.channel, "whatsapp"),
        eq(channelAccountsTable.provider, "zernio"),
        eq(channelAccountsTable.isActive, true),
        isNotNull(conversationsTable.externalThreadId),
      ))
      .orderBy(desc(conversationsTable.lastMessageAt))
      .limit(1);
    if (existing?.externalAccountId) {
      return {
        ...existing,
        externalAccountId: existing.externalAccountId,
      };
    }
  }

  const account = await resolveZernioWhatsAppAccount();
  return account ? { ...account, conversationId: null } : null;
}

function orderedTemplateVariableNames(template: {
  content: string;
  variables: unknown;
}): string[] {
  const configured = Array.isArray(template.variables)
    ? template.variables.map(cleanText).filter(Boolean)
    : [];
  return configured.length > 0
    ? configured
    : extractNamedMessageTemplateVariables(template.content || "");
}

function resolveTemplateParameters(params: {
  template: { content: string; variables: unknown };
  context: MessageTemplateVariableContext;
  providerVariableCount: number;
  providedParameters?: string[];
}): { parameters: string[]; renderedContent: string; variables: Record<string, string> } {
  const namedResolution = resolveNamedMessageTemplateVariables(
    params.template.content || "",
    params.context,
  );
  if (namedResolution.missingVariables.length > 0) {
    throw new WhatsAppTemplateSendError(
      422,
      "template_variables_missing",
      `Missing template data: ${namedResolution.missingVariables.join(", ")}`,
    );
  }

  const variableNames = orderedTemplateVariableNames(params.template);
  const variables: Record<string, string> = {};
  let parameters = (params.providedParameters || []).map(cleanText);

  if (params.providedParameters == null) {
    if (variableNames.length !== params.providerVariableCount) {
      throw new WhatsAppTemplateSendError(
        422,
        "template_variables_unmapped",
        `Approved template expects ${params.providerVariableCount} variables but ${variableNames.length} mappings are configured.`,
      );
    }
    parameters = variableNames.map((rawName) => {
      const canonical = canonicalMessageTemplateVariable(rawName);
      const value = canonical ? cleanText(params.context[canonical]) : "";
      if (!canonical || !value) {
        throw new WhatsAppTemplateSendError(
          422,
          "template_variables_missing",
          `Missing template data: ${canonical || rawName}`,
        );
      }
      variables[canonical] = value;
      return value;
    });
  } else {
    variableNames.forEach((rawName, index) => {
      const canonical = canonicalMessageTemplateVariable(rawName);
      if (canonical && parameters[index]) variables[canonical] = parameters[index];
    });
  }

  if (parameters.length !== params.providerVariableCount || parameters.some((value) => !value)) {
    throw new WhatsAppTemplateSendError(
      422,
      "template_variable_count_mismatch",
      `Approved template expects ${params.providerVariableCount} non-empty variables; ${parameters.length} were resolved.`,
    );
  }

  const renderedContent = parameters.reduce(
    (content, value, index) => content.replace(
      new RegExp(`\\{\\{\\s*${index + 1}\\s*\\}\\}`, "g"),
      value,
    ),
    namedResolution.content,
  );
  return { parameters, renderedContent, variables };
}

async function recordOutboundMessage(params: {
  conversationId: number;
  senderId: number;
  renderedContent: string;
  templateName: string;
  ok: boolean;
  externalMessageId?: string | null;
  broadcastId?: string | null;
  error?: string | null;
}): Promise<number> {
  const [message] = await db
    .insert(messagesTable)
    .values({
      conversationId: params.conversationId,
      senderId: params.senderId,
      content: params.renderedContent,
      channel: "whatsapp",
      direction: "outbound",
      status: params.ok ? "sent" : "failed",
      externalMessageId: params.externalMessageId || null,
      failedReason: params.ok ? null : params.error || "send_failed",
      sentAt: params.ok ? new Date() : null,
      metadata: {
        template: params.templateName,
        ...(params.broadcastId ? { broadcastId: params.broadcastId } : {}),
      },
    })
    .returning({ id: messagesTable.id });
  return message.id;
}

export async function sendWhatsAppTemplateToEntity(params: {
  actor: AuthUser;
  entityType: MessageTemplateEntityType;
  entityId: number;
  templateId: number;
  /**
   * Campaigns freeze the intended recipient at creation time. Refuse to send
   * when that record now resolves to another phone instead of silently
   * redirecting an already-approved campaign to a different person.
   */
  expectedPhoneE164?: string;
  /** Force this exact active Zernio WhatsApp line for the send. */
  channelAccountId?: number;
  parameters?: string[];
  requestIp?: string;
}): Promise<WhatsAppTemplateSendResult> {
  const target = await loadEntityTarget(params.actor, params.entityType, params.entityId);
  if (params.expectedPhoneE164 && target.phoneE164 !== params.expectedPhoneE164) {
    throw new WhatsAppTemplateSendError(
      409,
      "recipient_phone_changed",
      "The recipient phone changed after the campaign audience was frozen. Nothing was sent.",
    );
  }
  const [template] = await db
    .select()
    .from(messageTemplatesTable)
    .where(and(
      eq(messageTemplatesTable.id, params.templateId),
      eq(messageTemplatesTable.isActive, true),
    ))
    .limit(1);
  if (!template?.externalTemplateName || !["whatsapp", "all"].includes(template.channel)) {
    throw new WhatsAppTemplateSendError(400, "template_not_available");
  }

  const account = await resolveEntityWhatsAppTarget(target.contactCondition, params.channelAccountId);
  if (!account) {
    throw new WhatsAppTemplateSendError(
      409,
      "no_zernio_account",
      "No active WhatsApp line is available for this recipient.",
    );
  }

  const availability = await resolveApprovedZernioTemplate({
    externalAccountId: account.externalAccountId,
    templateName: template.externalTemplateName,
    preferredLanguage: template.language,
  });
  if (!availability.ok) {
    if (availability.reason === "provider_unavailable") {
      throw new WhatsAppTemplateSendError(
        502,
        "template_availability_check_failed",
        `Approved templates for WhatsApp line “${account.displayName}” could not be verified. Nothing was sent.`,
      );
    }
    throw new WhatsAppTemplateSendError(
      409,
      "template_not_approved_for_whatsapp_account",
      `Template “${template.externalTemplateName}” is not approved for WhatsApp line “${account.displayName}”.`,
    );
  }

  const context = await loadEntityTemplateVariableContext(params.entityType, params.entityId);
  const resolved = resolveTemplateParameters({
    template: { content: template.content || "", variables: template.variables },
    context,
    providerVariableCount: availability.template.variableCount,
    providedParameters: params.parameters,
  });

  let conversationId = account.conversationId;
  let alreadyExists = Boolean(conversationId);
  if (!conversationId) {
    const outboundExternalId = `wa_out:${target.phoneE164.replace(/^\+/, "")}`;
    let [contact] = await db
      .select({ id: externalContactsTable.id })
      .from(externalContactsTable)
      .where(and(
        eq(externalContactsTable.channel, "whatsapp"),
        eq(externalContactsTable.externalId, outboundExternalId),
      ))
      .limit(1);

    if (!contact) {
      [contact] = await db
        .insert(externalContactsTable)
        .values({
          channel: "whatsapp",
          externalId: outboundExternalId,
          phoneE164: target.phoneE164,
          displayName: target.displayName || target.phoneE164,
          leadId: target.entityType === "lead" ? target.entityId : null,
          studentId: target.resolvedStudentId,
        })
        .onConflictDoNothing({ target: [externalContactsTable.channel, externalContactsTable.externalId] })
        .returning({ id: externalContactsTable.id });
      if (!contact) {
        [contact] = await db
          .select({ id: externalContactsTable.id })
          .from(externalContactsTable)
          .where(and(
            eq(externalContactsTable.channel, "whatsapp"),
            eq(externalContactsTable.externalId, outboundExternalId),
          ))
          .limit(1);
      }
    }
    if (!contact) throw new WhatsAppTemplateSendError(500, "external_contact_create_failed");

    const linkUpdates: { leadId?: number; studentId?: number } = {};
    if (target.entityType === "lead") linkUpdates.leadId = target.entityId;
    if (target.resolvedStudentId != null) linkUpdates.studentId = target.resolvedStudentId;
    if (Object.keys(linkUpdates).length > 0) {
      await db.update(externalContactsTable).set(linkUpdates).where(eq(externalContactsTable.id, contact.id));
    }

    const [existingConversation] = await db
      .select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(and(
        eq(conversationsTable.externalContactId, contact.id),
        eq(conversationsTable.channel, "whatsapp"),
        eq(conversationsTable.channelAccountId, account.id),
      ))
      .orderBy(desc(conversationsTable.lastMessageAt))
      .limit(1);
    if (existingConversation) {
      conversationId = existingConversation.id;
      alreadyExists = true;
    } else {
      const [conversation] = await db
        .insert(conversationsTable)
        .values({
          type: "external",
          title: target.displayName || target.phoneE164,
          channel: "whatsapp",
          channelAccountId: account.id,
          externalContactId: contact.id,
          externalThreadId: null,
          unmatched: false,
          status: "open",
          createdById: params.actor.id,
          lastMessageAt: new Date(),
          lastMessagePreview: "",
          metadata: { source: "outbound_start" },
        })
        .returning({ id: conversationsTable.id });
      conversationId = conversation.id;
      alreadyExists = false;
    }
  }

  const providerResult = await sendZernioTemplate({
    externalAccountId: account.externalAccountId,
    templateName: template.externalTemplateName,
    language: availability.template.language,
    toPhoneE164: target.phoneE164,
    parameters: resolved.parameters,
    recipientLabel: target.displayName || target.phoneE164,
  });
  const messageId = await recordOutboundMessage({
    conversationId,
    senderId: params.actor.id,
    renderedContent: resolved.renderedContent,
    templateName: template.externalTemplateName,
    ok: providerResult.ok,
    externalMessageId: providerResult.externalMessageId,
    broadcastId: providerResult.broadcastId,
    error: providerResult.error,
  });
  if (!providerResult.ok) {
    throw new WhatsAppTemplateSendError(
      502,
      "template_send_failed",
      providerResult.error || undefined,
      conversationId,
      messageId,
    );
  }

  await db
    .update(conversationsTable)
    .set({ lastMessageAt: new Date(), lastMessagePreview: resolved.renderedContent.slice(0, 200) })
    .where(eq(conversationsTable.id, conversationId));
  await syncConversationOwner(conversationId, params.actor.id, params.requestIp);
  inboxBus.publish({
    type: "message",
    conversationId,
    channel: "whatsapp",
    assignedToId: null,
    unmatched: false,
    direction: "outbound",
  });
  logAudit(
    params.actor.id,
    "inbox.start_conversation",
    params.entityType,
    params.entityId,
    { channel: "whatsapp", templateName: template.externalTemplateName, conversationId },
    params.requestIp,
  );

  return {
    conversationId,
    alreadyExists,
    messageId,
    channelAccountId: account.id,
    renderedContent: resolved.renderedContent,
    externalMessageId: providerResult.externalMessageId || null,
    providerBroadcastId: providerResult.broadcastId || null,
    variables: resolved.variables,
  };
}
