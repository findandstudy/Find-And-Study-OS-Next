---
name: OpenAPI UserProfile schema vs session payload drift
description: buildSessionUser returns fields not declared in OpenAPI spec; how to keep them in sync.
---

## Rule
When adding a field to `buildSessionUser()` in `api-server/src/lib/auth.ts`, you **must** also:
1. Add the field to `UserProfile` in `lib/api-spec/openapi.yaml` (both `properties` and `required` if non-nullable)
2. Update the generated `lib/api-client-react/src/generated/api.schemas.ts` interface
3. Rebuild the dist: `cd lib/api-client-react && pnpm exec tsc -b --force`

**Why:** The frontend imports `UserProfile` from `@workspace/api-client-react` (compiled dist). If the dist is stale or the spec is missing the field, `tsc --noEmit` fails with `TS2339: Property '...' does not exist on type 'UserProfile'`, even though the field exists at runtime.

**How to apply:** Any time you see a `TS2339` referencing a `UserProfile` property, check the three locations above. The pattern is: API returns it, spec doesn't declare it, generated type doesn't have it, dist is stale.

**Discovered:** `emailVerified` was returned by `buildSessionUser` (line 75 auth.ts) but absent from openapi.yaml → `EmailVerificationGuard.tsx:19` crashed tsc.
