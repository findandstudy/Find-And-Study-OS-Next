---
name: Portal dry-test CLI reuse contract
description: How the local pnpm portal:dry CLI reuses the production runner/adapters without duplicating logic or changing worker behavior.
---

# Portal dry-test CLI single-source contract

`pnpm portal:dry <universityKey> <applicationId>` runs the SAME production
adapters + runner as the worker, forced dry + visible browser, so it can be
driven from a residential IP (Mac) without Cloudflare/bot blocks.

## Rule
The CLI must NOT re-implement adapter resolution, profile-building, or
credential-loading. It imports them:
- adapter resolution mirrors the runner: `adapterByKey(key) ?? adapterForUniversity(key)`.
- profile/docs via `buildProfileFromApplication(appId)` — a sibling of the
  worker's `buildStudentProfile(submissionId)`; both delegate to the SAME
  shared helpers (`buildSubmitProfileFromRecords`, `downloadStudentDocuments`)
  in `lib/portal-runner/src/profile.ts`.
- creds via the worker's `resolvePortalCreds`.

**Why:** duplicating any of these silently drifts the dry test away from what
the worker actually does, defeating the purpose of a local smoke test.

## Forcing dry + visible without touching production
`runSubmission` takes an optional last arg `opts?: { headless?: boolean }`,
default `true`. Worker/run-once omit it (behavior unchanged); the CLI passes
`{ headless:false }`. Dry is forced by `mode:"dry"` on the synthetic submission
(runner computes `isDry = mode !== "real"` → calls `adapter.submit(..., !isDry)`
i.e. doSubmit=false). **Never** hardcode headless or add a real-submit path to
the CLI.

## Keying difference
The CLI is keyed by applicationId (no portal_submissions row). It resolves the
student via `applications.studentId` (NOT NULL FK), whereas the worker uses
`portal_submissions.studentId`. These match in clean data; legacy divergence
would make CLI output differ from a real submission-row run.

## Plumbing
Root `package.json` `portal:dry` delegates via `pnpm --filter
@workspace/portal-automation-worker run portal:dry` → `tsx ./scripts/portal-dry.ts`.
Args forward through the nested pnpm chain.
