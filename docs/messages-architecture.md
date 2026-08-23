# Messages Modülü — Mimari ve Çalışma Mantığı

> EduConsult OS (`artifacts/edcons`) içindeki Messages bölümünün uçtan uca dokümantasyonu.
> Bu doküman başka bir AI ile tartışıp geliştirme yapmak için referans olarak hazırlanmıştır.

---

## 1. Genel Konsept

Messages, **omnichannel inbox** (çok kanallı gelen kutusu) yapısıdır. Farklı kanallardan (WhatsApp, web form, e-posta, SMS, Telegram) gelen mesajlar tek bir arayüzde toplanır; ek olarak personel arası **internal** mesajlaşma, **broadcast** (toplu bildirim) ve **template** (şablon) yönetimi de aynı sayfada sekme olarak sunulur.

**Sayfa:** `artifacts/edcons/src/pages/staff/Messages.tsx`

---

## 2. Sekme Yapısı

Üst tarafta 4 ana sekme var:

| Sekme | Amaç |
|---|---|
| **Inbox** | Dışarıdan gelen tüm konuşmalar (omnichannel) |
| **Internal** | Personel/admin arası iç mesajlaşma |
| **Broadcast** | Birden çok kişiye/role toplu mesaj/bildirim |
| **Templates** | WhatsApp/email/SMS için onaylı şablon kataloğu |

### Inbox sekmesi içindeki alt filtreler

İki katmanlı filtre var:

**Kapsam (tab):**
- `Mine` — kullanıcıya atanmış konuşmalar
- `Unassigned` — kimseye atanmamış
- `Unmatched` — sistemde lead/student kaydıyla eşleşmemiş (yabancı kişiden gelen)
- `All` — tümü (yetki dahilinde)

**Kanal:**
- `all`, `whatsapp`, `web_form`, `email`, `sms`, `telegram`

İki filtre birleştirilip `GET /api/inbox/conversations?tab={tab}&channel={channel}` endpoint'ine gönderiliyor.

**Live indicator:** Sağ üstte yeşil/turuncu/kırmızı nokta. SSE bağlantısının canlılığını gösteriyor (`open`, `connecting`, `stale` — 60s heartbeat yoksa, `offline`).

---

## 3. Konuşma (Conversation) Anatomisi

İki panelli klasik inbox UX:

- **Sol panel:** filtre + konuşma listesi; her satırda kişi adı, son mesaj özeti, kanal rozeti, "unmatched" rozeti (gerekirse).
- **Sağ panel:** seçili konuşma için tüm mesaj geçmişi (thread), üstte kişi/kanal başlığı, altta mesaj yazma kutusu.
- **Aksiyonlar:** "Assign to me" (kendine ata), "Match" (lead/student'e bağla), "Create new lead" (eşleşme yoksa yeni lead aç), template seçimi, dosya eki.

---

## 4. Backend — Route'lar

`artifacts/api-server/src/routes/inbox.ts` ve ilgili helper'lar:

| Endpoint | İş |
|---|---|
| `GET /api/inbox/conversations` | Filtreli liste |
| `GET /api/inbox/conversations/:id` | Tek konuşma + mesajlar |
| `POST /api/inbox/conversations/:id/messages` | Giden mesaj |
| `POST /api/inbox/conversations/:id/assign` | Atama |
| `POST /api/inbox/conversations/:id/match` | Manuel eşleştirme (lead/student bağlama) |
| `GET /api/inbox/events` | **SSE stream** (realtime) |
| `POST /api/webhooks/whatsapp` | Meta'dan gelen mesaj |
| `POST /api/webhooks/web-form` | Form gönderimleri |
| (kanal başına ek webhook'lar) | SMS/Telegram |

---

## 5. Veri Modeli (Database)

Temel tablolar:

- **`conversations`** — `channel`, `channel_account_id`, `external_contact_id`, `assigned_to_id`, `unmatched` (boolean), `status`, `last_message_at`.
- **`messages`** — `conversation_id`, `direction` (inbound/outbound/internal), `content`, `sender_id`, `external_message_id`, `status` (sent/received/failed), eklerle birlikte.
- **`external_contacts`** — dış platformlardaki kişi (telefon, e-posta, external_id) ve sistemdeki `lead_id` / `student_id` bağı. Eşleştirmenin kalbi burası.
- **`channel_accounts`** — entegrasyon hesapları (örn. hangi WhatsApp Business numarası, hangi e-posta adresi).
- **`conversation_participants`** — internal mesajlaşmada birden çok katılımcıyı tutar.
- **`message_templates`** — şablon kataloğu; `external_template_name` (Meta tarafındaki ad), `variables` (jsonb placeholder tanımları).
- **`broadcasts`** — toplu mesaj kayıtları; hedef kitle (`targetAudience`, `targetRoles`) ve sonuçta `notifications` tablosuna fan-out.

---

## 6. Inbound Mesaj Akışı

`lib/inbox/processInbound.ts` içindeki `processInboundMessage` fonksiyonu:

1. Webhook gövdesi doğrulanır (`x-hub-signature-256` — WhatsApp, `X-Webform-Signature` — web form, HMAC-SHA256).
2. `external_contacts` upsert edilir (telefon/e-posta/external_id ile).
3. `resolveIdentity` ile sistemdeki lead/student aday(lar)ı aranır.
   - Eşleşme varsa `conversation` o lead/student'e bağlanır, `unmatched=false`.
   - Eşleşme yoksa `unmatched=true` — Unmatched sekmesine düşer.
4. İlgili `conversation` bulunur veya açılır (`channel + external_contact_id` kombinasyonu ile).
5. `messages` tablosuna inbound kayıt eklenir.
6. `inboxBus` (Node EventEmitter) üzerinden `inbox_message` event'i yayılır → SSE üzerinden bağlı tüm staff browser'larına push.
7. Atanan kullanıcı varsa `dispatchNotification` ile bildirim üretilir.

---

## 7. Outbound (Giden) Akış

- Staff sağ paneldeki "Send" butonuna bastığında `POST /api/inbox/conversations/:id/messages` çağrılır.
- Kanal adapter'ı seçilir (`lib/inbox/channels/{whatsapp|email|sms|telegram|webForm}.ts`).
- Adapter ilgili dış API'ye (Meta Cloud, Twilio, SMTP vb.) çağrı yapar.
- Dönüşte `external_message_id` ve `status` `messages` tablosuna yazılır.
- SSE üzerinden konuşma listesi/detay tazelenir.

### Kanal-spesifik kurallar

| Kanal | Özel kural |
|---|---|
| **WhatsApp** | Meta Cloud API. **24 saatlik "service window"** kuralı: son inbound üzerinden 24 saat geçtiyse serbest mesaj reddedilir, **onaylı template** (`sendWhatsAppTemplate`) zorunlu. |
| **Email** | Hostinger SMTP (`lib/email.ts`). Şu an 429 rate-limit nedeniyle test workflow'ları FAIL durumda. |
| **Web Form** | İki yönlü değil; gelen form bir conversation açar, staff cevabı **email** kanalıyla gider. Form `agent_ref` taşıyorsa lead otomatik o agent'a atanır. |
| **SMS** | Twilio benzeri sağlayıcı (adapter pattern). |
| **Telegram** | Bot API webhook. |

---

## 8. Internal Sekmesi

- Ayrı tablo yok; `conversations.channel = 'internal'` ile aynı modeli kullanır.
- `conversation_participants` ile birden çok personel eklenebilir (1:1 veya grup).
- WhatsApp template / 24h penceresi gibi kısıtlar geçerli değil; doğrudan kayıt + SSE push.

---

## 9. Broadcast Sekmesi

- Staff bir mesaj hazırlar, hedef seçer: `all`, belirli `role` (örn. tüm agent'lar), belirli kullanıcı listesi.
- Backend `broadcasts` kaydı açar + hedef kullanıcılar için `notifications` tablosuna toplu insert eder.
- Kanal seçimine göre paralel olarak email/WhatsApp template fan-out yapılabilir (mimari hazır, kullanımı sınırlı olabilir).
- Sonuç: kullanıcının üst-bar zil ikonunda unread sayacı artar.

---

## 10. Templates Sekmesi

- `message_templates` tablosundan CRUD.
- Her şablonun bir adı, içeriği, kanalı, `external_template_name` (Meta'daki onaylı ad) ve `variables` listesi (`{{1}}`, `{{2}}` gibi) vardır.
- Inbox tarafında "Send template" akışında dropdown'a düşer; placeholder'lar form ile doldurulup gönderilir.
- WhatsApp tarafında 24h penceresi kapandığında **tek geçerli gönderim yolu**dur.

---

## 11. Realtime — SSE

- WebSocket değil, **Server-Sent Events** tercih edilmiş (`GET /api/inbox/events`).
- Server-side: `inboxBus` EventEmitter yayımcı, her bağlı browser bir consumer.
- Eventler: `inbox_message`, `inbox_assigned`, `inbox_match`, `heartbeat` (25s).
- Client: event geldiğinde sayfa state'i ile `fetchInbox()` / `fetchDetail()` tetiklenir (React Query yerine doğrudan `useState` + `useEffect` paterni).
- 60s boyunca heartbeat yoksa indicator `stale` rengine geçer; bağlantı kopmuşsa otomatik yeniden bağlanma var.

---

## 12. Bildirimler (Bell Icon)

- `notifications` tablosuna inbox eventleri yazılır.
- `GET /api/notifications/unread-count` ve `/section-counts` ile sayaç çekilir.
- `liveResourceFilter` SQL fragment'ı silinmiş lead/student'lere ait bildirimleri sayım dışı bırakır.
- Sol menüde Leads/Students/Applications yanında küçük yıldız rozeti aynı sayaçlardan beslenir.

---

## 13. Yetkilendirme

- Inbox'ı **admin** ve **staff** rolleri görür.
- `getVisibleUserIdsForStaff` helper'ı bir staff'ın sadece **kendine atanmış** lead/student'lerin konuşmalarına erişmesini sağlar (görünürlük scope'u).
- **Agent**'lar kendi mini dashboard'larında sadece kendilerine atanmış sohbetleri görür.
- **Unmatched** sekmesi tipik olarak admin/staff için açık — yeni gelen tanımsız kişiyi lead'e bağlama görevi orada.

---

## 14. Eşleştirme (Matching) Mantığı

`resolveIdentity`:

- Telefon/e-posta normalize edilir (E.164, lowercase).
- `external_contacts` → mevcut bağ
- Yoksa `leads` ve `students` tablolarında aynı telefon/e-posta arar.
- Tek aday → otomatik bağla.
- Birden çok aday → `unmatched=true` bırakılır, UI'da "Suggestions" listesi gösterilir, staff manuel seçer.
- Hiç aday yoksa "Create new lead" butonu çıkar; tıklandığında otomatik lead açıp bağlar.

---

## 15. e2e Test Kapsamı

`artifacts/edcons/tests/e2e/inbox-flow.spec.ts`:

1. Web form webhook'u atar.
2. Staff olarak login olur.
3. Mesajın **Unmatched** sekmesinde göründüğünü doğrular.
4. "Assign to me" yapar.
5. Mesajın **Mine** sekmesine geçtiğini doğrular.

> Not: `inbox-e2e` ve `inbox-tests` workflow'ları şu an Hostinger SMTP 429 rate-limit nedeniyle FAIL — kod hatası değil, dış servis limiti.

---

## 16. Eksik / Gelişime Açık Noktalar (Tartışma için)

Başka bir AI ile geliştirme tartışırken bu başlıkları gündeme almak faydalı olur:

1. **State yönetimi:** Sayfa React Query yerine ham `useState`/`useEffect` kullanıyor — büyüdükçe cache/invalidation karmaşıklaşıyor.
2. **Search:** Konuşma içinde tam metin arama yok.
3. **Bulk actions:** Çoklu seçim + toplu atama/kapatma yok.
4. **Saved replies / quick snippets:** Template'ten ayrı kişisel kısayollar yok.
5. **SLA & response-time metrikleri:** İlk cevap süresi, conversation süresi vb. raporlama yok.
6. **Notlar / etiketler:** Konuşma içi private not veya tag sistemi yok.
7. **Okundu işaretleri:** Inbound mesajların read/unread durumu basit, granüler değil.
8. **Çoklu cihaz senkronu:** Birden çok staff aynı konuşmayı açtığında "X yazıyor…" tarzı presence yok.
9. **Dosya/medya önizleme:** Resim/PDF inline preview sınırlı.
10. **Webhook retry / DLQ:** Inbound webhook hata yönetimi şeffaf değil.
11. **WhatsApp template senkronu:** Meta'daki onay durumu otomatik çekilmiyor, manuel `external_template_name` girilmesi gerekiyor.
12. **Internal mesajlaşma UX'i:** Modern messenger benzeri grup yönetimi, mention (`@`), reaction yok.
13. **Audit trail:** Atama değişiklikleri, eşleştirme geçmişi için ayrı bir görüntüleme yok.

---

## 17. Önemli Dosya Yolları (Hızlı Referans)

**Frontend:**
- `artifacts/edcons/src/pages/staff/Messages.tsx` — ana sayfa
- `artifacts/edcons/src/components/LiveStatusIndicator.tsx` — SSE durum rozeti

**Backend:**
- `artifacts/api-server/src/routes/inbox.ts` — REST + SSE route'ları
- `artifacts/api-server/src/routes/webhooks.ts` — kanal webhook'ları
- `artifacts/api-server/src/lib/inbox/processInbound.ts` — gelen mesaj boru hattı
- `artifacts/api-server/src/lib/inbox/resolveIdentity.ts` — eşleştirme
- `artifacts/api-server/src/lib/inbox/channels/` — kanal adapter'ları (whatsapp, email, sms, telegram, webForm)
- `artifacts/api-server/src/lib/inbox/inboxBus.ts` — SSE event emitter
- `artifacts/api-server/src/lib/email.ts` — SMTP gönderim

**Test:**
- `artifacts/edcons/tests/e2e/inbox-flow.spec.ts` — Playwright e2e
- `artifacts/api-server/test/inbox/` — backend unit/integration

---

*Hazırlanma tarihi: 2026-05-22*
