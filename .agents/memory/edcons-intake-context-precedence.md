---
name: Intake answers → contract template variable precedence
description: How signer intake answers map onto canonical contract template vars in buildAgentContext, and the precedence/guard rules that keep it safe.
---

# Intake → contract context precedence (buildAgentContext)

Contract intake form fields are **camelCase** (`fullName`, `companyName`, `taxNumber`, `address`), but standard contract template variables are **snake_case** (`contact_person_name`, `agency_name`, `agency_legal_name`, `tax_number`, `address`, `signer_name`). Spreading raw intake last only fixes keys that collide by name (e.g. `address`); camelCase answers do NOT override their snake_case template var.

`buildAgentContext` therefore adds a **canonical bridge**: map camelCase intake → snake_case vars, spread after raw intake so signer edits win over the admin-entered agent record (`autoFromAgent`).

**Rules (all enforced via guards):**
- Only fill a canonical key when the signer did NOT already supply that exact snake_case key in intake. Raw intake spread handles those, and distinct `agency_name` vs `agency_legal_name` values must be preserved (don't collapse both to one company field).
- **Never overwrite `signer_name` from intake** — it must reflect `contract.signerName` captured at the signature step (stored in `signedContracts`), or the final PDF shows a stale name while the audit/evidence stores the real one.
- Empty intake answers are skipped so they fall back to the agent record.

**Why:** the admin pre-fills the agent record at agent creation; the agent then edits intake during signing. Edited values must override admin values in the preview AND the final signed PDF. `buildAgentContext` is the single central builder for onboarding preview, admin/public signing preview, public sign render, template test, and the lazy final PDF (`ensureSignedContractPdf`) — fixing it once covers every render path.

**How to apply:** `agentIntakeDefaults(agent)` (same file) produces the form prefill defaults (camelCase + aliases, empties dropped); the client seeds `{...intakeDefaults, ...intakeData}` so saved answers win over defaults. Keep the bridge additive — adding a new intake field means adding its camelCase aliases to the relevant `firstVal(...)` pick list, never removing the snake_case guard.
