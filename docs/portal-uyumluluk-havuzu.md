# FAS-OS ↔ Portal Uyumluluk Havuzu
### Tüm oturum tecrübesinin konsolidasyonu (SIT + diğer portallar)

> **İlke:** KÖKLÜ DEĞİŞİKLİK YOK. Mevcut mimari korunur (`student_education_records`, `ai-extract`, Submission Board, `portal-automation-worker`, `deploy.sh`). Bu doküman yeni bir sistem önermez; **var olanın üstüne additive** olarak (matris + normalizasyon + tamlık kapısı) veri kalitesini portal-uyumlu hale getirir. Amaç: veri **kaynakta** (FAS-OS) doğru toplansın ki worker boşuna denemesin.

---

## 0. Kök Teşhis (bu oturumun özeti)

Otomatik başvurunun takıldığı yer worker/adapter değil, **bizim verimizin gönderilen portalın beklediği format/kurallara uymaması.** Worker düzeltildikçe her başarısızlık bir **veri kalitesi** sorununa indi:
- Ondalık GPA → Zoho reddi
- Country of Residence portal dropdown'ıyla eşleşmiyor
- City alanına adres parçası düşüyor
- Master başvuranında Bachelor bilgisi boş
- Eksik iletişim/aile alanları

**Sonuç:** En yüksek kaldıraç, kaynakta veriyi portal-uyumlu toplamak. Bu doküman o bilgiyi tek havuzda toplar.

---

## 1. Şu An Canlıda Olan (mevcut durum — sıfırdan başlanmayacak)

**Deploy edilmiş (5 faz + worker fix'leri):**
- Faz 1: `student_education_records` normalize tablosu + SIT toggle alanları (transferStudent/hasTcId/hasBlueCard) + `academicLevels` util (A/B/C grup).
- Faz 2: Education CRUD + apply akışı + **pasaport hard-blok** (süresi geçmiş → 422).
- Faz 3: AI çıkarımı seviye-bazlı (Bachelor→lise, Master→bachelor, PhD→bachelor+master).
- Faz 4: Profilde dinamik Academic Information, Education sekmesi kaldırıldı, SIT toggle soruları.
- Faz 5 (worker): GPA tam sayı, ikamet, belge-indirme.
- Ek worker fix: create/resolve (Zoho ID index gecikmesi ~55s bekleme; oturum düşünce sessiz atlama yerine retryable hata) + **retry-limit** (otomatik yol `MAX_AUTO_FAILED_SUBMISSIONS=3`, manuel yol limitsiz).

**Kanıtlanan (canlı loglarla):**
- Belge indirme + yükleme: **4/4** (photo, passport, transcript, diploma).
- Mevcut öğrenciye otomatik başvuru açma.
- **Yeni öğrenci create** (FAIZAN → SIT student id `6421426000085089072`) — ama ikamet alanları hatalı.

**Submission Board (admin → Portal Automation):** New Submission / Reset Stuck / Process All Queued; her kayıtta `Attempt X/3`, status (Running/Failed/Submitted). Manuel tetikleme retry-limitini atlar.

---

## 2. SIT (Study in Turkey / Zoho) Uyumluluk Kuralları — EN ÖNEMLİ BÖLÜM

Alan bazında, öğrenilen kural ve hata:

| Alan | Kural / Format | Öğrenilen hata (kanıt) |
|---|---|---|
| **GPA** | Tam sayı, **0–100**. Yüzde. | Ondalık reddediliyor: `INVALID_DATA: High_School_GPA` (4.33, 86.6 red; 76, 87 geçti). Kaynakta tam sayı sakla, sınıra bırakma. |
| **Country of Residence** | SIT dropdown değeriyle **birebir** eşleşmeli (kanonik ülke adı). | `cval='Pakistan' selIdx=-1 cOk=false` → serbest metin dropdown'da bulunamadı, seçilemedi. |
| **City** | Gerçek şehir adı; adresten **ayrı** temiz alan. | `CITYFILL city='HOUSE NO. 165' ok=false` → adres satırı şehir sanıldı. |
| **Seviye→Akademik** | Bachelor başvuranı: **Lise** (ülke+ad+GPA). Master: **Bachelor** (ülke+okul+GPA). PhD: **Bachelor+Master**. | Master'da bachelor boş → `boş alanlar: Bachelor Country/School/GPA` → fail. |
| **Kişisel** | DOB, cinsiyet, uyruk, pasaport no, pasaport veriliş, pasaport bitiş, email, mobil. | Tümü zorunlu; eksikse adım 2/3 validasyon hatası. |
| **Pasaport geçerlilik** | Bitiş tarihi **bugünden ileri** olmalı. | Faz 2 hard-blok (422 PASSPORT_EXPIRED). |
| **Aile** | Baba ad + meslek, anne ad + meslek. | Adım 4 zorunlu. |
| **Dil skoru** | Serbest metin (ör. "IELTS 7.0", "English language B3"). | — |
| **SIT toggle** | Transfer student / Have T.C / Blue Card = Yes/No. | Adım 1'de set ediliyor. |
| **Belgeler** | photo + passport + transcript + diploma; **indirilebilir** olmalı. | Eskiden indirilemiyor → "sıfır belgeli create engellendi"; artık public URL→imzalı→base64 fallback zinciri. |
| **Öğrenci var mı** | Önce `studentSearch` (email). Varsa "öğrenci mevcut → sadece başvuru". Yoksa wizard ile create. | Zaten var olan create edilemiyordu ("id çözümlenemedi"); ~55s Zoho index beklemesi eklendi. |

---

## 3. Portal Haritası (hangi üniversite nereye gider)

**Aggregator portallar (routing bunlardan):**
- **SIT = "Study in Turkey"** (`sit`, Auto-process açık). Üyeler: Ankara Medipol, Beykoz, Fenerbahce, Istanbul Arel, Istanbul Atlas, Istanbul Aydin, **Istanbul Gelisim**, Istanbul Galata, Istanbul Kent, Istanbul Kultur, Istanbul Yeni Yuzyil, Istinye.
- **United Education** (`united`): Ankara Bilim, Biruni, Istanbul Nisantasi.
- **Multico (Topkapı CAS)** (`multico`): kimlik bilgisi eksik (şu an gönderemez).

**Direct (tek üniversite kendi portalı):** Altinbas, Aydin, Bahcesehir/BAU, Beykent, Dogus, EMU, Isik, Istanbul Medipol, Okan, Ozyegin, Sabancı, Topkapi (auto-process açık), Uskudar, Yeditepe.

> **Not:** Her direct/aggregator portalın kendi zorunlu alan + format kuralları var. Matris portal-başına genişletilmeli; SIT'i referans al.

---

## 4. Öğrenilen Hata Modları ve Kök Nedenleri (tekrar etmesin)

1. **Ondalık GPA** → Zoho INVALID_DATA. → Kaynakta tam sayı.
2. **Country of Residence eşleşmiyor** → kanonik ülke listesi + doğru eşleşme.
3. **City = adres parçası** → ayrı, temiz şehir alanı.
4. **Master'da bachelor verisi boş** → seviyeye göre zorunlu akademik kayıt.
5. **Zaten var olan öğrenci** → alreadyExists doğru yakalanmalı; ID Zoho index gecikmesiyle geç geliyor (~55s bekle).
6. **Sonsuz retry kuyruğu kilitliyor** → otomatik yol 3 denemede dur (çözüldü); manuel limitsiz — manuel de kalıcı-fail eşiği düşünülebilir.
7. **Oturum login'e düşünce sessiz atlama** → retryable hata + kurtarma navigasyonu (çözüldü).
8. **Belge indirilemiyor** → public URL → imzalı `/api/documents/:id/file` → base64 fallback (çözüldü).

---

## 5. Önerilen Entegrasyon — ADDITIVE, KÖKLÜ DEĞİL

Mevcut yapıyı bozmadan 4 katman:

**5.1 Portal-Uyumluluk Matrisi (config/data)**
- Portal başına: zorunlu alanlar, format kuralları, geçerli değer listeleri (ör. Country of Residence kanonik liste).
- Tek yerde tanımlı, kodun her yerinden okunur. SIT ilk; diğerleri aynı şemayla eklenir.

**5.2 Normalizasyon yardımcıları (saf util)**
- `normalizeGpaInteger(raw) → 0–100 tam sayı`.
- `canonicalCountry(raw) → portal dropdown değeri` (uyruk/adres ülkesinden).
- Şehir: adresten **ayrı** `city` alanı; adres parçası şehir olarak kullanılmaz.
- Tarih formatları (DOB, pasaport) tek standart.

**5.3 AI çıkarımı hizalama (`ai-extract`)**
- Matristeki **tüm zorunlu alanları** hedefle (sadece bir kısmını değil).
- GPA'yı **tam sayı** çıkar; Country of Residence + City'i **temiz ve kanonik** çıkar; seviyeye göre akademik kaydı doldur.

**5.4 Gönderim öncesi tamlık/uyum kapısı**
- Profilde ve Submission Board'da: hedef portalın **eksik/uyumsuz** zorunlu alanları kırmızı.
- Eksikse gönderim uyarısı/soft-blok (personel eksik kayıt göndermeden görsün). Worker boşuna denemesin.

> Hiçbiri şema/mimari rewrite değil: mevcut `student_education_records` + `ai-extract` + Submission Board üstüne eklenir.

---

## 6. Operasyon Notları (deploy/worker)

- **Deploy:** `~/deploy.sh` (VPS) — fresh clone (git remote) → install → build (edcons+api-server) → atomik swap → `pm2 restart fasos-apply-api` → `/api/health` 200 → başarı; değilse otomatik rollback.
- **ÖNEMLİ:** `deploy.sh` worker'ı restart ETMEZ. Worker fix'i sonrası `pm2 restart findandstudy-portal-worker` gerekir.
- **pm2 processleri:** academy, fasos-apply-api (5057), findandstudy-cloud, **findandstudy-portal-worker** (poll 5s), freeturkish.
- **Git akışı:** Replit'te commit → Push (remote) → VPS `deploy.sh` → worker restart.

---

## 7. Başvuran-başı Veri Hazırlık Checklist (SIT — göndermeden önce)

- [ ] Email, Mobil
- [ ] DOB, Cinsiyet, Uyruk
- [ ] Pasaport No + Veriliş + Bitiş (bitiş **geçmemiş**)
- [ ] **Country of Residence** (kanonik) + **City** (gerçek şehir, adres değil)
- [ ] Baba ad+meslek, Anne ad+meslek
- [ ] Seviyeye göre akademik: Bachelor→Lise(ülke+ad+**GPA tam sayı**); Master→Bachelor(ülke+okul+GPA); PhD→ikisi
- [ ] Dil skoru (serbest metin)
- [ ] Belgeler yüklü + indirilebilir (photo, passport, transcript, diploma)
- [ ] SIT toggle: Transfer / T.C / Blue Card

---

*Bu havuz, bir sonraki adımda (istenirse) köklü değişiklik yapmadan bir Replit build prompt'una çevrilebilir: portal-uyumluluk matrisi + normalizasyon util'leri + ai-extract hizalama + gönderim öncesi tamlık kapısı.*