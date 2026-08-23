import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { aiBotsTable, db, knowledgeSourcesTable, pool } from "@workspace/db";
import { and, eq, ilike } from "drizzle-orm";
import { DEFAULT_ESCALATION_KEYWORDS } from "../src/lib/inbox/botBrain";
import { getAiAgentConfig, writeAiAgentConfig } from "../src/lib/inbox/aiAgentConfig";
import { createRagSource, updateRagSource } from "../src/lib/inbox/knowledgeSourcesAdmin";
import { ingestKnowledgeSource } from "../src/lib/inbox/knowledgeIngest";

const apply = process.argv.includes("--apply");
const slugArg = process.argv.find((value) => value.startsWith("--bot-slug="))?.split("=")[1]?.trim();
const knowledgePath = fileURLToPath(new URL("../../../docs/dormbooking-ai-operating-knowledge-v2.md", import.meta.url));

const rows = await db.select({ id: aiBotsTable.id, slug: aiBotsTable.slug, name: aiBotsTable.name })
  .from(aiBotsTable)
  .where(slugArg ? eq(aiBotsTable.slug, slugArg) : ilike(aiBotsTable.name, "%Dorm%Booking%"));
if (rows.length !== 1) {
  throw new Error(`Expected exactly one DormBooking AI bot, found ${rows.length}. Pass --bot-slug=<exact-slug>.`);
}
const bot = rows[0];
const current = await getAiAgentConfig(bot.id);
const knowledgeBase = await readFile(knowledgePath, "utf8");
const model = process.env.DORMBOOKING_AI_MODEL?.trim() || "claude-sonnet-4-5-20250929";
const scheduleDay = { enabled: true, start: "10:00", end: "19:00" };
const patch = {
  enabled: true,
  defaultOnForNew: true,
  model,
  temperature: 0.2,
  maxConsecutiveReplies: 6,
  programScope: { enabled: false, countries: "all", universityTypes: "all" },
  handoffMessage: current.handoffMessages.en,
  handoffMessages: current.handoffMessages,
  escalationKeywords: DEFAULT_ESCALATION_KEYWORDS,
  knowledgeBase,
  scheduleEnabled: true,
  timezone: "Europe/Istanbul",
  schedule: {
    mon: scheduleDay, tue: scheduleDay, wed: scheduleDay, thu: scheduleDay,
    fri: scheduleDay, sat: scheduleDay, sun: scheduleDay,
  },
} as const;

const [source] = await db.select({ id: knowledgeSourcesTable.id, isActive: knowledgeSourcesTable.isActive, status: knowledgeSourcesTable.status })
  .from(knowledgeSourcesTable)
  .where(and(eq(knowledgeSourcesTable.aiBotId, bot.id), eq(knowledgeSourcesTable.type, "dormbooking")));

console.log(JSON.stringify({
  mode: apply ? "apply" : "dry-run",
  bot: { id: bot.id, slug: bot.slug, name: bot.name },
  changes: {
    model: `${current.model} -> ${model}`,
    temperature: `${current.temperature} -> 0.2`,
    maxConsecutiveReplies: `${current.maxConsecutiveReplies} -> 6`,
    schedule: "Europe/Istanbul 10:00-19:00, every day",
    knowledgeChars: knowledgeBase.length,
    escalationGroups: Object.keys(DEFAULT_ESCALATION_KEYWORDS),
    dormBookingCatalogSource: source ?? "will be created",
  },
}, null, 2));

if (!apply) {
  await pool.end();
} else {
  await writeAiAgentConfig(patch, bot.id);
  let sourceId = source?.id;
  if (sourceId) {
    await updateRagSource(sourceId, bot.id, { isActive: true, name: "DormBooking Live Catalog" });
  } else {
    const created = await createRagSource({
      aiBotId: bot.id,
      type: "dormbooking",
      name: "DormBooking Live Catalog",
      config: {},
    });
    sourceId = created.id;
  }
  await ingestKnowledgeSource(sourceId);
  const [verified] = await db.select({ status: knowledgeSourcesTable.status, lastSyncedAt: knowledgeSourcesTable.lastSyncedAt })
    .from(knowledgeSourcesTable)
    .where(eq(knowledgeSourcesTable.id, sourceId));
  if (verified?.status !== "ready") throw new Error(`DormBooking catalog sync did not finish ready (status=${verified?.status ?? "missing"}).`);
  console.log(JSON.stringify({ applied: true, botId: bot.id, sourceId, catalog: verified }, null, 2));
  await pool.end();
}
