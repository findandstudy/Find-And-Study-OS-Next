---
name: Fast Refresh mixed exports crash
description: Why edcons dev showed the "Page could not be loaded" ErrorBoundary mid-session, and the rule that prevents it.
---

A `.tsx` file that exports BOTH a React component AND a non-component value
(a hook, util function, type, or context object) breaks React Fast Refresh.
Vite logs `hmr invalidate ... Could not Fast Refresh ("X" export is incompatible)`
and falls back to a **full-page module-graph reload**. During a rapid edit
cascade that full reload can momentarily crash a mounted shell component
(observed: `<DashboardLayout>` throwing an empty `{}` error), which trips the
ErrorBoundary "Page could not be loaded" screen.

**Why:** this is a dev-only HMR artifact (production has no HMR). It does NOT
explain production occurrences of the same screen — in prod that screen is the
already-handled stale-chunk-after-deploy case (App.tsx `lazyRetry` retries the
dynamic import, then ErrorBoundary does one cache-busted reload per pathname).
Do not conflate the two; don't oversell a Fast Refresh fix as a prod fix.

**How to apply:** keep component files exporting only components. Move hooks,
util functions, types, and context objects into their own non-component module
(e.g. `password-policy.ts`, `use-i18n-context.ts`). If a non-component export
has zero external importers, just drop the `export` keyword (e.g. CookieBanner
`getConsent`). To verify a fix: edit the file, then confirm the vite log shows
`hmr update` for it with NO new `Could not Fast Refresh` line.

**Phantom "Invalid hook call" / "more than one copy of React":** a SYNTAX error
earlier in the same dev session (e.g. a duplicate `const`/declaration) can leave
the BROWSER holding a half-applied/stale module graph. After you fix the source,
the browser may KEEP crashing with `Invalid hook call ... in <SomeComponent>` +
empty `[ErrorBoundary]{}` in a reload loop — even though tsc is clean, there is a
single React install, and every hook is structurally correct. Do NOT chase a
code bug; there isn't one. **Recovery:** fix the source, `rm -rf
node_modules/.vite` (the artifact's, not root), restart the vite workflow, then
let the browser do ONE full reload — the new `?v=<hash>` on optimized deps forces
fresh modules and the error clears (confirmed by a clean `APP INIT` with no hook
error after the reload). If you can't trigger the user's browser reload, tell
them to hard-refresh (Ctrl+Shift+R).
