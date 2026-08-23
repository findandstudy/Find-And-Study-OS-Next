# Authorization, Tenant Isolation & Data Protection Audit

**Date:** 2026-03-24  
**Scope:** All API endpoints - IDOR, role checks, tenant boundaries, data leakage

---

## Critical/High Fixes Applied

| # | Severity | Issue | File | Fix |
|---|----------|-------|------|-----|
| 1 | **CRITICAL** | `isActive` in user self-patch - regular users could activate/deactivate their own account | `routes/users.ts` | Moved `isActive` to `ADMIN_PATCH_FIELDS` only |
| 2 | **HIGH** | University contact info leaked on public `/course-finder` endpoint - `contactPersonName`, `contactPersonPhone`, `contactPersonEmail` exposed to unauthenticated users | `routes/course-finder.ts` | Contact fields stripped from response for unauthenticated requests; authenticated users still receive them |
| 3 | **HIGH** | Path traversal on storage endpoints - `..` sequences could access parent directories | `routes/storage.ts` | Added `..` and `\` rejection on both `/storage/objects/*` and `/storage/public-objects/*` |

---

## Endpoint Authorization Matrix

### Auth Routes (`/api/auth/*`) - Public

| Endpoint | Auth | Role | Ownership | Notes |
|----------|------|------|-----------|-------|
| `POST /auth/login` | - | - | - | Rate limited (10/IP) |
| `POST /auth/register` | - | - | - | Rate limited (5/IP) |
| `POST /auth/verify-email` | - | - | - | Rate limited (5/IP) |
| `POST /auth/forgot-password` | - | - | - | Generic response (no user enum) |
| `GET /auth/me` | - | - | - | Returns current session or null |
| `GET /auth/logout` | - | - | - | Clears session |

### Students (`/api/students/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /students` | Yes | Staff/Student/Agent | Agent: `getAgentVisibleIds`; Student: own only | Yes |
| `GET /students/:id` | Yes | Any auth | Agent: visibility check; Student: `userId` match; Staff: assigned check | Yes |
| `GET /students/me` | Yes | Any auth | `userId === req.user.id` | Yes |
| `PATCH /students/:id` | Yes | Any auth | Student: own only; Agent: visibility check | Yes |
| `DELETE /students/:id` | Yes | Staff only | No per-record ownership (staff-wide) | Medium |

### Applications (`/api/applications/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /applications` | Yes | Any auth | Student: own `studentId`; Agent: `getAgentVisibleIds` | Yes |
| `GET /applications/:id` | Yes | Any auth | Student: `studentId` match; Agent: visibility check | Yes |
| `POST /applications` | Yes | Staff/Agent | Validates student ownership for agents | Yes |
| `PATCH /applications/:id` | Yes | Staff only | Staff-wide access | N/A |
| `DELETE /applications/:id` | Yes | Staff only | Staff-wide access | N/A |

### Leads (`/api/leads/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /leads` | Yes | Staff/Agent | Agent: `getAgentVisibleIds`; Staff: assignedTo filter | Yes |
| `GET /leads/:id` | Yes | Staff/Agent | Agent: visibility check; Staff: assignedTo check | Yes |
| `POST /leads` | Yes | Staff/Agent | Auto-assigns creator | Yes |
| `PATCH /leads/:id` | Yes | Staff/Agent | Agent: visibility check; Staff: assignedTo check | Yes |
| `DELETE /leads/:id` | Yes | Staff only | No per-record ownership | Medium |

### Documents (`/api/documents/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /documents` | Yes | Any auth | Student: filtered by own `studentId` | Yes |
| `GET /documents/:id` | Yes | Any auth | Student: `studentId` match verified | Yes |
| `POST /documents` | Yes | Any auth | Student: can only upload for own `studentId` | Yes |
| `PATCH /documents/:id` | Yes | Staff only | Staff-wide | N/A |
| `DELETE /documents/:id` | Yes | Staff only | Staff-wide | N/A |

### Stage Documents (`/api/applications/:id/stage-documents/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /.../:id/stage-documents` | Yes | Any auth | `verifyApplicationAccess()` | Yes |
| `POST /.../:id/stage-documents` | Yes | Any auth | `verifyApplicationAccess()` | Yes |
| `DELETE /.../:id/stage-documents/:docId` | Yes | Any auth | `uploadedBy === user.id` or admin | Yes |
| `GET /.../:id/stage-documents/:docId/download` | Yes | Any auth | `verifyApplicationAccess()` | Yes |

### Messages (`/api/conversations/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /conversations` | Yes | Staff+ | Filtered by participant membership | Yes |
| `GET /conversations/:id/messages` | Yes | Staff+ | Participant check | Yes |
| `POST /conversations/:id/messages` | Yes | Staff+ | Participant check | Yes |
| Student message endpoints | Yes | Any auth | Student-specific conversation handling | Yes |

### Notifications (`/api/notifications/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /notifications` | Yes | Any auth | Filtered by `userId` | Yes |
| `PATCH /notifications/:id/read` | Yes | Any auth | `userId` match in WHERE clause | Yes |

### Finance (`/api/commissions/*`, `/api/service-fees/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /commissions` | Yes | Finance only | Finance-wide | N/A |
| `POST /commissions` | Yes | Finance only | - | N/A |
| `GET /agent/commissions` | Yes | Agent only | Filtered by own `agentId` | Yes |
| `GET /agent/service-fees` | Yes | Agent only | Filtered by own `agentId` | Yes |
| `GET /agent/finance-summary` | Yes | Agent only | Filtered by own `agentId` | Yes |

### Users (`/api/users/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /users` | Yes | Manager+ | Manager-wide | N/A |
| `GET /users/:id` | Yes | Manager+ | Manager-wide | N/A |
| `PATCH /users/:id` | Yes | Any auth | `isSelf` or `isAdmin`; `isActive`/`role` admin-only | Yes |
| `POST /users` | Yes | Admin only | - | N/A |
| `DELETE /users/:id` | Yes | Admin only | Cannot self-delete | Yes |
| `POST /users/:id/impersonate` | Yes | Admin only | Audit logged | Yes |
| `POST /users/:id/set-password` | Yes | Admin only | - | N/A |

### Agents (`/api/agents/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /agents/me` | Yes | Any auth | Own agent record | Yes |
| `PATCH /agents/me` | Yes | Any auth | Own agent record | Yes |
| `GET /agents/me/sub-agents` | Yes | Agent only | Own sub-agents | Yes |
| `DELETE /agents/me/sub-agents/:id` | Yes | Agent only | Ownership verified | Yes |
| `GET /agents` | Yes | Staff only | Staff-wide | N/A |
| `POST /agents/:id/impersonate` | Yes | Manager+ | Audit logged, agent/sub_agent only | Yes |

### Storage (`/api/storage/*`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `POST /storage/uploads/request-url` | Yes | Any auth | No per-object ACL set on upload | Medium |
| `GET /storage/objects/*path` | Yes | Any auth | Path traversal blocked; relies on UUID obscurity | Medium |
| `GET /storage/public-objects/*filePath` | No | - | Path traversal blocked; public directory only | Yes |

### Public/Catalog Endpoints

| Endpoint | Auth | Role | Sensitive Data | Safe |
|----------|------|------|----------------|------|
| `GET /course-finder` | No | - | Contact info stripped for unauth | Yes |
| `GET /course-finder/filters` | No | - | No sensitive data | Yes |
| `POST /public/apply` | No | - | Rate limited; no data returned | Yes |
| `GET /public/embed/*` | No | - | Domain validated; catalog only | Yes |
| `GET /countries`, `/cities`, `/catalog-options` | No | - | Metadata only | Yes |
| `GET /blog`, `/blog/:id` | No | - | Published content only | Yes |
| `GET /universities`, `/programs` | No | - | Catalog data only | Yes |

### Audit (`/api/audit`)

| Endpoint | Auth | Role | Ownership/Scope | IDOR Safe |
|----------|------|------|-----------------|-----------|
| `GET /audit` | Yes | Any auth | Manager+: all logs; Others: own logs only | Yes |

---

## Remaining Checklist (Medium/Low)

| # | Severity | Issue | Details |
|---|----------|-------|---------|
| 1 | Medium | Storage objects lack per-file ACL | Any authenticated user can access any file if they know the UUID path. Objects use UUID naming (GCS-generated) which provides reasonable obscurity. All database records referencing file URLs have their own ownership checks, so discovering paths requires authorized DB access. Full per-object ACL would require setting metadata on upload and checking on download — currently the `ObjectAclPolicy` infrastructure exists but isn't used. Accepted risk for single-tenant deployment. |
| 2 | Medium | Delete endpoints (leads, students, applications) allow any staff member to delete any record | No per-record assignment check on DELETE for staff. Only role-based restriction. |
| 3 | Medium | All deletes are hard deletes | No soft-delete pattern. Deleted data is unrecoverable. Consider `isDeleted` / `deletedAt` columns for critical entities (students, applications, documents). |
| 4 | Low | Message attachment URL validation | Server only checks URL prefix but doesn't verify sender has access to the referenced file. |
| 5 | Low | `DELETE /programs` (bulk) | Deletes ALL programs. Protected by MANAGER_ROLES but extremely destructive. Consider requiring confirmation. |

---

## Files Changed

| File | Change |
|------|--------|
| `artifacts/api-server/src/routes/users.ts` | Moved `isActive` from `ALLOWED_PATCH_FIELDS` to `ADMIN_PATCH_FIELDS` |
| `artifacts/api-server/src/routes/course-finder.ts` | Contact fields conditionally stripped for unauthenticated requests |
| `artifacts/api-server/src/routes/storage.ts` | Added path traversal protection on both storage endpoints |
