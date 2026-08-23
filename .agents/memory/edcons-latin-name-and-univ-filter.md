---
name: Latin-only name coverage + submission university filter source
description: Which create paths enforce Latin-only names (and which are deliberately exempt), and where the Submission Board university filter options must come from.
---

# Latin-only name enforcement — coverage map

Canonical helpers live in `artifacts/api-server/src/lib/textNormalize.ts`:
`containsNonLatinLetter`, `NON_LATIN_NAME_CODE` ("NON_LATIN_NAME"), and
`normalizeAndValidateNames(body, fields?)` (rejects non-Latin, else toLatinUpper).
Error format: `NON_LATIN_NAME:<field>: This field must contain only Latin letters.`
Frontend detects the prefix via `artifacts/edcons/src/lib/latinNameError.ts`
(`isNonLatinNameError`) → localized `common.nonLatinName` (all 10 langs).

**Enforced (reject + no record) at:** embed, students (create+bulk), leads
(create+bulk), public-apply `/public/apply` (firstName/lastName/mother/father),
inbox staff endpoints `/match/smart-new-lead` (body.fullName) and
`/match/new-lead` (contact.displayName).

**Deliberately EXEMPT:** `course-finder/apply` (no name INPUT — reuses existing
validated user names). Inbox **bot auto-capture** (`lib/inbox/leadCapture.ts`,
`lib/inbox/processInbound.ts`) is left transliterating-only, NOT rejecting.
**Why:** those are the WhatsApp bot pipeline (task rule "pipeline değişmez");
a hard reject there would silently drop inbound leads with no user-visible
error, losing business data. Acceptance verification for this rule is
panel/apply/bulk only.
**How to apply:** when asked to "reject non-Latin names everywhere", cover
user-facing create endpoints; do NOT add a hard reject to the bot capture paths
unless the ask explicitly includes dropping bot leads.

# Submission Board university filter source

`GET /portal-submissions/universities` (portalAutomation.ts) MUST source options
from canonical `portal_universities` via INNER JOIN, label = its `universityName`
only, dedup by `universityKey`. Never COALESCE-fall-back to the submission's raw
stored name/key (that produced duplicate "Topkapi University" + raw
"topkapi_university" rows). Trade-off: submissions whose key has no canonical
row are omitted from the filter; the portal↔CRM auto-linker keeps
portal_universities populated. Response shape `{key,label}` (frontend uses raw
customFetch, not orval).
