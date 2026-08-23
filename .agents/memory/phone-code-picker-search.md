---
name: Phone country-code picker dial-code search
description: Where dial-code search for the shared phone pickers actually lives, and why the embed widget behaved differently.
---

# Phone country-code picker — search by dial code

The shared in-app pickers (`components/ui/phone-code-picker.tsx` and
`components/ui/phone-input.tsx`, used by Add Student, Apply, Leads, Users,
Settings, etc.) do NOT filter their option list client-side when the country
catalog is available. They render server results from
`GET /api/public/countries?withDialCode=1&search=X` verbatim. Each component's
client-side name+dialCode+iso filter is only a FALLBACK for when the catalog is
empty/unreachable (offline dev / before backfill).

**The rule:** dial-code search behaviour for all in-app phone pickers is decided
by the `search` predicate in the `/public/countries` route (`routes/catalog.ts`),
not by the React components. It must match name OR dial code
(`regexp_replace(coalesce(dialCode,''),'[^0-9]','','g') LIKE digits%`, digits-only
normalized on both sides so "90"/"+90"/" 90 " all hit Turkey).

**Why:** the embed widget (`routes/embed.ts`) ships the whole catalog inline and
filters client-side by name+code, so it always searched by code — while the
in-app pickers looked broken because the server search was name-only. Same UX,
two different filter locations. Fix the endpoint, not the component, to keep every
picker consistent.

**Note:** catalog country names are English ("Turkey"), so a Turkish-script query
like "türk" legitimately returns 0 — that is data, not a search bug.
