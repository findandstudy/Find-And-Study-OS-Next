---
name: notifications table cascade-delete timeout
description: Deleting users times out via FK cascade into notifications; pre-existing infra debt unrelated to feature work touching users/notifications.
---

`notifications` has grown to millions of rows with only a PARTIAL index on `user_id` (`WHERE is_read = false`). Deleting users (test cleanup or real admin action) cascades via `ON DELETE CASCADE` into `notifications`, and for read rows there's no index to use — causes `canceling statement due to statement timeout` / `Query read timeout` under load.

**Why:** surfaced as a flaky failure in `test-tasks-access-control.ts` cleanup (`delete from users where id in (...)`) with no relation to whatever feature was being tested — don't assume a user-delete-cascade timeout is caused by your current change.

**How to apply:** if you need reliable user deletion (bulk test cleanup, admin delete-user flows) at scale, add a full btree index on `notifications(user_id)` — the existing partial index only covers unread rows. Not yet fixed as of this writing; treat repeated timeouts on this exact query shape as this known issue, not a regression.
