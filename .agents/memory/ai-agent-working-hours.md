---
name: AI agent working-hours schedule
description: Weekly schedule gate for WhatsApp bot auto-reply — semantics and drift risks
---
Rule: schedule gate order is config.enabled → isAiAgentWithinWorkingHours → per-conversation toggle, enforced only inside maybeAutoReply (all webhook triggers funnel there); runBotReplyTest is intentionally ungated.
Overnight windows (start>end) belong to the START day and spill into the next day (end exclusive); start===end is invalid/no-match.
**Why:** ticket required Mon 09:00–04:00 to cover Tue 03:00 and total silence outside hours with exact log "[bot] mesai disi — atlandi (conv=<id>)".
**How to apply:** any change to window semantics must update BOTH api-server src/lib/inbox/botSchedule.ts AND edcons src/lib/aiSchedule.ts (UI badge/next-transition mirrors backend); config is the encrypted ai_agent jsonb blob — writeAiAgentConfig deep-merges schedule per day, no DB migration needed. Tests: api-server scripts/test-ai-schedule.ts.
