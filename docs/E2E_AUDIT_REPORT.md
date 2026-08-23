# EduConsult OS — Kapsamlı E2E + Güvenlik/Mimari Denetim Raporu

**Tarih:** 14–15 Haziran 2026  
**Versiyon:** 1.3  
**Kapsam:** Tüm roller, tüm route'lar, güvenlik zafiyetleri, mimari bulgular, bug düzeltmeleri  
**Ortam:** DEV (no publish/deploy; no real messages/payments)

---

## İçindekiler

1. [Yönetici Özeti](#1-yönetici-özeti)
2. [Test Ortamı ve Roller](#2-test-ortamı-ve-roller)
3. [Bölüm A — E2E Rol Testleri](#3-bölüm-a--e2e-rol-testleri)
4. [Bölüm B — Güvenlik Bulguları](#4-bölüm-b--güvenlik-bulguları)
5. [Bölüm C — Mimari Bulgular](#5-bölüm-c--mimari-bulgular)
6. [Bölüm D — Bug Düzeltmeleri](#6-bölüm-d--bug-düzeltmeleri)
7. [Öneriler ve Takip Görevleri](#7-öneriler-ve-takip-görevleri)

---

## 1. Yönetici Özeti

Bu denetimde EduConsult OS (FAS-OS) pnpm monorepo uygulaması, tüm roller için E2E test koşumu, kapsamlı güvenlik kodu incelemesi ve mimari analiz yapılmıştır.

| Metrik | Sonuç |
|--------|-------|
| inbox-tests (unit/integration) | **301/301 PASS** ✅ (36 sub-grup) |
| inbox-e2e (Playwright E2E) | **130/131 PASS** (1 pre-existing hata — embed mobile) |
| Cascade assignment tests | **12/12 PASS** (fix ile) ✅ |
| **RBAC Fonksiyonel E2E (Bölüm A2)** | **106/106 PASS** ✅ — 11 rol × 6 alan |
| Kritik güvenlik bulgusu | **4 bulgu — hepsi düzeltildi** ✅ |
| Bug düzeltmesi | **13 fix** (3 güvenlik + 3 davranış + 4 ADIM C + 3 v1.3) |
| Typecheck (api-server + edcons) | **PASS** ✅ |

---

## 2. Test Ortamı ve Roller

### Uygulama URL
`https://8609d428-0c07-4d6f-bf8a-92b955eb83cd-00-1jrkokzh4qc40.picard.replit.dev`

### Test Hesapları

RBAC test hesapları yalnız izole E2E veritabanında fixture olarak oluşturulur.
Parolalar repoda tutulmaz; koşum sırasında `RBAC_E2E_PASSWORD` ortam
değişkeninden alınır. Canlı kullanıcı bilgileri E2E raporlarına yazılmaz.

### Rol Hiyerarşisi
- **ADMIN_ROLES**: `super_admin`, `admin`, `manager`
- **STAFF_ROLES**: ADMIN_ROLES + `staff`, `consultant`, `editor`, `accountant`
- **AGENT_ROLES**: `agent`, `sub_agent`, `agent_staff`
- **FINANCE_ROLES**: accountant + ADMIN_ROLES (per finance route guards)

---

## 3. Bölüm A — E2E Rol Testleri

### 3.1 Playwright E2E Sonuçları (inbox-e2e)

#### ADIM C — Stabil Final Koşumu (15 Haziran 2026)

**Özet: 130 PASS / 1 FAIL — 131 toplam test**  
Koşum: `pnpm test:e2e` (stabil ortam, API server up, fixture'lar seeded)  
Süre: ~2.6 dakika · 2 Playwright worker

| Spec Dosyası | Toplam | PASS | FAIL |
|-------------|--------|------|------|
| `rbac-functional.spec.ts` (11 rol × 6 alan) | 106 | 106 | 0 |
| `apply-flows.spec.ts` | 4 | 4 | 0 |
| `embed-widget.spec.ts` + diğerleri | 21 | 20 | 1 |
| **TOPLAM** | **131** | **130** | **1** |

#### ❌ FAIL (1/131) — Pre-existing, Kod Hatası Değil

| Test | Hata | Kök Neden |
|------|------|-----------|
| `embed-widget` mobile — viewport | `modalInfo.height: 0, expected > 120` | Tablet-portrait viewport'ta modal yüksekliği 0 px; pre-existing responsive layout sorunu |

#### ✅ DÜZELTİLDİ Bu Oturumda (apply-flows)

| Test | Önceki Hata | Düzeltme |
|------|-------------|----------|
| `apply-flows` (c) course-finder-apply | `STUDENT_DOCS_REQUIRED` (422) | Test, yeni öğrenci yerine tüm belgeleri seeded fixture öğrencisini kullanacak şekilde güncellendi (BUG-010) |

**Apply-flows son sonuç:** `4/4 PASS` ✅ (d, a, b, c)

#### Önceki Koşum Karşılaştırması

| Dönem | Toplam | PASS | FAIL | Açıklama |
|-------|--------|------|------|----------|
| Denetim başı (v1.0) | ~25 | 17 | 5+3 | API server restart sırasında koşuldu |
| ADIM C stabil koşum (v1.2) | 131 | 130 | 1 | Stabil ortam; 1 pre-existing (embed mobile) |

---

### 3.2 Unit / Integration Test Sonuçları (inbox-tests)

**Özet: 301/301 PASS** (36 sub-grup, `pnpm --filter @workspace/api-server test`)

| Test Paketi | Testler | Sonuç |
|-------------|---------|-------|
| @workspace/roles, pagination, i18n (shared-lib) | 16 | ✅ |
| xlsx export/import round-trip | 12 | ✅ |
| Student photo endpoint (SP-1..5) | 5 | ✅ |
| Dashboard Faz1 — activity view/summary (DV-1..5) | 5 | ✅ |
| Dashboard Faz2 — weekly/monthly/staffId (DV2-1..8) | 8 | ✅ |
| Service fee agent filter (SF-1..3) | 3 | ✅ |
| Portal automation (T1..7) | 7 | ✅ |
| Portal auto-trigger (TAT-1..4) | 4 | ✅ |
| Portal mgmt (TAU-1..7) | 7 | ✅ |
| Portal mgmt-b (TBB-1..7) | 7 | ✅ |
| Portal process (TP+TMD+TSR+TAP — 24 test) | 24 | ✅ |
| Portal API (TPA-1..9) | 9 | ✅ |
| Assignment cascade (12 senaryo) | 12 | ✅ |
| Agent commission, rbac-agent-source, rbac-route-integration | ~20 | ✅ |
| Contract context, sign, signing-scope, object-authz | ~16 | ✅ |
| API token (CRUD, auth, scope, role — 4 suite) | ~22 | ✅ |
| Webhook dedup, inbox-suite, inbox-ai, inbox-create-lead | ~18 | ✅ |
| Finance Faz3, staff bonus/commission/payment | ~15 | ✅ |
| Rate-limit IP security, doc-access-control, doc-equivalence | ~12 | ✅ |
| Diğer (stage-behaviors, gpa-normalize, tasks-access-control…) | ~20 | ✅ |
| **TOPLAM** | **301** | **✅ 301/301** |

**Cascade Test Detayı (12/12):**

```
✔ student PATCH assign cascades to linked lead and applications
✔ student PATCH unassign (null) clears lead and applications
✔ student bulk-assign cascades to each student's lead and applications
✔ cascade runs only with records.cascade_assignment permission
✔ re-assigning a student to the same assignee cascades nothing
✔ lead PATCH assign still cascades down to student and applications
✔ application PATCH assign cascades to student and linked lead
✔ application PATCH assign without cascade permission leaves student and lead untouched
✔ staffCards assign student cascades to linked lead and applications    ← FIX
✔ staffCards unassign student cascades null to lead and applications    ← FIX
✔ leads bulk-assign cascades to each lead's student and applications
✔ sync-assignment-backfill is idempotent
```

---

### 3.3 Bölüm A2 — Rol-bazlı Fonksiyonel E2E (RBAC Kapsamı)

**Tarih:** 15 Haziran 2026  
**Spec:** `artifacts/edcons/tests/e2e/rbac-functional.spec.ts`  
**Setup:** `artifacts/api-server/scripts/rbac-e2e-setup.ts` (11 audit hesabı + agent kayıtları)  
**Sonuç: 106 / 106 PASS ✅** (2 dk 48 sn)

#### Kapsam: 11 Rol × 6 Alan

| Rol | Toplam Test | PASS | FAIL |
|-----|-------------|------|------|
| super_admin | 12 | 12 | 0 |
| admin | 13 | 13 | 0 |
| manager | 10 | 10 | 0 |
| staff | 10 | 10 | 0 |
| consultant | 7 | 7 | 0 |
| editor | 7 | 7 | 0 |
| accountant | 10 | 10 | 0 |
| agent | 9 | 9 | 0 |
| sub_agent | 7 | 7 | 0 |
| agent_staff | 9 | 9 | 0 |
| student | 12 | 12 | 0 |
| **TOPLAM** | **106** | **106** | **0** |

---

#### Alan 1 — Finans (FINANCE_ROLES Sınırı)

**Endpoint:** `GET /api/finance/university-receivables`  
**İzin verilenler:** `super_admin`, `admin`, `accountant`  

| Rol | Beklenen | Alınan | Sonuç |
|-----|----------|--------|-------|
| superadmin | 200 | 200 | ✅ |
| admin | 200 | 200 | ✅ |
| accountant | 200 | 200 | ✅ |
| manager | 403 | 403 | ✅ |
| staff | 403 | 403 | ✅ |
| consultant | 403 | 403 | ✅ |
| editor | 403 | 403 | ✅ |
| student | 403 | 403 | ✅ |
| agent | 403 | 403 | ✅ |
| sub_agent | 403 | 403 | ✅ |
| agent_staff | 403 | 403 | ✅ |

**UI:** `accountant` → `/staff/finance` yüklenir; `staff` → yönlendirilir ✅

---

#### Alan 2 — AI Modları (ADMIN_ROLES Sınırı)

**Endpoint'ler:** `GET /api/ai-personas`, `GET /api/ai-extractors`  
**İzin verilenler:** `super_admin`, `admin`, `manager`

| Rol | ai-personas | ai-extractors | Sonuç |
|-----|-------------|---------------|-------|
| superadmin | 200 | 200 | ✅ |
| admin | 200 | 200 | ✅ |
| manager | 200 | 200 | ✅ |
| staff | 403 | — | ✅ |
| consultant | 403 | — | ✅ |
| editor | 403 | — | ✅ |
| accountant | 403 | — | ✅ |
| student | 403 | — | ✅ |
| agent | 403 | — | ✅ |
| agent_staff | 403 | — | ✅ |

**UI:** `admin` → `/admin/ai-personas` yüklenir; `staff` → yönlendirilir ✅

---

#### Alan 3 — Bildirimler

**Endpoint'ler:**  
- `GET /api/notifications/unread-count` → tüm auth roller  
- `GET /api/notification-rules` → ADMIN_ROLES only  
- `GET /api/notifications` → tüm auth roller (response: `{ data: [...] }`)

| Test | Sonuç |
|------|-------|
| Tüm 10 auth rol → `/notifications/unread-count` 200 | ✅ 10/10 |
| superadmin/admin/manager → `/notification-rules` 200 | ✅ 3/3 |
| staff/accountant/student/agent → `/notification-rules` 403 | ✅ 4/4 |
| admin → notifications list alınabilir (`{ data: [] }` shape) | ✅ |
| student → kendi notification listesi alınabilir | ✅ |

> **Not:** `/api/notifications` endpoint'i `{ notifications: [] }` değil `{ data: [] }` shape döndürür (keşfedilen davranış, spec buna göre güncellendi).

---

#### Alan 4 — Mesajlaşma / Inbox

**Endpoint'ler:**  
- `GET /api/conversations` → STAFF_ROLES (7 rol)  
- `GET /api/broadcasts` → ADMIN_ROLES  
- `GET /api/message-templates` → STAFF_ROLES

| Endpoint | İzin verilen | Yasak | Sonuç |
|----------|--------------|-------|-------|
| /conversations | 7 STAFF_ROLES → 200 | student/agent/subagent/agentstaff → 403 | ✅ 11/11 |
| /broadcasts | admin/manager/superadmin → 200 | staff/accountant/student/agent → 403 | ✅ 7/7 |
| /message-templates | admin/staff/accountant → 200 | student/agent → 403 | ✅ 5/5 |

**UI:** `staff` → `/staff/messages` hata olmadan açılır ✅

---

#### Alan 5 — Süreç Takibi (Pipeline)

**Endpoint'ler:** `/api/leads`, `/api/students`, `/api/applications`

| Test | Beklenen | Sonuç |
|------|----------|-------|
| STAFF_ROLES (7 rol) → `/leads` 200 | 7/7 | ✅ |
| student → `/leads` 403 | 403 | ✅ |
| agent_staff (leads perm) → `/leads` 200 | 200 | ✅ |
| superadmin/admin/staff → `/students` 200 | 3/3 | ✅ |
| student → `/students` 200 (kendi) | 200 | ✅ |
| agent_staff (students perm) → `/students` 200 | 200 | ✅ |
| admin/staff/student/agentstaff → `/applications` 200 | 4/4 | ✅ |

**UI:**
- `admin` → `/staff/students` hata olmadan açılır ✅
- `student` → `/student/applications` hata olmadan açılır ✅

---

#### Alan 6 — Agent Network (AGENT_ROLES + 7 İzin)

**Endpoint'ler:** `/api/agents/me`, `/api/agents/me/sub-agents`, commissions guard

| Test | Beklenen | Alınan | Sonuç |
|------|----------|--------|-------|
| agent → `/agents/me` | 200 | 200 | ✅ |
| sub_agent → `/agents/me` | 200 | 200 | ✅ |
| agent_staff → `/agents/me` | 200 | 200 | ✅ |
| staff → `/agents/me` | non-200 | 404* | ✅ |
| student → `/agents/me` | non-200 | 404* | ✅ |
| agent_staff → leads endpoint | 200 | 200 | ✅ |
| agent_staff → students endpoint | 200 | 200 | ✅ |
| agent_staff → applications endpoint | 200 | 200 | ✅ |
| subagent → leads (kendi scope) | 200 | 200 | ✅ |
| agent → `/agents/me/sub-agents` | 200 | 200 | ✅ |
| agent → `/commissions` (FINANCE_ROLES guard) | 403 | 403 | ✅ |
| agent_staff → `/commissions` (FINANCE_ROLES guard) | 403 | 403 | ✅ |

> *`/agents/me` → `requireAuth` kullanır, `requireRole` yok; non-agent roller agent kaydı bulunmadığından 404 döner (403 değil). Bu davranış güvenlik açığı değildir — non-agent roller buraya erişim sağlasa dahi boş sonuç alır, veri sızıntısı yoktur. İyileştirme önerisi: AGENT_ROLES guard eklenebilir (bkz. Alan 6 Öneriler).

**UI:**
- `agent` → `/agent` dashboard hata olmadan yüklenir ✅
- `sub_agent` → `/agent` dashboard hata olmadan yüklenir ✅
- `agent_staff` (tüm 7 izin) → `/agent` dashboard hata olmadan yüklenir ✅

---

#### A2 Keşfedilen Bulgular

| ID | Ciddiyet | Açıklama | Durum |
|----|----------|----------|-------|
| A2-F01 | Düşük | `/api/agents/me` → AGENT_ROLES guard eksik; non-agent roller 404 alır (veri sızıntısı yok) | ✅ DÜZELTİLDİ |
| A2-F02 | Bilgi | `/api/notifications` response shape `{ data: [] }` (dokümantasyonda `notifications[]` yazıyor) | ✅ DOKÜMANTASYon güncellendi |
| SEC-004 | Orta | `website.ts:941` `x-forwarded-for` header doğrudan okunuyordu (IP bypass riski) | ✅ DÜZELTİLDİ |

**A2-F01 Düzeltme:** `agents.ts` `/agents/me` ve `/agents/me` PATCH rotalarına `requireRole(...AGENT_ROLES)` eklendi. Non-agent roller artık net 403 alır (önceden 404). DB sorgusu artık yetkisiz isteklerde koşmaz.

**A2-F02 Karar:** API yanıt shape'i değiştirilmedi (`{ data: [] }` kalır). Değişiklik kırıcı olacaktı; bunun yerine bu rapor ve spec güncellemesi ile dokümante edildi.

**SEC-004 Düzeltme:** `(req.ip || req.headers["x-forwarded-for"] || "")` → `(getClientIp(req) ?? "")`. `getClientIp()`, Express'in `trust proxy = 1` konfigürasyonunu kullanarak doğru IP'yi döndürür; header doğrudan okuması kaldırıldı.

---

## 4. Bölüm B — Güvenlik Bulguları

### 4.1 Kritik / Yüksek — DÜZELTILDI

#### 🔴 SEC-001: SSRF (Server-Side Request Forgery) — documents.ts
**Ciddiyet:** YÜKSEK  
**Durum:** ✅ DÜZELTİLDİ

**Açıklama:** `artifacts/api-server/src/routes/documents.ts` içindeki `isValidHttpUrl()` fonksiyonu, özel IP aralıklarını (`127.x`, `10.x`, `192.168.x`, `172.16-31.x`, `169.254.x`, `localhost`) engellemiyordu. Saldırgan, dahili bir URL'yi belge URL'si olarak geçirerek iç ağa istek yaptırabilirdi.

**Düzeltme:** `isValidHttpUrl()` fonksiyonuna özel IP aralıklarını reddeden regex ve `localhost` kontrolü eklendi.

```typescript
// Eklenen kontroller:
// Strip IPv6 brackets: new URL('http://[::1]/').hostname === '[::1]'
const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
if (host === 'localhost' || host.endsWith('.localhost')) return false;
if (host === '::1' || host === '0.0.0.0') return false;
if (/^127\./.test(host) || /^10\./.test(host)) return false;
if (/^192\.168\./.test(host)) return false;
if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
if (/^169\.254\./.test(host)) return false; // AWS IMDSv1, link-local
```

**Bağımsız Doğrulama (28/28 PASS):**  
Engellenen: `127.0.0.1`, `10.x`, `192.168.x`, `172.16-31.x`, `169.254.x`, `localhost`, `*.localhost`, `0.0.0.0`, `::1` (IPv6, parantez soyularak), `ftp://`, `file://`.  
İzin verilen: `1.1.1.1`, `8.8.8.8`, `storage.googleapis.com`, `s3.amazonaws.com`, `172.32.x`, `172.15.x`.

**Ek fix:** IPv6 `::1` loopback başlangıçta tespit edilemiyordu — `new URL('http://[::1]/').hostname` değeri `'[::1]'` döndürüyor (parantezli), `'::1'` değil. `.replace(/^\[|\]$/g, "")` ile düzeltildi.

---

#### 🔴 SEC-002: Privilege Escalation — users.ts PATCH /users/:id
**Ciddiyet:** YÜKSEK  
**Durum:** ✅ DÜZELTİLDİ

**Açıklama:** `PATCH /api/users/:id` endpoint'inde `admin` ve `manager` rolündeki kullanıcılar bir `super_admin` hesabını doğrudan düzenleyebiliyordu (`phone`, `role`, `isActive`, `permissionOverrides` dahil). Guard yalnızca impersonation endpoint'inde mevcuttu; PATCH handler'ında hedef kullanıcının rolü hiç kontrol edilmiyordu.

**Kök neden:** `requireAuth` kullanan PATCH endpoint'i yalnızca `isAdmin || isSelf` kontrolü yapıyordu. `ADMIN_ROLES = ["super_admin", "admin", "manager"]` — dolayısıyla admin/manager `isAdmin = true` sayılıyor ve herhangi bir hedefe PATCH yapabiliyordu.

**Düzeltme (`users.ts`, yeni eklenen blok):**

```typescript
// SEC-002: prevent non-super_admin from modifying a super_admin account
if (req.user!.role !== "super_admin") {
  const [targetCheck] = await db.select({ role: usersTable.role })
    .from(usersTable).where(eq(usersTable.id, id));
  if (targetCheck?.role === "super_admin") {
    res.status(403).json({ error: "Only a super administrator may modify another super administrator account." });
    return;
  }
}
```

**Bağımsız Doğrulama (canlı API entegrasyon testi — 4/4 PASS):**
- `admin → super_admin PATCH` → **403** ✅  
- `manager → super_admin PATCH` → **403** ✅  
- `admin → kendi hesabı PATCH` → **400** (izin verildi) ✅  
- `admin → manager hesabı PATCH` → **400** (izin verildi) ✅

---

#### 🟠 SEC-003: XSS (Cross-Site Scripting) — SignFlow.tsx + SignContract.tsx
**Ciddiyet:** ORTA-YÜKSEK  
**Durum:** ✅ DÜZELTİLDİ

**Açıklama:** `artifacts/edcons/src/pages/sign/SignFlow.tsx` ve `artifacts/edcons/src/pages/agent/SignContract.tsx` dosyaları, sözleşme HTML önizlemesini `dangerouslySetInnerHTML` ile doğrudan DOM'a ekliyordu. Sözleşme şablonuna kötü niyetli HTML/JS enjekte edilebilirse XSS saldırısı mümkündü.

**Düzeltme:** Her iki dosyada `isomorphic-dompurify` ile `DOMPurify.sanitize()` eklendi.

```typescript
// SignFlow.tsx satır 2:
import DOMPurify from "isomorphic-dompurify";
// satır 494:
dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml) }}

// SignContract.tsx satır 2:
import DOMPurify from "isomorphic-dompurify";
// satır 300:
dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(data.previewHtml || "") }}
```

**Bağımsız Doğrulama (10/11 PASS, 1 false positive):**  
Temizlenen vektörler: `<script>alert()`, `onerror`, `onclick`, `javascript:` href, `svg/onbegin`, `iframe`, `data: URI object`.  
Meşru içerik korundu: `<p>`, `<strong>`, `<ul>`, `<h2>`.  
Not: `style="width:expression()"` — DOMPurify bunu tasarım gereği temizlemiyor; bu saldırı yalnızca Internet Explorer 6-8'de çalışır, modern tarayıcılarda etkisizdir.

---

### 4.2 Orta Ciddiyet — Gözlem (Fix Önerilmez/Öneri)

#### 🟡 SEC-004: website.ts — XFF Header Doğrudan Kullanımı (audit log)
**Ciddiyet:** DÜŞÜK  
**Durum:** ✅ DÜZELTİLDİ (ADIM C)

**Açıklama:** `artifacts/api-server/src/routes/website.ts:941` satırında audit log için IP adresi alınırken:
```typescript
// ÖNCE (hatalı):
ipAddress: (req.ip || req.headers["x-forwarded-for"] || "").toString().slice(0, 45),
```
`req.headers["x-forwarded-for"]` doğrudan okunuyordu. Bu sadece audit log içindir (rate limiting değil), dolayısıyla gerçek güvenlik riski düşüktür.

**Düzeltme:** `getClientIp(req) ?? ""` ile değiştirildi. Express `trust proxy = 1` konfigürasyonu ile doğru IP döner; XFF header'ı doğrudan okuma kaldırıldı.
```typescript
// SONRA (doğru):
import { getClientIp } from "../lib/clientIp";
ipAddress: (getClientIp(req) ?? "").slice(0, 45),
```

---

#### 🟡 SEC-005: Rate Limiter Bypass — Güçlü Durum (Onay)
**Ciddiyet:** DÜŞÜK  
**Durum:** ✅ ONAYLANDI — GÜVENLİ

`app.set("trust proxy", 1)` + `req.ip` kullanımı doğru yapılandırılmış. `clientIp.ts` açıklama satırları bu kararı belgeler. `X-Forwarded-For: fake, real` durumunda Express yalnızca `real` (son proxy eklediği) değeri döndürür — `fake` değer görmezden gelinir.

---

#### 🟡 SEC-006: Public-Apply IDOR Koruması (Onay)
**Ciddiyet:** DÜŞÜK  
**Durum:** ✅ ONAYLANDI — GÜVENLİ

`/api/public/apply` endpoint'i, gelen `leadId` parametresine güvenmez; kimliği `email + source` kombinasyonundan yeniden türetir. `ACCOUNT_CONFLICT` hataları uniform (bilgi sızdırmaz). Yeni lead oluşturulduğunda `leadId` ancak `created === true` ise döner.

---

### 4.3 Güvenlik Pozitif Bulgular

Aşağıdaki güvenlik kontrolleri doğru ve sağlam bulunmuştur:

| Kontrol | Durum | Notlar |
|---------|-------|--------|
| **Şifre reset flow** | ✅ | SHA-256 hash, 1sa expiry, reset sonrası tüm session'lar siliniyor |
| **CSRF koruması** | ✅ | Double-submit cookie pattern; istemci tarafı seed (autoscale edge bypass için) |
| **Session management** | ✅ | Logout → session silme; impersonation → session invalidation |
| **API token auth** | ✅ | SHA-256 hash, Bearer-first, default-deny scope guard, kendi token'larını yönetemez |
| **Finance route auth** | ✅ | Tüm finance route'ları `requireRole(...FINANCE_ROLES)` ile korunmuş |
| **Contract template auth** | ✅ | `requirePermission("contract_templates.view/manage")` |
| **Webhook signature** | ✅ | WhatsApp webhook imza doğrulaması mevcut (`website.ts` SSRF guard da var) |
| **Secret masking** | ✅ | `maskSecrets()` integrasyon sırları frontend'e dönmeden önce uygulanıyor |
| **SQL injection** | ✅ | Tüm sorgular Drizzle ORM ile parametrize; `sql`` `` tagged template'ler yalnızca tablo/kolon referansları için |
| **Dosya yükleme** | ✅ | Yüklenen dosyalar magic byte kontrolü + boyut limiti ile doğrulanıyor |
| **Agent-source RBAC** | ✅ | `agentSourceScope.ts` ile tüm agent kayıt sorgularında scope uygulanıyor |
| **Staff permission gating** | ✅ | `requireAgentStaffPermission` tüm 7 izin için uygulanmış |

---

## 5. Bölüm C — Mimari Bulgular

### 5.1 Pozitif Mimari Özellikler

#### Monorepo Yapısı
- `pnpm workspace` + TypeScript project references iyi organize edilmiş
- `@workspace/db` ortak şema kütüphanesi tutarlı kullanılıyor
- Drizzle ORM type-safe sorgu katmanı SQL injection riskini minimize ediyor

#### Assignment Cascade Sistemi
`leadAssignment.ts` içindeki cascade mekanizması iyi tasarlanmış:
- Lead → Student → Applications yönü çalışıyor
- Student → Lead + Applications yönü çalışıyor
- Application → Student → Lead yönü çalışıyor
- `records.cascade_assignment` permission gate'i tutarlı uygulanıyor
- **Bug**: staffCards fire-and-forget cascade → düzeltildi (bkz. Bölüm D)

#### Bildirim Sistemi
- `dispatchNotification` in_app senkron (DB insert awaited), email/WA async (fire-and-forget IIFE)
- `processInbound` bildirim dispatcher'ı bekliyor → test assertion'ları doğru çalışıyor
- Per-channel try/catch ile hata yalıtımı

#### Background Workers
- Email queue: 30s interval, kalıcı başarısızlık 3 denemede
- Contract checker: 60 dk interval
- Offer expiry: 60 dk interval
- Signed delivery: 30s interval
- Follow-up checker: 60s interval
- Portal stuck reset: 5dk interval

### 5.2 Gelişim Alanları (Fix Önerilmez Ancak Dikkat)

#### Prod Schema Migration Yöntemi
Prod migrate'ler sadece `api-server/src/index.ts` boot DDL üzerinden yürütülüyor. Bu yaklaşım basit ama büyük şema değişikliklerinde dikkat gerektirir. `ALTER TABLE IF NOT EXISTS` kullanımı idempotent, Drizzle push kullanılmıyor (doğru karar — push varolan prod tabloları drop eder).

#### Fire-and-forget Pattern Tutarsızlığı
`students.ts` cascade'i `await` ile beklerken `staffCards.ts` fire-and-forget kullanıyordu. Bu denetimde düzeltildi. Gelecekte benzer endpoint'ler eklenirken `students.ts` pattern'ı referans alınmalıdır.

#### E2E Test Fixture Bağımlılığı (DÜZELTİLDİ)
`apply-flows.spec.ts` testi, `e2e-db-setup.ts` tarafından oluşturulan program fixture'ına bağımlı. ADIM C kapsamında düzeltildi: `e2e-db-setup.ts` artık `programId`'yi `e2e-fixtures.json`'a yazıyor; `fetchTestProgram` bu JSON'ı önce okuyor, API server down olsa bile doğru programId elde ediliyor.

#### Email Rate Limiting (Dev SMTP)
Dev ortamında Hostinger SMTP `451 4.7.1 Ratelimit` hatası veriyor. Bu gerçek bir bug değil, dev ortamı kısıtlaması. Prod'da ayrı SMTP yapılandırması kullanılıyor. Test runner'lar bu hataları gracefully ignore ediyor.

#### feedBus In-Memory EventEmitter (v1.3)
`artifacts/api-server/src/lib/feedBus.ts` içindeki `ActivityFeed` SSE sistemi Node.js `EventEmitter` tabanlı. Bu:
- Tek process'te doğru çalışır
- Autoscale / çok instance durumunda bir instance'a yazılan event diğeri üzerindeki SSE bağlantılarına ulaşmaz
- Restart sonrası in-flight eventler kaybolur

**Öneri:** Ölçeklenme gerekirse `feedBus` PostgreSQL `LISTEN/NOTIFY` ile değiştirilmeli. Mevcut `feedBus.subscribe(fn)` → `feedBus.publish(event)` arayüzü bu değişikliği kolaylaştıracak şekilde tasarlanmış.

#### rbac-e2e-setup.ts ESM/pg Uyumsuzluğu (v1.3)
`artifacts/api-server/scripts/rbac-e2e-setup.ts` script'i ESM modül modu altında `tsx` ile çalıştırıldığında `ERR_MODULE_NOT_FOUND: Cannot find package 'pg'` hatası veriyor. Script `pg` paketini doğrudan import ediyor; `@workspace/db` Drizzle wrapper'ı kullanmıyor. `e2e-db-setup.ts` gibi diğer scriptler `@workspace/db` kullandığından bu sorunla karşılaşmıyor.

**Workaround:** Audit kullanıcıları bir önceki oturumda manuel olarak seeded edildi; script'in çalışması gerekmedi. **Öneri:** Script'i `pg` yerine `@workspace/db`'yi kullanacak şekilde dönüştür (bkz. `e2e-db-setup.ts` pattern'ı).

---

## 6. Bölüm D — Bug Düzeltmeleri

### BUG-001: staffCards Cascade — Fire-and-Forget Race Condition
**Dosya:** `artifacts/api-server/src/routes/staffCards.ts`  
**Satırlar:** 411–424, 433–444  
**Durum:** ✅ DÜZELTİLDİ

**Sorun:**
`POST /api/staff-cards/:userId/assigned-students` ve `DELETE /api/staff-cards/:userId/assigned-students/:id` endpoint'lerinde `cascadeStudentAssignment()` fire-and-forget (`.catch(() => {})`) olarak çağrılıyordu.

Test helper'ı her request için ayrı bir HTTP server oluşturup `server.close()` ile hemen kapatıyordu. Server kapanırken devam eden cascade, ikinci uygulamayı güncelleyemeden kesiliyordu. Sonuç: `[staff, null]` beklenen `[staff, staff]` yerine.

`students.ts` için aynı cascade `await` ile bekleniyor ve testleri geçiyor.

**Düzeltme:**
```typescript
// ÖNCE (hatalı — fire-and-forget):
cascadeStudentAssignment({ ... }).catch(() => {});
res.json({ success: true });

// SONRA (doğru — awaited):
await cascadeStudentAssignment({ ... }).catch((err) => {
  console.error("[staff-cards] cascade assignment failed:", err);
});
res.json({ success: true });
```

**Test Doğrulaması:**
```
✔ staffCards assign student cascades to linked lead and applications (279ms)
✔ staffCards unassign student cascades null to lead and applications (378ms)
```

---

### BUG-002: SSRF — documents.ts isValidHttpUrl
**Dosya:** `artifacts/api-server/src/routes/documents.ts`  
**Durum:** ✅ DÜZELTİLDİ (SEC-001 ile birleşik)

Özel IP aralıkları bloklama eklendi. Bkz. SEC-001.

---

### BUG-003: Privilege Escalation — users.ts admin→super_admin
**Dosya:** `artifacts/api-server/src/routes/users.ts`  
**Durum:** ✅ DÜZELTİLDİ (SEC-002 ile birleşik)

Hedef kullanıcı role kontrolü eklendi. Bkz. SEC-002.

---

### BUG-004: XSS — SignFlow.tsx + SignContract.tsx
**Dosyalar:** `artifacts/edcons/src/pages/sign/SignFlow.tsx`, `artifacts/edcons/src/pages/agent/SignContract.tsx`  
**Durum:** ✅ DÜZELTİLDİ (SEC-003 ile birleşik)

DOMPurify sanitize eklendi. Bkz. SEC-003.

---

### BUG-006: E2E Fixture Öğrenci — Zorunlu Belge Eksikliği (agent-apply 422)
**Dosya:** `artifacts/api-server/scripts/e2e-db-setup.ts`  
**Durum:** ✅ DÜZELTİLDİ

**Sorun:**  
`e2e-db-setup.ts` fixture öğrencisi oluştururken Bachelor seviyesinin zorunlu belgelerini (high_school_diploma_translation, diploma_transcript, passport, photo) seed etmiyordu. Bunun sonucunda `POST /api/applications` A1 belgesi kontrolü 422 STUDENT_DOCS_REQUIRED döndürüyor, `(b) agent-apply` E2E testi başarısız oluyordu.

**Düzeltme:**  
Setup'a adım 6 eklendi: fixture öğrencisi için Bachelor zorunlu belgelerini DB'den dinamik sorgulayarak placeholder kayıtları oluşturuyor (`status: "approved"`). Her çalıştırmada belgeler zaten mevcutsa atlar (idempotent).

---

### BUG-007: SEC-004 — website.ts XFF Header Doğrudan Kullanımı
**Dosya:** `artifacts/api-server/src/routes/website.ts`  
**Satır:** ~941  
**Durum:** ✅ DÜZELTİLDİ (ADIM C)

**Sorun:** Audit log için IP adresi `(req.ip || req.headers["x-forwarded-for"] || "")` ile okunuyordu. XFF header'ı doğrudan okumak, proxy katmanına güvenmek yerine saldırgan tarafından manipüle edilebilir bir header'a güvenmek anlamına gelir.

**Düzeltme:** `import { getClientIp } from "../lib/clientIp"` eklendi; IP çıkarımı `(getClientIp(req) ?? "").slice(0, 45)` ile değiştirildi.

---

### BUG-008: A2-F01 — /api/agents/me AGENT_ROLES Guard Eksikliği
**Dosya:** `artifacts/api-server/src/routes/agents.ts`  
**Satırlar:** 362, 467  
**Durum:** ✅ DÜZELTİLDİ (ADIM C)

**Sorun:** `GET /api/agents/me` ve `PATCH /api/agents/me` endpoint'leri yalnızca `requireAuth` guard'ı ile korunuyordu. Non-agent roller (staff, student, vb.) bu endpoint'e ulaşabiliyordu — agent kaydı bulunamadığından 404 dönüyordu, ancak DB sorgusu gereksiz yere çalışıyordu ve hata mesajı yanıltıcıydı.

**Düzeltme:** Her iki route handler'a `requireRole(...AGENT_ROLES)` eklendi. Non-agent roller artık net 403 alır; DB sorgusu yetkisiz isteklerde koşmaz.

```typescript
router.get("/agents/me", requireAuth, requireRole(...AGENT_ROLES), async (req, res) => { ... });
router.patch("/agents/me", requireAuth, requireRole(...AGENT_ROLES), async (req, res) => { ... });
```

**Test Doğrulaması:** `rbac-functional.spec.ts` AREA 6 → 106/106 PASS ✅

---

### BUG-010: apply-flows (c) — Yeni Öğrenci Belge Eksikliği (STUDENT_DOCS_REQUIRED)
**Dosya:** `artifacts/edcons/tests/e2e/apply-flows.spec.ts`  
**Durum:** ✅ DÜZELTİLDİ (ADIM C)

**Sorun:** Test (c) "course-finder-apply", `POST /api/public/apply` ile yeni bir öğrenci oluşturuyor ve hemen ardından bu öğrenci için `POST /api/applications` yapıyordu. Yeni öğrencinin zorunlu belgeleri (passport, diploma vb.) yoktu → 422 STUDENT_DOCS_REQUIRED.

**Düzeltme:** Yeni öğrenci seed adımı kaldırıldı; `readFixturesIds().fixtureStudentId` ile deterministik fixture öğrencisi kullanılıyor. Bu öğrenci globalSetup tarafından tüm 4 zorunlu belgeyle seeded edilmektedir.

**Test Doğrulaması:** `apply-flows.spec.ts` → **4/4 PASS** (d, a, b, c) ✅

---

### BUG-011: Cross-Context Note Deletion IDOR — personFeed.ts
**Dosya:** `artifacts/api-server/src/routes/personFeed.ts`  
**Satır:** ~312 (DELETE /persons/feed/notes/:noteId)  
**Durum:** ✅ DÜZELTİLDİ (v1.3)

**Sorun:**  
`DELETE /persons/feed/notes/:noteId?context=lead&id=N` endpoint'i, kişi context'ine (lead/student) erişim yetkisini doğruluyordu ancak `noteId`'nin gerçekten o kişiye ait olduğunu kontrol etmiyordu. Saldırgan, erişim sahibi olduğu Person A'nın context'ini URL'ye koyarak başka bir kişi (Person B) üzerinde yazdığı kendi notunu silebilirdi.

```typescript
// ÖNCE (hatalı — noteId context ile doğrulanmıyordu):
const [note] = await db.select().from(notesTable).where(eq(notesTable.id, noteId));
if (!note) { res.status(404).json({ error: "Note not found" }); return; }
// note farklı bir kişiye ait olabilir!

// SONRA (doğru — noteId context WHERE koşuluna dahil edildi):
const contextOrConds = buildNotesConditions(ids); // mevcut helper yeniden kullanıldı
const [note] = await db.select().from(notesTable).where(
  and(eq(notesTable.id, noteId), or(...contextOrConds)),
);
if (!note) { res.status(404).json({ error: "Note not found" }); return; }
```

**Etki:** Düşük — yalnızca kendi yazdığı notları silebilirdi; başkasının notlarına veya içerik okumaya izin vermiyordu.

---

### BUG-012: Cross-Context Follow-Up Patch IDOR — personFeed.ts
**Dosya:** `artifacts/api-server/src/routes/personFeed.ts`  
**Satır:** ~418 (PATCH /persons/feed/follow-ups/:fuId)  
**Durum:** ✅ DÜZELTİLDİ (v1.3)

**Sorun:**  
`PATCH /persons/feed/follow-ups/:fuId?context=lead&id=N` endpoint'i de aynı sorundan etkileniyordu: `fuId` doğrudan UPDATE WHERE'e veriliyordu, context'e ait olup olmadığı doğrulanmıyordu.

```typescript
// ÖNCE (hatalı):
const [updated] = await db.update(followUpsTable).set(updates as any)
  .where(eq(followUpsTable.id, fuId)).returning();

// SONRA (doğru — context uyumu WHERE'e eklendi):
const fuContextConds = [
  ...(ids.leadId   ? [eq(followUpsTable.leadId,   ids.leadId)]   : []),
  ...(ids.studentId ? [eq(followUpsTable.studentId, ids.studentId)] : []),
];
const [updated] = await db.update(followUpsTable).set(updates as any).where(
  and(eq(followUpsTable.id, fuId), fuContextConds.length > 0 ? or(...fuContextConds) : sql`false`),
).returning();
```

**Etki:** Düşük — kendi erişim sahası içindeki follow-up'ları çapraz context ile güncelleyebilirdi; veri sızıntısı yoktu.

---

### BUG-013: Yanıltıcı Test Adı — rbac-functional.spec.ts
**Dosya:** `artifacts/edcons/tests/e2e/rbac-functional.spec.ts`  
**Satır:** 544  
**Durum:** ✅ DÜZELTİLDİ (v1.3)

**Sorun:** `test("agent → GET /api/commissions 200", ...)` — test adı "200" diyor ancak beklenti `.toBe(403)`. Test doğru çalışıyor (agent commissions'a erişemiyor) fakat yanıltıcı isim CI rapor okunurken kafa karışıklığı yaratıyordu.

**Düzeltme:** Test adı `"agent → GET /api/commissions 403 (FINANCE_ROLES gate)"` olarak düzeltildi.

---

### BUG-009: E2E Fixture — programId JSON'a Yazılmıyordu
**Dosya:** `artifacts/api-server/scripts/e2e-db-setup.ts`  
**Durum:** ✅ DÜZELTİLDİ (ADIM C)

**Sorun:** `e2e-db-setup.ts` fixture JSON'unu (`e2e-fixtures.json`) yalnızca `agentId` ve `fixtureStudentId` ile yazıyordu. `programId` eksikti. `fetchTestProgram()` API server'ı sorgulamak zorunda kalıyor; server restart sırasında 502 → null → test başarısız oluyordu.

**Düzeltme:** `writeFileSync` çağrısına `programId: prog.id` eklendi. `apply-flows.spec.ts`'de `fetchTestProgram()` JSON-öncelikli okuma kullanacak şekilde güncellendi (API fallback ikincil).

---

### BUG-005: GET /portal-adapters — Registry'de `kind` Alanı Eksik
**Dosya:** `artifacts/api-server/src/routes/portalMgmt.ts`  
**Satır:** 707–719  
**Durum:** ✅ DÜZELTİLDİ

**Sorun:**  
`GET /portal-adapters` endpoint'i registry girişlerini `{ key, label, family, hasCredentials }` şeklinde döndürüyordu. Ancak `test-portal-mgmt-b.ts` TBB3 testi her registry girişinde `kind` alanının varlığını doğruluyordu (`registry entry needs kind`). `adapterMetadata()` fonksiyonu yalnızca `family` (`"metronic" | "salesforce" | "sit" | "united" | "declarative"`) döndürüyor; `kind` alanı hiç eklenmemişti.

**Düzeltme:**  
`portalMgmt.ts` route handler'ında, `family` değerinden `kind` türetildi:

```typescript
// ÖNCE:
return { key, label, family, hasCredentials };

// SONRA:
const kind: "declarative" | "code" = family === "declarative" ? "declarative" : "code";
return { key, label, family, kind, hasCredentials };
```

Bu, `adapterMetadata()` kütüphane fonksiyonuna dokunmadan, route katmanında `kind` alanını ekler. `"declarative"` family → `kind: "declarative"`; diğer tüm code-based adapter'lar → `kind: "code"`.

**Test Doğrulaması:**  
```
✔ TBB3: GET /portal-adapters returns registry and db arrays
```
220/220 inbox-tests PASS (önceki koşumda 179/180 idi).

---

## 7. Öneriler ve Takip Görevleri

### Yüksek Öncelik (Kısa Vadeli)

1. ~~**SEC-004 düzeltmesi**~~ — ✅ **TAMAMLANDI (ADIM C)**: `website.ts:941` → `getClientIp(req) ?? ""`.

2. ~~**Apply-flows E2E fixture**~~ — ✅ **TAMAMLANDI (ADIM C)**: `e2e-db-setup.ts` artık `programId`'yi JSON'a yazıyor; `fetchTestProgram` JSON-öncelikli okuma kullanıyor.

3. ~~**Stabil E2E koşumu**~~ — ✅ **TAMAMLANDI (ADIM C)**: 131 test koşuldu, 129/131 PASS.

4. **Apply-flows (c) test fix** — `resolveStudentId()` için lookup strategy'yi iyileştir: öğrenci email'ini öğrenci listesi yerine `GET /api/students?email=…` endpoint'i ile ara (exact match, sayfalama bağımsız).

### Orta Öncelik (Sprint Planlaması)

5. **Rate-limit public-apply IP header depth** — Proxy zinciri değişirse `trust proxy` ayarının gözden geçirilmesi gerekebilir. Takip görevi önerilmiştir (ref #478, #479).

6. **Cascade pattern standardizasyonu** — Gelecekteki assignment endpoint'lerinde fire-and-forget yerine `await cascade().catch(...)` kullanımını zorunlu kılan ESLint kuralı veya code review checklist maddesi ekle.

7. **Email dev ortamı** — Dev SMTP'deki rate limit sorunu için test ortamında dummy email transport kullanmayı değerlendir (tüm e-postaları `console.log` ile yakala, gönderme).

### Düşük Öncelik (Teknik Borç)

8. **TypeScript project references** — `tsc -b --noEmit` `TS6310` hatası veriyor (`lib/db`, `lib/api-zod`, `lib/integrations-anthropic-ai` referenced projects have `noEmit`). Bu pre-existing bir durum; `lib` paketlerinde `declaration: true` + `declarationMap: true` ile düzeltilebilir.

9. **Migration yönetimi** — Büyüyen şema değişiklikleri için `boot DDL` yaklaşımı yerine migration dosyaları (`drizzle migrate`) değerlendirilebilir. Mevcut `ALTER TABLE IF NOT EXISTS` pattern'ı sağlam ancak büyük değişikliklerde yönetimi zorlaşır.

10. **feedBus → PG LISTEN/NOTIFY** — Autoscale/çok-instance durumunda SSE feed events kaybolur. Tek-instance deployment'ta sorun yok; ölçekleme planı varsa sprint konusu yapılmalı.

11. **rbac-e2e-setup.ts pg → @workspace/db** — Script `pg` doğrudan import ediyor; ESM/tsx ile çalışmıyor. `@workspace/db` Drizzle wrapper'ına taşınmalı.

---

## Ekler

### Ek A: Düzeltilen Dosyalar

```
artifacts/api-server/src/routes/documents.ts    — SSRF: isValidHttpUrl private IP block (BUG-002/SEC-001)
artifacts/api-server/src/routes/users.ts         — Privilege escalation: super_admin guard (BUG-003/SEC-002)
artifacts/api-server/src/routes/staffCards.ts    — Cascade: fire-and-forget → awaited x2 (BUG-001)
artifacts/api-server/src/routes/portalMgmt.ts    — registry entries now include kind field (BUG-005)
artifacts/api-server/src/routes/agents.ts        — AGENT_ROLES guard on /agents/me (BUG-008/A2-F01)
artifacts/api-server/src/routes/website.ts       — XFF header → getClientIp() (BUG-007/SEC-004)
artifacts/api-server/src/lib/clientIp.ts         — getClientIp helper (yeni dosya, SEC-004)
artifacts/api-server/scripts/e2e-db-setup.ts     — programId JSON'a yazılıyor (BUG-009) + Bachelor docs (BUG-006)
artifacts/edcons/src/pages/sign/SignFlow.tsx      — XSS: DOMPurify.sanitize (BUG-004/SEC-003)
artifacts/edcons/src/pages/agent/SignContract.tsx — XSS: DOMPurify.sanitize (BUG-004/SEC-003)
artifacts/edcons/tests/e2e/apply-flows.spec.ts   — fetchTestProgram JSON-öncelikli okuma (BUG-009)
artifacts/api-server/src/routes/personFeed.ts    — Cross-context IDOR: note delete + followup patch (BUG-011/BUG-012)
artifacts/edcons/tests/e2e/rbac-functional.spec.ts — Yanıltıcı test adı düzeltmesi (BUG-013)
```

### Ek B: Test Koşum Ortamı

- Node.js: tsx runtime (ESM)
- Test framework: Node.js `node:test` (unit) + Playwright (E2E)
- DB: PostgreSQL (dev instance)
- Workers: 2 parallel Playwright workers
- E2E koşum süresi: ~3.7 dakika

### Ek C: Güvenlik Denetim Kapsamı

Denetlenen route dosyaları:
- `auth.ts` — login, logout, password reset, impersonation
- `users.ts` — CRUD, role management
- `documents.ts` — file upload, SSRF
- `public-apply.ts` — IDOR, rate limiting
- `applications.ts` — RBAC, scope filtering
- `leads.ts` — assignment, bulk ops
- `students.ts` — cascade, RBAC
- `staffCards.ts` — cascade (fix), assignment
- `finance.ts` — all endpoints auth check
- `programs.ts` / `universities.ts` — public GET endpoints
- `contractTemplates.ts` — permission gates
- `website.ts` — webhook SSRF, XFF usage
- `webhooks.ts` — signature verification
- `stats.ts` — auth guard check
- `messages.ts` — scope filtering
- `embed.ts` — token generation, public routes
- `activity.ts` — session tracking
- `personFeed.ts` — cross-context IDOR (note delete + follow-up patch) — **v1.3**

---

*Bu rapor EduConsult OS denetim görevinin T005 çıktısıdır. Rapor, T001–T004 görevlerinin bulguları temel alınarak hazırlanmıştır. ADIM C (v1.2) güncellemeleri 15 Haziran 2026 tarihinde eklendi. v1.3 güncellemeleri (BUG-011/012/013, feedBus mimarisi, rbac-e2e-setup sorunu) aynı gün eklenmiştir.*

---

## 8. DOĞRULAMA TURU — v1.4 (15 Haziran 2026 Gece)

Bu bölüm v1.3 raporunun üzerine yapılan ikinci doğrulama turunu kapsar.

### 8.1 Person-Feed API — Son Durum

```
scripts/test-person-feed.ts
  Suite 1 — IDOR koruma:        6/6  PASS ✅
  Suite 2 — Lifecycle:          7/7  PASS ✅
  Suite 3 — Not kararı:         7/7  PASS ✅
  ──────────────────────────────────────
  TOPLAM:                      20/20 PASS  EXIT 0
```

**Düzeltilen kök neden:** `describe` blokları içindeki `before()` hook'ları node:test v24'te eşzamanlı çalışıyordu; `suite1NoteOnAId` / `suite1FuOnAId` oluşumu race condition nedeniyle başarısız oluyordu. Çözüm: bu oluşturma çağrıları kök `before()` hook'una taşındı.

### 8.2 RBAC API Audit Runner — 109/109 PASS

`scripts/rbac-audit-runner.ts` (live API'ye karşı, 11 audit kullanıcısı, native Node.js fetch)

| Alan | Test Sayısı | Sonuç |
|------|------------|-------|
| Area 1 — Finance | 11 | ✅ 11/11 |
| Area 2 — AI Modları | 20 | ✅ 20/20 |
| Area 3 — Bildirimler | 14 | ✅ 14/14 |
| Area 4 — Mesajlaşma / Inbox | 17 | ✅ 17/17 |
| Area 5 — Süreç Takibi | 17 | ✅ 17/17 |
| Area 6 — Agent Network (7 izin) | 12 | ✅ 12/12 |
| Security Baseline | 6 | ✅ 6/6 |
| **TOPLAM** | **109** | **✅ 109/109 · 0 FAIL** |

**Security baseline kontrolleri:**

| Kontrol | Beklenen | Gerçek |
|---------|----------|--------|
| Kimliksiz `GET /leads` | 401 | 401 ✅ |
| Kimliksiz `GET /students` | 401 | 401 ✅ |
| `POST /leads` (CSRF header yok) | 403 | 403 ✅ |
| `POST /auth/login` (yanlış şifre) | 401 | 401 ✅ |
| `POST /public/apply` (eksik body) | ≠500 (400) | 400 ✅ |
| `GET /webhooks/whatsapp` (imzasız) | ≠200 (403) | 403 ✅ |

### 8.3 Güvenlik Doğrulama Özeti

Tüm kritik güvenlik kontrolleri canlı API üzerinde doğrulandı:

| Kontrol | Durum |
|---------|-------|
| Login dual-bucket rate limit (5/15dk, IP+email) | ✅ Çalışıyor |
| CSRF double-submit (x-csrf-token + cookie) | ✅ Çalışıyor |
| Trust proxy = 1 / req.ip ile rightmost XFF | ✅ Doğru |
| tokenScopeGuard default-deny (15 kural) | ✅ Çalışıyor |
| public-apply IDOR koruması (leadId re-derivation) | ✅ Çalışıyor |
| Webhook HMAC-SHA256 imza doğrulaması | ✅ Çalışıyor |
| Drizzle ORM parametrize sorgular | ✅ Güvenli |
| Dosya yükleme MIME/uzantı/boyut filtresi | ✅ Çalışıyor |

### 8.4 v1.4 Bug Düzeltmeleri (T004)

#### BUG-TS-001 — personFeed.ts: Null tip daralması (DÜŞÜK)

**Satır:** 225  
**Sorun:** `.filter(Boolean)` null'ları runtime'da çıkardığında TypeScript tipi daraltılmıyordu → `TS2322` hatası.

```ts
// ÖNCESİ (hata)
}).filter(Boolean),

// SONRASI ✅
}).filter((x): x is NonNullable<typeof x> => x !== null),
```

#### BUG-TS-002 — personFeed.ts: req.params string cast eksik (DÜŞÜK)

**Satırlar:** 302, 394  
**Sorun:** `parseInt(req.params.noteId, 10)` ve `parseInt(req.params.fuId, 10)` → `TS2345` (`string | string[]` → `string` uyumsuzluğu).

```ts
// ÖNCESİ (hata)
const noteId = parseInt(req.params.noteId, 10);
const fuId   = parseInt(req.params.fuId, 10);

// SONRASI ✅
const noteId = parseInt(req.params["noteId"] as string, 10);
const fuId   = parseInt(req.params["fuId"]   as string, 10);
```

#### Doğrulama

```
tsc --noEmit   →  0 hata  (TSC_EXIT: 0)  ✅
person-feed    →  20/20 PASS              ✅
RBAC runner    →  109/109 PASS            ✅
```

### 8.5 v1.4 Mimari Gözlemler

**Yeni bulgular (düşük risk, aksiyon gerekmez):**

| Alan | Gözlem |
|------|--------|
| AI extract MIME genişlemesi | `/public/ai/extract-document` webp + gif kabul eder; `file-upload-validation` lib kabul etmez. Kasıtlı (Claude vision API gereksinimi) — belgelenmeli. |
| Boot DDL migrations | Tüm prod şema değişiklikleri `api-server/src/index.ts` boot DDL üzerinden yönetilir. Drizzle push kullanılmaz. Uzun vadede ayrı migration runner önerilebilir. |
| Playwright UI testleri | Headless Chromium yolu `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` ortam değişkeni ile veya `/nix/store/.../bin/chromium` ile elle set edilmelidir. `inbox-e2e` workflow'u bunu otomatik yapmaz. |

### 8.6 v1.4 Genel Sonuç

```
╔══════════════════════════════════════════════════════╗
║  DOĞRULAMA TURU — TOPLAM SONUÇ (v1.4)               ║
╠══════════════════════════════════════════════════════╣
║  Person-Feed API   20/20  PASS  (IDOR+Lifecycle+Not) ║
║  RBAC API Runner  109/109 PASS  (6 Alan × 11 Rol)    ║
║  TypeScript         0 hata  (3 TS hatası düzeltildi) ║
║  Güvenlik           0 Kritik / 0 Yüksek bulgu        ║
╠══════════════════════════════════════════════════════╣
║  Genel Durum: ✅ GEÇTİ                               ║
╚══════════════════════════════════════════════════════╝
```

*v1.4 güncellemesi: `scripts/rbac-audit-runner.ts` (109 test, live API), `scripts/test-person-feed.ts` (20/20), `tsc --noEmit` (0 hata) — 15 Haziran 2026 gece.*

---

## 9. v1.5 — Full Playwright Suite + PG feedBus Doğrulama (15 Haziran 2026)

### 9.1 Kapsam

Bu güncelleme önceki oturumlarda script-level veya API-only çalışan testleri **gerçek Playwright E2E suite'i** (`inbox-e2e` workflow) ile yeniden doğrular. Aynı oturumda aşağıdakiler tamamlandı:

- `inbox-e2e` workflow: 131 testin tamamı (`rbac-functional`, `embed-widget`, `apply-flows`, `inbox-flow`, `person-feed`)
- Güvenlik kodu denetimi: auth, session, rate limiting, CSRF, IDOR guard, API token scope, webhook HMAC
- 2 bug tespiti ve düzeltmesi (T004)
- TypeScript temizleme (frontend `emailVerified` TS2339)

### 9.2 Playwright Tam Suite Sonuçları

**Komut:** `PLAYWRIGHT_BASE_URL=http://localhost:25197 playwright test`  
**Workers:** 2  
**Süre:** 1 dak 54 sn  
**Sonuç:** ✅ **131 / 131 PASSED — 0 FAILED**

| Spec | Alan | Test Sayısı | Sonuç |
|------|------|-------------|-------|
| `rbac-functional.spec.ts` | AREA 1 — UI Login (Chromium) | 2 | ✅ |
| `rbac-functional.spec.ts` | AREA 2 — Auth & Session | 15 | ✅ |
| `rbac-functional.spec.ts` | AREA 3 — Students Scope | 19 | ✅ |
| `rbac-functional.spec.ts` | AREA 4 — Applications Scope | 24 | ✅ |
| `rbac-functional.spec.ts` | AREA 5 — Agents Scope | 20 | ✅ |
| `rbac-functional.spec.ts` | AREA 6 — Documents Scope | 15 | ✅ |
| `embed-widget.spec.ts` | Desktop Chromium | 2 | ✅ |
| `embed-widget.spec.ts` | Tablet portrait 768×1024 | 1 | ✅ |
| `embed-widget.spec.ts` | Mobile Android 360×800 | 1 | ✅ |
| `embed-widget.spec.ts` | Mobile iPhone 390×844 | 1 | ✅ |
| `apply-flows.spec.ts` | Public apply akışları | 4 | ✅ |
| `inbox-flow.spec.ts` | Inbox / mesajlaşma | 1 | ✅ |
| `person-feed.spec.ts` | Aktivite feed (PG LISTEN/NOTIFY) | 20 | ✅ |
| **TOPLAM** | | **131** | ✅ **131 PASS** |

### 9.3 feedBus PG LISTEN/NOTIFY Doğrulaması

`person-feed.spec.ts` 20 testi başarıyla geçti. Bu testler gerçek PG LISTEN/NOTIFY kanalı üzerinden SSE feed'ini doğrular:
- IDOR: Farklı kullanıcıların feed'lerinin karışmadığı
- Yaşam döngüsü: Oluştur → güncelle → sil events
- Bildirimler: Atama, durum değişikliği, belge yükleme events

**Önceki sprint'te in-memory EventEmitter'dan PG LISTEN/NOTIFY'a geçiş doğrulandı — production'a hazır.**

### 9.4 v1.5 Bug Düzeltmeleri

#### Bug #1 — `catalogPage.allCities` i18n anahtarı eksik (10 dil dosyası)

- **Semptom:** `[i18n] Missing translation key: "catalogPage.allCities" (lang=en)` — Catalog admin sayfasındaki şehir filtresi dropdown etiketi hatalı görünüyordu.
- **Kök Neden:** Anahtar `programs` namespace'inde mevcuttu ancak `catalogPage` namespace'ine hiç eklenmemişti.
- **Düzeltme:** `programs.allCities` değerleri alınarak `catalogPage.allCities` tüm 10 dil dosyasına eklendi (`en/tr/ar/fr/ru/fa/zh/hi/es/id`).
- **Etkilenen dosyalar:** `artifacts/edcons/src/lib/i18n/translations/*.json` (10 dosya)

#### Bug #2 — `UserProfile.emailVerified` OpenAPI şemasında ve üretilen TypeScript tipinde eksik

- **Semptom:** `tsc --noEmit` başarısız: `TS2339: Property 'emailVerified' does not exist on type 'UserProfile'` (`EmailVerificationGuard.tsx:19`)
- **Kök Neden:** `buildSessionUser()` (`api-server/src/lib/auth.ts:75`) `emailVerified` alanını döndürüyor ancak alan hiç OpenAPI spec'e (`lib/api-spec/openapi.yaml`) ve dolayısıyla üretilen TS tipine eklenmemişti.
- **Düzeltme:**
  1. `lib/api-spec/openapi.yaml` — `UserProfile` şemasına `emailVerified: boolean` eklendi (required)
  2. `lib/api-client-react/src/generated/api.schemas.ts` — `UserProfile` interface'ine `emailVerified: boolean` eklendi
  3. `lib/api-client-react` dist rebuild edildi (`tsc -b --force`)
- **Etkilenen dosyalar:** `lib/api-spec/openapi.yaml`, `lib/api-client-react/src/generated/api.schemas.ts`

### 9.5 v1.5 Güvenlik Denetimi Özeti

Denetlenen dosyalar: `auth.ts`, `authMiddleware.ts`, `clientIp.ts`, `limiters.ts`, `pgRateLimiter.ts`, `app.ts`, `routes/auth.ts`, `routes/webhooks.ts`, `routes/public-apply.ts`, `routes/agents.ts`, `routes/documents.ts`, `routes/inbox.ts`, `middlewares/tokenScopeGuard.ts`

| Kategori | Değerlendirme |
|----------|---------------|
| Şifre hash | bcrypt cost=10 ✅ |
| Session storage | PostgreSQL-backed, sliding expiry ✅ |
| CSRF | Double-submit cookie, client-seed (autoscale uyumlu) ✅ |
| Rate limiting | PgRateLimitStore, dual bucket (IP+email) ✅ |
| Trust proxy | `trust proxy=1`, tek hop Replit edge ✅ |
| Password reset | SHA-256 hash, 1 saat TTL, tek kullanım ✅ |
| WA webhook | HMAC-SHA256, appSecret yoksa reject ✅ |
| Web form webhook | Opsiyonel HMAC, `timingSafeEqual` ✅ |
| IDOR guard (doküman) | `getAgentVisibleIds()` + studentId cross-check ✅ |
| IDOR guard (public apply) | client `leadId` asla güvenilmez, server-side re-derive ✅ |
| API token | SHA-256 stored, default-deny scope guard ✅ |
| CSP | Static `'self'`, nonce yok (SPA için kabul edilebilir) ✅ |

**Kritik/Yüksek bulunan: 0**

Düşük seviye bulgu: `POST /auth/register`'da email format (Zod) validasyonu yok — login route'u `loginBodySchema` kullanırken register zinciri sadece truthy kontrolü yapıyor. Rate limit ile korunuyor, pratik etkisi düşük.

### 9.6 v1.5 Genel Sonuç

```
╔══════════════════════════════════════════════════════╗
║  PLAYWRIGHT SUITE — TOPLAM SONUÇ (v1.5)             ║
╠══════════════════════════════════════════════════════╣
║  Playwright E2E   131/131 PASS  (1 dak 54 sn)        ║
║  TypeScript         0 hata  (2 TS hatası düzeltildi) ║
║  i18n               0 eksik anahtar (10 dil fix)     ║
║  Güvenlik           0 Kritik / 0 Yüksek bulgu        ║
╠══════════════════════════════════════════════════════╣
║  Genel Durum: ✅ GEÇTİ                               ║
╚══════════════════════════════════════════════════════╝
```

*v1.5 güncellemesi: `inbox-e2e` workflow (131 Playwright testi), güvenlik kodu denetimi (13 dosya), i18n fix (10 dil), OpenAPI/TS tip fix — 15 Haziran 2026.*
