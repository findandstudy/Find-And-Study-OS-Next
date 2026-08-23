import {
  db,
  conversationsTable,
  messagesTable,
  externalContactsTable,
  channelAccountsTable,
  agentsTable,
  leadsTable,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { resolveIdentity } from "./identityResolver";
import { toE164 } from "./phone";
import { dispatchNotification } from "../notificationDispatcher";
import { inboxBus } from "./eventBus";
import { applyLeadAssignmentRules } from "../leadAssignment";
import { getAiAgentConfig } from "./aiAgentConfig";
import { resolveInboundCommunicationContext } from "./channelAccountConfig";

export interface InboundContactInfo {
  externalId: string;
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  metadata?: Record<string, unknown>;
}

export interface InboundMessageInfo {
  externalMessageId: string;
  text: string;
  externalThreadId?: string | null;
  receivedAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface InboundResult {
  conversationId: number;
  messageId: number;
  externalContactId: number;
  duplicate: boolean;
  unmatched: boolean;
}

/**
 * Idempotent inbound message ingestion. Handles:
 *   - upsert external_contacts by (channel, externalId)
 *   - identity resolution (strong / ambiguous / none)
 *   - upsert conversation by (channelAccountId, externalThreadId)
 *   - dedupe message by (channel, externalMessageId)
 *   - notification dispatch on new inbound
 */
export async function processInboundMessage(opts: {
  channel: string;
  channelAccountId?: number | null;
  contact: InboundContactInfo;
  message: InboundMessageInfo;
}): Promise<InboundResult> {
  const { channel, channelAccountId = null, contact, message } = opts;
  const phoneE164 = toE164(contact.phone || null);
  const inboundCommunicationContext = channelAccountId
    ? await resolveInboundCommunicationContext(channelAccountId)
    : null;

  // Race-safe upsert: insert with onConflictDoNothing on the (channel, externalId)
  // unique index. If the row already exists OR was inserted concurrently by
  // another worker, refetch it. This eliminates select-then-insert TOCTOU.
  const [insertedContact] = await db
    .insert(externalContactsTable)
    .values({
      channel,
      externalId: contact.externalId,
      displayName: contact.displayName || null,
      phone: contact.phone || null,
      phoneE164,
      email: contact.email ? String(contact.email).toLowerCase() : null,
      metadata: contact.metadata || {},
    })
    .onConflictDoNothing({
      target: [externalContactsTable.channel, externalContactsTable.externalId],
    })
    .returning();

  let externalContact = insertedContact;
  if (!externalContact) {
    const [refetched] = await db
      .select()
      .from(externalContactsTable)
      .where(
        and(
          eq(externalContactsTable.channel, channel),
          eq(externalContactsTable.externalId, contact.externalId),
        ),
      );
    externalContact = refetched;
    if (!externalContact) {
      throw new Error("processInbound: external contact upsert returned no row");
    }
  }
  // Refresh metadata on the canonical row when not freshly inserted.
  if (insertedContact === undefined) {
    await db
      .update(externalContactsTable)
      .set({
        lastSeenAt: new Date(),
        displayName: externalContact.displayName || contact.displayName || null,
        phone: externalContact.phone || contact.phone || null,
        phoneE164: externalContact.phoneE164 || phoneE164,
        email: externalContact.email || (contact.email ? String(contact.email).toLowerCase() : null),
      })
      .where(eq(externalContactsTable.id, externalContact.id));
  }

  if (!externalContact.leadId && !externalContact.studentId && !externalContact.agentId) {
    const resolution = await resolveIdentity({ phone: contact.phone, email: contact.email });
    if (resolution.outcome === "strong") {
      const c = resolution.candidates[0];
      const updates: { leadId: number | null; studentId: number | null; agentId: number | null } = {
        leadId: null,
        studentId: null,
        agentId: null,
      };
      if (c.type === "lead") updates.leadId = c.id;
      if (c.type === "student") updates.studentId = c.id;
      if (c.type === "agent") updates.agentId = c.id;
      await db.update(externalContactsTable).set(updates).where(eq(externalContactsTable.id, externalContact.id));
      externalContact = { ...externalContact, ...updates };
    }
  }

  // agent_ref pipeline (web_form sub-agent referrals): if no identity match yet
  // and an agent_ref was provided, try to match it to an agent via agencyCode and
  // auto-create a lead with assignedAgentId set. Conversation ownership stays null.
  // Spec: lib/db/schema/leads.ts assignedAgentId path; conversation.assignedToId untouched.
  let subAgentMatch: { agentId: number; agencyCode: string | null; displayName: string } | null = null;
  const readAgentRef = (m: Record<string, unknown> | undefined): unknown => {
    if (!m || typeof m !== "object") return null;
    return (m as { agentRef?: unknown }).agentRef ?? null;
  };
  const agentRefRaw = readAgentRef(contact.metadata) || readAgentRef(message.metadata);
  const agentRef = agentRefRaw ? String(agentRefRaw).trim() : "";
  if (agentRef && !externalContact.leadId && !externalContact.studentId && !externalContact.agentId) {
    try {
      const [matched] = await db
        .select({ id: agentsTable.id, code: agentsTable.agencyCode, name: agentsTable.companyName })
        .from(agentsTable)
        .where(sql`lower(${agentsTable.agencyCode}) = lower(${agentRef})`)
        .limit(1);
      if (matched) {
        // Split displayName into first/last; fall back to channel handle.
        const fullName = (contact.displayName || "").trim();
        const parts = fullName.split(/\s+/).filter(Boolean);
        const firstName = parts[0] || (contact.email?.split("@")[0]) || (contact.phone || "Web");
        const lastName = parts.slice(1).join(" ") || "Lead";
        const [createdLead] = await db
          .insert(leadsTable)
          .values({
            firstName,
            lastName,
            email: contact.email ? String(contact.email).toLowerCase() : null,
            phone: contact.phone || null,
            phoneE164,
            source: `web_form:${agentRef}`,
            status: "new",
            agentId: matched.id,
            originType: "agent",
            originEntityType: "agent",
            originEntityId: matched.id,
            originDisplayName: matched.name || matched.code || `Agent #${matched.id}`,
          })
          .returning({ id: leadsTable.id });
        if (createdLead) {
          await applyLeadAssignmentRules({
            id: createdLead.id,
            source: `web_form:${agentRef}`,
            phone: contact.phone || null,
            country: null,
            interestedCountry: null,
          });
          await db
            .update(externalContactsTable)
            .set({ leadId: createdLead.id })
            .where(eq(externalContactsTable.id, externalContact.id));
          externalContact = { ...externalContact, leadId: createdLead.id };
          subAgentMatch = {
            agentId: matched.id,
            agencyCode: matched.code,
            displayName: matched.name || matched.code || `Agent #${matched.id}`,
          };
        }
      }
    } catch (err) {
      console.error("[INBOX] agent_ref pipeline failed:", err);
    }
  }

  // ── wa_out: reconciliation ────────────────────────────────────────────────
  // When the CRM initiates an outbound conversation (POST /inbox/conversations/
  // start) it creates a placeholder external_contact with
  //   externalId = "wa_out:<digits>"  (no real wa_id yet).
  // When the student replies, processInbound upserts a NEW contact row using
  // the real externalId — creating a duplicate pair and a second conversation.
  //
  // This block detects that situation and merges the placeholder conversation
  // into the real one so both sides of the thread stay in the same conversation:
  //   1. Copy entity links (leadId / studentId) from wa_out to real contact.
  //   2. Re-key the wa_out conversation (externalThreadId IS NULL) to the real
  //      thread ID + real contact, so the upcoming conversation-upsert finds IT
  //      instead of creating a fresh row.
  //   3. Reassign any other conversations still pointing at the wa_out contact.
  //   4. Delete the now-orphaned wa_out external_contact row.
  if (phoneE164 && !contact.externalId.startsWith("wa_out:")) {
    try {
      const waOutExternalId = `wa_out:${phoneE164.replace(/\+/, "")}`;
      const [waOutContact] = await db
        .select()
        .from(externalContactsTable)
        .where(and(
          eq(externalContactsTable.channel, channel),
          eq(externalContactsTable.externalId, waOutExternalId),
        ))
        .limit(1);

      if (waOutContact && waOutContact.id !== externalContact.id) {
        // 1. Copy entity links to real contact if not already set.
        const mergeFields: { leadId?: number | null; studentId?: number | null; agentId?: number | null } = {};
        if (!externalContact.leadId && waOutContact.leadId) mergeFields.leadId = waOutContact.leadId;
        if (!externalContact.studentId && waOutContact.studentId) mergeFields.studentId = waOutContact.studentId;
        if (!externalContact.agentId && waOutContact.agentId) mergeFields.agentId = waOutContact.agentId;
        if (Object.keys(mergeFields).length > 0) {
          await db.update(externalContactsTable).set(mergeFields).where(eq(externalContactsTable.id, externalContact.id));
          externalContact = { ...externalContact, ...mergeFields };
        }

        // 2. Re-key the CRM-started conversation (externalThreadId IS NULL) to
        //    the real thread + real contact.  This makes the conversation-upsert
        //    below find the outbound conversation and add the inbound reply to it
        //    instead of opening a second conversation.
        const realThreadId = message.externalThreadId || contact.externalId;
        await db
          .update(conversationsTable)
          .set({ externalContactId: externalContact.id, externalThreadId: realThreadId })
          .where(and(
            eq(conversationsTable.externalContactId, waOutContact.id),
            isNull(conversationsTable.externalThreadId),
          ));

        // 3. Move any remaining conversations (edge-case: non-null threadId rows).
        await db
          .update(conversationsTable)
          .set({ externalContactId: externalContact.id })
          .where(eq(conversationsTable.externalContactId, waOutContact.id));

        // 4. Remove the now-orphaned wa_out contact.
        await db.delete(externalContactsTable).where(eq(externalContactsTable.id, waOutContact.id));
      }
    } catch (err) {
      // Non-fatal — a unique-index conflict means a real conversation already
      // exists for this thread; the inbound message will still land correctly.
      console.error("[processInbound] wa_out contact merge failed (non-fatal):", err);
    }
  }

  const isLinked = Boolean(externalContact.leadId || externalContact.studentId || externalContact.agentId);
  const isBlocked = externalContact.isBlocked === true;

  const externalThreadId = message.externalThreadId || contact.externalId;

  // Conversation identity is keyed by (channel, channelAccountId, externalThreadId)
  // so multiple WA business accounts (or web-form forms) cannot collide on the
  // same externalThreadId. When channelAccountId is null (legacy / unknown),
  // we fall back to channel + thread to preserve idempotency.
  const convIdentityWhere = channelAccountId == null
    ? and(
        eq(conversationsTable.channel, channel),
        isNull(conversationsTable.channelAccountId),
        eq(conversationsTable.externalThreadId, externalThreadId),
      )
    : and(
        eq(conversationsTable.channel, channel),
        eq(conversationsTable.channelAccountId, channelAccountId),
        eq(conversationsTable.externalThreadId, externalThreadId),
      );
  // Race-safe conversation upsert. The unique index is
  // (channel_account_id, external_thread_id) — when channelAccountId is null
  // we can't rely on the partial unique constraint catching duplicates, so
  // fall back to select-then-insert (acceptable: null channelAccountId only
  // occurs in legacy/unconfigured paths with low concurrency).
  let conversation = (
    await db
      .select()
      .from(conversationsTable)
      .where(convIdentityWhere)
      .limit(1)
  )[0];

  if (!conversation) {
    // New conversations start with the bot toggle from the "default-on for new
    // chats" setting (default OFF — nothing auto-enables until staff opt in).
    const aiConfig = await getAiAgentConfig(inboundCommunicationContext?.aiBotId);
    const insertResult = await db
      .insert(conversationsTable)
      .values({
        type: "external",
        title: contact.displayName || contact.phone || channel,
        channel,
        channelAccountId,
        aiBotId: inboundCommunicationContext?.aiBotId ?? null,
        communicationPipelineId: inboundCommunicationContext?.communicationPipelineId ?? null,
        externalContactId: externalContact.id,
        externalThreadId,
        unmatched: !isLinked,
        status: "open",
        botEnabled: isBlocked ? false : aiConfig.defaultOnForNew,
        lastMessageAt: message.receivedAt || new Date(),
        lastMessagePreview: message.text.slice(0, 200),
        lastInboundAt: message.receivedAt || new Date(),
        metadata: subAgentMatch
          ? { source: channel, subAgent: subAgentMatch }
          : { source: channel },
      })
      .onConflictDoNothing({
        target: [conversationsTable.channelAccountId, conversationsTable.externalThreadId],
      })
      .returning();
    if (insertResult.length > 0) {
      conversation = insertResult[0];
    } else {
      // Concurrent insert won the race — refetch the canonical conversation row.
      const [refetched] = await db
        .select()
        .from(conversationsTable)
        .where(convIdentityWhere)
        .limit(1);
      conversation = refetched;
      if (!conversation) {
        throw new Error("processInbound: conversation upsert returned no row");
      }
    }
  }

  // Attach legacy conversations to their inbound pipeline once it becomes
  // known, but never move a conversation that was already pinned elsewhere.
  if (
    inboundCommunicationContext &&
    (!conversation.aiBotId || !conversation.communicationPipelineId)
  ) {
    const communicationPatch = {
      ...(conversation.aiBotId
        ? {}
        : { aiBotId: inboundCommunicationContext.aiBotId }),
      ...(conversation.communicationPipelineId
        ? {}
        : {
            communicationPipelineId:
              inboundCommunicationContext.communicationPipelineId,
          }),
    };
    await db
      .update(conversationsTable)
      .set(communicationPatch)
      .where(eq(conversationsTable.id, conversation.id));
    conversation = { ...conversation, ...communicationPatch };
  }

  // Race-safe message insert. The unique index on (channel, externalMessageId)
  // doubles as our dedupe guarantee — a duplicate webhook delivery is dropped
  // by the DB and we report `duplicate: true` after a refetch.
  const insertedRows = await db
    .insert(messagesTable)
    .values({
      conversationId: conversation.id,
      content: message.text,
      channel,
      direction: "inbound",
      status: "received",
      externalMessageId: message.externalMessageId,
      sentAt: message.receivedAt || new Date(),
      metadata: message.metadata || {},
    })
    .onConflictDoNothing({
      target: [messagesTable.channel, messagesTable.externalMessageId],
    })
    .returning();

  if (insertedRows.length === 0) {
    const [existingMsg] = await db
      .select({ id: messagesTable.id })
      .from(messagesTable)
      .where(
        and(
          eq(messagesTable.channel, channel),
          eq(messagesTable.externalMessageId, message.externalMessageId),
        ),
      );
    return {
      conversationId: conversation.id,
      messageId: existingMsg?.id ?? 0,
      externalContactId: externalContact.id,
      duplicate: true,
      unmatched: !isLinked,
    };
  }
  const inserted = insertedRows[0];

  await db
    .update(conversationsTable)
    .set({
      lastMessageAt: message.receivedAt || new Date(),
      lastMessagePreview: message.text.slice(0, 200),
      lastInboundAt: message.receivedAt || new Date(),
      // `botReplyCount` is a consecutive AI-output guard, not a lifetime
      // conversation counter. Every accepted human inbound breaks the AI
      // streak, including messages on a reused provider thread.
      botReplyCount: 0,
      ...(isBlocked ? { botEnabled: false } : { status: "open" }),
      unmatched: !isLinked,
    })
    .where(eq(conversationsTable.id, conversation.id));

  if (channelAccountId) {
    await db
      .update(channelAccountsTable)
      .set({ lastSeenAt: new Date() })
      .where(eq(channelAccountsTable.id, channelAccountId));
  }

  if (!isBlocked) try {
    // Targeting:
    //   - if conversation has an assignee, send only to that user (assigned semantics).
    //   - else fall through to role-based routing in dispatchNotification.
    const recipientUserIds = conversation.assignedToId ? [conversation.assignedToId] : undefined;
    const baseData = {
      conversationId: conversation.id,
      channel,
      unmatched: !isLinked,
      assignedToId: conversation.assignedToId || null,
    };

    // Always dispatch inbox.new_message on every new inbound (per spec).
    // dispatchNotification writes in_app DB records synchronously then fires
    // email/WA delivery in the background — so await here is safe and fast.
    await dispatchNotification({
      event: "inbox.new_message",
      title: `New ${channel} message from ${contact.displayName || contact.phone || "contact"}`,
      body: message.text.slice(0, 280),
      actionUrl: `/staff/messages?conversation=${conversation.id}`,
      icon: "message",
      recipientUserIds,
      data: baseData,
    });

    // Additionally dispatch inbox.message_unmatched when no identity was
    // resolved, so the matching queue can route it to the appropriate role
    // pool. Channels (in_app / email / whatsapp) come from the UI-managed
    // notification rule — email is OFF by default to prevent mail floods.
    if (!isLinked) {
      await dispatchNotification({
        event: "inbox.message_unmatched",
        title: `Unmatched ${channel} message — needs review`,
        body: message.text.slice(0, 280),
        actionUrl: `/staff/messages?conversation=${conversation.id}`,
        icon: "alert",
        // Unmatched fans out per its rule (no recipientUserIds override).
        data: baseData,
      });
    }
  } catch (err) {
    console.error("[INBOX] Notification dispatch failed:", err);
  }

  // Push live update to any connected staff inbox streams.
  try {
    inboxBus.publish({
      type: "message",
      conversationId: conversation.id,
      channel,
      assignedToId: conversation.assignedToId ?? null,
      unmatched: !isLinked,
      direction: "inbound",
    });
  } catch (err) {
    console.error("[INBOX] Live event publish failed:", err);
  }

  return {
    conversationId: conversation.id,
    messageId: inserted.id,
    externalContactId: externalContact.id,
    duplicate: false,
    unmatched: !isLinked,
  };
}
