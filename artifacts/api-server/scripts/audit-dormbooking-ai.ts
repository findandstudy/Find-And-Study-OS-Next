import { db, pool } from "@workspace/db";
import { sql } from "drizzle-orm";
import { extractDormBookingCatalog } from "../src/lib/inbox/dormBookingKnowledge.js";

const violations: any = await db.execute(sql`
  SELECT
    handoff.conversation_id AS "conversationId",
    handoff.id AS "handoffMessageId",
    later.id AS "laterBotMessageId",
    later.created_at AS "laterBotMessageAt"
  FROM messages handoff
  JOIN messages later
    ON later.conversation_id = handoff.conversation_id
   AND later.id > handoff.id
   AND later.metadata->>'botSent' = 'true'
   AND coalesce(later.metadata->>'botHandoff', 'false') <> 'true'
  WHERE handoff.metadata->>'botHandoff' = 'true'
    AND handoff.created_at >= now() - interval '30 days'
  ORDER BY handoff.conversation_id, later.id
`);

const triggerDistribution: any = await db.execute(sql`
  SELECT coalesce(metadata->>'topic', 'unknown') AS reason, count(*)::int AS count
  FROM messages
  WHERE metadata->>'botHandoff' = 'true'
    AND created_at >= now() - interval '7 days'
  GROUP BY 1
  ORDER BY count(*) DESC
`);

const catalog = await extractDormBookingCatalog();
console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  handoffViolationsLast30Days: violations.rows ?? violations,
  handoffTriggerDistributionLast7Days: triggerDistribution.rows ?? triggerDistribution,
  catalogQuality: {
    dormCount: catalog.dormCount,
    roomCount: catalog.roomCount,
    suppressedDormCount: catalog.suppressedDormCount,
    incompletePricedRoomCount: catalog.incompletePricedRoomCount,
    incompletePriceFields: catalog.incompletePriceFields,
    fetchedAt: catalog.fetchedAt,
  },
}, null, 2));
await pool.end();
