---
name: Lifting a child's submit/readiness to a parent footer
description: Pattern + pitfall when a child's action button is moved to a parent sticky footer via ref + state.
---

When a child component's primary action button is moved into a parent-owned area
(e.g. a sticky footer outside the child), lift two things to the parent:
- a `submitRef` (MutableRefObject) the child assigns its latest submit closure to
  (assign in an effect that runs every render so the closure is never stale), and
- a readiness flag via an `onReady(bool)` callback the child calls when its
  preconditions are met.

**Why:** Without lifecycle cleanup this stale-enables across view/step changes.
If the parent keeps `sigReady`/`submitRef` in state and the child can unmount and
remount (e.g. step `sign → review → sign`), the first render of the second mount
can still see the previous `ready=true` and the old ref closure — so the footer
button renders enabled and a fast click fires the **previous** mount's handler.

**How to apply:**
1. Child effects must clean up: `submitRef.current = null` and `onReady(false)`
   on unmount (return cleanups from the effects).
2. Parent must reset the lifted state when it leaves the relevant view:
   `useEffect(() => { if (step !== "sign") { ref.current = null; setReady(false); } }, [step])`.
3. Refs don't trigger re-render, so don't rely on `!ref.current` in `disabled`;
   gate on the lifted readiness state instead.
