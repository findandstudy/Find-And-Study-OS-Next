# Portal Automation — Architecture & Operations Guide

## Overview

The Portal Automation system automates submission of student applications to
external university portals. It consists of three layers:

| Layer | Location | Role |
|---|---|---|
| **API routes** | `artifacts/api-server/src/routes/portalAutomation.ts` + `portalMgmt.ts` | Enqueueing, settings, CRUD |
| **Admin UI** | `artifacts/edcons/src/pages/admin/PortalAutomation.tsx` | Configuration & monitoring |
| **Worker** | `artifacts/portal-automation-worker/` | Headless browser execution |

---

## Database Tables

| Table | Purpose |
|---|---|
| `portal_automation_settings` | Global on/off, mode, scope, trigger stages |
| `portal_universities` | Which universities to submit to + per-uni defaults |
| `portal_program_mapping` | Portal label → CRM program name dictionary per university |
| `portal_adapters` | DB-stored declarative adapter configurations |
| `portal_submissions` | Submission queue + status tracking |

---

## Worker Setup

### Prerequisites

- Node.js 20+
- pnpm
- Sufficient RAM (≥2 GB recommended — Chromium is launched per job)

### Install & Build

```bash
# From the project root — installs all workspace deps + Playwright Chromium
bash deploy/build-production.sh
```

The script runs five steps:
1. `pnpm install --frozen-lockfile`
2. Shared library typecheck (`typecheck:libs`)
3. Frontend build (edcons)
4. Backend build (api-server)
5. **Worker typecheck + `playwright install chromium --with-deps`** ← new worker step

> **VPS first deploy**: step 5 downloads ~130 MB Chromium and its OS-level
> dependencies (libnss, libatk, etc.). It is safe to re-run — subsequent runs
> are a no-op when the version has not changed.

### Configuration

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
# Edit .env — add DATABASE_URL, ENCRYPTION_KEY, and adapter credentials
```

Key variables for the worker (see `.env.example` for full comments):

| Variable | Default | Purpose |
|---|---|---|
| `WORKER_POLL_MS` | `5000` | Polling interval when queue is empty (ms) |
| `WORKER_STALE_MS` | `300000` | Stale-lock threshold for crash recovery (ms) |
| `ENCRYPTION_KEY` | — | **Required** — AES-256-GCM key for DB-stored portal credentials |
| `PLAYWRIGHT_HEADLESS` | `true` | Chromium headless flag (always true in production) |
| `AUTH_STATE_DIR` | — | Path to persist Playwright browser sessions across restarts |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | — | Custom Chromium path (leave empty on VPS) |

> **Security**: `ENCRYPTION_KEY` must be the same value used by the API server
> (`SESSION_SECRET` is the legacy fallback). Generate once per environment:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```
> **Key rotation**: if you rotate `ENCRYPTION_KEY`, all existing `*Enc` rows in
> `portal_credentials` become unreadable. Re-encrypt each row by re-saving
> credentials through the **Admin → Portal Credentials** UI after rotation.

---

## PM2 Operations Runbook

The worker runs as a separate PM2 process (`findandstudy-portal-worker`) in
**fork mode** alongside the API cluster. The authoritative ecosystem config is
`deploy/ecosystem.config.cjs` (root `ecosystem.config.cjs` re-exports it).

### Start / Reload

```bash
# First start (all processes — API + worker)
pm2 start deploy/ecosystem.config.cjs --env production
pm2 save    # persist process list across reboots

# Reload worker only (zero-downtime, picks up new env vars)
pm2 reload findandstudy-portal-worker --update-env

# Reload everything (API + worker) after a full deploy
pm2 reload deploy/ecosystem.config.cjs --update-env
pm2 save
```

### Stop / Delete

```bash
pm2 stop   findandstudy-portal-worker
pm2 delete findandstudy-portal-worker   # removes from pm2 list
```

### Logs

```bash
# Live stream
pm2 logs findandstudy-portal-worker

# Last 200 lines
pm2 logs findandstudy-portal-worker --lines 200

# Log files on disk (rotate via deploy/logrotate.conf)
tail -f logs/portal-worker-out.log
tail -f logs/portal-worker-error.log
```

Apply logrotate once on the VPS:
```bash
sudo cp deploy/logrotate.conf /etc/logrotate.d/findandstudy
```

### Status & Memory

```bash
pm2 status          # process list with uptime and restart count
pm2 monit           # interactive CPU/RAM monitor
```

The worker is configured with `max_memory_restart: "1G"`. If PM2 is
restarting frequently, check for Chromium process leaks:

```bash
ps aux | grep chromium | wc -l   # should be 0 when worker is idle
```

### Smoke Test (API + worker together)

```bash
# 1. Confirm both processes are running
pm2 status

# 2. Enqueue a dry submission (replace application ID and cookie)
curl -s -X POST https://yourdomain.com/api/applications/123/portal-submissions \
  -H "Cookie: <session>" \
  -H "Content-Type: application/json" \
  -d '{"universityKey":"sit","mode":"dry"}'

# 3. Watch the worker claim the job within WORKER_POLL_MS
pm2 logs findandstudy-portal-worker --lines 50

# 4. Check result
curl -s "https://yourdomain.com/api/portal-submissions?applicationId=123" \
  -H "Cookie: <session>"
# Expect: status "submitted-dry"
```

---

## Adding a New University Portal

### 1 — Choose adapter type

**Adapter Spec v2 (JSON)** — preferred for new mappings. Supports guarded
steps, resumable state machines, program/quota classification, profile
fallback policy, strict dry-run and version rollback. See
[`adapter-spec-v2.md`](./adapter-spec-v2.md).

**Code/protocol driver** — use only for mechanics the spec runtime cannot yet
express, such as CAPTCHA or encrypted server-chained flow protocols. Portal
field mapping and business policy should remain in a spec wherever possible.

### 2 — Register in Admin UI

1. Open **Admin → Portal Automation → Üniversite Portalleri**
2. Click **Yeni Ekle**
3. Fill in:
   - **University key** — lowercase, hyphens only (e.g. `okan`, `bahcesehir`)
   - **Display name** — shown in the UI
   - **Adapter type** — `declarative` or the code adapter key
   - **Default mode** — set to `dry` during initial calibration
4. Save

### 3 — Set credentials

**Option A — Admin UI (recommended, AES-256-GCM encrypted in DB):**
1. Open **Admin → Portal Credentials**
2. Find the university → enter username/password → Save

**Option B — environment variable (plain-text in `.env`, legacy fallback):**
```bash
MYUNI_EMAIL=automation@example.com
MYUNI_PASSWORD=secret
```

Credential resolution order: DB (decrypted) → `<KEY>_EMAIL/_USER` env →
`<ADAPTERKEY>_EMAIL/_USER` env (legacy).

### 4 — Program mapping

If the portal uses different program names than the CRM:
1. Go to **Admin → Portal Automation → Program Haritalama**
2. Select the university
3. Add pairs: **Portal Label** → **CRM Program Name**
4. Save

### 5 — Dry calibration (see next section)

---

## Dry Run Calibration Procedure

Dry mode runs the full Playwright flow but **stops before the final submit
button click**. Use it to verify the adapter navigates correctly before
enabling real submissions.

### Steps

1. Confirm the university's default mode is `dry` in Admin UI
2. Pick a real application with complete student documents
   (passport, transcript, photo — incomplete profiles fail early)
3. Enqueue a dry submission:
   **Application Detail → Portal Automation panel → select university → Dry Run**
4. Watch the worker log:
   ```bash
   pm2 logs findandstudy-portal-worker --lines 100
   ```
5. Check the screenshot saved on dry completion:
   ```bash
   ls logs/screenshots/
   # <submissionId>_dry_<timestamp>.png
   ```

### Interpreting dry results

| Status | Meaning | Action |
|---|---|---|
| `submitted-dry` | Navigation succeeded, stopped before submit | ✅ Ready to enable real |
| `program_missing` | Program label not found in portal dropdown | Add to Program Haritalama |
| `failed` (login error) | Bad credentials or portal layout changed | Fix creds; inspect screenshot |
| `failed` (selector) | DOM selector broke — portal updated UI | Update adapter selector |

### Promoting to real mode

1. Confirm **≥3 consecutive dry runs succeed** on different student profiles
2. Switch the university default mode to `real` in Admin UI
3. Run one **real** submission on a low-risk test application (confirm with
   the student that they are aware)
4. Verify `externalRef` is populated and the stage moves to **Awaiting Offer**

---

## CAPTCHA & Manual Login Procedure

Some portals (e.g. Salesforce-based `uskudar`) trigger CAPTCHA on first login
from a new IP or after session expiry. The worker cannot solve CAPTCHAs
automatically.

### Option A — Browser session persistence (recommended)

When `AUTH_STATE_DIR` is set, the worker saves Playwright `storageState`
after a successful login and reuses it on subsequent runs:

```bash
# In .env
AUTH_STATE_DIR=/var/www/findandstudy/auth
chmod 700 /var/www/findandstudy/auth   # protect session files
```

Session file per university: `<AUTH_STATE_DIR>/<universityKey>.json`.
Sessions expire when the portal cookie TTL expires (typically 30–90 days).

### Option B — Manual CAPTCHA seed login

When the session has expired or the worker hits a CAPTCHA on a fresh VPS:

```bash
# SSH into the VPS with a display (X11 or desktop session)
# Run the manual-login helper — launches a VISIBLE browser
pnpm --filter @workspace/portal-automation-worker run-once \
  --university uskudar --manual-login

# Complete the CAPTCHA + login in the browser window.
# The helper saves storageState to AUTH_STATE_DIR/<key>.json and exits.

# Reload the worker to pick up the new session
pm2 reload findandstudy-portal-worker --update-env
```

If the VPS has no display:
```bash
DISPLAY=:99 xvfb-run --server-args="-screen 0 1280x1024x24" \
  pnpm --filter @workspace/portal-automation-worker run-once \
  --university uskudar --manual-login
```

### Session rotation schedule

| Portal | Typical TTL | Action |
|---|---|---|
| SIT | ~90 days | Re-seed when `failed (login)` appears in logs |
| United | ~30 days | Re-seed monthly |
| Topkapi | ~60 days | Re-seed when `failed (login)` appears in logs |
| Uskudar (Salesforce) | ~30 days | Re-seed monthly; watch for CAPTCHA in logs |

---

## Submission Lifecycle

```
Admin triggers / automation rule fires
         │
         ▼
POST /api/applications/:id/portal-submissions
  → INSERT portal_submissions (status=queued)
         │
         ▼
Worker polls: SELECT ... WHERE status='queued' FOR UPDATE SKIP LOCKED
  → UPDATE status=running, locked_at=now(), worker_id=<hostname-pid>
         │
         ▼
Playwright launches Chromium
  → adapterByKey(universityKey).submit(profile)
         │
    ┌────┴────┐
    ▼         ▼
submitted   failed
    │         │
    └──UPDATE status, result──┘
         │
         ▼
 stageWriteback: set application stage (e.g. "Awaiting Offer")
```

### Statuses

| Status | Meaning |
|---|---|
| `queued` | Waiting to be picked up by the worker |
| `running` | Currently being processed |
| `submitted` | Successfully submitted to the portal |
| `submitted-dry` | Dry run completed (stopped before submit) |
| `already_exists` | Student already exists in the portal |
| `program_missing` | Program not found in portal (check mapping) |
| `failed` | Submission failed — see `error` field |
| `canceled` | Manually canceled before execution |

### Retry & Cancel

Failed/canceled submissions can be retried via:

```
POST /api/portal-submissions/:id/retry
```

Queued/running submissions can be canceled via:

```
POST /api/portal-submissions/:id/cancel
```

---

## Adapters

### Code Adapters (built-in)

Located in `lib/portal-adapters/src/universities/`. These are TypeScript
classes implementing `PortalAdapter`:

- `sit` — SIT Portal (11 universities: Halic, Atlas, Ankara Medipol, …)
- `united` — United Portal (Biruni, Nisantasi, Ankara Bilim)
- `topkapi` — İstanbul Topkapı
- `salesforce` — Üsküdar + future Salesforce-based schools

### Declarative Adapters

Configured in **Admin → Portal Automation → Adaptörler**. No code required.
The JSON configuration describes selectors, form fields, and submission steps:

```json
{
  "loginUrl": "https://apply.example.edu.tr/login",
  "steps": [
    { "type": "fill", "selector": "#email", "value": "{{email}}" },
    { "type": "fill", "selector": "#password", "value": "{{password}}" },
    { "type": "click", "selector": "button[type=submit]" },
    { "type": "navigate", "url": "https://apply.example.edu.tr/apply/new" }
  ]
}
```

---

## Program Mapping

When a portal uses different program names than the CRM:

1. Go to **Admin → Portal Automation → Program Haritalama**
2. Select the university
3. Add pairs: **Portal Label** → **CRM Program Name**
4. Save

The worker uses this mapping to find the correct portal program when submitting.

---

## Monitoring

- **Başvuru Panosu tab**: Real-time submission queue status
- **Denetim Günlüğü tab**: Full audit trail of all portal automation actions
- **PM2 logs**: `pm2 logs findandstudy-portal-worker`
- **Log files**: `logs/portal-worker-out.log`, `logs/portal-worker-error.log`

---

## Dry Run vs Real Mode

| Mode | Effect |
|---|---|
| **Dry Run** | Simulates the full flow but stops before final submit |
| **Real** | Actually submits to the portal — requires `confirm: true` |

The global default is set in **Otomasyon Kuralları → Submission Mode**.
Individual manual triggers always require explicit mode selection.

---

## Security Notes

- Portal credentials stored in DB are encrypted at rest (AES-256-GCM via `ENCRYPTION_KEY`)
- `hasCredentials` boolean is the only credential signal returned by any API endpoint
- The portal panel never renders credential values in the UI
- `AUTH_STATE_DIR` session files contain browser cookies — protect with `chmod 700`
- All operations are logged in `audit_logs` with actor + IP
- Agent-role users only see submissions for their own applications (RBAC isolation)
- Worker runs as a separate OS process — a Chromium crash cannot affect the API server
