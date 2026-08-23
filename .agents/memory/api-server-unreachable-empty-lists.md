---
name: api-server unreachable shows empty lists
description: When list pages show 0 rows despite DB having data, suspect the api-server is not serving and restart it.
---

# Empty lists despite data = api-server not reachable

Symptom: a list page (e.g. Students) shows "0 total / no records" while the DB
clearly has matching rows, and the browser console shows NO API error.

Root cause seen: the api-server process stopped serving on its port (edcons vite
proxies `/api` → `localhost:8080`). When the upstream is down, the proxy returns
**502**, and the frontend renders `data?.data ?? []` → an empty list rather than
surfacing an error. So the UI looks like "no data" even though auth is valid and
the DB is full.

**Why:** the frontend swallows fetch failures into an empty array, so a transport
failure is indistinguishable from a genuinely empty result in the UI.

**How to apply:**
- Verify data really exists in the same DB the api-server uses (both use
  `DATABASE_URL`; confirmed db name `heliumdb`).
- Test the live endpoint the browser uses: `curl https://$REPLIT_DEV_DOMAIN/api/...`.
  A 502 (not 401/200) means the api-server isn't reachable behind the proxy.
- Sessions are unsigned: cookie `sid` = raw `sessions.sid`. You can replay an
  active session by sending `Cookie: sid=<sid>` to test authenticated endpoints.
- Fix: restart the `artifacts/api-server: API Server` workflow so it rebinds the
  port; re-test the endpoint returns 200 with data.
