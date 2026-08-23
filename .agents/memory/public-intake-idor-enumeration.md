---
name: public intake IDOR & enumeration hardening
description: Rules for keeping public/unauthenticated intake endpoints (public-apply, embed apply/lead) safe from object-ID trust, identity enumeration, and lead-ID recovery.
---

# Public intake endpoints: never trust client object IDs; keep responses uniform

Applies to the unauthenticated routes: `/api/public/apply`, `/api/public/embed/:slug/apply`,
`/api/public/lead`, `/api/public/embed/:slug/lead`.

## Rules
1. **Never trust a client-supplied `leadId`** (or any object ID) on a public endpoint.
   Re-derive the target lead server-side:
   - public-apply: latest non-deleted lead where `lower(email)=normalizedEmail AND source='website'`
     (`orderBy desc(createdAt) limit 1`).
   - embed apply: ALWAYS `findOrUpsertEmbedLead(slug, email)` (dedup key = email + `source='embed:<slug>'`).
   Remove `leadId` from the request destructure entirely so it can't leak back in.
2. **Conflict responses must be uniform** to prevent identity enumeration. Staff-email conflict and
   passport-already-registered both return the SAME generic 409 (`code:"ACCOUNT_CONFLICT"`, same message
   incl. `loginUrl`). Log the specific reason server-side only (`console.warn`), never in the response.
3. **Don't disclose existing lead IDs.** Lead endpoints return `leadId` only when `created===true`;
   on a dedup hit return `leadId: null`. Frontend/embed scripts treat lead capture as best-effort and
   proceed without an ID, so this does not break the lead-first → auto-convert UX (apply re-derives).

**Why:** a client-trusted `leadId` is a broken-object-binding/IDOR primitive (attach docs to / overwrite /
convert leads you don't own); distinct conflict codes + returned lead IDs let an unauthenticated attacker
confirm staff emails / on-file passports and recover any known email's lead ID.

**How to apply:** when adding/editing any public intake field or response, keep these three invariants.
The residual email-keyed conversion (a public caller acting for a known email within the same source/slug)
is inherent to unauthenticated forms and is NOT fixable without email verification — which is out of scope
for hardening tasks. Rate limiting (`pg_rate_limits`, per-IP) + embed domain checks are the pragmatic boundary.

**Testing note:** `scripts/test-public-apply-flow.ts` exercises these flows but shares one IP, so it trips
the per-IP limiter quickly — `DELETE FROM pg_rate_limits` before a clean run. Pre-existing failures on
`student.address`/`student.highSchool` in the embed section are `tlu()` uppercasing mismatches, unrelated.
