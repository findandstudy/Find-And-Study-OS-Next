---
name: Declarative portal-adapter engine capabilities & dry-run gate
description: What the JSON-config declarative portal engine supports and the contract for its dry-run safety gate.
---

## Engine scope

`lib/portal-adapters` runs DB-stored JSON step lists (zod-validated in `dbLoader.ts`) against a Playwright-like `MinimalPage` (`declarativeAdapter.ts`). Step types include the basics (navigate/fill/select/click/upload/wait/screenshot) plus conditional ones: `check` (checkbox state-diff), `radio` (profile-value→selector map with exact/startsWith/includes matching + `fallback`), `selectLabel` (`<select>` by visible OPTION label, not value), and `phone` (fills visible input + sets a hidden intl-tel full-number input via `evaluate`).

**Parity rule:** the `DeclarativeStep` TS union in `declarativeAdapter.ts` and the zod `stepSchema` union in `dbLoader.ts` must stay in lockstep — adding a variant or a `ProfileField` in one without the other silently rejects valid configs or drops a field. `PROFILE_FIELDS` in `dbLoader.ts` must mirror `SubmitProfile` keys.

## Dry-run gate contract

`adapter.submit(session, profile, files, doSubmit=true)` runs dry when `doSubmit===false` OR `process.env.PORTAL_DRYRUN==='1'`. In dry mode `runSteps(..., skipFinal=true)` skips ONLY `click` steps marked `{ final: true }`, then returns `{ submitted:false, alreadyExists:false, programMissing:false }` without classifying the page.

**Why:** dry-run must guarantee no real application is created during portal bring-up/testing.

**How to apply:** a declarative config's terminal submit click MUST carry `final: true`, or dry-run will still fire it and create a real application. This is a config-governance requirement, not enforced by the engine — when authoring a new portal config, mark the submit click `final`.
