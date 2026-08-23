---
name: Country-aware phone validation & phone_e164
description: How project-wide phone validation is wired (shared lib, backend guard, dual-write invariant, widget UX, backfill)
---

# Country-aware phone validation (libphonenumber-js)

- Shared package `@workspace/phone` (`lib/phone`, source-only export like `@workspace/roles` — no tsconfig/build): `normalizePhone` / `toValidE164`. Country-valid lengths (TR=10 national digits, UZ=9, etc.), E.164 canonical output.
- Backend guard: `artifacts/api-server/src/lib/phoneValidation.ts` `rejectInvalidPhone()` → 422 `{ error, code: "phone.invalid" }`. Wired into leads, students, and embed `/apply`.
- **Intentional exception:** embed `/lead` (Step-1 early lead fire) stays lenient — never lose a captured contact; it only best-effort writes `phoneE164` via `toE164`.
- **Dual-write invariant:** every write that sets `phone` MUST also set `phoneE164` (`stored.phoneE164 || toE164(phone) || null`). Easy-to-miss paths already fixed once: lead→student conversion (leads.ts) and student set-password user creation (students.ts). Audit new phone writes for this.
- **Why:** WhatsApp/inbox matching and portal adapters key on E.164; legacy `phone` is free-text.
- Frontend: `artifacts/edcons/src/components/ui/phone-field.tsx` (`PhoneField`, `isPhoneFieldValid`, `toPhoneFieldValue`) — swapped into the 5 panel forms; edit-init uses `toPhoneFieldValue(phoneE164 || phone)`. i18n `phone.*` namespace exists in all 10 locales.
- Embed widget JS (template literal in embed.ts): 422 `phone.invalid` bounces back to the personal step with inline `.ew-field-err` (no alert); `phoneError` reset on submit + apply-open. Widget JS is served by api-server (tsx, no watch) — **restart api-server after editing embed.ts**.
- Backfill: `artifacts/api-server/scripts/backfill-phone-e164.ts` (dry-run default, `--apply`) covers students/leads/users/agents. Dry-run verified; unparseables are genuinely bad legacy data.
- Portal profile builders (both portal-runner + worker) prefer `student.phoneE164 ?? student.phone`.
- Known pre-existing, NOT phone-related: embed e2e "fills the apply form" fails at review step (`#ew-form` never renders after doc-skip; reproduces on HEAD embed.ts); apply-flows E2EFIRST name-case failure; inbox-tests notifications cascade timeout.
