# Find & Study — Hostinger VPS Deployment Kılavuzu

Bu kılavuz, projeyi sıfırdan Ubuntu 22.04 üzerinde çalışan bir Hostinger VPS'e deploy etmek için gereken tüm adımları içerir.

---

## İçindekiler

1. [Önkoşullar](#1-önkoşullar)
2. [İlk Sunucu Kurulumu](#2-i̇lk-sunucu-kurulumu)
3. [Node.js ve pnpm Kurulumu](#3-nodejs-ve-pnpm-kurulumu)
4. [Repo Klonlama](#4-repo-klonlama)
5. [Ortam Değişkenleri](#5-ortam-değişkenleri)
6. [PostgreSQL Kurulumu ve Yapılandırması](#6-postgresql-kurulumu-ve-yapılandırması)
7. [Nginx Kurulumu](#7-nginx-kurulumu)
8. [SSL Sertifikası (Let's Encrypt)](#8-ssl-sertifikası-lets-encrypt)
9. [PM2 ile API Sunucusunu Başlatma](#9-pm2-ile-api-sunucusunu-başlatma)
10. [İlk Deploy](#10-i̇lk-deploy)
11. [DNS Ayarları](#11-dns-ayarları)
12. [Güncelleme Prosedürü](#12-güncelleme-prosedürü)
13. [Rollback](#13-rollback)

---

## 1. Önkoşullar

Sunucuda kurulu olması gerekenler:

| Bileşen | Versiyon |
|---------|----------|
| İşletim sistemi | Ubuntu 22.04 LTS |
| Node.js | 20 LTS |
| pnpm | 9+ |
| PostgreSQL | 16 |
| Nginx | 1.24+ |
| PM2 | 5+ |
| Certbot | güncel |

Hostinger hPanel'den **VPS** planı satın alındıktan sonra SSH erişimi sağlanmalıdır.

---

## 2. İlk Sunucu Kurulumu

Sunucuya SSH ile bağlan ve sistemi güncelle:

```bash
ssh root@<SUNUCU_IP>

# Sistem paketlerini güncelle
apt update && apt upgrade -y

# Temel araçları kur
apt install -y git curl wget build-essential unzip ufw fail2ban

# Güvenlik duvarını yapılandır
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable

# fail2ban'ı etkinleştir (brute-force koruması)
systemctl enable fail2ban --now
```

Güvenlik için `root` yerine ayrı bir kullanıcı oluştur:

```bash
adduser findandstudy
usermod -aG sudo findandstudy
rsync --archive --chown=findandstudy:findandstudy ~/.ssh /home/findandstudy

# Artık bu kullanıcıyla bağlan
ssh findandstudy@<SUNUCU_IP>
```

---

## 3. Node.js ve pnpm Kurulumu

```bash
# Node.js 20 LTS — NodeSource deposunu ekle
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Versiyonu doğrula
node -v   # v20.x.x
npm -v    # 10.x.x

# pnpm'i global kur
npm install -g pnpm@latest

# PM2'yi global kur
npm install -g pm2@latest

# Versiyonu doğrula
pnpm -v   # 9.x.x
pm2 -v    # 5.x.x
```

---

## 4. Repo Klonlama

```bash
# Proje dizinini oluştur
sudo mkdir -p /var/www/findandstudy
sudo chown findandstudy:findandstudy /var/www/findandstudy

# Repoyu klonla
cd /var/www/findandstudy
git clone https://github.com/<KULLANICI>/<REPO>.git .

# Dizin yapısını doğrula
ls
# → artifacts/  lib/  scripts/  conf/  package.json  ...
```

> **Not:** Repo private ise, GitHub'da bir deploy key oluştur:
> ```bash
> ssh-keygen -t ed25519 -C "deploy@findandstudy.com" -f ~/.ssh/deploy_key
> cat ~/.ssh/deploy_key.pub  # Bu public key'i GitHub → Settings → Deploy Keys'e ekle
> ```

---

## 5. Ortam Değişkenleri

```bash
cd /var/www/findandstudy

# .env.example'dan .env oluştur
cp .env.example .env

# .env dosyasını düzenle
nano .env
```

Doldurulması zorunlu değerler:

```env
DATABASE_URL=postgresql://findandstudy:<DB_PAROLA>@localhost:5432/findandstudy
NODE_ENV=production
PORT=5000
ALLOWED_ORIGINS=https://findandstudy.com,https://www.findandstudy.com
ANTHROPIC_API_KEY=sk-ant-api03-...
BASE_URL=https://findandstudy.com
```

Dosyayı kaydet (`Ctrl+O`, `Enter`, `Ctrl+X`) ve izinleri kısıtla:

```bash
chmod 600 .env
```

---

## 6. PostgreSQL Kurulumu ve Yapılandırması

```bash
# PostgreSQL 16 kur
sudo apt install -y postgresql-16

# Servisi başlat
sudo systemctl enable postgresql --now

# PostgreSQL konsoluna gir
sudo -u postgres psql

# Kullanıcı ve veritabanı oluştur
CREATE USER findandstudy WITH PASSWORD '<DB_PAROLA>';
CREATE DATABASE findandstudy OWNER findandstudy;
GRANT ALL PRIVILEGES ON DATABASE findandstudy TO findandstudy;
\q

# Bağlantıyı test et
psql postgresql://findandstudy:<DB_PAROLA>@localhost:5432/findandstudy -c "SELECT 1;"
```

> **Not:** `<DB_PAROLA>` değerini `.env` dosyasındaki `DATABASE_URL` ile eşleştir.

---

## 7. Nginx Kurulumu

```bash
# Nginx kur
sudo apt install -y nginx
sudo systemctl enable nginx --now

# Konfig şablonundan site konfigürasyonunu oluştur
sudo cp /var/www/findandstudy/conf/nginx.conf.template \
        /etc/nginx/sites-available/findandstudy.com

# Sembolik link oluştur (siteyi etkinleştir)
sudo ln -s /etc/nginx/sites-available/findandstudy.com \
           /etc/nginx/sites-enabled/findandstudy.com

# Varsayılan siteyi devre dışı bırak
sudo rm -f /etc/nginx/sites-enabled/default

# Rate limiting için http bloğuna limit_req_zone direktiflerini ekle
sudo nano /etc/nginx/nginx.conf
```

`nginx.conf` içindeki `http { }` bloğuna şu satırları ekle:

```nginx
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=30r/m;
limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=10r/m;
```

Nginx konfigürasyonunu test et ve yenile:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

---

## 8. SSL Sertifikası (Let's Encrypt)

```bash
# Certbot kur
sudo apt install -y certbot python3-certbot-nginx

# Sertifika al (alan adlarını düzenle)
sudo certbot --nginx \
  -d findandstudy.com \
  -d www.findandstudy.com \
  --email admin@findandstudy.com \
  --agree-tos \
  --no-eff-email

# Nginx'i yeniden yükle
sudo systemctl reload nginx

# Otomatik yenilemeyi test et
sudo certbot renew --dry-run
```

Certbot, sertifikaları otomatik olarak `/etc/letsencrypt/live/findandstudy.com/` altına kurar ve cron görevi ekler. Yenileme işlemi 90 günde bir otomatik çalışır.

---

## 9. PM2 ile API Sunucusunu Başlatma

```bash
cd /var/www/findandstudy

# Logs dizinini oluştur
mkdir -p logs

# PM2'yi ekosistem dosyasıyla başlat
pm2 start ecosystem.config.cjs --env production

# PM2'nin sunucu yeniden başladığında otomatik çalışmasını sağla
pm2 save
pm2 startup

# Startup komutunu kopyalayıp çalıştır (PM2 çıktısında gösterilir), örnek:
# sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u findandstudy --hp /home/findandstudy

# Durumu kontrol et
pm2 status
pm2 logs fasos-apply-api --lines 30
```

---

## 10. İlk Deploy

```bash
cd /var/www/findandstudy

# .env'in yüklü olduğundan emin ol
cat .env | grep NODE_ENV   # → NODE_ENV=production

# Bağımlılıkları yükle ve projeyi derle
bash scripts/build.sh

# Statik dosyaları Nginx'in kök dizinine kopyala
sudo mkdir -p /var/www/findandstudy/dist/public
# (build.sh zaten artifacts/edcons/dist/public/ altında oluşturur)

# Nginx konfigürasyonundaki root yolunun build çıktısıyla eşleştiğini doğrula:
# root /var/www/findandstudy/artifacts/edcons/dist/public;
# Gerekirse nginx.conf.template içindeki root satırını güncelle.

# Veritabanı şemasını uygula ve API'yi başlat
bash scripts/deploy.sh
```

Tarayıcıdan `https://findandstudy.com` adresini açarak siteyi doğrula.

---

## 11. DNS Ayarları

Hostinger hPanel → **DNS Bölge Yöneticisi** menüsünden şu kayıtları ekle:

| Tür | Ad | Değer | TTL |
|-----|----|-------|-----|
| A | `@` | `<SUNUCU_IP>` | 300 |
| A | `www` | `<SUNUCU_IP>` | 300 |

DNS yayılması 5–60 dakika sürebilir. Yayılmayı kontrol etmek için:

```bash
dig findandstudy.com A +short
dig www.findandstudy.com A +short
```

Her iki komut da `<SUNUCU_IP>` adresini döndürmelidir.

---

## 12. Güncelleme Prosedürü

Kod tabanında değişiklik yapıldığında sunucuya deploy etmek için:

```bash
ssh findandstudy@<SUNUCU_IP>
cd /var/www/findandstudy

# En son kodu çek
git pull origin main

# Yeniden derle ve deploy et
bash scripts/build.sh
bash scripts/deploy.sh
```

`deploy.sh` PM2'yi graceful reload yapar — sıfır kesinti süresiyle güncelleme gerçekleşir.

---

## 13. Rollback

Güncelleme sonrası bir sorun çıkarsa önceki commit'e geri dön:

```bash
cd /var/www/findandstudy

# Commit geçmişini listele
git log --oneline -10

# Belirli bir commit'e geri dön
git checkout <COMMIT_HASH>

# Eski versiyonu yeniden derle ve başlat
bash scripts/build.sh
bash scripts/deploy.sh
```

Kalıcı olarak eski versiyona sabitlemek için:

```bash
git checkout -b hotfix/<ACIKLAMA> <COMMIT_HASH>
git push origin hotfix/<ACIKLAMA>
```

---

## Faydalı Komutlar

```bash
# API sunucusu logları (canlı)
pm2 logs fasos-apply-api

# Nginx erişim logları
sudo tail -f /var/log/nginx/findandstudy.access.log

# Nginx hata logları
sudo tail -f /var/log/nginx/findandstudy.error.log

# PM2 süreç durumu
pm2 status

# API'yi manuel yeniden başlat
pm2 restart fasos-apply-api

# Nginx'i test et ve yenile
sudo nginx -t && sudo systemctl reload nginx

# SSL sertifika durumu
sudo certbot certificates

# Disk kullanımı
df -h

# Bellek kullanımı
free -h
```
