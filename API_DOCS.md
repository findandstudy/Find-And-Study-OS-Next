# API Documentation — EduConsult OS / Find & Study

Base URL: `/api`  
All authenticated endpoints require a valid session cookie (`sid`).  
Rate limiting: 10 login attempts / 15 min per IP; 5 register attempts / 15 min per IP.

---

## Role Reference

| Role | Level | Notes |
|------|-------|-------|
| `super_admin` | ADMIN | Full access |
| `admin` | ADMIN | Full access except some super_admin-only actions |
| `manager` | MANAGER | Manage staff, agents, students |
| `staff` | STAFF | Consultants, editors, accountants |
| `consultant` | STAFF | Student/application management |
| `editor` | STAFF | Blog & content |
| `accountant` | STAFF/FINANCE | Finance access |
| `agent` | AGENT | Manages own students + sub-agents |
| `sub_agent` | AGENT | Scoped under parent agent |
| `agent_staff` | AGENT | Staff hired by an agent |
| `student` | STUDENT | Own records only |

**Auth shorthand used below:**
- `public` — no session required
- `auth` — any authenticated user
- `student` — auth + role=student
- `agent` — auth + role∈{agent, sub_agent, agent_staff}
- `staff` — auth + role∈STAFF_ROLES
- `manager` — auth + role∈MANAGER_ROLES
- `admin` — auth + role∈ADMIN_ROLES
- `finance` — auth + role∈{super_admin, admin, accountant}

---

## 1. Health

### `GET /api/healthz`
- **Auth:** public
- **Response:** `{ status: "ok" }`

### `GET /api/health`
- **Auth:** public
- **Response:** `{ status, timestamp, uptime, dbConnected, version }`
- Returns `503` if database is unreachable.

---

## 2. Auth

### `GET /api/auth/me`
- **Auth:** auth
- **Response:** Session user object + `isImpersonating: boolean`
- Returns `401` if not logged in.

### `POST /api/auth/login`
- **Auth:** public
- **Rate limit:** 10/15 min per IP and per email
- **Body:** `{ email, password }`
- **Response:** `{ user }` + sets `sid` cookie
- **Errors:** `400` missing fields, `401` invalid credentials, `403` deactivated, `429` rate limited

### `POST /api/auth/register`
- **Auth:** public
- **Rate limit:** 5/15 min per IP
- **Body:** `{ email, password, firstName, lastName, phone? }`
- Password rules: ≥8 chars, ≥1 uppercase, ≥1 digit
- **Response:** `{ message, requiresVerification: true, email }`
- Sends 6-digit email verification code. Account is inactive until verified.
- **Errors:** `400` validation, `409` email taken, `429` rate limited

### `POST /api/auth/verify-email`
- **Auth:** public
- **Rate limit:** 5/15 min per IP and per email
- **Body:** `{ email, code }` (6-digit code sent by register/resend-code)
- **Response:** `{ user, verified: true }` + sets `sid` cookie (auto-login)

### `POST /api/auth/resend-code`
- **Auth:** public
- **Rate limit:** 3/15 min per IP and per email
- **Body:** `{ email }`
- **Response:** `{ message }` (always success regardless of email existence)

### `POST /api/auth/forgot-password`
- **Auth:** public
- **Rate limit:** 5/15 min per IP, 3/15 min per email
- **Body:** `{ email }`
- Sends password reset link (valid 1 hour) to the email.
- **Response:** `{ message }` (always success for security)

### `POST /api/auth/set-password`
- **Auth:** public
- **Body:** `{ token, password }`
- Token comes from the reset link (`?token=...`).
- **Response:** `{ success: true, message }`
- **Errors:** `400` invalid/expired token or weak password

### `GET /api/auth/verify-email-token/:token`
- **Auth:** public
- Verifies email via a link token (older flow). Redirects to `/login?verified=true`.

### `POST /api/auth/resend-verification-email`
- **Auth:** auth (or public with `email` in body)
- **Body (public only):** `{ email }`
- Sends a verification link (not a code). Used when user has a link-based token.
- **Response:** `{ message }`

### `GET /api/auth/logout`
### `POST /api/auth/logout`
- **Auth:** auth
- Clears session cookie. Redirects to `/login`.

---

## 3. Users (Staff & Admin)

### `GET /api/users`
- **Auth:** manager
- **Query:** `role?, search?, page=1, limit=50`
- **Response:** `{ data: User[], meta: { total, page, limit, totalPages } }`

### `POST /api/users`
- **Auth:** admin
- **Body:** `{ email, firstName, lastName, role, phone?, language?, password? }`
- **Response:** `201` User object (passwordHash stripped)
- **Errors:** `400` missing/invalid fields, `409` email conflict

### `GET /api/users/:id`
- **Auth:** manager
- **Response:** User object (passwordHash stripped)

### `PATCH /api/users/:id`
- **Auth:** auth (admin OR self)
- Admins can change `role`, `isActive`. Users can change profile fields only.
- **Body:** any subset of allowed fields
- **Response:** Updated user

### `DELETE /api/users/:id`
- **Auth:** admin
- Cannot delete own account.
- **Response:** `204 No Content`

### `POST /api/users/:id/set-password`
- **Auth:** admin
- **Body:** `{ password }` (≥6 chars)
- **Response:** `{ success: true }`

### `POST /api/users/me/change-password`
- **Auth:** auth
- **Body:** `{ currentPassword, newPassword }` (newPassword ≥6 chars)
- **Response:** `{ success: true }`

### `POST /api/users/:id/impersonate`
- **Auth:** admin
- Cannot impersonate self.
- **Response:** `{ success: true, redirectTo, role }` + sets impersonation session cookie

---

## 4. Agents

### `GET /api/agents/me`
- **Auth:** agent
- **Response:** Agent profile + `assignedStaff` + `parentAgent` (sub_agent only)

### `PATCH /api/agents/me`
- **Auth:** agent
- Editable fields: `businessName, logoUrl, businessCertUrl`
- **Response:** Updated agent

### `GET /api/agents/me/embed-token`
- **Auth:** auth (agent)
- Returns or generates the agent's embed token for the public-facing embed form.
- **Response:** `{ embedToken }`

### `GET /api/agents/:agentId/embed-token`
- **Auth:** super_admin
- **Response:** `{ embedToken }`

### Sub-agents (agent managing own sub-agents)

#### `GET /api/agents/me/sub-agents`
- **Auth:** role=agent
- **Query:** `search?, status?, page=1, limit=50`
- **Response:** `{ data: Agent[], meta }`

#### `POST /api/agents/me/sub-agents`
- **Auth:** role=agent
- **Body:** `{ firstName, lastName, email?, phone?, commissionRate?, password?, companyName?, logoUrl?, hideServiceFees? }`
- **Response:** `201` Sub-agent record

#### `PATCH /api/agents/me/sub-agents/:id`
- **Auth:** role=agent
- **Body:** `{ firstName?, lastName?, email?, phone?, commissionRate?, status?, companyName?, logoUrl?, hideServiceFees?, canManageStaff? }`
- **Response:** Updated sub-agent

#### `DELETE /api/agents/me/sub-agents/:id`
- **Auth:** role=agent
- Also deletes the sub-agent's user account.
- **Response:** `{ success: true }`

#### `POST /api/agents/me/sub-agents/:id/set-password`
- **Auth:** role=agent
- **Body:** `{ password }` (≥6 chars)
- **Response:** `{ success: true }`

#### `PATCH /api/agents/me/sub-agents/:id/status`
- **Auth:** role=agent
- **Body:** `{ status: "active" | "inactive" }`
- **Response:** Updated sub-agent

#### `POST /api/agents/me/sub-agents/:id/impersonate`
- **Auth:** role=agent
- Switches session to the sub-agent's account. Sets `originalSid` for return.
- **Response:** `{ success: true, redirectTo: "/agent" }`

#### `POST /api/agents/me/return-to-agent`
- **Auth:** auth
- Restores the parent agent session from impersonation.
- **Response:** `{ success: true, redirectTo: "/" }`

### Agent Staff (agent managing own staff users)

#### `GET /api/agents/me/staff`
- **Auth:** role∈{agent, sub_agent}
- **Query:** `search?, page=1, limit=50`
- **Response:** `{ data: AgentStaffUser[], meta }`

#### `POST /api/agents/me/staff`
- **Auth:** role∈{agent, sub_agent}
- **Body:** `{ firstName, lastName, email, phone?, password, permissions?: string[] }`
- Default permissions: `["leads","students","applications","documents","course_finder"]`
- **Response:** `201` Staff user

#### `PATCH /api/agents/me/staff/:id`
- **Auth:** role∈{agent, sub_agent}
- **Body:** `{ firstName?, lastName?, phone?, isActive?, permissions?, password? }`
- **Response:** Updated staff user

#### `DELETE /api/agents/me/staff/:id`
- **Auth:** role∈{agent, sub_agent}
- **Response:** `{ success: true }`

#### `GET /api/agents/me/staff/permissions`
- **Auth:** role∈{agent, sub_agent}
- **Response:** `[{ key, label }]` — list of available permission keys

### Staff-facing agent management

#### `GET /api/agents`
- **Auth:** staff
- **Query:** `search?, status?, category?, country?, page=1, limit=50`
- **Response:** `{ data: Agent[], meta }`

#### `GET /api/agents/:id`
- **Auth:** staff
- **Response:** Agent object

#### `GET /api/agents/:id/sub-agents`
- **Auth:** staff
- **Response:** Sub-agents list for given agent

#### `POST /api/agents`
- **Auth:** manager
- **Body:** `{ firstName, lastName, email?, phone?, companyName?, commissionRate?, country?, agencyCode?, ... }`
- **Response:** `201` Agent record

#### `PATCH /api/agents/:id`
- **Auth:** manager
- **Body:** any subset of agent patch fields
- **Response:** Updated agent

#### `DELETE /api/agents/:id`
- **Auth:** manager
- **Response:** `{ success: true }`

#### `POST /api/agents/bulk-delete`
- **Auth:** manager
- **Body:** `{ ids: number[] }`
- **Response:** `{ success: true, deleted: number }`

#### `POST /api/agents/bulk-assign`
- **Auth:** manager
- **Body:** `{ ids: number[], assignedStaffId: number }`
- **Response:** `{ success: true }`

---

## 5. Students

### `GET /api/students/me`
- **Auth:** student
- **Response:** Own student profile

### `GET /api/students/my-advisor`
- **Auth:** student
- **Response:** Assigned advisor user `{ id, firstName, lastName, email, phone, role, avatarUrl }` or `null`

### `PUT /api/students/me`
- **Auth:** student
- **Body:** `{ firstName?, lastName?, phone?, nationality?, dateOfBirth?, passportNumber?, passportIssueDate?, passportExpiry?, motherName?, fatherName?, address?, highSchool?, universityBachelor?, universityMaster?, graduationYear?, gpa?, languageScore? }`
- Creates profile if not exists; updates if it does.
- **Response:** Student record

### `GET /api/students/:id/photo`
- **Auth:** auth
- **Response:** Image binary (Content-Type: image/jpeg) or `404`

### `GET /api/students`
- **Auth:** staff | agent (scoped)
- **Query:** `agentId?, status?, search?, season?, page=1, limit=20, originType?`
- Staff/admin see all (admins unrestricted, non-admins see assigned or unassigned).
- Agents see only their scoped students.
- **Response:** `{ data: Student[], meta }`

### `POST /api/students`
- **Auth:** staff | agent
- **Body:** `{ firstName*, lastName*, email?, phone?, nationality?, dateOfBirth?, passportNumber?, passportIssueDate?, passportExpiry?, motherName?, fatherName?, address?, agentId?, userId?, notes?, highSchool?, graduationYear?, gpa?, languageScore?, season?, interestedLevel?, status? }`
- **Response:** `201` Student record

### `POST /api/students/bulk`
- **Auth:** staff | role=agent
- **Body:** `{ students: StudentInput[] }`
- **Response:** `201 { inserted, errors, total, success }`

### `GET /api/students/:id`
- **Auth:** auth (access-controlled)
- Staff/admin: all. Agent: scoped. Student: own profile only.
- **Response:** Student record

### `PATCH /api/students/:id`
- **Auth:** auth (access-controlled)
- Editable fields vary by role. Students: profile fields. Agents: most fields except agentId/userId/assignedToId/status.
- **Body:** subset of STUDENT_PATCH_FIELDS
- **Response:** Updated student

### `POST /api/students/bulk-action`
- **Auth:** admin
- **Body:** `{ ids: number[], action: "delete"|"assign"|"move", assignedToId?: number, status?: string }`
- **Response:** `{ success: true, updated: number }`

### `DELETE /api/students/:id`
- **Auth:** staff
- Soft-delete (sets `deletedAt`).
- **Response:** `204 No Content`

### `PATCH /api/students/:id/origin`
- **Auth:** admin
- **Body:** `{ originType, originEntityType?, originEntityId?, originDisplayName? }`
- **Response:** Updated student

### `POST /api/students/:id/set-password`
- **Auth:** admin
- **Body:** `{ password }`
- Sets the student's login account password.
- **Response:** `{ success: true }`

### `GET /api/students/:id/notes`
- **Auth:** staff | agent | student (own)
- **Response:** `Note[]`

### `POST /api/students/:id/notes`
- **Auth:** staff | agent
- **Body:** `{ content }`
- **Response:** `201` Note record

### `GET /api/students/:id/follow-ups`
- **Auth:** staff
- **Response:** `FollowUp[]`

### `POST /api/students/:id/follow-ups`
- **Auth:** staff
- **Body:** `{ note, followUpAt, type? }`
- **Response:** `201` FollowUp record

---

## 6. Leads

### `GET /api/nationalities`
- **Auth:** staff
- **Response:** `string[]` — list of distinct nationalities from students table

### `POST /api/public/lead`
- **Auth:** public (rate limited)
- **Body:** `{ firstName, lastName, email?, phone?, nationality?, source?, notes?, agentToken? }`
- Creates a lead from a public form submission.
- **Response:** `201 { success: true, lead }`

### `POST /api/public/lead/:token`
- **Auth:** public (rate limited)
- Agent-branded public lead form. `token` is the agent's embed token.
- **Body:** same as above
- **Response:** `201 { success: true }`

### `GET /api/leads`
- **Auth:** staff | agent (scoped)
- **Query:** `search?, status?, source?, agentId?, page=1, limit=20`
- **Response:** `{ data: Lead[], meta }`

### `POST /api/leads`
- **Auth:** staff | agent
- **Body:** `{ firstName, lastName, email?, phone?, nationality?, source?, notes?, agentId?, stage? }`
- **Response:** `201` Lead record

### `GET /api/leads/:id`
- **Auth:** staff | agent
- **Response:** Lead record

### `PATCH /api/leads/:id`
- **Auth:** staff | agent
- **Body:** subset of lead patch fields
- **Response:** Updated lead

### `DELETE /api/leads/:id`
- **Auth:** staff
- **Response:** `204 No Content`

### `POST /api/leads/bulk-action`
- **Auth:** admin
- **Body:** `{ ids: number[], action: "delete"|"assign"|"convert", assignedToId? }`
- **Response:** `{ success: true, updated: number }`

### `POST /api/leads/:id/convert`
- **Auth:** staff | agent
- Converts a lead to a student record.
- **Body:** `{ agentId?, season? }`
- **Response:** `{ student }` + sends notification

### `GET /api/leads/:id/notes`
- **Auth:** staff | agent
- **Response:** `Note[]`

### `POST /api/leads/:id/notes`
- **Auth:** staff | agent
- **Body:** `{ content }`
- **Response:** `201` Note

### `GET /api/leads/:id/follow-ups`
- **Auth:** staff
- **Response:** `FollowUp[]`

### `POST /api/leads/:id/follow-ups`
- **Auth:** staff
- **Body:** `{ note, followUpAt, type? }`
- **Response:** `201` FollowUp

### `PATCH /api/follow-ups/:id`
- **Auth:** staff
- **Body:** `{ note?, followUpAt?, completed?, type? }`
- **Response:** Updated FollowUp

### `GET /api/follow-ups/upcoming`
- **Auth:** staff
- **Query:** `days=7, limit=20`
- **Response:** `FollowUp[]` sorted by date ascending

### `PATCH /api/leads/:id/origin`
- **Auth:** admin
- **Body:** `{ originType, originEntityType?, originEntityId?, originDisplayName? }`
- **Response:** Updated lead

---

## 7. Applications

### `GET /api/applications/doc-required-stages`
- **Auth:** auth
- **Response:** `string[]` — stage keys that require documents before transition

### `GET /api/applications`
- **Auth:** staff | agent | student (scoped)
- **Query:** `studentId?, agentId?, stage?, season?, page=1, limit=20, originType?`
- **Response:** `{ data: Application[], meta }`
- Commission fields are role-scoped: agents see `agentCommissionAmount`; staff see `universityCommissionAmount`.

### `POST /api/applications`
- **Auth:** staff | agent
- **Body:**
  ```json
  {
    "studentId": 123,
    "stage": "inquiry",
    "universityId?": 1,
    "programId?": 5,
    "agentId?": 2,
    "universityName?": "Example University",
    "country?": "UK",
    "programName?": "Computer Science",
    "intake?": "September 2025",
    "level?": "bachelor",
    "instructionLanguage?": "English",
    "deadline?": "2025-03-01",
    "tuitionFee?": 15000,
    "scholarship?": 10,
    "notes?": "...",
    "season?": "2025"
  }
  ```
- If `programId` is provided, snapshots fees, commission rate, and service fee from the program record.
- Automatically creates commission and service fee records.
- **Response:** `201` Application record
- **Errors:** `400` missing studentId, `403` agent scope, `404` student not found, `422` missing required student fields

### `GET /api/applications/:id`
- **Auth:** auth (access-controlled)
- **Response:** Application with student name, commission, assigned user info

### `PATCH /api/applications/:id`
- **Auth:** staff | agent
- Editable fields: stage, universityId/Name, programId/Name, agentId, assignedToId, intake, level, instructionLanguage, deadline, tuitionFee, discountedFee, scholarship, commissionRate, serviceFeeAmount, applicationFee, depositFee, advancedFee, languageFee, currency, notes, season
- Moving to certain stages requires existing stage documents (returns `422` with `code: "DOCS_REQUIRED"`).
- When moved to a won stage, sibling applications are auto-cancelled.
- **Body:** subset of patch fields
- **Response:** Updated application

### `DELETE /api/applications/:id`
- **Auth:** staff
- Soft-delete.
- **Response:** `204 No Content`

### `POST /api/applications/bulk-delete`
- **Auth:** admin
- **Body:** `{ ids: number[] }`
- **Response:** `{ success: true, deleted: number }`

---

## 8. Application Stage Documents

Base prefix: `/api/applications/:id`

### `GET /api/applications/:id/stage-documents`
- **Auth:** auth (documents permission)
- **Query:** `stage?`
- **Response:** `StageDocument[]`

### `POST /api/applications/:id/stage-documents`
- **Auth:** auth (documents permission)
- **Body (multipart/form-data):** `stage, file (binary), label?, isMissingDocNote?`
- Or **Body (JSON):** `{ stage, fileData (base64), fileName, mimeType, label?, isMissingDocNote? }`
- **Response:** `201` StageDocument

### `DELETE /api/applications/:id/stage-documents/:docId`
- **Auth:** auth (documents permission)
- **Response:** `204 No Content`

### `GET /api/applications/:id/stage-documents/:docId/download`
- **Auth:** auth (documents permission)
- **Response:** File binary with appropriate Content-Type and Content-Disposition headers

### `GET /api/applications/:id/missing-doc-notes`
- **Auth:** auth (documents permission)
- **Response:** `StageDocument[]` (only missing-doc notes)

### `POST /api/applications/:id/missing-doc-notes`
- **Auth:** auth (documents permission)
- **Body:** `{ stage, label, note? }`
- **Response:** `201` StageDocument (as note placeholder)

---

## 9. Documents (Student Documents)

### `GET /api/documents`
- **Auth:** auth
- **Query:** `studentId?, type?, page=1, limit=50`
- **Response:** `{ data: Document[], meta }`

### `POST /api/documents`
- **Auth:** auth
- **Body (multipart/form-data):** `studentId, type, file, label?`
- Or **Body (JSON):** `{ studentId, type, fileData (base64), fileName, mimeType, label? }`
- **Response:** `201` Document record

### `GET /api/documents/:id`
- **Auth:** auth
- **Response:** Document metadata + fileData (base64)

### `PATCH /api/documents/:id`
- **Auth:** staff
- **Body:** `{ label?, type? }`
- **Response:** Updated document

### `POST /api/documents/bulk-delete`
- **Auth:** staff
- **Body:** `{ ids: number[] }`
- **Response:** `{ success: true, deleted: number }`

### `DELETE /api/documents/:id`
- **Auth:** staff | agent
- **Response:** `204 No Content`

### `GET /api/documents/download-zip/:studentId`
- **Auth:** staff | agent
- **Query:** `type?`
- Downloads all documents for a student as a ZIP file.
- **Response:** `application/zip` binary

### `POST /api/documents/merge-pdf`
- **Auth:** staff | agent
- **Body:** `{ documentIds: number[] }`
- Merges multiple PDF documents into one.
- **Response:** `application/pdf` binary

### `POST /api/documents/:id/extract`
- **Auth:** staff | agent
- Triggers AI extraction of passport/document data from the file.
- **Response:** `{ extracted: { passportNumber?, nationality?, ... }, warnings? }`

---

## 10. Finance

> Commission and service fee amounts are **never exposed to public or student roles**. Agents see only their own commission amount.

### Commissions

#### `GET /api/commissions`
- **Auth:** finance
- **Query:** `applicationId?, agentId?, status?, season?, page=1, limit=50`
- **Response:** `{ data: Commission[], meta }`

#### `POST /api/commissions`
- **Auth:** finance
- **Body:** `{ applicationId, studentId, agentId?, status, programFee?, universityCommissionRate?, universityCommissionAmount?, agentCommissionRate?, agentCommissionAmount?, currency?, season? }`
- **Response:** `201` Commission record

#### `GET /api/commissions/:id`
- **Auth:** finance
- **Response:** Commission record

#### `PATCH /api/commissions/:id`
- **Auth:** finance
- **Body:** subset of commission fields
- **Response:** Updated commission

#### `POST /api/commissions/bulk-delete`
- **Auth:** finance
- **Body:** `{ ids: number[] }`
- **Response:** `{ success: true }`

#### `DELETE /api/commissions/:id`
- **Auth:** finance
- **Response:** `204 No Content`

### Service Fees

#### `GET /api/service-fees`
- **Auth:** finance
- **Query:** `applicationId?, agentId?, status?, season?, page=1, limit=50`
- **Response:** `{ data: ServiceFee[], meta }`

#### `POST /api/service-fees`
- **Auth:** finance
- **Body:** `{ applicationId, studentId, agentId?, totalAmount, firstInstallmentAmount?, secondInstallmentAmount?, currency?, season?, financeStatus?, status? }`
- **Response:** `201` Service fee record

#### `PATCH /api/service-fees/:id`
- **Auth:** finance
- **Body:** subset of service fee fields including payment timestamps
- **Response:** Updated service fee

#### `DELETE /api/service-fees/:id`
- **Auth:** finance
- **Response:** `204 No Content`

### Financial Transactions

#### `GET /api/financial-transactions`
- **Auth:** finance
- **Query:** `commissionId?, serviceFeeId?, type?, page=1, limit=50`
- **Response:** `{ data: Transaction[], meta }`

#### `POST /api/financial-transactions`
- **Auth:** finance
- **Body:** `{ commissionId?, serviceFeeId?, type, amount, currency, notes?, transactionDate?, referenceNo? }`
- **Response:** `201` Transaction record

#### `DELETE /api/financial-transactions/:id`
- **Auth:** finance
- **Response:** `204 No Content`

### Finance Analytics

#### `GET /api/finance/university-breakdown`
- **Auth:** finance
- **Query:** `season?, agentId?`
- **Response:** Per-university commission + service fee totals

#### `GET /api/finance/summary`
- **Auth:** finance
- **Query:** `season?`
- **Response:** `{ totalCommission, totalServiceFees, totalCollected, byStatus, byCurrency, ... }`

### Invoices

#### `GET /api/invoices`
- **Auth:** finance
- **Query:** `agentId?, season?, page=1, limit=50`
- **Response:** `{ data: Invoice[], meta }`

#### `POST /api/invoices`
- **Auth:** finance
- **Body:** `{ agentId, commissionIds?: number[], serviceFeeIds?: number[], notes?, dueDate? }`
- **Response:** `201` Invoice record

#### `PATCH /api/invoices/:id`
- **Auth:** finance
- **Body:** `{ status?, paidAt?, notes? }`
- **Response:** Updated invoice

### Agent Finance (agent-facing)

#### `GET /api/agent/finance-summary`
- **Auth:** agent (commissions permission)
- **Query:** `season?`
- **Response:** Agent's own commission + service fee summary

#### `GET /api/agent/commissions`
- **Auth:** agent (commissions permission)
- **Query:** `season?, status?, page=1, limit=50`
- **Response:** Agent's own commission records (agentCommissionAmount only)

#### `GET /api/agent/service-fees`
- **Auth:** agent (commissions permission)
- **Query:** `season?, status?, page=1, limit=50`
- **Response:** Agent's own service fee records

---

## 11. Course Finder & Wishlists

### `GET /api/course-finder`
- **Auth:** public
- **Query:** `search?, country?, level?, language?, minFee?, maxFee?, universityId?, page=1, limit=20`
- **Response:** `{ data: Program[], meta }`

### `GET /api/course-finder/filters`
- **Auth:** public
- **Response:** `{ countries, levels, languages, universities }` — filter options

### `GET /api/course-finder/students`
- **Auth:** auth (course_finder permission)
- For selecting a student when applying via course finder.
- **Query:** `search?, page=1, limit=20`
- **Response:** `{ data: Student[], meta }`

### `POST /api/course-finder/apply`
- **Auth:** staff | agent | student (course_finder permission)
- Creates an application directly from a program listing.
- **Body:** `{ studentId, programId, intake?, notes?, agentId? }`
- **Response:** `201` Application record

### Wishlists

#### `GET /api/wishlists`
- **Auth:** auth
- **Response:** `Wishlist[]` — current user's wishlist program IDs

#### `GET /api/wishlists/details`
- **Auth:** auth
- **Response:** Full program details for wishlisted items

#### `POST /api/wishlists`
- **Auth:** auth
- **Body:** `{ programId }`
- **Response:** `201` Wishlist entry

#### `DELETE /api/wishlists/:programId`
- **Auth:** auth
- **Response:** `204 No Content`

---

## 12. Pipeline

### `GET /api/pipeline-stages/:entityType`
- **Auth:** staff | agent
- **Params:** `entityType` = `"lead"` | `"student"` | `"application"`
- **Response:** `PipelineStage[]` ordered list

### `PUT /api/pipeline-stages/:entityType`
- **Auth:** manager
- **Body:** `{ stages: [{ key, label, color?, variant?, order }] }`
- Full replace of pipeline config for the entity type.
- **Response:** Updated `PipelineStage[]`

---

## 13. Messages & Conversations

### Staff/Admin Messaging

#### `GET /api/conversations`
- **Auth:** staff | admin
- **Query:** `search?, page=1, limit=20`
- **Response:** `{ data: Conversation[], meta }`

#### `POST /api/conversations`
- **Auth:** staff | admin
- **Body:** `{ title?, participantIds: number[], message: string }`
- **Response:** `201 { conversation, message }`

#### `GET /api/conversations/:id/messages`
- **Auth:** staff | admin
- **Query:** `page=1, limit=50`
- **Response:** `{ data: Message[], meta }`

#### `POST /api/conversations/:id/messages`
- **Auth:** staff | admin
- **Body:** `{ content, attachmentIds?: number[] }`
- **Response:** `201` Message record

#### `GET /api/conversations/:id/participants`
- **Auth:** staff | admin
- **Response:** `User[]`

#### `GET /api/users-search`
- **Auth:** staff | admin
- **Query:** `search, page=1, limit=20`
- **Response:** `{ data: User[] }` for recipient selection

#### `POST /api/broadcasts`
- **Auth:** staff | admin
- **Body:** `{ subject, body, recipientIds: number[], templateId? }`
- Sends broadcast message to multiple users.
- **Response:** `201 { success: true, sent: number }`

#### `GET /api/broadcasts`
- **Auth:** admin
- **Response:** `Broadcast[]`

#### `POST /api/quick-contact`
- **Auth:** staff | admin
- **Body:** `{ userId, subject, message }`
- Sends a quick message to a single user.
- **Response:** `{ success: true }`

#### `GET /api/message-templates`
- **Auth:** staff | admin
- **Response:** `MessageTemplate[]`

#### `POST /api/message-templates`
- **Auth:** staff | admin
- **Body:** `{ name, subject, body, category? }`
- **Response:** `201` Template record

#### `PATCH /api/message-templates/:id`
- **Auth:** staff | admin
- **Body:** `{ name?, subject?, body?, category? }`
- **Response:** Updated template

#### `DELETE /api/message-templates/:id`
- **Auth:** staff | admin
- **Response:** `204 No Content`

### Student Messaging

#### `GET /api/student/conversations`
- **Auth:** student
- **Response:** Student's own conversations

#### `GET /api/student/conversations/:id/messages`
- **Auth:** student
- **Query:** `page=1, limit=50`
- **Response:** `{ data: Message[], meta }`

#### `POST /api/student/conversations`
- **Auth:** student
- **Body:** `{ message, subject? }`
- **Response:** `201 { conversation, message }`

#### `POST /api/student/conversations/:id/messages`
- **Auth:** student
- **Body:** `{ content }`
- **Response:** `201` Message record

### Agent Messaging

#### `GET /api/agent/conversations`
- **Auth:** agent (messages permission)
- **Response:** Agent's conversations

#### `GET /api/agent/conversations/:id/messages`
- **Auth:** agent (messages permission)
- **Query:** `page=1, limit=50`
- **Response:** `{ data: Message[], meta }`

---

## 14. Notifications

### `GET /api/notifications`
- **Auth:** auth
- **Query:** `page=1, limit=20, read?`
- **Response:** `{ data: Notification[], meta }`

### `GET /api/notifications/unread-count`
- **Auth:** auth
- **Response:** `{ count: number }`

### `GET /api/notifications/section-counts`
- **Auth:** auth
- **Response:** `{ applications, students, leads, messages, finance, ... }` unread counts per section

### `PATCH /api/notifications/:id/read`
- **Auth:** auth
- **Response:** `{ success: true }`

### `POST /api/notifications/mark-all-read`
- **Auth:** auth
- **Response:** `{ success: true }`

### Notification Rules (admin)

#### `GET /api/notification-rules`
- **Auth:** admin
- **Response:** `NotificationRule[]`

#### `GET /api/notification-rules/schema`
- **Auth:** admin
- **Response:** `{ events: [{ key, label, templateVars }] }`

#### `PATCH /api/notification-rules/:id`
- **Auth:** admin
- **Body:** `{ enabled?, emailEnabled?, inAppEnabled?, roles?, templateSubject?, templateBody? }`
- **Response:** Updated rule

#### `POST /api/notification-rules`
- **Auth:** admin
- **Body:** `{ event, enabled, emailEnabled, inAppEnabled, roles?, templateSubject?, templateBody? }`
- **Response:** `201` Rule record

---

## 15. Activity & Analytics

### `POST /api/activity/session/start`
- **Auth:** auth
- **Body:** `{ page?, referrer? }`
- **Response:** `{ sessionId }`

### `POST /api/activity/heartbeat`
- **Auth:** auth
- **Body:** `{ sessionId }`
- **Response:** `{ success: true }`

### `POST /api/activity/page-visit`
- **Auth:** auth
- **Body:** `{ page, sessionId? }`
- **Response:** `{ success: true }`

### `POST /api/activity/page-leave`
- **Auth:** auth
- **Body:** `{ page, duration, sessionId? }`
- **Response:** `{ success: true }`

### `POST /api/activity/event`
- **Auth:** auth
- **Body:** `{ event, data?, sessionId? }`
- **Response:** `{ success: true }`

### `POST /api/activity/session/end`
- **Auth:** auth
- **Body:** `{ sessionId }`
- **Response:** `{ success: true }`

### `GET /api/activity/presence`
- **Auth:** admin
- **Response:** `{ online: User[], count: number }` — users active in last 5 min

### `GET /api/activity/analytics`
- **Auth:** admin
- **Query:** `from?, to?, page?, userId?`
- **Response:** `{ pageViews, sessions, topPages, topUsers, ... }`

### `GET /api/activity/user/:userId`
- **Auth:** admin
- **Query:** `from?, to?`
- **Response:** Activity timeline for a specific user

### `GET /api/activity/modules`
- **Auth:** admin
- **Response:** Module usage statistics

---

## 16. Audit Log

### `GET /api/audit`
- **Auth:** auth (admin in practice)
- **Query:** `userId?, action?, entityType?, entityId?, page=1, limit=50`
- **Response:** `{ data: AuditLog[], meta }`

---

## 17. Statistics

### `GET /api/stats/overview`
- **Auth:** staff | agent
- **Query:** `season?`
- **Response:** `{ leads, students, applications, commissions, ... }` — dashboard KPIs (scoped by role)

### `GET /api/stats/growth`
- **Auth:** staff | agent
- **Query:** `season?, months=6`
- **Response:** `{ months: [{ month, leads, students, applications }] }`

---

## 18. Content (Blog & Announcements)

### Blog

#### `GET /api/blog`
- **Auth:** public
- **Query:** `category?, search?, page=1, limit=10`
- **Response:** `{ data: BlogPost[], meta }`

#### `POST /api/blog`
- **Auth:** staff (editor/admin)
- **Body:** `{ title, slug, content, excerpt?, category?, tags?, publishedAt?, featuredImageUrl?, status? }`
- **Response:** `201` Blog post

#### `GET /api/blog/:slug`
- **Auth:** public
- **Response:** Blog post or `404`

#### `PATCH /api/blog/:slug`
- **Auth:** staff (editor/admin)
- **Body:** subset of blog fields
- **Response:** Updated post

#### `DELETE /api/blog/:slug`
- **Auth:** staff (editor/admin)
- **Response:** `204 No Content`

### Announcements

#### `GET /api/announcements`
- **Auth:** public
- **Query:** `active?, page=1, limit=10`
- **Response:** `{ data: Announcement[], meta }`

#### `POST /api/announcements`
- **Auth:** manager
- **Body:** `{ title, body, type?, expiresAt?, targetRoles? }`
- **Response:** `201` Announcement

#### `PATCH /api/announcements/:id`
- **Auth:** manager
- **Body:** `{ title?, body?, type?, expiresAt?, targetRoles?, isActive? }`
- **Response:** Updated announcement

#### `DELETE /api/announcements/:id`
- **Auth:** manager
- **Response:** `204 No Content`

---

## 19. Universities & Programs

### `GET /api/universities/countries`
- **Auth:** public
- **Response:** `string[]` — distinct countries with at least one university

### `GET /api/universities`
- **Auth:** public
- **Query:** `search?, country?, page=1, limit=50`
- **Response:** `{ data: University[], meta }`

### `POST /api/universities`
- **Auth:** manager
- **Body:** `{ name, country?, city?, universityType?, website?, logoUrl?, description? }`
- **Response:** `201` University record

### `GET /api/universities/:id`
- **Auth:** public
- **Response:** University record or `404`

### `PATCH /api/universities/:id`
- **Auth:** manager
- **Body:** subset of university fields
- **Response:** Updated university

### `DELETE /api/universities/:id`
- **Auth:** manager
- **Response:** `204 No Content`

### Programs

#### `GET /api/programs`
- **Auth:** public
- **Query:** `universityId?, level?, language?, search?, page=1, limit=50`
- **Response:** `{ data: Program[], meta }` (commission/fee fields stripped for public/agent responses)

#### `POST /api/programs`
- **Auth:** manager
- **Body:** `{ universityId, name, degree?, language?, duration?, tuitionFee?, discountedFee?, scholarship?, commissionRate?, serviceFeeAmount?, applicationFee?, depositFee?, advancedFee?, languageFee?, currency?, intake?, deadline?, description? }`
- **Response:** `201` Program record

#### `GET /api/programs/:id`
- **Auth:** public
- **Response:** Program record

#### `PATCH /api/programs/:id`
- **Auth:** manager
- **Body:** subset of program fields
- **Response:** Updated program

#### `DELETE /api/programs/:id`
- **Auth:** manager
- **Response:** `204 No Content`

#### `DELETE /api/programs`
- **Auth:** manager
- **Body:** `{ ids: number[] }`
- **Response:** `{ success: true, deleted: number }`

---

## 20. Catalog (Countries, Cities, Options)

### `GET /api/countries`
- **Auth:** public
- **Query:** `search?, page=1, limit=100`
- **Response:** `Country[]`

### `POST /api/countries`
- **Auth:** manager
- **Body:** `{ name, code?, flag? }`
- **Response:** `201` Country

### `POST /api/countries/bulk`
- **Auth:** manager
- **Body:** `{ countries: CountryInput[] }`
- **Response:** `201 { inserted, errors }`

### `PATCH /api/countries/:id`
- **Auth:** manager
- **Body:** `{ name?, code?, flag? }`
- **Response:** Updated country

### `DELETE /api/countries/:id`
- **Auth:** manager
- **Response:** `204 No Content`

### `GET /api/cities`
- **Auth:** public
- **Query:** `countryId?, search?, page=1, limit=100`
- **Response:** `City[]`

### `POST /api/cities`
- **Auth:** manager
- **Body:** `{ name, countryId }`
- **Response:** `201` City

### `POST /api/cities/bulk`
- **Auth:** manager
- **Body:** `{ cities: { name, countryId }[] }`
- **Response:** `201 { inserted, errors }`

### `PATCH /api/cities/:id`
- **Auth:** manager
- **Body:** `{ name?, countryId? }`
- **Response:** Updated city

### `DELETE /api/cities/:id`
- **Auth:** manager
- **Response:** `204 No Content`

### `POST /api/universities/bulk`
- **Auth:** manager
- **Body:** `{ universities: UniversityInput[] }`
- **Response:** `201 { inserted, errors }`

### `POST /api/programs/bulk`
- **Auth:** manager
- **Body:** `{ programs: ProgramInput[] }`
- **Response:** `201 { inserted, errors }`

### `GET /api/catalog-options`
- **Auth:** public
- **Response:** `CatalogOption[]` (e.g. degree levels, languages)

### `POST /api/catalog-options`
- **Auth:** manager
- **Body:** `{ type, value, label? }`
- **Response:** `201` CatalogOption

### `PATCH /api/catalog-options/:id`
- **Auth:** manager
- **Body:** `{ value?, label? }`
- **Response:** Updated option

### `DELETE /api/catalog-options/:id`
- **Auth:** manager
- **Response:** `204 No Content`

---

## 21. Settings & Branding

### `GET /api/settings/branding`
- **Auth:** public
- **Response:** `{ logoUrl, companyName, primaryColor, ... }` — public branding config

### `GET /api/settings/branding/logo`
- **Auth:** public
- Streams the logo image file.
- **Response:** Image binary

### `GET /api/settings/available-years`
- **Auth:** public
- **Response:** `string[]` — academic seasons (e.g. `["2024","2025"]`)

### `GET /api/settings`
- **Auth:** auth
- **Response:** App settings object

### `PATCH /api/settings`
- **Auth:** manager
- **Body:** any subset of settings fields
- **Response:** Updated settings

---

## 22. Integrations (Admin)

### `GET /api/integrations`
- **Auth:** admin
- **Response:** `Integration[]` — all configured integrations (SMTP, etc.)

### `GET /api/integrations/:key`
- **Auth:** admin
- **Response:** Single integration by key (e.g. `smtp`, `openai`)

### `PUT /api/integrations/:key`
- **Auth:** admin
- **Body:** Integration-specific config object
- **Response:** Updated integration

### `PATCH /api/integrations/:key/toggle`
- **Auth:** admin
- **Body:** `{ enabled: boolean }`
- **Response:** `{ success: true }`

### `POST /api/integrations/:key/test`
- **Auth:** admin
- Tests the integration connection (e.g. sends test email).
- **Response:** `{ success: true, message? }` or `{ success: false, error }`

---

## 23. Roles (Admin)

### `GET /api/roles`
- **Auth:** admin
- **Response:** `Role[]` — custom roles

### `GET /api/roles/permissions-schema`
- **Auth:** admin
- **Response:** Permissions structure for role editing

### `GET /api/roles/:id`
- **Auth:** admin
- **Response:** Role record

### `POST /api/roles`
- **Auth:** admin
- **Body:** `{ name, label?, permissions? }`
- **Response:** `201` Role record

### `PATCH /api/roles/:id`
- **Auth:** admin
- **Body:** `{ label?, permissions? }`
- **Response:** Updated role

### `DELETE /api/roles/:id`
- **Auth:** admin
- **Response:** `204 No Content`

---

## 24. Quick Links

### `GET /api/quick-links`
- **Auth:** auth
- **Response:** `QuickLink[]` scoped to current user's role

### `GET /api/quick-links/admin`
- **Auth:** manager
- **Response:** All quick links

### `POST /api/quick-links`
- **Auth:** manager
- **Body:** `{ label, url, icon?, targetRoles?, order? }`
- **Response:** `201` QuickLink

### `PATCH /api/quick-links/:id`
- **Auth:** manager
- **Body:** `{ label?, url?, icon?, targetRoles?, order? }`
- **Response:** Updated QuickLink

### `DELETE /api/quick-links/:id`
- **Auth:** manager
- **Response:** `204 No Content`

---

## 25. Storage (Object Storage)

### `POST /api/storage/uploads/request-url`
- **Auth:** auth
- **Body:** `{ fileName, mimeType, folder? }`
- Returns a pre-signed upload URL or a direct upload path.
- **Response:** `{ uploadUrl, objectPath }`

### `GET /api/storage/public-objects/*filePath`
- **Auth:** public
- Streams a public object (logo, branding assets).
- **Response:** File binary

### `GET /api/storage/objects/*path`
- **Auth:** auth
- Streams a private object (contracts, documents).
- **Response:** File binary

---

## 26. AI / Document Extraction

### `POST /api/ai/extract-document`
- **Auth:** auth
- **Rate limit:** 10 calls / 15 min per user
- **Body:** `{ documentIds: number[] }` (IDs of uploaded documents in DB)
- Uses AI (OpenAI/configured LLM) to extract passport/ID fields.
- **Response:** `{ extracted: { firstName?, lastName?, passportNumber?, nationality?, dateOfBirth?, passportExpiry?, passportIssueDate?, ... }, warnings?: string[] }`
- **Errors:** `400` no docs, `503` AI not configured, `500` extraction failed

### `POST /api/ai/extract-bulk-csv`
- **Auth:** auth
- **Rate limit:** 5 calls / 15 min per user
- **Body:** `{ csv: string }` (raw CSV text)
- Parses and extracts multiple student records from a CSV using AI.
- **Response:** `{ students: StudentInput[] }`

---

## 27. Public Endpoints

### `GET /api/public/destinations`
- **Auth:** public
- **Response:** `Destination[]` — study destination pages for SEO/marketing

### `GET /api/public/destinations/:slug`
- **Auth:** public
- **Response:** Single destination or `404`

### `POST /api/public/apply`
- **Auth:** public (rate limited)
- Full public application form submission (creates student + application).
- **Body:** `{ firstName, lastName, email, phone, nationality, passportNumber, programId?, universityId?, intake?, agentToken? }`
- Sends confirmation email to student.
- **Response:** `201 { success: true, studentId, applicationId }`

### `POST /api/public/ai/extract-document`
- **Auth:** public (rate limited, stricter)
- AI passport extraction for the public apply form (no auth required).
- **Body:** `{ fileData: string (base64), mimeType }`
- **Response:** `{ extracted }` (same shape as authenticated version)

---

## Error Response Format

All errors return JSON:
```json
{ "error": "Human-readable message" }
```
Some endpoints add extra fields:
```json
{ "error": "...", "missingFields": ["passportNumber", "phone"] }
{ "error": "...", "code": "DOCS_REQUIRED", "requiredStage": "offer_received" }
```

## Pagination Meta

Paginated endpoints return:
```json
{
  "data": [...],
  "meta": {
    "total": 142,
    "page": 1,
    "limit": 20,
    "totalPages": 8
  }
}
```
