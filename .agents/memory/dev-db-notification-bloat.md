---
name: Dev-DB notification bloat & connect timeouts
description: Why webhook-dedup grinds/fails and why connect timeout must stay >=10s
---
The inbox notification dispatch fans out one in_app row per eligible staff user. The dev DB has ~10k leaked staff/admin test users, so every webhook-dedup run adds ~8k notifications rows. Once notifications passed 13M rows, the dedup verification aggregate (group-by over data->>'conversationId') took ~24s and the whatsapp scenario ran for many minutes / failed.

**Why:** leaked test users + per-recipient row fan-out compound across runs; the table is never pruned.
**How to apply:** if webhook-dedup stalls with "[db pool] pressure ... SELECT pg_notify" and totalCount stuck low, check `select count(*) from notifications` first. Purge via temp-table+TRUNCATE+reinsert (batched DELETE of 13M rows is far too slow). Also: pool connect timeout (DB_CONNECT_TIMEOUT_MS) below ~10s produces spurious "timeout exceeded when trying to connect" in busy Node processes even when the DB itself connects in ms — the event loop delays the handshake callbacks.
