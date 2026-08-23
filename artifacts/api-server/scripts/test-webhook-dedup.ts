/**
 * Concurrent webhook delivery dedup test.
 *
 * Verifies the inbound pipeline is safe under the race condition where the
 * same webhook payload arrives twice in parallel (a common WhatsApp Cloud
 * API and web-form provider behavior when a 200 response is delayed).
 *
 * The test mirrors the production webhook path (src/routes/webhooks.ts) by
 * resolving a real `channelAccountId` via `ensureChannelAccount` before
 * invoking `processInboundMessage` — this exercises the same conversation
 * uniqueness index `(channel_account_id, external_thread_id)` that the live
 * routes hit.
 *
 * For each channel (whatsapp + web_form) we:
 *   1. Ensure a real `channel_accounts` row exists for the test.
 *   2. Fire two `processInboundMessage` calls for the same external message
 *      ID concurrently via `Promise.all`.
 *   3. Assert exactly one wrote a fresh message row and the other was the
 *      duplicate; both share the same conversation/message/contact ids.
 *   4. Assert the messages, conversations, and external_contacts tables
 *      contain exactly one row per logical event for this run.
 *   5. Assert `inbox.new_message` notifications were dispatched exactly
 *      once: at least one recipient row exists, and no per-user duplicates.
 *
 * Exits non-zero on any assertion failure so it can be wired into CI.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server run test:webhook-dedup
 *   # or directly:
 *   pnpm --filter @workspace/api-server exec tsx ./scripts/test-webhook-dedup.ts
 */
import {
  db,
  messagesTable,
  conversationsTable,
  externalContactsTable,
  notificationsTable,
  notificationRulesTable,
  channelAccountsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { processInboundMessage, type InboundResult } from "../src/lib/inbox/processInbound";

const RUN_ID = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

interface ScenarioResult {
  channel: string;
  ok: boolean;
  details: string[];
}

function assert(cond: boolean, msg: string, details: string[]): boolean {
  details.push(`${cond ? "OK   " : "FAIL "} ${msg}`);
  return cond;
}

/**
 * Seed an active staff user that matches the active `inbox.new_message` rule
 * so the "dispatched at least once" assertion is always exercised, regardless
 * of how sparse the local CI/dev DB is. The seeded user is tagged with the
 * RUN_ID so it can be removed in cleanup and never collides with reruns.
 *
 * The seeded role is chosen from the rule's recipient roles when available
 * (defaulting to "staff", which is in the default rule set) to make the test
 * self-correcting if the recipient roles drift over time.
 */
async function seedRecipient(): Promise<{ userId: number; email: string; role: string }> {
  const [rule] = await db
    .select()
    .from(notificationRulesTable)
    .where(
      and(
        eq(notificationRulesTable.event, "inbox.new_message"),
        eq(notificationRulesTable.isActive, true),
      ),
    );
  const roles = (rule?.recipientRoles as string[] | null) || [];
  const recipientType = rule?.recipientType ?? "role";
  // For recipientType="all" any active user qualifies; otherwise pick a role
  // that the rule actually targets. Fall back to "staff" which is in the
  // default rule set (DEFAULT_NOTIFICATION_RULES in lib/db/src/schema/notifications.ts).
  const role = recipientType === "all" ? "staff" : roles[0] ?? "staff";

  const email = `dedup-recipient-${RUN_ID}@test.local`;
  const [created] = await db
    .insert(usersTable)
    .values({
      email,
      firstName: "Dedup",
      lastName: `Recipient ${RUN_ID}`,
      role,
      isActive: true,
      emailVerified: true,
    })
    .returning({ id: usersTable.id });
  return { userId: created.id, email, role };
}

async function cleanupRecipient(userId: number): Promise<void> {
  // notifications.user_id has ON DELETE CASCADE so deleting the user wipes
  // their notification rows in the same transaction.
  try {
    await db.delete(usersTable).where(eq(usersTable.id, userId));
  } catch (err) {
    console.warn(`[cleanup recipient ${userId}] non-fatal:`, err);
  }
}

/**
 * Mirror of notificationDispatcher.ts recipient resolution for the
 * `inbox.new_message` rule. After `seedRecipient()` runs, this is expected
 * to return at least 1 — used as a precondition sanity check at startup so
 * a drift in the rule definition (e.g. role list changes) surfaces as an
 * explicit, actionable failure rather than a silent zero count.
 */
async function getEligibleRecipientCount(): Promise<number> {
  const [rule] = await db
    .select()
    .from(notificationRulesTable)
    .where(
      and(
        eq(notificationRulesTable.event, "inbox.new_message"),
        eq(notificationRulesTable.isActive, true),
      ),
    );
  if (!rule) return 0;

  const recipientType = rule.recipientType;
  const recipientRoles = (rule.recipientRoles as string[]) || [];

  if (recipientType === "all") {
    const rows = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.isActive, true));
    return rows.length;
  }
  if (recipientRoles.length > 0) {
    const rows = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(
        and(
          inArray(usersTable.role, recipientRoles),
          eq(usersTable.isActive, true),
        ),
      );
    return rows.length;
  }
  return 0;
}

/**
 * Mirror of webhooks.ts `ensureChannelAccount`. Reproduced verbatim to keep
 * the test execution path identical to production webhook routes.
 */
async function ensureChannelAccount(
  channel: string,
  displayName: string,
  externalAccountId: string,
): Promise<number> {
  const [existing] = await db
    .select()
    .from(channelAccountsTable)
    .where(
      and(
        eq(channelAccountsTable.channel, channel),
        eq(channelAccountsTable.externalAccountId, externalAccountId),
      ),
    );
  if (existing) return existing.id;
  const [created] = await db
    .insert(channelAccountsTable)
    .values({ channel, displayName, externalAccountId, status: "active" })
    .returning();
  return created.id;
}

async function runScenario(opts: {
  channel: string;
  channelAccountId: number;
  externalMessageId: string;
  externalContactId: string;
  text: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
  externalThreadId: string;
  seededRecipientUserId: number;
}): Promise<ScenarioResult> {
  const details: string[] = [];

  const payload = {
    channel: opts.channel,
    channelAccountId: opts.channelAccountId,
    contact: {
      externalId: opts.externalContactId,
      displayName: `Dedup Test ${opts.channel} ${RUN_ID}`,
      phone: opts.contactPhone ?? null,
      email: opts.contactEmail ?? null,
    },
    message: {
      externalMessageId: opts.externalMessageId,
      text: opts.text,
      externalThreadId: opts.externalThreadId,
      receivedAt: new Date(),
    },
  };

  // Fire both calls in parallel — this is the actual race we're guarding.
  const [a, b] = await Promise.all([
    processInboundMessage(payload).catch((err: Error) => err),
    processInboundMessage(payload).catch((err: Error) => err),
  ]);

  let ok = true;

  if (a instanceof Error || b instanceof Error) {
    ok = assert(
      false,
      `processInboundMessage threw: a=${a instanceof Error ? a.message : "ok"} b=${b instanceof Error ? b.message : "ok"}`,
      details,
    ) && ok;
    return { channel: opts.channel, ok, details };
  }

  const ra = a as InboundResult;
  const rb = b as InboundResult;

  ok = assert(
    ra.duplicate !== rb.duplicate,
    `exactly one call reported duplicate=true (a=${ra.duplicate}, b=${rb.duplicate})`,
    details,
  ) && ok;

  ok = assert(
    ra.conversationId === rb.conversationId && ra.conversationId > 0,
    `both calls returned the same conversationId (a=${ra.conversationId}, b=${rb.conversationId})`,
    details,
  ) && ok;

  ok = assert(
    ra.messageId === rb.messageId && ra.messageId > 0,
    `both calls returned the same messageId (a=${ra.messageId}, b=${rb.messageId})`,
    details,
  ) && ok;

  ok = assert(
    ra.externalContactId === rb.externalContactId && ra.externalContactId > 0,
    `both calls returned the same externalContactId (a=${ra.externalContactId}, b=${rb.externalContactId})`,
    details,
  ) && ok;

  // DB-side assertions: only one row per logical event.
  const msgRows = await db
    .select({ id: messagesTable.id })
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.channel, opts.channel),
        eq(messagesTable.externalMessageId, opts.externalMessageId),
      ),
    );
  ok = assert(
    msgRows.length === 1,
    `messages table has exactly 1 row for (${opts.channel}, ${opts.externalMessageId}) — found ${msgRows.length}`,
    details,
  ) && ok;

  const convRows = await db
    .select({ id: conversationsTable.id })
    .from(conversationsTable)
    .where(
      and(
        eq(conversationsTable.channelAccountId, opts.channelAccountId),
        eq(conversationsTable.externalThreadId, opts.externalThreadId),
      ),
    );
  ok = assert(
    convRows.length === 1,
    `conversations table has exactly 1 row for (channelAccountId=${opts.channelAccountId}, thread=${opts.externalThreadId}) — found ${convRows.length}`,
    details,
  ) && ok;

  const contactRows = await db
    .select({ id: externalContactsTable.id })
    .from(externalContactsTable)
    .where(
      and(
        eq(externalContactsTable.channel, opts.channel),
        eq(externalContactsTable.externalId, opts.externalContactId),
      ),
    );
  ok = assert(
    contactRows.length === 1,
    `external_contacts table has exactly 1 row for (${opts.channel}, ${opts.externalContactId}) — found ${contactRows.length}`,
    details,
  ) && ok;

  // Notifications: dispatchNotification only runs on the non-duplicate path,
  // so the row count for this conversationId must equal a single dispatch's
  // recipient fanout, not double it. We verify:
  //   - No user received more than one inbox.new_message for this conversation
  //     (this is the actual duplicate-dispatch invariant).
  //   - Total rows == distinct recipients (no double-fanout from a duplicate
  //     dispatch).
  // The "at least one recipient" check is done separately and only enforced
  // when the environment actually has eligible recipients for this rule —
  // otherwise sparse CI/dev DBs without active users would falsely fail.
  const notifs = await db
    .select({
      userId: notificationsTable.userId,
      cnt: sql<number>`count(*)::int`,
    })
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.type, "inbox.new_message"),
        sql`${notificationsTable.data}->>'conversationId' = ${String(ra.conversationId)}`,
      ),
    )
    .groupBy(notificationsTable.userId);

  // Hard assertion: the run-scoped seeded recipient guarantees the rule
  // resolves to at least one user, so a dispatch fanout MUST have produced
  // at least one notification row. A regression that breaks notification
  // fanout (e.g. the dispatcher no longer fires on processInboundMessage)
  // will fail this assertion in any environment, sparse or not.
  ok = assert(
    notifs.length > 0,
    `inbox.new_message dispatched at least once for this conversation (recipients=${notifs.length})`,
    details,
  ) && ok;

  // Stronger check: the seeded recipient specifically must appear in the
  // dispatch fanout. This proves the dispatcher targets the active rule's
  // role set correctly — if the role-resolution logic ever silently drops
  // matching users, this catches it even when other recipients still exist.
  const seededReceived = notifs.some(
    (r) => Number(r.userId) === opts.seededRecipientUserId,
  );
  ok = assert(
    seededReceived,
    `seeded eligible recipient (userId=${opts.seededRecipientUserId}) received the inbox.new_message notification`,
    details,
  ) && ok;

  const dupedUsers = notifs.filter((r) => Number(r.cnt) > 1);
  ok = assert(
    dupedUsers.length === 0,
    `no user received more than one inbox.new_message notification for this conversation (offenders: ${dupedUsers.map((d) => `${d.userId}=${d.cnt}`).join(", ") || "none"})`,
    details,
  ) && ok;

  const totalNotifs = notifs.reduce((sum, r) => sum + Number(r.cnt), 0);
  ok = assert(
    totalNotifs === notifs.length,
    `total notifications (${totalNotifs}) equals distinct recipients (${notifs.length}) — exactly one dispatch happened`,
    details,
  ) && ok;

  return { channel: opts.channel, ok, details };
}

async function cleanup(opts: {
  channel: string;
  channelAccountId: number;
  externalMessageId: string;
  externalContactId: string;
  externalThreadId: string;
  channelAccountWasCreated: boolean;
}): Promise<void> {
  // Best-effort cleanup; ignore errors so a failed test still tears down.
  try {
    const convRows = await db
      .select({ id: conversationsTable.id })
      .from(conversationsTable)
      .where(
        and(
          eq(conversationsTable.channelAccountId, opts.channelAccountId),
          eq(conversationsTable.externalThreadId, opts.externalThreadId),
        ),
      );
    const convIds = convRows.map((r) => r.id);
    if (convIds.length > 0) {
      // notifications referencing this conversation in data->>conversationId
      for (const t of ["inbox.new_message", "inbox.unmatched"] as const) {
        await db
          .delete(notificationsTable)
          .where(
            and(
              eq(notificationsTable.type, t),
              inArray(
                sql`(${notificationsTable.data}->>'conversationId')::int`,
                convIds,
              ),
            ),
          );
      }
    }

    await db
      .delete(messagesTable)
      .where(
        and(
          eq(messagesTable.channel, opts.channel),
          eq(messagesTable.externalMessageId, opts.externalMessageId),
        ),
      );

    if (convIds.length > 0) {
      await db.delete(conversationsTable).where(inArray(conversationsTable.id, convIds));
    }

    await db
      .delete(externalContactsTable)
      .where(
        and(
          eq(externalContactsTable.channel, opts.channel),
          eq(externalContactsTable.externalId, opts.externalContactId),
        ),
      );

    if (opts.channelAccountWasCreated) {
      await db
        .delete(channelAccountsTable)
        .where(eq(channelAccountsTable.id, opts.channelAccountId));
    }
  } catch (err) {
    console.warn(`[cleanup ${opts.channel}] non-fatal:`, err);
  }
}

interface ScenarioSpec {
  channel: string;
  channelAccountDisplayName: string;
  externalAccountId: string;
  externalMessageId: string;
  externalContactId: string;
  externalThreadId: string;
  text: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
}

async function main(): Promise<void> {
  console.log(`[webhook-dedup] starting run ${RUN_ID}`);

  // Seed a guaranteed-eligible staff user BEFORE any scenario runs so the
  // notification dispatch fanout always has at least one target. Stored in
  // a top-level binding so the finally block can tear it down even if a
  // scenario throws.
  let seededRecipient: { userId: number; email: string; role: string } | null = null;
  try {
    seededRecipient = await seedRecipient();
    console.log(
      `[webhook-dedup] seeded recipient userId=${seededRecipient.userId} role=${seededRecipient.role}`,
    );
  } catch (err) {
    // No outer finally to run yet — seedRecipient() failed before any rows
    // were inserted, so there's nothing to clean up.
    console.error("[webhook-dedup] failed to seed recipient:", err);
    process.exit(1);
  }

  const waPhone = `+15555${RUN_ID.slice(0, 6).replace(/[^0-9]/g, "0").padEnd(6, "0")}`;
  const wfEmail = `dedup_${RUN_ID}@example.test`;

  const scenarios: ScenarioSpec[] = [
    {
      channel: "whatsapp",
      channelAccountDisplayName: "WhatsApp Business (dedup test)",
      externalAccountId: `wa_phoneid_dedup_${RUN_ID}`,
      externalMessageId: `wamid.TEST_${RUN_ID}`,
      externalContactId: waPhone,
      externalThreadId: waPhone,
      text: "hello from a duplicate WA delivery",
      contactPhone: waPhone,
    },
    {
      channel: "web_form",
      channelAccountDisplayName: "Web Form (dedup test)",
      externalAccountId: `wf_form_dedup_${RUN_ID}`,
      externalMessageId: `wf_TEST_${RUN_ID}`,
      externalContactId: wfEmail,
      externalThreadId: wfEmail,
      text: "hello from a duplicate web_form delivery",
      contactEmail: wfEmail,
    },
  ];

  const results: ScenarioResult[] = [];
  let allOk = true;
  try {
    // Precondition: the freshly-seeded user must satisfy the active rule's
    // recipient query. If not, the rule definition has drifted (e.g. role
    // list changed) and the test would silently miss recipients — fail loud.
    // Throw (don't process.exit) so the outer finally still tears the
    // seeded recipient down.
    const eligible = await getEligibleRecipientCount();
    if (eligible < 1) {
      throw new Error(
        `precondition failed: 0 eligible recipients after seeding (rule recipient roles may have drifted)`,
      );
    }

    for (const s of scenarios) {
      let result: ScenarioResult;
      let channelAccountId = 0;
      let channelAccountWasCreated = false;
      try {
        // Track whether we created the channel_accounts row so cleanup only
        // removes rows we own.
        const before = await db
          .select({ id: channelAccountsTable.id })
          .from(channelAccountsTable)
          .where(
            and(
              eq(channelAccountsTable.channel, s.channel),
              eq(channelAccountsTable.externalAccountId, s.externalAccountId),
            ),
          );
        channelAccountWasCreated = before.length === 0;
        channelAccountId = await ensureChannelAccount(
          s.channel,
          s.channelAccountDisplayName,
          s.externalAccountId,
        );

        result = await runScenario({
          channel: s.channel,
          channelAccountId,
          externalMessageId: s.externalMessageId,
          externalContactId: s.externalContactId,
          externalThreadId: s.externalThreadId,
          text: s.text,
          contactPhone: s.contactPhone ?? null,
          contactEmail: s.contactEmail ?? null,
          seededRecipientUserId: seededRecipient!.userId,
        });
      } catch (err) {
        result = {
          channel: s.channel,
          ok: false,
          details: [`FAIL  scenario threw: ${err instanceof Error ? err.message : String(err)}`],
        };
      } finally {
        if (channelAccountId > 0) {
          await cleanup({
            channel: s.channel,
            channelAccountId,
            externalMessageId: s.externalMessageId,
            externalContactId: s.externalContactId,
            externalThreadId: s.externalThreadId,
            channelAccountWasCreated,
          });
        }
      }
      results.push(result);
    }

    for (const r of results) {
      console.log(`\n=== ${r.channel} ${r.ok ? "PASS" : "FAIL"} ===`);
      for (const d of r.details) console.log("  " + d);
      if (!r.ok) allOk = false;
    }

    console.log(`\n[webhook-dedup] ${allOk ? "PASS" : "FAIL"} (run ${RUN_ID})`);
  } finally {
    // Always tear down the seeded recipient — even when scenarios threw —
    // so reruns stay idempotent and a failed run doesn't leak users.
    await cleanupRecipient(seededRecipient!.userId);
  }

  // Don't await pool.end() — the inboxBus LISTEN client holds an open
  // connection for the lifetime of the process, so pool.end() would hang.
  // process.exit() tears everything down cleanly for a one-shot script.
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[webhook-dedup] unexpected error:", err);
  process.exit(1);
});
