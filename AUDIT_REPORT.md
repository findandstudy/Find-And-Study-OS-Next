# EduConsult OS - Production Readiness Audit Report

**Date:** 2026-03-24  
**Auditor:** Senior Architect Review  
**Scope:** Full codebase security, stability, and production readiness audit

---

## Executive Summary

The EduConsult OS platform demonstrates solid foundational security with session-based authentication, role-based access control, parameterized database queries (Drizzle ORM), and proper IDOR prevention. Several critical and high-severity issues were identified and fixed. Remaining items are documented as a checklist below.

---

## Findings by Severity

### CRITICAL - Fixed

| # | Issue | File(s) | Fix Applied |
|---|-------|---------|-------------|
| C1 | **Hardcoded passwords in source code** - Super admin and agent seed passwords were plaintext in `index.ts` | `artifacts/api-server/src/index.ts` | Replaced with `process.env.SEED_ADMIN_PASSWORD` and `process.env.SEED_AGENT_PASSWORD` environment variables |
| C2 | **Error message leakage in AI routes** - `err.message` returned to client, potentially exposing API keys, internal paths, or DB connection strings | `artifacts/api-server/src/routes/ai-extract.ts` | Replaced with generic error messages ("AI extraction failed", "CSV parsing failed") |

### HIGH - Fixed

| # | Issue | File(s) | Fix Applied |
|---|-------|---------|-------------|
| H1 | **XSS in embeddable widget** - Unescaped database values (logo URLs, filter options) injected into HTML | `artifacts/api-server/src/routes/embed.ts` | Wrapped all dynamic values with existing `esc()` function |
| H2 | **Missing rate limiting on AI endpoints** - AI extraction routes had no rate limits, enabling resource exhaustion/DoS | `artifacts/api-server/src/routes/ai-extract.ts` | Added per-user rate limiting (10 req/15min for document extraction, 5 req/15min for CSV bulk) |
| H3 | **No process crash handlers** - Unhandled promise rejections could silently crash the server | `artifacts/api-server/src/index.ts` | Added `process.on('unhandledRejection')` and `process.on('uncaughtException')` handlers |
| H4 | **Global error handler leaks details in non-production** - Any environment besides explicit "production" exposed `err.message` | `artifacts/api-server/src/app.ts` | Changed to only expose messages for client errors (4xx); all 5xx errors now return generic message regardless of environment |
| H5 | **Excessive request body size (50MB)** - Could be exploited for memory exhaustion | `artifacts/api-server/src/app.ts` | Reduced `express.json` and `express.urlencoded` limit from 50MB to 10MB |

### CRITICAL - Fixed (Authorization)

| # | Issue | File(s) | Fix Applied |
|---|-------|---------|-------------|
| C3 | **`isActive` field in user self-patch** - Regular users could activate/deactivate their own account by including `isActive` in PATCH body | `artifacts/api-server/src/routes/users.ts` | Moved `isActive` from `ALLOWED_PATCH_FIELDS` to `ADMIN_PATCH_FIELDS` |

### HIGH - Fixed (Data Leakage & Path Traversal)

| # | Issue | File(s) | Fix Applied |
|---|-------|---------|-------------|
| H7 | **University contact info exposed on public endpoint** - `contactPersonName`, `contactPersonPhone`, `contactPersonEmail` sent to unauthenticated users via `/api/course-finder` | `artifacts/api-server/src/routes/course-finder.ts` | Contact fields restricted to staff and agent roles only; stripped for unauthenticated users and students |
| H8 | **Path traversal on storage endpoints** - `..` sequences in object path could traverse directory tree | `artifacts/api-server/src/routes/storage.ts` | Added `..` and `\` rejection on both `/storage/objects/*` and `/storage/public-objects/*` |

### HIGH - Fixed (Security Headers)

| # | Issue | File(s) | Fix Applied |
|---|-------|---------|-------------|
| H6 | **Missing security headers** - No `X-Content-Type-Options`, `Referrer-Policy`, or `Permissions-Policy` headers | `artifacts/api-server/src/app.ts` | Added `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()` |

---

### MEDIUM - Fixed

| # | Issue | Fix Applied |
|---|-------|-------------|
| M1 | **No CSRF protection** | Double-submit cookie CSRF pattern added. `csrf_token` cookie + `x-csrf-token` header validated on POST/PATCH/DELETE. Excluded paths: `/api/public/`, `/api/course-finder`, `/api/auth/`. Frontend global fetch interceptor in `csrfSetup.ts`. |
| M2 | **Content Security Policy disabled** | CSP enabled in Helmet with `script-src 'self' 'unsafe-inline'`, `style-src 'self' 'unsafe-inline'` (required for shadcn/Tailwind), `object-src 'none'`, `frame-ancestors 'self'`. |
| M3 | **Missing database foreign key constraints** | FK references added to all schema files with appropriate ON DELETE actions (SET NULL for nullable FKs, CASCADE for child records, RESTRICT for required FKs). |
| M4 | **Missing unique constraint on `students.email`** | Unique index added on `students.email`. |
| M5 | **Missing database indexes** | Indexes added on frequently filtered columns (`agentId`, `studentId`, `status`, `season`, `assignedToId`, etc.) across students, applications, leads, documents, finance schemas. |
| M6 | **Async routes without try-catch** | Express 5.2.1 natively propagates async errors to the error handler — no wrapper needed. |
| M8 | **Rate limiting on storage upload endpoint** | In-memory rate limiter added: 30 uploads per 15 minutes per user on `POST /storage/uploads/request-url`. |

### MEDIUM - Remaining

| # | Issue | Details | Priority |
|---|-------|---------|----------|
| M7 | **`dangerouslySetInnerHTML` in chart component** | `ChartStyle` component in `chart.tsx` injects CSS via `dangerouslySetInnerHTML`. Low risk if chart config is developer-controlled. | Low-Medium |
| M9 | **Sequential DB queries in POST /applications** | Multiple `await` calls (student, program, university lookups) could be parallelized with `Promise.all` for better latency. | Low-Medium |
| M10 | **Audit log writes are synchronous** | `logAudit()` is awaited inline in request handlers. Should be fire-and-forget or queued to avoid adding latency. | Low |

### LOW - Fixed

| # | Issue | Fix Applied |
|---|-------|-------------|
| L1 | **No pagination on sub-resource endpoints** | Pagination (page/limit with defaults and max caps) added to: application notes, lead notes, lead follow-ups, stage documents, missing-doc notes, sub-agents. |

### LOW - Remaining

| # | Issue | Details |
|---|-------|---------|
| L2 | **In-memory rate limiter for auth routes** | Uses a `Map` that resets on server restart. Acceptable for single-instance deployments, but consider Redis-backed limiter for multi-instance. |
| L3 | **`students.userId` and `agents.userId` are nullable** | Allows orphaned entities. Consider making non-null with migration for existing data. |
| L4 | **Missing HSTS header** | Helmet enables it by default, but verify it's present in production responses. |

### NEW - Soft Delete

| # | Feature | Details |
|---|---------|---------|
| S1 | **Soft delete for students** | `deletedAt` column added. DELETE sets timestamp instead of hard-deleting. GET queries filter `WHERE deletedAt IS NULL`. |
| S2 | **Soft delete for applications** | `deletedAt` column added. DELETE sets timestamp instead of hard-deleting. GET queries filter `WHERE deletedAt IS NULL`. |
| S3 | **Soft delete for documents** | `deletedAt` column added. Single and bulk DELETE set timestamp instead of hard-deleting. GET queries filter `WHERE deletedAt IS NULL`. |

---

## What's Already Done Well

- **SQL Injection**: No vulnerabilities found. Drizzle ORM parameterizes all queries. Manual `sql` uses proper template interpolation.
- **Authentication**: bcrypt (salt 10), secure session cookies (`httpOnly`, `secure`, `sameSite: lax`), 7-day TTL.
- **Authorization**: Consistent `requireAuth` + `requireRole()` middleware. IDOR prevention with ownership checks on students, applications, leads, documents.
- **SEO**: Public pages have proper meta tags, OG tags, canonical URLs. Private pages use `noindex`.
- **Audit Logging**: All create/update/delete operations logged with user ID and IP.
- **Input Validation**: ID parsing with `parseInt` + `isNaN` checks. String length limits. Zod validation on storage routes.
- **CORS**: Properly configured with dynamic origin whitelist. Public embed routes allow any origin without credentials.
- **Rate Limiting**: Auth routes (login, register, verify) have rate limits. Public apply and embed submit have limits.

---

## Files Changed in This Audit

| File | Changes |
|------|---------|
| `artifacts/api-server/src/index.ts` | Removed hardcoded passwords, added env var references, added crash handlers |
| `artifacts/api-server/src/app.ts` | Added security headers, reduced body size limit, hardened error handler, CSP enabled, CSRF double-submit cookie middleware |
| `artifacts/api-server/src/routes/ai-extract.ts` | Added rate limiting, removed error message leakage |
| `artifacts/api-server/src/routes/embed.ts` | Escaped all dynamic values in widget HTML to prevent XSS |
| `artifacts/api-server/src/routes/users.ts` | Moved `isActive` to admin-only patch fields |
| `artifacts/api-server/src/routes/course-finder.ts` | Stripped contact info for unauthenticated requests |
| `artifacts/api-server/src/routes/storage.ts` | Added path traversal protection, upload rate limiting (30 req/15min) |
| `artifacts/api-server/src/routes/students.ts` | Soft-delete logic (DELETE sets `deletedAt`, GET filters `deletedAt IS NULL`) |
| `artifacts/api-server/src/routes/applications.ts` | Soft-delete logic, notes pagination |
| `artifacts/api-server/src/routes/documents.ts` | Soft-delete logic (single + bulk delete) |
| `artifacts/api-server/src/routes/leads.ts` | Notes and follow-ups pagination |
| `artifacts/api-server/src/routes/agents.ts` | Sub-agents pagination |
| `artifacts/api-server/src/routes/applicationStageDocuments.ts` | Stage documents and missing-doc notes pagination |
| `artifacts/edcons/src/lib/csrfSetup.ts` | Global fetch interceptor for CSRF token handling |
| `artifacts/edcons/src/main.tsx` | Import csrfSetup |
| `lib/db/src/schema/students.ts` | FK references, indexes, unique email constraint, `deletedAt` column |
| `lib/db/src/schema/applications.ts` | FK references, indexes, `deletedAt` column |
| `lib/db/src/schema/documents.ts` | FK references, indexes, `deletedAt` column |
| `lib/db/src/schema/*.ts` | FK references and indexes across all schema files |

---

## Recommendations for Production Deployment

1. **Set strong, unique values** for `SEED_ADMIN_PASSWORD` and `SEED_AGENT_PASSWORD` in development only
2. **Change default admin password** before going to production
3. **Set up monitoring/alerting** for the unhandled rejection and uncaught exception handlers
4. **Consider Redis-backed rate limiting** for multi-instance deployments

---

## Sprint Closeout — 2026-05-03 (Hardening Sprint, Maddes #3 / #5 / #6)

**Sprint goal:** Tighten previously-identified MEDIUM findings (M9, M10) and add end-to-end coverage for the four apply flows so future regressions surface in CI rather than production.

### Merged

| Madde | Commit | Title | Notes |
|-------|--------|-------|-------|
| #5 | `ee140ad` | Improve agent commission calculation for edge cases | Hardens commission math against zero/negative discounts and missing markup; resolves AUDIT M9-adjacent finance correctness gap. |
| #6 | `399feb0` | Improve application processing speed by running tasks in parallel | Parallelizes student / program / university lookups in `POST /applications` via `Promise.all`. **Closes M9.** |
| #3 | `d4f7476` | Add end-to-end tests for application creation and improve database seeding | New `apply-flows.spec.ts` covers (a) public-apply, (b) agent-apply via `NewApplicationDialog`, (c) course-finder-apply, (d) inbox-apply (register-then-apply). Idempotent fixture seed/teardown scripts (`e2e-db-setup.ts`, `e2e-db-teardown.ts`). Final result: **19/19 e2e PASS, inbox-tests PASS**. |

### Canceled / Deferred

| Item | Reason |
|------|--------|
| Hostinger SMTP delivery assertions in e2e | SMTP rate-limit (`451 4.7.1 hostinger_out_ratelimit`) is non-deterministic in CI. By design, e2e tests assert queueing behavior only — never actual mailbox delivery. Documented in `apply-flows.spec.ts`. |
| Pre-existing typecheck errors in `artifacts/api-server/src/routes/website.ts` (lines 485-774) | Out of sprint scope. Errors exist on master prior to this sprint; tracked separately. Sprint-touched files are typecheck-clean. |
| Driving `NewApplicationDialog` cascade selects (Country → University → Program) via UI | Smoke-test trade-off: tests POST to `/api/applications` after verifying dialog opens, to keep tests resilient to dialog field changes. Architect-acknowledged as acceptable for a smoke suite; full UI coverage deferred to a future "form interaction" suite. |

### Follow-ups (open, queued for next sprint)

Originating from architect review of Madde #3 e2e suite:

1. **`public-apply.ts` archived-student restore vs unique constraints** — when an archived student is restored on re-apply, the `(email)` and `(userId)` unique indexes can collide if a parallel signup happened between archive and restore. Needs explicit `ON CONFLICT` handling or a transactional check.
2. **Eligibility / quota negative-path smoke** — current e2e covers happy paths only; the `minGpa`, `minLanguageScore`, and `quota` rejection branches in `public-apply.ts` (lines 59-99) have no regression coverage.
3. **Notification dispatch assertion** — `dispatchNotification` call at `applications.ts:492` is fire-and-forget; e2e currently does not assert it ran. Consider a queue-state assertion or test double.
4. **Audit log writes still synchronous (M10)** — not addressed in this sprint. `logAudit()` remains awaited inline in request handlers; should be moved to fire-and-forget or a queue.
5. **Shared agent fixture race** — e2e relies on a deterministic agent (`e2e-agent@test.local`). Currently safe under `test.describe.configure({ mode: "serial" })`, but if any other suite reuses this agent under parallel execution, races will appear. Document the reservation or namespace per-suite.

### Sprint metrics

- Commits merged: **3** (Madde #3, #5, #6)
- E2E tests added: **4** apply flows (now 19 total in `inbox-e2e`)
- Test suite status at close: **19/19 e2e PASS · inbox-tests PASS**
- AUDIT findings closed by this sprint: **M9** (sequential DB queries in POST /applications)
- AUDIT findings still open: **M7, M10, L2, L3, L4** (unchanged from previous report)
