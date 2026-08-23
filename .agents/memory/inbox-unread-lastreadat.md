---
name: Inbox unread badge lastReadAt
description: How unread/awaiting badges are tracked and the concurrency rule for lastReadAt
---
Rule: opening a conversation bumps `conversation_participants.last_read_at` via atomic `INSERT ... ON CONFLICT (conversation_id, user_id) DO UPDATE` (unique index `cp_conv_user_uniq` exists in boot DDL). Never use select/update-then-insert — concurrent opens raced and duplicates would break the scalar `cp.last_read_at` subqueries in the list query.
**Why:** unreadCount and the unread tab filter use scalar subqueries that throw on duplicate participant rows.
**How to apply:** any new read-tracking write must go through the same upsert; new per-student inbox-adjacent endpoints (e.g. doc preflight) must use `assertCanAccessStudent` (IDOR).
