---
name: Vite ships render-time ReferenceErrors silently
description: Why undefined/out-of-scope references in edcons web compile fine but crash at runtime, and how the ErrorBoundary turns that into a reload loop in the Replit canvas.
---

Vite dev/build uses esbuild, which transpiles by stripping TypeScript types and does
NOT do whole-program scope/type checking. A name that is referenced but out of scope
(e.g. a helper defined inside an IIFE/block but used outside it) compiles and serves
fine, then throws `ReferenceError: X is not defined` at the moment that JSX renders.

In artifacts/edcons this is especially dangerous because:
- The top-level `ErrorBoundary` catches any render throw and does a CACHE-BUSTED RELOAD
  (`location.replace` with `?_cb=`), not just an inline fallback.
- Its "reload at most once per 5 min" guard lives in **sessionStorage**. In the Replit
  canvas the in-memory routing freezes the URL and the canvas proxy RECREATES the iframe
  on every Vite reconnect, wiping sessionStorage — so the cooldown never persists and the
  page reloads **every** time the error recurs. Symptom the user sees: "reload page error,
  page refreshes" right when the broken view first renders.

**Why this matters:** such a bug is invisible to a quick read and to `vite build`; it only
shows up as a runtime crash on the specific surface that renders the broken code (e.g. a
dialog step that only mounts after a button click), which makes it look data/AI-dependent
when it is actually a plain scoping bug.

**How to apply:** after editing edcons `.tsx`, run `npx tsc --noEmit -p tsconfig.json`
(filter to the changed file) — tsc *does* catch "Cannot find name 'X'". Don't trust the dev
server compiling as proof the render path is sound. When a page mysteriously reloads on a
specific interaction, reproduce in a real browser and read the console for a ReferenceError /
`[ErrorBoundary]` log before theorizing about data shapes.
