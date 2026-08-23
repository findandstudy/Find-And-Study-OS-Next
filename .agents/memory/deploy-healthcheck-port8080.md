---
name: Deploy healthcheck & port 8080 contention
description: GET /api must stay DB-independent; e2e workflow steals port 8080 from the dev api-server.
---
Rule 1: The deployment healthcheck probes GET /api (not /api/health). health.ts serves a DB-independent 200 at router "/" (mounted at /api). Never make that route touch the DB — a slow prod DB at boot would make the platform kill healthy instances.
**Why:** Prod deploys showed bursts of "healthcheck /api returned 500" while the DB was slow; the route previously didn't exist at all.
**How to apply:** DB-aware health lives on /api/health (503 when degraded); keep /api and /api/healthz static.

Rule 2: The inbox-e2e workflow (pnpm test:e2e) starts its OWN api-server bound to 8080. While it runs, restart_workflow on the real api-server silently loses the port (old uptime keeps climbing, new code never serves). Check /api/health uptime after a restart; if it didn't reset, find and kill the e2e-spawned server before restarting.
**Why:** Cost two blind restarts before spotting the stale uptime.
