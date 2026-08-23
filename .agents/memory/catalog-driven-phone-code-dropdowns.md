---
name: Catalog-driven phone-code dropdowns
description: How dial-code/phone-code dropdowns are sourced from the country catalog, and the per-file PHONE_CODES dual-use gotcha.
---

Phone-code (dial code) dropdowns across the product are sourced from the admin-managed
country catalog (countries.dial_code), NOT from hardcoded arrays. The shared component is
`components/ui/phone-code-picker.tsx` (`<PhoneCodePicker value onChange triggerClassName>`),
with `phone-input.tsx` as the combined code+number variant. Both fetch via
`hooks/use-countries.ts` (`useDialCodeCountries`) with server-side AJAX debounced search.

**Dual-use gotcha (the trap):** ~13 page/dialog files each declared their OWN local
`const PHONE_CODES = [...]` that was used for TWO things: (1) rendering the dropdown, and
(2) `[...PHONE_CODES].sort(...)` to PARSE a stored phone string into code+number on submit.
When migrating a dropdown to `<PhoneCodePicker>`, KEEP the local array — it's still the
phone-number parser. Only the JSX `<Select>/<DropdownMenu>` that maps PHONE_CODES gets
replaced. After migration, `rg "PHONE_CODES\.map"` should only show parsing usages
(e.g. Programs.tsx `sortedCodes`), never SelectItem rendering.

**Some pickers were `DropdownMenu`-based, not shadcn `<Select>`** (Settings, SubAgents,
Users) — both forms iterate the local PHONE_CODES and both must be migrated.

**Picker correctness rules (learned from review):**
- Resolve the *selected* item from the base catalog (`useDialCodeCountries("")`) FIRST so
  admin-edited dial codes display correctly; fall back to the hardcoded ITU list only when
  the catalog is globally empty/unreachable.
- Gate the hardcoded fallback on `catalogAvailable` (base list non-empty), NOT on the
  per-search response length — otherwise an empty SEARCH result wrongly dumps the whole
  hardcoded list instead of showing honest "No results".

**Field is OPTIONAL:** only countries WITH a dial code appear in phone dropdowns
(`withDialCode=1` filter); public no-auth endpoint is `GET /api/public/countries`.

**embed.ts widget XSS:** dial codes injected into the inline `<script>` come from
admin-entered DB data, so escape them like the existing `DOC_META` pattern
(`.replace(/<\/script/gi,"<\\/script").replace(/\u2028.../).replace(/\u2029.../)`) — raw
`JSON.stringify` of user data into an inline script is a `</script>` breakout sink.
