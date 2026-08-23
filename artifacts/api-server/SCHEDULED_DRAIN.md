# Portal Submission Drain — Scheduled Deployment Kurulumu

## Genel Bakış

`drain-once.ts` scripti, kuyrukta bekleyen (`queued`) `portal_submissions` kayıtlarını sıralı olarak işler ve çıkar. Replit Autoscale'de sürekli çalışan worker olmayacağı için bu scripti Replit **Scheduled Deployment** (zamanlanmış deployment) olarak periyodik çalıştırın.

## Otomatik İşleme Kapısı (Auto-Drain Gate)

Script her çalıştığında üç aşamalı bir kap kontrolü yapar:

| Adım | Kontrol | Başarısız Sonucu |
|------|---------|-----------------|
| 1 | `portal_automation_settings.auto_process_enabled = true` | Sessizce çıkar (exit 0) |
| 2 | `now - last_auto_drain_at >= auto_process_interval_minutes` | Sessizce çıkar (exit 0) |
| 3 | `portal_universities.auto_process = true AND is_active = true` olan üniversite var mı? | Sessizce çıkar (exit 0) |

Bu kap geçildikten sonra, script **yalnızca `auto_process=true` olan üniversitelerin** kuyruktaki başvurularını işler. Diğer üniversitelerin başvuruları dokunulmaz bırakılır.

### Panel Yapılandırması

**Automation Rules sekmesi → Scheduled Auto-Process kartı:**
- **Enable Scheduled Auto-Process** — global açma/kapama toggle'ı
- **Processing Interval** — 10 / 20 / 30 / 60 dakika seçenekleri

**Universities sekmesi:**
- Her üniversite satırında **Auto-process** toggle'ı — o üniversiteye ait başvuruların otomatik işlenip işlenmeyeceğini belirler

### Denetim Kaydı

Her drain çalışması `audit_logs` tablosuna kayıt düşer:
- `action = 'auto_drain_completed'` — başarılı işlem (işlenen / gönderilen / başarısız sayıları)
- `action = 'auto_drain_skipped_interval'` — interval geçmemiş, atlandı
- `user_id = NULL` — scheduled context'de oturum yoktur

## Çalıştırma Komutu

```bash
pnpm --filter @workspace/api-server run drain-once
```

> `drain-once` script'i `package.json`'da `NODE_OPTIONS=--max-old-space-size=512 tsx scripts/drain-once.ts` olarak tanımlıdır — `run drain-once` bu memory limitini otomatik uygular.

## Gerekli Environment Değişkenleri

| Değişken | Açıklama |
|---|---|
| `DATABASE_URL` | PostgreSQL bağlantı URL'si |
| `ENCRYPTION_KEY` | Portal kimlik bilgileri şifreleme anahtarı |
| `SESSION_SECRET` | ENCRYPTION_KEY yoksa fallback olarak kullanılır |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | Nix chromium yolu (otomatik `.replit` tarafından set edilir) |

## Replit Scheduled Deployment Adımları

1. **Replit panelinde** projenizi açın
2. Sol menüden **Deployments** → **New Deployment** seçin
3. Deployment tipini **Scheduled** olarak ayarlayın
4. **Command** alanına:
   ```
   pnpm --filter @workspace/api-server run drain-once
   ```
5. **Schedule** — **`*/10 * * * *`** (önerilen: her 10 dakikada bir)
   > Cron frekansı panel'deki `auto_process_interval_minutes` değerinden bağımsızdır. Script interval geçmemişse kendi kendini durdurur; cron sık olsa da sorun yaratmaz. Cron en az paneldeki interval kadar sık olmalıdır.
6. **Environment Variables** bölümünde `DATABASE_URL`, `ENCRYPTION_KEY`, `SESSION_SECRET` ekleyin

## Önemli Notlar

- Script **idempotent**tir — aynı anda birden fazla çalışsa bile `FOR UPDATE SKIP LOCKED` sayesinde her satır yalnızca bir kez işlenir
- Her submission'dan sonra browser **kapatılır** (bellek temizlenir)
- Başarısız submission'lar `portal_submissions.status = 'failed'` olarak kaydedilir; `max_attempts` aşılmamışsa bir sonraki çalışmada tekrar denenir
- Script sıfır (`0`) ile çıkar — başarısız submission'lar olsa bile (DB hatası yoksa)
- `last_auto_drain_at` sütunu her başarılı drain sonrasında güncellenir (interval kapısını bir sonraki çalışmada açar)

## Manuel Çalıştırma

Dev ortamında test için:

```bash
# Auto-process kapısını atlayıp tüm kuyruğu zorla işle (env ile kap devre dışı bırakılabilir)
pnpm --filter @workspace/api-server run drain-once

# Çıktı örneği (kapı geçildi, 1 submission işlendi):
# [drain-once] Starting — id=drain-once-hostname-12345
# [drain-once] Auto-process filter: 2 university(ies) — topkapi, ankara_uni
# [drain-once] Released 0 stale submission(s)
# [drain-once] Processing #42 — uni=topkapi mode=dry attempt=1/3
# [drain-once] #42 → dry_run
# [drain-once] Done — 1 submission(s) processed
# [drain-once] lastAutoDrainAt updated. Audit recorded.

# Çıktı örneği (kapı: interval geçmemiş):
# [drain-once] Starting — id=drain-once-hostname-12346
# [drain-once] Interval gate: 18 min remaining (interval=20 min, elapsed=2 min) — skipping
```

## Manuel "Şimdi İşle" (API)

Scheduled deployment beklemeden anlık işleme için Submission Board'daki **"Şimdi İşle"** butonunu kullanın. Bu endpointler **otomatik işleme kapısından etkilenmez** — her zaman tüm üniversitelerin kuyruktaki başvurularını işler:

- **Tekil**: Bir submission satırındaki "İşle" butonu (`POST /api/portal-submissions/:id/process`)
- **Toplu**: Toolbar'daki "Tüm Bekleyenleri İşle" butonu (`POST /api/portal-submissions/process-queued`)
