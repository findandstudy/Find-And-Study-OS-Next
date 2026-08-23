---
name: Inbox match drops lead link; lead-doc adoption
description: /match type=student nulls contact.leadId; lead-owned docs invisible to student-doc gates — adoption pattern
---
Rule: inbox POST /match resets ALL contact links (leadId nulled when matching a student), so any data still owned by the lead (documents) becomes unreachable from the student side. Mandatory-doc gates read student-owned docs only.

**Why:** inbox flows stage docs on the lead; DOCUMENTS summary ORs lead+student docs (green) while application gates 422'd (STUDENT_DOCS_REQUIRED).

**How to apply:** use `adoptLeadDocsForStudent()` (api-server/src/lib/leadDocAdoption.ts) — sets documents.studentId keeping leadId, matches leads by convertedStudentId OR email/phoneE164 (fallbacks gated on convertedStudentId IS NULL). Wired into: POST applications gate, PATCH documents_collected gate, checkMandatoryDocsForStudent, and /match type=student (which also fills leads.convertedStudentId). Any NEW mandatory-doc gate must adopt-then-recheck before rejecting.
