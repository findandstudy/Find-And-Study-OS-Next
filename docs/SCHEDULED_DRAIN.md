# Portal Automation — Scheduled Drain

## Neden gerekli?

Replit Autoscale ortamında gelen HTTP istekleri timeout'a uğrayabilir. Portal
kuyruğundaki görevler (`status = 'queued'`) gerçek bir üniversite portalına
bağlanmayı gerektirir; bu işlem 1-3 dakika sürebilir ve inline HTTP isteği
üzerinde çalıştırıldığında Autoscale request timeout'una takılarak satırı
`running`'de öksüz bırakır.

**Gerçek çözüm:** `drain-once.ts` ayrı bir Scheduled Deployment olarak her
2-3 dakikada bir çalıştırılır. Bu deployment'ın **kendi request limiti yoktur**
ve kuyruğu sonuna kadar işler.

---

## Stuck-Reset Mekanizması

Inline bir istek çökmüş veya timeout'a uğramış olsa bile satır sonunda
kurtarılır:

| Katman | Açıklama |
|---|---|
| **Inline timeout (50s)** | `/process` endpoint'i 50sn aşarsa `requeueStuck()` çağırır → satır `queued`'e döner |
| **Heartbeat (inline)** | `/process` endpoint'i 20s'de bir `locked_at = NOW()` günceller |
| **Heartbeat (drain-once)** | `drain-once` 30s'de bir `locked_at = NOW()` günceller → stuck-reset yanlış tetiklenmez |
| **Periyodik otomatik reset** | API server her 5 dakikada bir 10dk+ `running` kalan satırları sıfırlar |
| **Manuel Reset** | Admin paneli → Submissions → "Reset Stuck" butonu → `POST /api/portal-submissions/reset-stuck` |
| **drain-once başlangıcı** | Her çalışmada `releaseStale(5dk)` ile önceki çökmeleri temizler |

Heartbeat, `locked_by` guard ile çalışır: yalnızca aynı `workerId` sahibi olan
worker `locked_at`'i güncelleyebilir ya da sıfırlayabilir. Bu sayede birden
fazla instance veya drain-once birbirine karışmaz.

---

## Otomatik Drain Kurulumu (Önerilen: Scheduled Deployment)

### Adımlar

1. **Replit → Deploy → New Deployment** seçin
2. Deployment türü: **Scheduled**
3. Run command:
   ```
   pnpm --filter @workspace/api-server drain
   ```
   (`artifacts/api-server/package.json` → `"drain": "tsx scripts/drain-once.ts"`)
4. Schedule (cron): **Her 2-3 dakikada bir** çalıştırın:
   ```
   */2 * * * *
   ```
   veya
   ```
   */3 * * * *
   ```
5. Gerekli ortam değişkenlerini ekleyin:
   ```
   DATABASE_URL=<prod-db-url>
   ENCRYPTION_KEY=<same-as-api-server>
   NODE_ENV=production
   ```
6. Deploy edin.

> **Not:** drain-once idempotent ve concurrency-safe'dir (`FOR UPDATE SKIP
> LOCKED`). Birden fazla örnek aynı anda çalışsa da her submission sadece bir
> kez işlenir.

---

## drain-once Çalışma Akışı

```
drain-once başlar
  ├── releaseStale(5dk)  → önceki çökmelerden kalan running satırları temizle
  └── LOOP:
        ├── claimNext(FOR UPDATE SKIP LOCKED)  → atomik sahiplenme
        ├── heartbeat interval başlat (30s'de bir locked_at güncelle)
        ├── buildStudentProfile + resolvePortalCreds + runSubmission
        ├── writebackResult(workerId guard)
        ├── heartbeat interval temizle
        └── 2s cooldown (GC için)
      → queue boşalınca çık
```

---

## Manuel Tetikleme Seçenekleri

### Seçenek 1: Admin paneli (anlık test için)
Admin paneli → Portal Automation → Submissions → **"Process All Queued"**

> ⚠️ Bu endpoint inline çalışır (50sn timeout vardır). Uzun süren işlemler
> `requeued` döner. Üretim ortamında Scheduled Deployment kullanın.

### Seçenek 2: Reset Stuck butonu
Submission Board'da `running` kayıt varsa **"Reset Stuck"** / **"Takılıları Sıfırla"**
butonu görünür. 10 dakikadan uzun süre `running`'de kalan satırları `queued`'e
geri alır.

### Seçenek 3: Harici cron + API token
```bash
curl -X POST https://<domain>/api/portal-submissions/process-queued \
  -H "Authorization: Bearer fas_live_<token>" \
  -H "Content-Type: application/json"
```
API token `scope: portal` ile oluşturulmuş olmalıdır.

### Seçenek 4: drain-once.ts scripti (tek seferlik)
```bash
DATABASE_URL=... ENCRYPTION_KEY=... NODE_ENV=production \
pnpm --filter @workspace/api-server drain
```

---

## Credential Kurulumu (PROD)

Admin paneli → Portal Automation → **Portal Credentials** sekmesinden
Topkapi bilgilerini ekleyin. DB'de `portal_key = 'topkapi'` ile kayıt oluşur.

---

## Özet: Hangi Durumda Ne Yapmalı?

| Durum | Çözüm |
|---|---|
| Submission `running`'de takılı kaldı | "Reset Stuck" butonu |
| Queue'da kayıt var ama işlenmiyor | Scheduled Deployment kur (yukarıda) |
| Dropdown boş | Credentials sekmesinden Topkapi creds gir |
| Process butonu "failed" dönüyor | Portal Credentials sekmesini kontrol et |
| Process butonu "requeued" dönüyor | Normal — drain-once 2-3 dk içinde tamamlar |
