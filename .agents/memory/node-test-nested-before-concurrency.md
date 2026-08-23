---
name: node:test v24 nested before() concurrency
description: Nested describe before() hooks run concurrently in node:test v24 — shared resource creation races. Hoist to root before() to fix.
---

## The Rule

When multiple `describe` blocks in a single node:test file each have their own `before()` that creates shared DB rows (or any shared state), those `before()` hooks may run concurrently. If a later suite's test body references an ID created by an earlier suite's `before()`, the ID may not exist yet.

**Why:** node:test v24 processes describe blocks concurrently by default. The `before()` inside each describe starts as soon as the describe is entered, not sequentially.

**How to apply:** Any fixture that must be visible across multiple suites should be created in the root (top-level) `before()` hook — not inside individual `describe` blocks. Only suite-local fixtures belong in describe-level `before()`.

```ts
// BAD — races between suite1.before() and suite2.before()
describe("Suite 1", () => {
  before(async () => { sharedId = await createRow(); }); // may not finish before Suite 2 tests read it
  test("uses sharedId", ...);
});

// GOOD — root before() runs once, all suites see it
before(async () => { sharedId = await createRow(); });
describe("Suite 1", () => {
  test("uses sharedId", ...); // sharedId guaranteed to exist
});
```

## Observed instance

`scripts/test-person-feed.ts` — Suite 1 `before()` created `suite1NoteOnAId` and `suite1FuOnAId`. Suite 2 tests read these IDs but Suite 1's `before()` hadn't finished, causing 500 errors. Fixed by hoisting both creations to the root `before()`.
