---
name: Manual portal submission (admin board)
description: Admin manual portal enqueue endpoint — shared university resolver, credential-gate difference vs auto-trigger, coexisting legacy path, and the in-memory rate-limiter test gotcha.
---

# Manual portal submission

Admins manually queue applications to a university portal (Submission Board "Yeni Gönderim" + per-app panel) via `POST /portal-automation/submit` and discover candidates via `GET /portal-automation/eligible-applications`.

- **Shared university resolver.** Both the auto-trigger (`maybeEnqueuePortalSubmission`) and manual submit resolve the portal university from the application's OWN record through `findActivePortalUniversity({universityId, universityName})` (crmUniversityId exact OR case-insensitive name match; active + not-deleted). Never hardcode `universityKey`. **Why:** keeps auto and manual paths consistent — changing match logic in one must not diverge from the other. **How to apply:** any new submit surface must call this helper, not re-implement matching.

- **Manual submit intentionally skips the credential gate.** The auto-trigger checks portal credentials before enqueuing; manual submit does NOT (an admin may queue dry runs / queue ahead of credential setup). Don't "fix" this by adding a credential check.

- **Two single-app paths coexist (known divergence).** The NEW board path is admin-only (`requireRole(...ADMIN_ROLES)`) with server-resolved university. The PRE-EXISTING `PortalSubmissionPanel` on ApplicationDetail still POSTs to legacy `POST /applications/:appId/portal-submissions`, which allows `STAFF_ROLES` and accepts a client-provided `universityKey`. This was left as-is (sprint scope = optional, retiring it is a behavior change). If a future task wants admin-only single-app, migrate the panel to `/portal-automation/submit` and gate/retire the legacy route.

- **Queuing never auto-processes.** Insert only `status='queued'`; drain-once/worker still key off `portal_universities.autoProcess=true`. Don't couple enqueue to processing.

- **Test gotcha — module-level in-memory rate limiter persists across tests.** The per-user limiter (`_manualSubmitHits`, 20/10s) lives at module scope, so it accumulates across every test in the same process. The saturating burst test must be registered LAST, or it bleeds 429s into later `/submit` tests sharing the same user id. Also: use an EXISTING user id for the burst, else the fire-and-forget `logAudit` insert violates the `audit_logs → users` FK (harmless stderr noise, but pollutes output).

- **Core enqueue loop is now extracted to a shared helper (`api-server/src/lib/portalManualEnqueue.ts`, `enqueuePortalSubmissions()`)** — resolves routing, applies the ALREADY_QUEUED/NO_PORTAL/NOT_FOUND duplicate guard, and inserts the `portal_submissions` row. Both `/portal-automation/submit` (admin-only) and a staff-accessible `run_portal_automation` action on `/applications/bulk-action` call it with `mode` as the only real difference. **Why:** any NEW bulk/manual enqueue surface must call this helper instead of re-implementing the loop, or the duplicate-guard/skip-reason semantics will drift between surfaces.
