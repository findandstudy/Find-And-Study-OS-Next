# Inbox Go-Live Checklist — WhatsApp Business + Messenger + Instagram DM + Web Form

This is the production runbook for switching the Omnichannel Inbox from
simulated/dev mode to live, accepting real WhatsApp messages and real form
submissions. Follow it top-to-bottom on the production deployment.

> **Why this exists.** In dev (and any deployment without
> `NODE_ENV=production` / `ALLOW_LIVE_INTEGRATIONS=true`), inbound webhooks
> work but outbound WA sends are simulated. To go live we need real Meta Cloud
> API credentials, a registered webhook callback, and a sanity dry-run.

---

## 0. Pre-flight (one time)

| Item | How to verify | Where |
|---|---|---|
| `NODE_ENV=production` is set on the API server | `printenv NODE_ENV` on the box, or check process manager env | VPS / process env |
| `ENCRYPTION_KEY` (or `SESSION_SECRET` fallback) is set | Required to encrypt integration secrets at rest. Without it the API refuses to start. | VPS env |
| `DATABASE_URL` points at the production Postgres | `psql $DATABASE_URL -c '\dt'` lists `integrations`, `external_contacts`, `channel_accounts`, `conversations`, `messages` | VPS env |
| API is reachable on HTTPS | `curl -I https://findandstudy.com/api/health` returns 200 | Public |
| Admin can sign in to `/staff/settings` | Browser | `/staff/settings` |
| Live-mode badge is green | `GET /api/integrations/live-mode` returns `{"live":true,...}` | API |

If `live-mode` returns `{"live":false}`, **stop**. The Settings UI will refuse
to enable the WA / Web Form cards and the `PUT /api/integrations/...` endpoint
will return `403 live_integrations_disabled`. Fix `NODE_ENV` first.

---

## 1. WhatsApp Business — Meta Cloud API setup

### 1a. Collect credentials from Meta

In Meta → developers.facebook.com → your App → **WhatsApp → API Setup** /
**App Settings → Basic**, gather:

- **Phone Number ID** — from WhatsApp → API Setup, the dropdown value next to "From".
- **Access Token** — generate a **System User permanent token** in Business Settings →
  Users → System Users → Add Assets (WhatsApp Business Account, with `whatsapp_business_messaging` and `whatsapp_business_management` scopes). Temporary tokens expire in 24h — do not use them in production.
- **Business Account ID** — WhatsApp → API Setup, "WhatsApp Business Account ID" field.
- **App Secret** — App Settings → Basic, "App Secret" (click *Show*). Required for HMAC signature checks on every inbound webhook.
- **Webhook Verify Token** — pick any high-entropy string yourself (e.g. `openssl rand -hex 32`). Meta will echo it back during the GET handshake; the API will reject it unless it matches exactly.

### 1b. Save credentials in Settings → Integrations

1. Sign in as an admin → **Settings → Integrations → WhatsApp Business → Configure**.
2. Paste **Phone Number ID**, **Access Token**, **Business Account ID**, **App Secret**, **Webhook Verify Token**.
3. Click **Save**.
4. Toggle the **Enable Integration** switch on. (The toggle is rejected with `whatsapp_secrets_required` unless both `appSecret` and `webhookVerifyToken` are present.)

The values are encrypted at rest with `ENCRYPTION_KEY` and masked when read back.

### 1c. Register the webhook with Meta

The dialog now shows a **Meta Cloud API webhook setup** panel with copy
buttons. Paste these into Meta → WhatsApp → Configuration → Webhook → Edit:

- **Callback URL:** `https://<your-domain>/api/webhooks/whatsapp`
  (the panel auto-fills this from the deployed origin)
- **Verify Token:** the exact value you saved in step 1b.

Meta will immediately call:

```
GET /api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
```

The handler echoes `hub.challenge` back as `text/plain` only when
`hub.verify_token` matches the saved value. **Successful handshake → green
checkmark in Meta's UI.** A failure logs `webhook_auth_failed` to the audit
trail with the reason.

After the handshake passes, **Subscribe** the `messages` field. (Optional:
`message_template_status_update` for template approval events.)

### 1d. Round-trip dry run

1. From any phone, send a free-text WhatsApp message to the business number.
2. Within ~5s the message must appear in `/staff/messages` under the
   **Unmatched** or **Mine/Unassigned** tab (depending on identity match)
   with the green WhatsApp icon and the sender's number.
3. Open the conversation, type a reply, click **Send**.
4. Confirm the reply lands on the phone in WhatsApp.
5. In the message detail header, confirm the message bubble shows **status: sent**
   (not "Simulated (dev)" or "Failed").

**Verification queries** (read-only, against production DB):

```sql
-- inbound row created from the test message
SELECT id, channel, direction, status, external_message_id, sent_at
FROM messages WHERE channel='whatsapp' ORDER BY id DESC LIMIT 5;

-- channel_account last_seen_at advanced
SELECT channel, display_name, external_account_id, status, last_seen_at
FROM channel_accounts WHERE channel='whatsapp';

-- no auth failures in the last 10 min
SELECT created_at, action, details FROM audit_logs
WHERE action='webhook_auth_failed' AND created_at > NOW() - INTERVAL '10 minutes';
```

### 1e. If the handshake fails

| Symptom | Likely cause | Fix |
|---|---|---|
| Meta shows "URL could not be validated" | Verify Token mismatch, or callback URL not HTTPS / not reachable | Re-copy the token from the dialog; ensure HTTPS resolves to the API server |
| Inbound webhooks return `401 Invalid or missing signature` | App Secret missing or wrong | Re-copy from Meta App Basic settings; re-save WA integration |
| Inbound webhooks return `200 ignored: integration disabled` | The Enable switch is off | Toggle it on (requires both secrets) |
| `403 Forbidden` on GET handshake | Verify Token typo, or WA integration not yet saved | Save creds first, then re-paste in Meta |

---

## 1.5. Facebook Messenger + Instagram — Direct Messages (DM only)

> **Scope:** Direct Messages only. Public **comments, feed posts, mentions, and
> story replies are explicitly out of scope** for this rollout — do not subscribe
> to any feed/comment webhook fields and do not request any comment-management
> permission. This keeps the Meta App Review surface minimal and avoids the
> Advanced Access reviews that comment moderation would trigger.

Both Messenger and Instagram DM share **one** webhook callback with WhatsApp:

```
https://apply.findandstudy.com/api/webhooks/meta
```

Inbound is signature-verified with the **same** App Secret (`X-Hub-Signature-256`),
and outbound DMs go to the Graph `me/messages` endpoint. Live sending is gated by
the same live-mode switch as WhatsApp (`isLiveIntegrationsEnabled()` —
`NODE_ENV=production` or `ALLOW_LIVE_INTEGRATIONS=true`); in dev the send is
**simulated** and returns `{ simulated: true }`.

### 1.5a. Prerequisites

- A **Facebook Page** for the brand (Messenger is Page-scoped).
- An **Instagram professional account** (Business or Creator) **linked to that
  Page** (Instagram → Settings → linked Facebook Page). Personal IG accounts
  cannot receive Messaging API webhooks.
- A **Meta System User** (Business Settings → Users → System Users) with a
  **non-expiring Page access token** generated for the Page above. Use a System
  User token, not a personal short-lived token, so the integration does not break
  every 60 days.
- App ID **1490649605420814** (same app as WhatsApp).

### 1.5b. Subscribe the webhook fields (DM only)

In **Meta App → Webhooks**, using the existing callback URL + Verify Token:

- **Page** product → subscribe **only**:
  - `messages`
  - `messaging_postbacks`
  - `message_reactions`
  - `messaging_referrals`
  - *(do NOT subscribe `feed`, `mention`, `message_deliveries` is optional/receipt-only)*
- **Instagram** product → subscribe **only**:
  - `messages`
  - *(do NOT subscribe `comments`, `mentions`, `story_insights`)*

Then **subscribe the Page to the app** (Page → app subscription) so message
events actually flow. For Instagram, ensure the **Instagram account is connected
to the app's Page** and the app has messaging access for that IG account.

### 1.5c. Save the page token + enable

1. **Settings → Integrations → Messenger / Instagram → Configure.**
2. Paste the **System User Page access token** (and IG account id where prompted).
3. The **App Secret** and **Verify Token** are shared with WhatsApp — no need to
   re-enter; the single `/api/webhooks/meta` route validates all three channels.
4. Toggle **Enable Integration** on (requires the same live-mode gate as WA).

### 1.5d. Round-trip dry run

1. From a **different** Facebook account, send a DM to the Page.
2. Confirm it appears in `/staff/messages` under **channel: messenger** within ~5s.
3. Reply from the inbox → the DM is received back in Messenger, message status `sent`.
4. Repeat from a different Instagram account DM-ing the IG business account →
   appears under **channel: instagram**.

**Verification queries:**

```sql
SELECT id, channel, status, last_inbound_at
FROM conversations WHERE channel IN ('messenger','instagram') ORDER BY id DESC LIMIT 5;

SELECT id, channel, direction, content, sent_at
FROM messages WHERE channel IN ('messenger','instagram') ORDER BY id DESC LIMIT 5;
```

> **24-hour window:** Like WhatsApp, Meta only allows free-form outbound DMs
> within **24 hours** of the user's last inbound message. Replies after that
> return `409 outside_24h_window`. (Message-tag/HSM sending is not part of this
> rollout.)

### 1.5e. Meta App Review — DM-only permissions

Submit the app for review requesting **only** the permissions a DM workflow
needs. Each one needs a screencast showing the inbox sending/receiving DMs.

| Permission | Why (DM use case) |
|---|---|
| `pages_messaging` | Send & receive Messenger DMs on behalf of the Page |
| `pages_manage_metadata` | Subscribe the Page to the messaging webhook |
| `pages_read_engagement` | Read Page + conversation metadata for inbox display |
| `pages_show_list` | Let the admin pick which Page to connect |
| `instagram_basic` | Read the linked IG business account profile |
| `instagram_manage_messages` | Send & receive Instagram DMs |
| `business_management` | Manage the System User token / Business assets |

**Do NOT request** (out of scope — comments/feed):

- `instagram_manage_comments`
- `pages_manage_engagement`
- `pages_manage_posts` / any `*_content_publish`
- any `feed`/`mention` comment-moderation scope

**Review submission checklist:**

- [ ] App in **Live** mode (not Development) before requesting Advanced Access
- [ ] Privacy Policy URL + Data Deletion Instructions URL set on the app
- [ ] Each requested permission has a clear screencast of the DM flow
- [ ] Screencast shows a **test user / real Page** DM round-trip in the inbox
- [ ] No comment/feed permissions requested (faster review)
- [ ] App Icon, Category, and Business Verification completed

### 1.5f. Rollout order

1. Ship code (already gated — dev simulates, prod requires live-mode + token).
2. Connect Page + IG account, save System User token, **keep toggle OFF**.
3. Submit App Review (DM permissions above). Wait for approval.
4. After approval: subscribe webhook fields (1.5b), toggle **Enable** on.
5. Do the round-trip dry run (1.5d) with a real external account.
6. Announce internally once both channels round-trip cleanly.

### 1.5g. If it fails

| Symptom | Likely cause | Fix |
|---|---|---|
| DMs never arrive | Page not subscribed to the app, or field not subscribed | Re-do 1.5b; confirm Page→app subscription |
| Instagram DMs missing while Messenger works | IG not a professional acct, or not linked to the Page | Convert IG to Business/Creator and link the Page |
| Inbound returns `401 Invalid or missing signature` | App Secret mismatch | Shared with WA — re-save the WA App Secret |
| Outbound returns `409 outside_24h_window` | User's last inbound > 24h ago | Wait for a new inbound; HSM/tags not in scope |
| Outbound returns `190` / token error from Graph | Page token expired/short-lived | Re-issue a **System User** non-expiring token |

---

## 2. Web Form — embed snippet on the customer site

### 2a. Generate formId + secret

1. **Settings → Integrations → Web Form → Configure**.
2. Click **Save**. (`formId` and `secret` are auto-generated on first save.)
3. Toggle **Enable Integration** on. (Same live-mode gate as WA.)
4. Optionally fill **After-submit Redirect URL** so HTML form posts land on a
   thank-you page (e.g. `https://findandstudy.com/thanks`).

### 2b. Copy the integration snippet

The secret is a **server-to-server credential** and must never appear in public
website HTML — anyone viewing the page could read it and forge submissions.
The dialog therefore shows two parts:

1. **Public form (no secret)** — standard fields firstName, lastName, email,
   phone, message, plus hidden `agent_ref` (empty for organic leads; sub-agents
   pre-fill it with their `agencyCode` to attribute the lead). This form posts to
   the customer's **own backend**, not directly to the webhook.
2. **Server-to-server forward (secret in header)** — the customer's backend
   forwards the submission to
   `https://<your-domain>/api/webhooks/web-form/<formId>` with the secret in the
   `X-Webform-Token` header (or an HMAC `X-Webform-Signature`). The webhook no
   longer accepts a secret supplied in the request body.

Click **Copy form** / **Copy example** and hand them to the customer's web team.

### 2c. Round-trip dry run

1. Submit the form once with a real email + phone.
2. Confirm the conversation appears in `/staff/messages` (channel: globe icon "Web").
3. If the email/phone matches an existing lead/student/agent, the conversation
   shows the **Linked: …** chip; otherwise it lands in **Unmatched** with
   match suggestions.
4. The staff member responsible for unmatched leads receives an
   `inbox.unmatched` notification.

**Verification queries:**

```sql
SELECT id, channel, status, last_message_at, unmatched
FROM conversations WHERE channel='web_form' ORDER BY id DESC LIMIT 5;

SELECT id, channel, direction, content, sent_at
FROM messages WHERE channel='web_form' ORDER BY id DESC LIMIT 5;
```

### 2d. agent_ref (sub-agent attribution) sanity check

If sub-agents are embedding the form with `agent_ref` pre-filled:

1. Submit a test with `<input type="hidden" name="agent_ref" value="<agencyCode>">`.
2. The new lead row must have `assigned_agent_id` set to that agent.
3. The conversation row must have `assigned_to_id = NULL` (lead ownership ≠
   conversation ownership — the conversation stays in the **Unassigned**
   pool until staff click "Take it").

```sql
SELECT id, first_name, last_name, source, agent_id
FROM leads WHERE source LIKE 'web_form:%' ORDER BY id DESC LIMIT 5;
```

### 2e. If submissions are rejected

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 Invalid or missing webhook secret` | request missing the `X-Webform-Token` header / valid `X-Webform-Signature`, or secret rotated (a `secret_token` body field is no longer accepted) | Send the secret in the `X-Webform-Token` header from your server; the secret in the panel is the source of truth |
| `404 Unknown form id` | `formId` in URL doesn't match the saved one | Re-copy snippet; the URL is auto-built from the saved formId |
| `200 ignored: integration disabled` | Web Form toggle is off | Enable in Settings |
| Submission lands but no email reply when staff respond | SMTP integration not configured | Settings → Integrations → Email (SMTP) → Configure & Test |

---

## 3. Notification routing sanity

After enabling both channels, confirm the staff who watch the inbox actually
get notified. Send one inbound on each channel and check:

- **Assigned conversation** → only the assignee sees `inbox.new_message`
  (in-app + email per their notification preferences).
- **Unassigned & unmatched** → all admin/manager-role staff see
  `inbox.unmatched`.
- **Outbound failure** → `inbox.send_failed` reaches the sender.

If notifications don't arrive, check `notification_preferences` and SMTP
connectivity (Settings → Integrations → Email → Test).

---

## 4. Rollback / disable

If something is wrong post go-live, you can **disable without losing data**:

1. **Settings → Integrations → WhatsApp Business → toggle off.**
   Inbound webhooks return `200 ignored: integration disabled`; outbound
   sends are blocked.
2. **Settings → Integrations → Web Form → toggle off.** Same behaviour.

To temporarily revoke a leaked Web Form embed, **rotate the secret**: clear
the `secret` field and **Save** — a new secret is generated and old embeds
get `401`. Re-copy the snippet to the new customer-site location.

To revoke a leaked WhatsApp token, rotate the System User token in Meta and
re-save in Settings.

---

## 5. Done checklist

Tick each before announcing the feature internally:

- [ ] `live-mode` endpoint returns `{"live":true}`
- [ ] WhatsApp: App Secret, Verify Token, Phone Number ID, Access Token saved
- [ ] WhatsApp webhook URL registered in Meta and **Subscribed to `messages`**
- [ ] WhatsApp GET handshake passes (green check in Meta)
- [ ] One real inbound WA message → appears in inbox within 5s
- [ ] One real outbound WA reply → received on phone, status `sent`
- [ ] Messenger + Instagram: System User Page token saved, both toggles enabled
- [ ] Page subscribed to the app; **DM-only** webhook fields subscribed (no feed/comments)
- [ ] Instagram is a professional account linked to the Page
- [ ] App Review approved for DM permissions only (no comment scopes requested)
- [ ] One real Messenger DM inbound → appears in inbox; reply received, status `sent`
- [ ] One real Instagram DM inbound → appears in inbox; reply received, status `sent`
- [ ] Web Form formId + secret saved, integration enabled
- [ ] Embed snippet pasted on the customer site
- [ ] One real form submission → appears in inbox; correct routing (linked / unmatched)
- [ ] `inbox.unmatched` notification received by the responsible role
- [ ] Audit log shows zero `webhook_auth_failed` events from legitimate traffic
- [ ] Operator handover note (`INBOX_OPERATIONS.md`) shared with staff
