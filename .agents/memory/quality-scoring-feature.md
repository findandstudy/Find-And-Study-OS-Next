---
name: Conversation quality scoring
description: LLM chat-quality scoring engine, worker, RBAC visibility, and awaitingReply derivation
---
- Engine in api-server `src/lib/inbox/qualityScoring.ts`; config lives inside aiAgentConfig (QualityScoringConfig), NOT a new settings table.
- Nightly batch: worker ticks every 15 min; per-day claim via `system_kv` conditional upsert — never add a second scheduler for it.
- Dedup is contentHash-based upsert (`onConflictDoUpdate` on conversationId); re-scoring only when transcript changes.
- Visibility rule: admins/managers see all; other staff see only their own scores and ONLY when `selfVisible=true` (403 QUALITY_NOT_VISIBLE otherwise). Frontend StaffQualityTab must handle that 403 gracefully.
- **Why:** scores are sensitive HR-adjacent data; selfVisible is an org-level toggle in quality settings.
- awaitingReply (orange dot) is derived from LAST message direction subquery in routes/inbox.ts, not a stored flag; Messages.tsx also clears it optimistically on send.
