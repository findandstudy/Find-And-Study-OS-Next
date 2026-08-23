---
name: Portal Universities management — reuse existing API
description: Why the Universities tab CRUD reuses /api/portal-universities/* (portalMgmt.ts) instead of a new OpenAPI/orval contract.
---

# Portal Automation → Universities management

The working management API is `/api/portal-universities/*` in `artifacts/api-server/src/routes/portalMgmt.ts` (list, POST, PATCH /:id accepting universityKey/universityName/adapterKey/crmUniversityId/defaults, soft DELETE /:id, PATCH /:id/active, PATCH /:id/auto-process, PUT+DELETE /:portalKey/credentials, POST /:id/test-login). Frontend `PortalUniversitiesTab.tsx` talks to it via `customFetch`, NOT orval/OpenAPI hooks.

**Rule:** add Universities-tab features against these existing endpoints. Do NOT introduce the spec-proposed `/portal-automation/universities/*` REST + OpenAPI/orval split — it would duplicate a working contract.

**Why:** a Turkish spec proposed a parallel REST surface; building it would fork the contract and the credentials/leak guarantees. The existing routes already have RBAC + audit + hasCredentials masking.

**RBAC (keep as-is):** CRUD = STAFF_ROLES+ADMIN_ROLES; credentials PUT/DELETE = ADMIN_ROLES only. agent_staff already excluded. List returns `hasCredentials` only — plaintext is never serialized.

**Edit dialog:** when editing adapterKey, keep a stored-but-unregistered adapter selectable (registry may not list it) so editing other fields never drops the binding.

Regression test: `scripts/test-portal-universities.ts` (registered as `test:portal-universities`, in the aggregate `test`).
