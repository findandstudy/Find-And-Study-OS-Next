---
name: Passport expiry gate + education replace-set
description: Decisions from the Akademik Bilgi/SIT sprint FAZ 2 backend — passport hard-block semantics, education CRUD replace-set, and public-apply spec coverage.
---

- Passport gate: `isPassportExpired` is fail-open — missing or unparseable expiry NEVER blocks; only a parseable date strictly before today (00:00 UTC) returns true. Public apply returns stable `422 { error: "PASSPORT_EXPIRED" }` BEFORE any insert. **Why:** blocking on bad data would lose legitimate leads; the stable code is the i18n contract for Faz 4 frontend.
- Education records: one active record per level (high_school/bachelor/master, partial unique WHERE deleted_at IS NULL). PUT /students/:id/education is replace-set in one tx (soft-delete active set, insert new). `program` is force-nulled for high_school. Public-apply writes are best-effort (try/catch, per-level replace) so they can never break a submission.
- `/public/apply` is intentionally NOT in openapi.yaml — public embed/widget clients use raw fetch, so extending its body needs no spec/orval change. **How to apply:** don't "fix" spec drift for public endpoints; only staff-facing routes live in the contract.
