// Sohbet Kalite Puanlama — Faz 1 scoring engine.
//
// Scores stable (idle) external conversations per staff member on 5
// dimensions (accuracy, completeness, speed, tone, outcome; 1-5) plus an
// overall 0-100. Four dimensions come from the LLM with rationale +
// PII-masked evidence quotes; SPEED is computed from real reply-pair timing
// data, never by the LLM. Bot messages (senderId null) are NEVER attributed
// to staff — they appear in the transcript labeled BOT for context only.
// A contentHash over the conversation's messages dedups re-scoring when
// nothing changed. Config lives in aiAgentConfig.quality.
import crypto from "crypto";
import { db, conversationQualityScoresTable, pool } from "@workspace/db";
import { getAnthropicClient } from "@workspace/integrations-anthropic-ai";
import { STAFF_ROLES } from "@workspace/roles";
import { getAiAgentConfig, type QualityScoringConfig } from "./aiAgentConfig";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DimensionResult {
  score: number; // 1-5
  rationale: string;
  evidence: string[]; // PII-masked short quotes
}

export interface QualityBatchResult {
  scanned: number;
  scored: number;
  skippedUnchanged: number;
  errors: number;
}

interface TranscriptMessage {
  id: number;
  senderId: number | null;
  direction: string;
  content: string;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// PII masking — applied to every evidence quote AFTER the LLM returns, as a
// hard guarantee on top of the prompt instruction.
// ---------------------------------------------------------------------------

export function maskPii(text: string): string {
  let out = text;
  // Emails
  out = out.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "***@***");
  // Phone-like sequences (7+ digits allowing separators)
  out = out.replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 7 ? "***tel***" : m;
  });
  // Long bare digit runs (passport / ID numbers)
  out = out.replace(/\b\d{7,}\b/g, "***no***");
  // URLs with query strings that may embed tokens
  out = out.replace(/https?:\/\/\S+/g, (m) => (m.includes("?") ? m.split("?")[0] + "?..." : m));
  return out;
}

// ---------------------------------------------------------------------------
// Speed — from real data. Average staff reply time (that user's first reply
// after each customer message) mapped onto a 1-5 band.
// ---------------------------------------------------------------------------

export function speedToScore(avgReplySeconds: number | null): number {
  if (avgReplySeconds == null) return 3; // no reply pairs measurable — neutral
  if (avgReplySeconds <= 120) return 5; // ≤ 2 min
  if (avgReplySeconds <= 600) return 4; // ≤ 10 min
  if (avgReplySeconds <= 3600) return 3; // ≤ 1 h
  if (avgReplySeconds <= 14400) return 2; // ≤ 4 h
  return 1;
}

/** Weighted overall 0-100 from the five 1-5 dimensions. */
export function computeOverall(d: {
  accuracy: number; completeness: number; speed: number; tone: number; outcome: number;
}): number {
  const weighted =
    d.accuracy * 0.25 + d.completeness * 0.2 + d.speed * 0.2 + d.tone * 0.15 + d.outcome * 0.2;
  return Math.round(((weighted - 1) / 4) * 100);
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 3;
  return Math.min(5, Math.max(1, n));
}

// ---------------------------------------------------------------------------
// Transcript building
// ---------------------------------------------------------------------------

const MAX_TRANSCRIPT_MESSAGES = 120;
const MAX_TRANSCRIPT_CHARS = 28000;

function roleLabel(m: TranscriptMessage, targetUserId: number): string {
  if (m.direction === "inbound") return "CUSTOMER";
  if (m.direction === "internal") return "NOTE";
  // outbound
  if (m.senderId == null) return "BOT";
  return m.senderId === targetUserId ? "STAFF" : "OTHER_STAFF";
}

export function buildTranscript(messages: TranscriptMessage[], targetUserId: number): string {
  const recent = messages.slice(-MAX_TRANSCRIPT_MESSAGES);
  const lines: string[] = [];
  let total = 0;
  for (const m of recent) {
    const content = (m.content || "").replace(/\s+/g, " ").slice(0, 600);
    const line = `[${roleLabel(m, targetUserId)}] ${content}`;
    total += line.length + 1;
    lines.push(line);
  }
  // If over the char budget, drop from the FRONT (keep the latest exchange).
  while (total > MAX_TRANSCRIPT_CHARS && lines.length > 10) {
    const removed = lines.shift()!;
    total -= removed.length + 1;
  }
  return lines.join("\n");
}

export function computeContentHash(messages: TranscriptMessage[]): string {
  const h = crypto.createHash("sha256");
  for (const m of messages) {
    h.update(`${m.id}:${m.direction}:${m.senderId ?? ""}:${m.content}\n`);
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------
// LLM scoring of the 4 subjective dimensions + topic + language.
// ---------------------------------------------------------------------------

const SCORING_SYSTEM = `You are a strict but fair quality reviewer for an international education consultancy's customer chat operations (WhatsApp / Messenger / Instagram).

You will receive a chat transcript. Lines are labeled:
- [CUSTOMER] — the customer/lead.
- [STAFF] — the SINGLE staff member you must evaluate.
- [BOT] — the AI assistant. NEVER attribute BOT messages to STAFF. Ignore BOT quality entirely; it is only conversational context.
- [OTHER_STAFF] — other team members. Do not score them.
- [NOTE] — internal notes, context only.

Score ONLY the [STAFF] member's performance on these dimensions, each 1-5 (integers):
- accuracy: factual correctness and reliability of the information STAFF gave.
- completeness: did STAFF address all of the customer's questions and needs?
- tone: professionalism, empathy, politeness, language quality.
- outcome: did the conversation move toward a concrete result (info delivered, next step agreed, application progressed, issue resolved)?

Also produce:
- topic: a SHORT lowercase topic label in Turkish, 1-3 words, from the customer's main subject (examples: "vize", "burs", "kayıt ücreti", "program seçimi", "belge talebi", "konaklama", "genel bilgi"). Pick the dominant one.
- language: the customer's primary language as a 2-letter code (tr, en, ar, ru, fr, fa, ...).

For EACH dimension give a one-to-two sentence rationale (in Turkish) and up to 2 SHORT evidence quotes from the transcript. In evidence quotes you MUST mask personal data: replace names with ***, emails with ***@***, phone/ID numbers with ***.

Respond with ONLY valid JSON, no markdown fences:
{"accuracy":{"score":1-5,"rationale":"...","evidence":["..."]},
 "completeness":{"score":1-5,"rationale":"...","evidence":["..."]},
 "tone":{"score":1-5,"rationale":"...","evidence":["..."]},
 "outcome":{"score":1-5,"rationale":"...","evidence":["..."]},
 "topic":"...","language":"xx"}`;

interface LlmScores {
  accuracy: DimensionResult;
  completeness: DimensionResult;
  tone: DimensionResult;
  outcome: DimensionResult;
  topic: string | null;
  language: string | null;
}

function parseDim(raw: any): DimensionResult {
  const evidence = Array.isArray(raw?.evidence)
    ? raw.evidence.slice(0, 3).map((e: unknown) => maskPii(String(e)).slice(0, 300))
    : [];
  return {
    score: clampScore(raw?.score),
    rationale: typeof raw?.rationale === "string" ? raw.rationale.slice(0, 1000) : "",
    evidence,
  };
}

// Test seam — tests override the LLM call to avoid a live key.
let __llmOverride: ((transcript: string) => Promise<LlmScores>) | null = null;
export function __setQualityLlmOverrideForTests(
  fn: ((transcript: string) => Promise<LlmScores>) | null,
): void {
  __llmOverride = fn;
}

async function scoreWithLlm(transcript: string, model: string): Promise<LlmScores> {
  if (__llmOverride) return __llmOverride(transcript);
  const anthropic = await getAnthropicClient();
  const resp = await anthropic.messages.create({
    model,
    max_tokens: 1500,
    system: SCORING_SYSTEM,
    messages: [{ role: "user", content: `Transcript:\n${transcript}` }],
  });
  const textBlock = resp.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("quality LLM returned no text");
  let text = textBlock.text.trim();
  // Tolerate accidental markdown fences.
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(text);
  return {
    accuracy: parseDim(parsed.accuracy),
    completeness: parseDim(parsed.completeness),
    tone: parseDim(parsed.tone),
    outcome: parseDim(parsed.outcome),
    topic: typeof parsed.topic === "string" ? parsed.topic.trim().toLowerCase().slice(0, 80) : null,
    language: typeof parsed.language === "string" ? parsed.language.trim().toLowerCase().slice(0, 8) : null,
  };
}

// ---------------------------------------------------------------------------
// Candidate selection + per-candidate scoring
// ---------------------------------------------------------------------------

interface Candidate {
  conversationId: number;
  userId: number;
  staffMessageCount: number;
}

async function findCandidates(cfg: QualityScoringConfig, limit: number): Promise<Candidate[]> {
  // Stable external conversations with >= minStaffMessages human outbound
  // messages per staff user, where no up-to-date score row exists yet.
  // "Up to date" is checked later via contentHash; here we only skip pairs
  // whose score is newer than the conversation's last message (cheap filter).
  const { rows } = await pool.query<{
    conversation_id: number; user_id: number; staff_msg_count: string;
  }>(
    `
    SELECT m.conversation_id, m.sender_id AS user_id, COUNT(*) AS staff_msg_count
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u ON u.id = m.sender_id
    LEFT JOIN conversation_quality_scores q
      ON q.conversation_id = m.conversation_id AND q.user_id = m.sender_id
    WHERE c.channel <> 'internal'
      AND c.last_message_at IS NOT NULL
      AND c.last_message_at < NOW() - ($1 || ' hours')::interval
      AND m.direction = 'outbound'
      AND m.sender_id IS NOT NULL
      AND u.role = ANY($4)
      AND (q.id IS NULL OR q.scored_at < c.last_message_at)
    GROUP BY m.conversation_id, m.sender_id
    HAVING COUNT(*) >= $2
    ORDER BY MAX(m.created_at) DESC
    LIMIT $3
    `,
    [String(cfg.idleHours), cfg.minStaffMessages, limit, STAFF_ROLES],
  );
  return rows.map((r) => ({
    conversationId: Number(r.conversation_id),
    userId: Number(r.user_id),
    staffMessageCount: Number(r.staff_msg_count),
  }));
}

async function loadMessages(conversationId: number): Promise<TranscriptMessage[]> {
  const { rows } = await pool.query<{
    id: number; sender_id: number | null; direction: string; content: string; created_at: Date;
  }>(
    `SELECT id, sender_id, direction, content, created_at
     FROM messages WHERE conversation_id = $1
     ORDER BY created_at ASC, id ASC`,
    [conversationId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    senderId: r.sender_id == null ? null : Number(r.sender_id),
    direction: r.direction,
    content: r.content,
    createdAt: new Date(r.created_at),
  }));
}

/** Average of this user's first-reply delays after each customer message. */
export function computeAvgReplySeconds(
  messages: TranscriptMessage[],
  userId: number,
): number | null {
  const deltas: number[] = [];
  let pendingInboundAt: Date | null = null;
  for (const m of messages) {
    if (m.direction === "inbound") {
      // Only the FIRST unanswered inbound in a burst starts the clock.
      if (pendingInboundAt == null) pendingInboundAt = m.createdAt;
    } else if (m.direction === "outbound") {
      if (pendingInboundAt != null && m.senderId === userId) {
        deltas.push((m.createdAt.getTime() - pendingInboundAt.getTime()) / 1000);
      }
      // ANY outbound (bot or other staff) answers the pending burst.
      if (pendingInboundAt != null) pendingInboundAt = null;
    }
  }
  if (!deltas.length) return null;
  return Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length);
}

export async function scoreCandidate(
  cand: Candidate,
  cfg: QualityScoringConfig,
): Promise<"scored" | "unchanged"> {
  const messages = await loadMessages(cand.conversationId);
  const contentHash = computeContentHash(messages);

  const { rows: existing } = await pool.query<{ content_hash: string }>(
    `SELECT content_hash FROM conversation_quality_scores
     WHERE conversation_id = $1 AND user_id = $2`,
    [cand.conversationId, cand.userId],
  );
  if (existing[0]?.content_hash === contentHash) {
    // Nothing changed — refresh scored_at so the candidate filter stops
    // re-selecting this pair every night.
    await pool.query(
      `UPDATE conversation_quality_scores SET scored_at = NOW(), updated_at = NOW()
       WHERE conversation_id = $1 AND user_id = $2`,
      [cand.conversationId, cand.userId],
    );
    return "unchanged";
  }

  const avgReplySeconds = computeAvgReplySeconds(messages, cand.userId);
  const speed = speedToScore(avgReplySeconds);
  const transcript = buildTranscript(messages, cand.userId);
  const llm = await scoreWithLlm(transcript, cfg.model);

  const dims = {
    accuracy: llm.accuracy.score,
    completeness: llm.completeness.score,
    speed,
    tone: llm.tone.score,
    outcome: llm.outcome.score,
  };
  const overall = computeOverall(dims);
  const rationales = {
    accuracy: llm.accuracy,
    completeness: llm.completeness,
    speed: {
      score: speed,
      rationale:
        avgReplySeconds == null
          ? "Ölçülebilir yanıt çifti yok — nötr puan."
          : `Gerçek verilerden hesaplandı: ortalama ilk yanıt süresi ${Math.round(avgReplySeconds / 60)} dk.`,
      evidence: [],
    },
    tone: llm.tone,
    outcome: llm.outcome,
  };

  await db
    .insert(conversationQualityScoresTable)
    .values({
      conversationId: cand.conversationId,
      userId: cand.userId,
      accuracy: dims.accuracy,
      completeness: dims.completeness,
      speed: dims.speed,
      tone: dims.tone,
      outcome: dims.outcome,
      overall,
      rationales,
      topic: llm.topic,
      language: llm.language,
      staffMessageCount: cand.staffMessageCount,
      avgReplySeconds,
      contentHash,
      model: cfg.model,
      scoredAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [conversationQualityScoresTable.conversationId, conversationQualityScoresTable.userId],
      set: {
        accuracy: dims.accuracy,
        completeness: dims.completeness,
        speed: dims.speed,
        tone: dims.tone,
        outcome: dims.outcome,
        overall,
        rationales,
        topic: llm.topic,
        language: llm.language,
        staffMessageCount: cand.staffMessageCount,
        avgReplySeconds,
        contentHash,
        model: cfg.model,
        scoredAt: new Date(),
        updatedAt: new Date(),
      },
    });
  return "scored";
}

// ---------------------------------------------------------------------------
// Batch runner + nightly worker
// ---------------------------------------------------------------------------

let batchRunning = false;

export async function runQualityBatch(opts?: { limit?: number }): Promise<QualityBatchResult> {
  const result: QualityBatchResult = { scanned: 0, scored: 0, skippedUnchanged: 0, errors: 0 };
  if (batchRunning) return result;
  batchRunning = true;
  try {
    const cfg = (await getAiAgentConfig()).quality;
    if (!cfg.enabled) return result;
    const limit = Math.min(opts?.limit ?? cfg.batchSize, 500);
    const candidates = await findCandidates(cfg, limit);
    result.scanned = candidates.length;
    for (const cand of candidates) {
      try {
        const r = await scoreCandidate(cand, cfg);
        if (r === "scored") result.scored++;
        else result.skippedUnchanged++;
      } catch (err: any) {
        result.errors++;
        console.error(
          `[quality] scoring conv=${cand.conversationId} user=${cand.userId} failed:`,
          err?.message || err,
        );
      }
    }
    if (result.scanned > 0) {
      console.log(
        `[quality] batch done: scanned=${result.scanned} scored=${result.scored} unchanged=${result.skippedUnchanged} errors=${result.errors}`,
      );
    }
    return result;
  } finally {
    batchRunning = false;
  }
}

const LAST_RUN_KV_KEY = "quality_scoring_last_run_date";
const CHECK_INTERVAL_MS = 15 * 60 * 1000;
let workerTimer: NodeJS.Timeout | null = null;

/** Nightly batch: checks every 15 min; fires once per UTC day at runHourUtc. */
export function startQualityScoringWorker(): () => Promise<void> {
  if (workerTimer) return stopQualityScoringWorker;
  const tick = async (): Promise<void> => {
    try {
      const cfg = (await getAiAgentConfig()).quality;
      if (!cfg.enabled) return;
      const now = new Date();
      if (now.getUTCHours() !== cfg.runHourUtc) return;
      const today = now.toISOString().slice(0, 10);
      // system_kv guard — once per day, safe across multiple instances (the
      // conditional upsert only lets ONE instance claim the run).
      const { rows } = await pool.query<{ key: string }>(
        `INSERT INTO system_kv (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
         WHERE system_kv.value <> EXCLUDED.value
         RETURNING key`,
        [LAST_RUN_KV_KEY, today],
      );
      if (!rows.length) return; // already ran today
      await runQualityBatch();
    } catch (err: any) {
      console.error("[quality] worker tick error:", err?.message || err);
    }
  };
  workerTimer = setInterval(() => { void tick(); }, CHECK_INTERVAL_MS);
  workerTimer.unref?.();
  console.log("[quality] nightly scoring worker started");
  return stopQualityScoringWorker;
}

export async function stopQualityScoringWorker(): Promise<void> {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  const deadline = Date.now() + 10_000;
  while (batchRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
