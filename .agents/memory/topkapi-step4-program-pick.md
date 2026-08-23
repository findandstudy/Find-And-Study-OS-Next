---
name: Topkapı Step 4 program selection
description: How the Topkapı program dropdown is selected and why disabled/full programs must fast-fail.
---

# Topkapı Step 4 program selection

`select[name=programFirstPreference]` is a HIDDEN select2 (twopulse, aria-hidden),
so `page.selectOption()` cannot reach it (times out). Select it the SAME way as
the other select2 fields: `setSelectByValue` → in-page jQuery `.val().trigger("change")`
(+ native input/change events). Keep the post-select read-back verify gate.

**Kontenjan Dolu (quota full) fast-fail:** a full programme is rendered with the
native `disabled` attribute AND/OR a "(Kontenjan Dolu)" suffix in the option
text. Selecting a disabled option makes Playwright hang ~8s ("option being
selected is not enabled"). So capture each option's `disabled` flag
(`o.disabled || /\(\s*Kontenjan\s*Dolu\s*\)/i`), and AFTER matchResult is
finalized (covers BOTH override and fuzzy paths) check `matchedOpt.disabled` —
if full, take a screenshot then **throw** an immediate clear error and include
the OPEN (enabled) programmes as `value: name` so an operator can pick the
nearest available one.

**Why throw vs return:** spec wants an instant explicit error (no 8s timeout);
the runner's catch surfaces it. Always log ALL options with state plus a separate
"Açık programlar" list for diagnosis.

**dump-program-options.ts** must pass DB-resolved creds via
`adapter.login({ credentials: { user, password } })` (login only falls back to
TOPKAPI_EMAIL/PASSWORD env when `credentials` is omitted) so it runs standalone;
dump the `disabled` flag too.
