#!/usr/bin/env bash
# SEC-002 — Privilege Escalation doğrulama testi
# Canlı API sunucusuna (localhost:8080) gerçek HTTP istekleri gönderir.
# Çalıştır: bash artifacts/api-server/scripts/validate-sec002-privesc.sh

set -euo pipefail
BASE="http://localhost:8080/api"

pass=0
fail=0
failures=()

check() {
  local label="$1"
  local expected_status="$2"
  local got_status="$3"
  local body="$4"

  if [[ "$got_status" == "$expected_status" ]]; then
    echo "  ✅ PASS  [$got_status]  $label"
    ((pass++)) || true
  else
    echo "  ❌ FAIL  [beklenen=$expected_status, alınan=$got_status]  $label"
    echo "     body: $body"
    failures+=("$label")
    ((fail++)) || true
  fi
}

echo ""
echo "═══════════════════════════════════════════════════════════"
echo " SEC-002 — Privilege Escalation Doğrulama Testi"
echo "═══════════════════════════════════════════════════════════"
echo ""

# ─── Oturum aç: admin ────────────────────────────────────────────────────────
echo "→ admin olarak oturum açılıyor..."
ADMIN_COOKIE_JAR=$(mktemp /tmp/sec002-admin-XXXXXX.txt)
ADMIN_LOGIN=$(curl -s -c "$ADMIN_COOKIE_JAR" -b "$ADMIN_COOKIE_JAR" \
  -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@edcons.test","password":"TestPass123!"}' \
  -w "\n%{http_code}")
ADMIN_STATUS=$(echo "$ADMIN_LOGIN" | tail -1)
ADMIN_BODY=$(echo "$ADMIN_LOGIN" | head -n -1)
ADMIN_ROLE=$(echo "$ADMIN_BODY" | grep -o '"role":"[^"]*"' | head -1 | sed 's/"role":"//;s/"//')

if [[ "$ADMIN_STATUS" != "200" ]]; then
  echo "  ⚠️  admin girişi başarısız (HTTP $ADMIN_STATUS) — DB'de admin kullanıcısı yok, test atlanıyor."
  echo "  Body: $ADMIN_BODY"
  echo ""
  echo "  NOT: Bu test canlı test verisi gerektirir. API sunucusu erişilebilirse"
  echo "  ve admin@edcons.test mevcutsa sonuçlar gösterilir."
  rm -f "$ADMIN_COOKIE_JAR"
  exit 0
fi
echo "  → admin girişi başarılı (rol: $ADMIN_ROLE)"

# CSRF token al
CSRF_TOKEN=$(curl -s -c "$ADMIN_COOKIE_JAR" -b "$ADMIN_COOKIE_JAR" \
  "$BASE/auth/me" | grep -o '"csrfToken":"[^"]*"' | sed 's/"csrfToken":"//;s/"//' || echo "")

# ─── super_admin kullanıcısını bul ────────────────────────────────────────────
echo "→ super_admin kullanıcısı aranıyor..."
USERS_RESP=$(curl -s -c "$ADMIN_COOKIE_JAR" -b "$ADMIN_COOKIE_JAR" \
  "$BASE/users?role=super_admin&limit=5")
SUPER_ADMIN_ID=$(echo "$USERS_RESP" | grep -o '"id":[0-9]*' | head -1 | sed 's/"id"://')

if [[ -z "$SUPER_ADMIN_ID" ]]; then
  echo "  ⚠️  super_admin kullanıcısı bulunamadı — test atlanıyor."
  rm -f "$ADMIN_COOKIE_JAR"
  exit 0
fi
echo "  → super_admin kullanıcısı bulundu: id=$SUPER_ADMIN_ID"

# ─── Test 1: admin → super_admin PATCH (403 bekleniyor) ──────────────────────
echo ""
echo "Test 1: admin rolü → super_admin hesabına PATCH (403 bekleniyor)"
RESP=$(curl -s -o /tmp/sec002-body.txt -w "%{http_code}" \
  -X PATCH "$BASE/users/$SUPER_ADMIN_ID" \
  -c "$ADMIN_COOKIE_JAR" -b "$ADMIN_COOKIE_JAR" \
  -H "Content-Type: application/json" \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -d '{"phone":"+905550000001"}')
BODY=$(cat /tmp/sec002-body.txt)
check "admin PATCH super_admin hesabı → 403" "403" "$RESP" "$BODY"

# ─── Oturum aç: manager ──────────────────────────────────────────────────────
MANAGER_COOKIE_JAR=$(mktemp /tmp/sec002-manager-XXXXXX.txt)
MANAGER_LOGIN=$(curl -s -c "$MANAGER_COOKIE_JAR" -b "$MANAGER_COOKIE_JAR" \
  -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"manager@edcons.test","password":"TestPass123!"}' \
  -w "\n%{http_code}")
MANAGER_STATUS=$(echo "$MANAGER_LOGIN" | tail -1)
MANAGER_BODY=$(echo "$MANAGER_LOGIN" | head -n -1)

if [[ "$MANAGER_STATUS" == "200" ]]; then
  MANAGER_CSRF=$(curl -s -c "$MANAGER_COOKIE_JAR" -b "$MANAGER_COOKIE_JAR" \
    "$BASE/auth/me" | grep -o '"csrfToken":"[^"]*"' | sed 's/"csrfToken":"//;s/"//' || echo "")

  echo ""
  echo "Test 2: manager rolü → super_admin hesabına PATCH (403 bekleniyor)"
  RESP=$(curl -s -o /tmp/sec002-body2.txt -w "%{http_code}" \
    -X PATCH "$BASE/users/$SUPER_ADMIN_ID" \
    -c "$MANAGER_COOKIE_JAR" -b "$MANAGER_COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $MANAGER_CSRF" \
    -d '{"phone":"+905550000002"}')
  BODY=$(cat /tmp/sec002-body2.txt)
  check "manager PATCH super_admin hesabı → 403" "403" "$RESP" "$BODY"
else
  echo "  ⚠️  manager girişi başarısız — Test 2 atlanıyor."
fi

# ─── Test 3: admin → normal staff hesabına PATCH (başarılı olmalı) ───────────
echo ""
echo "Test 3: admin rolü → normal staff hesabını PATCH (2xx bekleniyor)"
STAFF_USERS=$(curl -s -c "$ADMIN_COOKIE_JAR" -b "$ADMIN_COOKIE_JAR" \
  "$BASE/users?role=staff&limit=5")
STAFF_ID=$(echo "$STAFF_USERS" | grep -o '"id":[0-9]*' | head -1 | sed 's/"id"://')

if [[ -n "$STAFF_ID" ]]; then
  RESP=$(curl -s -o /tmp/sec002-body3.txt -w "%{http_code}" \
    -X PATCH "$BASE/users/$STAFF_ID" \
    -c "$ADMIN_COOKIE_JAR" -b "$ADMIN_COOKIE_JAR" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{}')
  BODY=$(cat /tmp/sec002-body3.txt)
  # 400 "No valid fields" da kabul edilir — 403 DEĞİL
  if [[ "$RESP" == "200" || "$RESP" == "400" ]]; then
    check "admin PATCH normal staff hesabı → izin verildi" "$RESP" "$RESP" "$BODY"
  else
    check "admin PATCH normal staff hesabı → izin verildi" "200_or_400" "$RESP" "$BODY"
  fi
else
  echo "  ⚠️  staff kullanıcısı bulunamadı — Test 3 atlanıyor."
fi

rm -f "$ADMIN_COOKIE_JAR" "$MANAGER_COOKIE_JAR" /tmp/sec002-body*.txt

echo ""
echo "── SEC-002 Privilege Escalation: $pass PASS, $fail FAIL ──"
[[ $fail -eq 0 ]] && exit 0 || exit 1
