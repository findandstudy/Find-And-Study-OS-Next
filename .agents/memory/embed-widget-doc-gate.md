---
name: Mandatory-doc gate is a dual-path concern
description: Required-document enforcement must be mirrored in BOTH the on-site apply form and the embed widget; they diverge silently.
---

# Mandatory document gate lives in two independent UIs

There are two separate public apply UIs that each need their own required-document gate:

1. On-site form — `artifacts/edcons/src/pages/public/Programs.tsx` (React; `missingRequired`, disabled continue/skip buttons).
2. Embed widget — `artifacts/api-server/src/routes/embed.ts`, which is **generated JS emitted as a template string** by `generateWidgetHTML`. It is NOT type-checked by tsc and edits only take effect after restarting the api-server (dev runs `tsx`, no watch). Fetch the served widget at `GET /api/public/embed/:slug/widget` and `new Function(scriptBody)` it to syntax-check.

**Why:** A production application came in via the embed widget with only 2 of 4 mandatory docs because the widget showed "Required" labels but never gated submit — the on-site form did. Fixing one path does not fix the other.

**How to apply:** Any change to mandatory-doc / required-field enforcement must be applied to BOTH paths. In the widget, the gate (`getDocTypes`/`missingRequiredDocs`/`enforceDocGate`) must guard every exit: the documents-step buttons (disabled) AND the modal skip, inline skip, analyze, and submit handlers (defense-in-depth re-check).

**Source of truth — server-side gate in `/apply`:** The widget client gate is bypassable (stale cached widget, JS disabled, direct API call) — that is how a prod app came in with 2 of 4 docs. The real enforcement lives in `embed.ts` `/public/embed/:slug/apply`, placed AFTER the lead+submission tx commits (lead preserved) but BEFORE student/app creation: it computes uploaded types from the request `docArray` labels and calls `checkMandatoryDocs(programId, uploadedTypes)` (equivalence-aware). If any mandatory doc is missing it returns `422 {error, missingDocuments, leadId}` and stops — NO student/app/conversion. The lead is intentionally kept, so blocking does not drop the contact.

**Why the override:** This deliberately replaces the older "Submit always converts + park in `missing_docs`" design for the mandatory-docs case, per explicit user request — incomplete embed apps must NOT be accepted. The downstream park logic (`checkMandatoryDocsForStudent` + `parkApplicationInMissingDocsStage`) remains only as defense-in-depth for paths the early gate doesn't cover. The gate is program-scoped: it is skipped when `programId` is absent/invalid (consistent with park logic; the embed flow always sends a programId).

**Client UX:** keep retrying the per-program requirements fetch once with a default-required fallback for the *client* gate (don't strand the user on a fetch error), but the *server* 422 is authoritative. On a 422 with `missingDocuments`, the widget sets `formStep='documents'` to bounce the user back. Template-string emoji/regex escapes are double-escaped (`\\ud83d`, `\\s`).
