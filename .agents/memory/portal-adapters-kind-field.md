---
name: portal-adapters kind field
description: GET /portal-adapters registry entries must include a `kind` field ("declarative"|"code") derived from the adapter family.
---

## Rule
`GET /portal-adapters` registry entries must include a `kind` field alongside `family`.

**Why:** `adapterMetadata()` in `lib/portal-adapters/src/registry.ts` returns `{ key, label, family }` where `family` is one of `"metronic" | "salesforce" | "sit" | "united" | "declarative"`. The test suite (`test-portal-mgmt-b.ts` TBB3) and the UI expect `kind: "declarative" | "code"` — a coarser two-value classification.

**How to apply:**
In `portalMgmt.ts` GET /portal-adapters route, derive `kind` from `family` before returning:
```typescript
const kind: "declarative" | "code" = family === "declarative" ? "declarative" : "code";
return { key, label, family, kind, hasCredentials };
```
Do NOT add `kind` to `adapterMetadata()` itself — it lives in a shared lib and only the route layer needs the coarse classification.
