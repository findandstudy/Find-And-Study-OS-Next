# Portal Automation Worker — Runbook

> **Son güncelleme:** Faz 3C  
> **Kapsam:** Portal Automation Worker'ın lokal DRY testi ve real submit protokolü.

---

## İçindekiler

1. [Ön Koşullar](#1-ön-koşullar)
2. [Dry Job Kuyruğa Alma](#2-dry-job-kuyruğa-alma)
3. [run-once ile DRY Testi Çalıştırma](#3-run-once-ile-dry-testi-çalıştırma)
4. [Doğrulama Checklist](#4-doğrulama-checklist)
5. [Edge Case Testleri](#5-edge-case-testleri)
6. [Hata Durumları](#6-hata-durumları)
7. [Real Submit Onay Kapısı](#7-real-submit-onay-kapısı)
8. [Mimari Notlar](#8-mimari-notlar)

---

## 1. Ön Koşullar

### 1.1 Portal Credentials

Topkapı credentials `portal_credentials` tablosunda şifreli hazır olmalı:

```sql
-- Var mı kontrol et (değerleri gösterme):
SELECT portal_key, is_active,
  (username_enc IS NOT NULL AND username_enc != '') AS has_user,
  (password_enc IS NOT NULL AND password_enc != '') AS has_pass
FROM portal_credentials
WHERE portal_key = 'topkapi' AND deleted_at IS NULL;
```

Alternatif: `.env`'de `TOPKAPI_EMAIL` + `TOPKAPI_PASSWORD` env değişkenleri.  
credResolver DB → env sırasıyla kontrol eder.

### 1.2 Test Application

Belgeleri tam olan (photo, passport, transcript/diploma), Topkapı programı seçili bir application hazır olmalı. `id`'sini not al.

```sql
-- Topkapı uygulamaları ve belge durumu:
SELECT a.id AS app_id, a.stage, a.university_name, a.level,
  array_agg(DISTINCT d.type) AS doc_types,
  COUNT(DISTINCT d.id) AS doc_count
FROM applications a
LEFT JOIN documents d ON d.application_id = a.id AND d.deleted_at IS NULL
WHERE a.university_name ILIKE '%topkap%' AND a.deleted_at IS NULL
GROUP BY a.id, a.stage, a.university_name, a.level
ORDER BY doc_count DESC, a.id DESC
LIMIT 10;
```

### 1.3 Object Storage

`PRIVATE_OBJECT_DIR` env var set olmalı (screenshot upload için). api-server ile aynı değer.

```bash
printenv PRIVATE_OBJECT_DIR | sed 's/=.*/=<REDACTED>/'
```

### 1.4 Chromium

```bash
pnpm --filter @workspace/portal-automation-worker exec playwright install chromium
```

Nix kütüphane hatası gelirse (`libgobject`, `libdbus` vb.) → [Hata Durumları §6.1](#61-chromium-sistem-kütüphanesi-eksik) bölümüne bak.

### 1.5 ENCRYPTION_KEY

DB credentials çözümlemek için `ENCRYPTION_KEY` (veya `SESSION_SECRET`) env var set olmalı.

---

## 2. Dry Job Kuyruğa Alma

### Yol A: API ile (tercih edilir)

```bash
curl -X POST http://localhost:PORT/applications/<appId>/portal-submissions \
  -H "Content-Type: application/json" \
  -H "Cookie: <oturum çerezi>" \
  -d '{"universityKey":"topkapi","mode":"dry"}'
```

Dry mode'da `confirm` gerekmiyor.

### Yol B: seed-dry-job.ts scripti

```bash
# applicationId = 2025, universityKey = topkapi
tsx artifacts/portal-automation-worker/scripts/seed-dry-job.ts 2025 topkapi
```

Çıktı örneği:
```
[seed-dry-job] Application #2025
  university : Istanbul Topkapi University
  level      : Bachelor
  stage      : offer_received
[seed-dry-job] Created portal_submission:
  id            : 99
  status        : queued
  mode          : dry
  universityKey : topkapi
[seed-dry-job] Run next:
  pnpm --filter @workspace/portal-automation-worker run-once -- --id 99 --dry
```

---

## 3. run-once ile DRY Testi Çalıştırma

```bash
# Sıradan ilk işi işle (--dry: DB mode ne olursa dry'a zorla)
pnpm --filter @workspace/portal-automation-worker run-once -- --next --dry

# Ya da belirli bir submission ID ile:
pnpm --filter @workspace/portal-automation-worker run-once -- --id <subId> --dry
```

### Beklenen log akışı

```
[run-once] Claiming next queued submission …
[run-once] Claimed #99 app=2025 uni=topkapi mode=dry attempt=1/3
[run-once] Profile built — email=<REDACTED> program="<program name>"
[topkapi] login — navigating to panel
[topkapi] login successful — URL: https://apply.topkapi.edu.tr/panel
[topkapi] submit — program: ... level: Bachelor doSubmit: false
[topkapi] Step 1: email + passport
[topkapi] Step 2: personal info
[topkapi] Step 3: education background
[topkapi] Step 4: program selection (AJAX)
[topkapi] Step 5: document uploads
[topkapi] doSubmit=false — stopping before final submit (dry run)   ← KRİTİK
[run-once] Run complete:
  submitted     : false
  alreadyExists : false
  programMissing: false
  screenshots   : 6              ← ~7 adet
  meta          : { adapterKey: 'topkapi', dryRun: true }
[run-once] Writeback complete — submission #99 done
[run-once] Final status: dry_run
```

---

## 4. Doğrulama Checklist

Her maddeyi DB sorgusu veya log ile kanıtla.

### ✅ 4.1 run-once temiz çıkış

```
[run-once] Final status: dry_run
```

Exit code 0.

### ✅ 4.2 portal_submissions.status = 'dry_run'

```sql
SELECT id, status, mode, attempts, locked_at, locked_by,
  result_json, screenshot_urls
FROM portal_submissions
WHERE id = <subId>;
```

- `status = 'dry_run'`
- `locked_at IS NULL`, `locked_by IS NULL`
- `attempts = 1`

### ✅ 4.3 resultJson içeriği

```json
{
  "adapterKey": "topkapi",
  "dryRun": true,
  "result": {
    "submitted": false,
    "alreadyExists": false,
    "programMissing": false,
    "screenshots": []
  }
}
```

`submitted: false` olmalı. Credential değerleri YOK.

### ✅ 4.4 application-save.php çağrılmadı

Log'da: `[topkapi] doSubmit=false — stopping before final submit (dry run)`  
Network'te `application-save.php` isteği YOK.

### ✅ 4.5 screenshotUrls — kalıcı /objects/... referansları

```sql
SELECT screenshot_urls FROM portal_submissions WHERE id = <subId>;
```

- `/tmp/` ile başlayan yol yok
- `/objects/portal-submissions/<subId>/...` formatında 5–7 kayıt
- GCS'te dosyalar var

### ✅ 4.6 Pipeline stage değişmedi

```sql
SELECT stage FROM applications WHERE id = <appId>;
```

Stage, job öncesiyle aynı olmalı (`submitted=false` → writeback stage'e dokunmaz).

### ✅ 4.7 /tmp temizlendi

```bash
ls /tmp/portal-shot-na-*.png 2>/dev/null | wc -l
# Sonuç: 0
```

### ✅ 4.8 Credential/cookie sızıntısı yok

```bash
# Log dosyasını tara (run-once çıktısı kaydedilmişse):
grep -iE "password|cookie|PHPSESSID|token" <run-once-output.log>
# Sonuç: boş
```

---

## 5. Edge Case Testleri

Her edge case için ayrı dry job + run-once.

### EC-1: Belge eksik application

1. Belgesi olmayan bir application seç (veya yeni bir tane oluştur).
2. `tsx scripts/seed-dry-job.ts <appId> topkapi`
3. `pnpm ... run-once -- --next --dry`

Beklenen:  
- `resultJson.missingDocuments` dolu: `["passport", "transcript"]` vb.
- `submitted: false`, pipeline stage değişmedi.

### EC-2: Zaten Topkapı'ya kayıtlı öğrenci

1. Topkapı'da kaydı olan bir öğrencinin applicationını seç.
2. Dry job ekle + run-once çalıştır.

Beklenen:  
- `resultJson.result.alreadyExists: true`
- `status = 'dry_run'` (dry olduğu için stage yine değişmez)

### EC-3: Portalda olmayan program

1. CRM'de başka bir program adı olan (Topkapı listesinde bulunmayan) bir application seç.
2. Dry job ekle + run-once çalıştır.

Beklenen:  
- `resultJson.result.programMissing: true`
- `resultJson.result.detail` → "Program '...' not found in dropdown"
- `status = 'dry_run'`

---

## 6. Hata Durumları

### 6.1 Chromium sistem kütüphanesi eksik

Hata örneği:
```
error while loading shared libraries: libgobject-2.0.so.0
```

Çözüm önerisi (Replit Nix):
```nix
# replit.nix veya shell.nix'e ekle:
pkgs.glib pkgs.nss pkgs.atk pkgs.cups pkgs.dbus pkgs.libdrm
pkgs.xorg.libX11 pkgs.xorg.libXcomposite pkgs.xorg.libXdamage
pkgs.xorg.libXext pkgs.xorg.libXfixes pkgs.xorg.libXrandr
pkgs.mesa pkgs.expat pkgs.pango pkgs.cairo pkgs.alsa-lib
```

Otomatik kurma YOK — eksik paketleri raporla, Eymen eklesin.

### 6.2 Credential bulunamadı

```
[credResolver] No credentials for portal key "topkapi".
Configure via the admin panel or set TOPKAPI_EMAIL + _PASSWORD in .env
```

Çözüm: Admin panel → Portal Credentials → Topkapi credential ekle.  
Değerleri log'a veya run-once çıktısına YAZMA.

### 6.3 Login başarısız

Log'da:
```
[topkapi] login redirect — filling credentials
TimeoutError: page.waitForURL: Timeout 15000ms exceeded
```

- screenshot_urls'deki login ekran görüntüsü ref'ine bak
- Credential değerlerini LOGLAMA, sadece "login failed at step X" bildir

### 6.4 ENCRYPTION_KEY eksik

```
[credResolver] ENCRYPTION_KEY is required for decrypting portal credentials
```

Çözüm: `ENCRYPTION_KEY` veya `SESSION_SECRET` env var tanımla.

### 6.5 Object Storage yapılandırılmamış

```
[object-storage] PRIVATE_OBJECT_DIR is not set
```

Screenshotlar /tmp'ye yazılır, GCS upload atlanır (non-fatal). `screenshot_urls = []` olarak döner.

---

## 7. Real Submit Onay Kapısı

> **⛔ Eymen'den açık yazılı onay ("real gönderebilirsin") gelmeden bu adımlara geçme.**

3 edge case dahil DRY test yeşil olduktan sonra:

```bash
# 1. Tek gerçek başvuru ile başla
curl -X POST .../applications/<appId>/portal-submissions \
  -d '{"universityKey":"topkapi","mode":"real","confirm":true}'

# 2. run-once ile işle (--dry flag'i KULLANMA)
pnpm --filter @workspace/portal-automation-worker run-once -- --id <subId>
```

Başarı kriterleri:
- `/panel/applications/view/{UUID}` → başvuru görünür
- `resultJson.result.submitted: true`
- `resultJson.externalRef` dolu (portal UUID'si)
- `application.stage = 'awaiting_offer_letter'`
- `alreadyExists → 'already_registered'`; `programMissing → 'documents_collected'`

Başarı sonrası batch'e geç.

---

## 8. Mimari Notlar

### Dry mode browser akışı (Faz 3B+)

`dry` mode artık **gerçek browser açar** ve tüm form adımlarını doldurur — sadece son submit butonuna (Başvuruyu Tamamla) tıklamaz (`doSubmit=false`). Bu sayede:

- Login credentials doğrulanır
- Wizard adımları doğrulanır (program match, AJAX vb.)
- Per-step screenshot'lar alınır (7 adet)
- GCS'e upload edilir → kalıcı `/objects/...` ref

### Screenshot akışı

```
Adapter.submit() → page.screenshot() → /tmp/portal-shot-na-<step>-<ts>.png
                                                      ↓
Runner → readFile() → uploadBufferToGcs()  → GCS: /<PRIVATE_OBJECT_DIR>/portal-submissions/<id>/<n>-shot.png
                                                      ↓
portal_submissions.screenshot_urls[] = ["/objects/portal-submissions/<id>/..."]
```

### Stage writeback kuralları

| Adapter sonucu     | submission.status | application.stage        |
|--------------------|-------------------|--------------------------|
| submitted=true     | submitted         | awaiting_offer_letter    |
| programMissing=true| program_missing   | documents_collected      |
| alreadyExists=true | already_exists    | already_registered       |
| dryRun=true        | dry_run           | DEĞİŞMEZ                 |
| hata               | failed            | DEĞİŞMEZ                 |
