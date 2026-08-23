import test from "node:test";
import assert from "node:assert/strict";
import { drizzle } from "drizzle-orm/node-postgres";
import { integer, pgTable } from "drizzle-orm/pg-core";
import {
  inboxAwaitingReplySql,
  inboxEffectiveAssignedToSql,
  inboxIsStarredSql,
  inboxIsSubscribedSql,
  inboxUnreadCountSql,
  manualUnreadLastReadAt,
} from "../src/lib/inboxConversationIndicators";

// Query-generation tests do not need a database connection or the full CRM
// schema. Keeping this fixture local makes the regression suite deterministic
// and fast even when the development database is stopped.
const db = drizzle.mock();
const conversationsTable = pgTable("conversations", {
  id: integer("id"),
});

test("inbox indicators correlate to the qualified outer conversation id", () => {
  const compiled = db
    .select({
      id: conversationsTable.id,
      isStarred: inboxIsStarredSql(8),
      isSubscribed: inboxIsSubscribedSql(8),
      unreadCount: inboxUnreadCountSql(8),
      awaitingReply: inboxAwaitingReplySql(),
      assignedToId: inboxEffectiveAssignedToSql(),
    })
    .from(conversationsTable)
    .toSQL();

  const qualifiedMatches =
    compiled.sql.match(/conversation_id = "conversations"\."id"/g) ?? [];

  assert.equal(qualifiedMatches.length, 5);
  assert.doesNotMatch(compiled.sql, /conversation_id = "id"/);
  assert.deepEqual(compiled.params, [8, 8, 8]);
});

test("effective inbox owner follows student, lead, conversation precedence", () => {
  const compiled = db
    .select({ assignedToId: inboxEffectiveAssignedToSql() })
    .from(conversationsTable)
    .toSQL();

  const normalized = compiled.sql.replace(/\s+/g, " ");
  assert.match(normalized, /coalesce\s*\(/i);
  assert.match(normalized, /join students s/i);
  assert.match(normalized, /join leads l/i);
  assert.match(normalized, /ec\.id = "conversations"\."external_contact_id"/i);
  assert.match(normalized, /"conversations"\."assigned_to_id"/i);
  assert.ok(
    normalized.indexOf("JOIN students s") < normalized.indexOf("JOIN leads l"),
    "student owner must take precedence over lead owner",
  );
});

test("manual unread cursor sits immediately before the latest inbound message", () => {
  const latest = new Date("2026-07-30T00:36:12.500Z");
  const cursor = manualUnreadLastReadAt(latest);

  assert.equal(cursor.toISOString(), "2026-07-30T00:36:12.499Z");
  assert.equal(manualUnreadLastReadAt(latest.toISOString()).getTime(), cursor.getTime());
  assert.throws(() => manualUnreadLastReadAt("not-a-date"), /Invalid latest inbound timestamp/);
});
