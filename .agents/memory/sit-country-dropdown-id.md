---
name: SIT country/nationality is a zoho_countries ID (dropdown), not a name
description: Why the SIT student-create webhook rejects a raw country name and how nationality is resolved to a zoho_countries row id.
---

# SIT nationality/country → zoho_countries id

The SIT student-create webhook (and the application webhook's `country`) stores
country fields as Zoho **dropdowns** — they expect the `zoho_countries` ROW ID,
not the plain name. Sending a raw name (e.g. `"Pakistan"`) makes the student
webhook reject the create with `{"status":false,"message":"Unable to create
because of INVALID_DATA: Nationality1"}`.

**Fix:** `resolveCountryId(page, name)` in the SIT `graphql.ts` resolves name→id
via read-only pg_graphql `zoho_countriesCollection(filter:{name:{ilike:"%name%"}})`,
Turkish-fold-insensitive (`fold()` from programMatch). `createStudent` sets
`payload.nationality = resolveCountryId(...) ?? undefined` (was the raw name).

**Why fail-safe matters:** `ilike` is a substring match, so a short/ambiguous
input ("Guinea" → Guinea, Guinea-Bissau, Equatorial Guinea…) can return several
rows. Guessing `nodes[0]` would silently map to the WRONG country. Rule: prefer
a folded-EXACT name match; else accept a contains-match ONLY when it is the
single candidate; else return `null`. Never throws — unresolved → send empty and
STILL attempt the create, logging `[sit] nationality: "<name>" → <id|NOT_FOUND>`
(this diagnostic log line was explicitly required by the operator; the "no PII
logging" rule targets passwords/secrets and the full webhook body, never logged).

**How to apply:** any NEW country-typed field added to a SIT webhook payload
(country_of_residence, high_school_country, etc.) must go through resolveCountryId
too — a raw country name in a dropdown field = INVALID_DATA. The application
webhook's `country` already uses a zoho id (the program's `country_id`), so it
was never affected.
