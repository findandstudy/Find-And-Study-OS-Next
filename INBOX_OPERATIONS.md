# Inbox Operations — Staff Handover

This is a one-page guide for staff who work the inbox at `/staff/messages`.
It covers the channels, the tabs, who sees what, and the daily flows you need
to know.

> **What changed.** The Messages page now receives WhatsApp Business and Web
> Form conversations alongside internal CRM messages. Identity matching,
> assignment, and the 24-hour WhatsApp service window all happen automatically
> — your job is to triage and reply.

---

## 1. Channels at a glance

| Channel | Icon | Source | Outbound goes via |
|---|---|---|---|
| **Internal** | user avatar | CRM-to-CRM messages | stays in CRM |
| **WhatsApp** | green WhatsApp | inbound from any phone via Meta Cloud API | Meta Graph API → recipient's WhatsApp |
| **Web Form** | globe | inbound from the website's "Bize Yazın" form | dahili kalır + `email` varsa SMTP üzerinden otomatik yanıt |

You can filter the inbox by channel using the **pills above the list**:
**Tümü / Dahili / WhatsApp / Web Formu**.

---

## 2. The four tabs

The inbox has four tabs (URL is shareable — the active tab is in the query
string):

| Tab | What you see | When to watch |
|---|---|---|
| **Bana Atanmış** (Mine) | Conversations where you clicked "Bana al" | Your daily queue |
| **Atanmamış** (Unassigned) | Open conversations nobody owns yet | Take what you can handle |
| **Eşleşmemiş** (Unmatched) | Inbound where the system couldn't link the sender to a lead/öğrenci/acente | Triage — match or create lead |
| **Tümü** (All) | Everything that's open | Bird's-eye view |

A small **green dot** in the top-right of the inbox header means live updates
are connected — new messages slide in within ~5s without a refresh.

---

## 3. Daily flows

### 3a. New WhatsApp message arrives

1. The conversation appears in **Atanmamış** (or **Eşleşmemiş** if the phone
   doesn't match a known contact).
2. The header shows the WhatsApp icon, the sender's phone, and (if WA's
   Profile has it) the display name.
3. **Take it:** click "**Bana al**" in the conversation header. The
   conversation moves to **Bana Atanmış**.
4. **Reply:** type in the message box → **Gönder**. The reply goes out via
   WhatsApp Cloud API. The bubble turns into "**Sent**" once Meta confirms,
   or "**Gönderilemedi**" with a reason if it fails.

### 3b. Web form submission arrives

1. Same flow — appears in inbox with the **globe** icon.
2. If the submitter included an email, your reply is **also sent as an email
   automatically** (no extra clicks).
3. If the form had a hidden `agent_ref` field, the lead is automatically
   attributed to that sub-agent (you'll see a "**Sub-agent: …**" chip on the
   conversation). The conversation itself is still in the **Unassigned**
   pool — lead ownership and conversation ownership are separate.

### 3c. Eşleşmemiş — triage flow

When the system can't auto-match an inbound to a known contact:

1. Open the conversation. A **yellow banner** appears above the message box
   with one of two states:
   - **Aday(lar) önerildi:** "Bu kişi şununla aynı olabilir: Ahmet Y. (Lead)
     — **Şununla eşle**" → click to confirm.
   - **Aday yok:** "**Yeni lead oluştur**" → opens the lead create form
     pre-filled from WA contact / form fields.
2. Once matched (manually or auto-strong), the **Linked: …** badge replaces
   the warning, and future messages from the same external contact land
   directly on the linked entity.

### 3d. WhatsApp 24-hour service window

WhatsApp's policy: free-text replies are only allowed within **24 hours of
the user's last inbound message**. Outside that window:

1. The message box is **kilitli** (locked).
2. A **"Şablon gönder"** button replaces it.
3. Click it → choose an approved template (templates are created in Meta
   Business Suite and named in `message_templates`).
4. Once the user replies, the 24-hour window reopens automatically.

---

## 4. Notifications you'll receive

| Event | Who gets it | When |
|---|---|---|
| `inbox.new_message` | the assignee (or all admin/manager if unassigned) | every inbound message |
| `inbox.unmatched` | role pool (admin / manager) | inbound where identity isn't strong-matched |
| `inbox.send_failed` | the staff who sent the failed outbound | WA/email send error |

In-app notifications appear in the bell; email notifications follow each
user's notification preferences.

---

## 5. Profile-side history

On any **Lead / Öğrenci / Acente** detail page there is a **"Tüm Mesajlaşma"**
tab — every conversation that person has ever had on any channel (WA + Web +
internal), filtered by the contact links the inbox has built up. Use it
before responding to remind yourself of context.

---

## 6. Quick troubleshooting

| Problem | What to check first |
|---|---|
| WA reply shows "Gönderilemedi" with "outside 24h window" | Use a template instead |
| Inbox isn't updating live | Refresh once — if the green dot doesn't return, ping the admin |
| Sub-agent's lead isn't tagged to them | The form's `agent_ref` value must match the agent's `agencyCode` exactly (case-insensitive) |
| Email reply to a Web Form submitter never arrived | Settings → Integrations → Email (SMTP) → Test (admin only) |
| Same WA message appears twice | It shouldn't — the inbox dedupes by `(channel, externalMessageId)`. Report to the admin if you see it. |

---

## 7. Who to contact

- **Inbox bug or duplicate:** report to admin (open a task in the project
  tracker)
- **WhatsApp won't connect / token expired:** admin re-issues the System
  User token in Meta and re-saves in Settings → Integrations
- **New form embed needed for a partner site:** admin copies the snippet from
  Settings → Integrations → Web Form and shares the secret out-of-band

— end of handover —
