---
name: Embed widget Step-1 early lead
description: Early lead capture fires on basics-only (name+email), before phone validation blocks navigation
---

**Rule:** In the embed widget's Step-1 (Personal Info) Next handler, the early lead POST must fire as soon as firstName+lastName+email are valid — even when missing phone/country-code blocks navigation with an alert. Never gate lead capture behind the full-form validation, and never let a failed capture block navigation.

**Why:** The backend `/public/embed/:slug/lead` requires only name+email (phone optional). Gating the capture behind full validation silently lost every visitor who abandoned at the phone field — reported as "no lead lands in CRM" while backend and full-form path were fine. Diagnosing this cost a full session because the full-form path *did* work in live tests.

**How to apply:**
- Basics-only fire is skipped for `lead_form` widgets (there Step-1 IS the whole submission; marking leadId early would drop the phone forever since there's no `/apply` follow-up).
- A phone-less early fire sets a pending flag; the next fully-valid Next re-fires once — backend dedups by email+source and refreshes the same row, adding the phone (no duplicate lead).
- Deduped responses return `leadId: null` by design (security) — a 201 with null leadId means "existing row refreshed", NOT failure. This also explains false "no lead created" reports when testers reuse an email.
