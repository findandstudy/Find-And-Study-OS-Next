#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "[nginx-install:error] $*" >&2
  exit 1
}

for command_name in cmp cp date dirname grep id install mkdir mktemp nginx node perl rm systemctl; do
  command -v "$command_name" >/dev/null 2>&1 || fail "$command_name is required"
done
[ "$(id -u)" = "0" ] || fail "run as root after an approved production preflight"

RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-}"
[ -n "$RUNTIME_ENV_FILE" ] || fail "RUNTIME_ENV_FILE is required"
case "$RUNTIME_ENV_FILE" in /*) ;; *) fail "RUNTIME_ENV_FILE must be absolute" ;; esac
[ -f "$RUNTIME_ENV_FILE" ] || fail "RUNTIME_ENV_FILE does not exist"

set -a
# shellcheck disable=SC1090
source "$RUNTIME_ENV_FILE"
set +a

PORT="${PORT:-}"
CANDIDATE_PORT="${CANDIDATE_PORT:-}"
APP_BASE_URL="${APP_BASE_URL:-}"
NGINX_SITE_CONFIGS="${NGINX_SITE_CONFIGS:-}"
NGINX_UPSTREAM_FILE="${NGINX_UPSTREAM_FILE:-/etc/nginx/conf.d/findandstudy-upstream.conf}"
NGINX_UPSTREAM_NAME="${NGINX_UPSTREAM_NAME:-fasos_backend}"
NGINX_CONFIG_BACKUP_DIR="${NGINX_CONFIG_BACKUP_DIR:-/var/backups/findandstudy/nginx-$(date -u +%Y%m%dT%H%M%SZ)}"

[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || fail "PORT must be numeric"
[[ "$CANDIDATE_PORT" =~ ^[0-9]{2,5}$ ]] || fail "CANDIDATE_PORT must be numeric"
[ "$PORT" != "$CANDIDATE_PORT" ] || fail "PORT and CANDIDATE_PORT must differ"
[ -n "$APP_BASE_URL" ] || fail "APP_BASE_URL is required"
[ -n "$NGINX_SITE_CONFIGS" ] || fail "NGINX_SITE_CONFIGS must list explicit absolute config paths separated by ':'"
case "$NGINX_UPSTREAM_FILE" in /*) ;; *) fail "NGINX_UPSTREAM_FILE must be absolute" ;; esac
case "$NGINX_CONFIG_BACKUP_DIR" in /*) ;; *) fail "NGINX_CONFIG_BACKUP_DIR must be absolute" ;; esac
[[ "$NGINX_UPSTREAM_NAME" =~ ^[A-Za-z0-9_]+$ ]] || fail "NGINX_UPSTREAM_NAME is invalid"
[ ! -e "$NGINX_CONFIG_BACKUP_DIR" ] || fail "backup directory already exists"

APP_HOST="$(APP_BASE_URL="$APP_BASE_URL" node -e '
  try { process.stdout.write(new URL(process.env.APP_BASE_URL).hostname); }
  catch { process.exit(1); }
')" || fail "APP_BASE_URL must be an absolute URL"
[ -n "$APP_HOST" ] || fail "APP_BASE_URL has no hostname"

IFS=':' read -r -a site_configs <<<"$NGINX_SITE_CONFIGS"
[ "${#site_configs[@]}" -gt 0 ] || fail "no Nginx site config supplied"

work_dir="$(mktemp -d)"
cleanup() {
  rm -rf -- "$work_dir"
}
trap cleanup EXIT INT TERM

mkdir -p "$NGINX_CONFIG_BACKUP_DIR"
manifest="$NGINX_CONFIG_BACKUP_DIR/manifest.tsv"
: >"$manifest"

upstream_existed=false
if [ -e "$NGINX_UPSTREAM_FILE" ]; then
  [ -f "$NGINX_UPSTREAM_FILE" ] || fail "existing upstream target is not a regular file"
  cp -p "$NGINX_UPSTREAM_FILE" "$NGINX_CONFIG_BACKUP_DIR/upstream.conf"
  upstream_existed=true
fi

for index in "${!site_configs[@]}"; do
  target="${site_configs[$index]}"
  case "$target" in /*) ;; *) fail "site config must be absolute: $target" ;; esac
  [ -f "$target" ] || fail "site config does not exist: $target"
  [ ! -L "$target" ] || fail "site config must be the resolved sites-available file, not a symlink: $target"
  backup="$NGINX_CONFIG_BACKUP_DIR/site-$index.conf"
  staged="$work_dir/site-$index.conf"
  cp -p "$target" "$backup"
  printf '%s\t%s\n' "$target" "$backup" >>"$manifest"
  PORT_VALUE="$PORT" UPSTREAM_VALUE="$NGINX_UPSTREAM_NAME" perl -0pe '
    s{\bproxy_pass\s+http://(?:127\.0\.0\.1|localhost):\Q$ENV{PORT_VALUE}\E;}
     {proxy_pass http://$ENV{UPSTREAM_VALUE};}g
  ' "$target" >"$staged"
  if cmp -s "$target" "$staged" &&
    ! grep -Eq "proxy_pass[[:space:]]+http://${NGINX_UPSTREAM_NAME};" "$target"; then
    fail "no canonical proxy_pass found in $target"
  fi
done

cat >"$work_dir/upstream.conf" <<EOF
# Managed by Find And Study OS deploy/install-nginx-failover.sh.
upstream ${NGINX_UPSTREAM_NAME} {
    # Do not let a worker's passive failure accounting mark both local peers
    # unavailable. The deploy gate proves the candidate is healthy before the
    # canonical restart, and proxy_next_upstream still retries connection
    # errors without replaying non-idempotent requests.
    server 127.0.0.1:${PORT} max_fails=0;
    server 127.0.0.1:${CANDIDATE_PORT} backup max_fails=0;
    keepalive 64;
}
EOF

restore_previous_config() {
  set +e
  while IFS=$'\t' read -r target backup; do
    [ -n "$target" ] || continue
    cp -p "$backup" "$target"
  done <"$manifest"
  if [ "$upstream_existed" = "true" ]; then
    cp -p "$NGINX_CONFIG_BACKUP_DIR/upstream.conf" "$NGINX_UPSTREAM_FILE"
  else
    rm -f -- "$NGINX_UPSTREAM_FILE"
  fi
  nginx -t >/dev/null 2>&1 && systemctl reload nginx >/dev/null 2>&1
  set -e
}

install -d -m 755 "$(dirname "$NGINX_UPSTREAM_FILE")"
install -m 644 "$work_dir/upstream.conf" "$NGINX_UPSTREAM_FILE"
for index in "${!site_configs[@]}"; do
  target="${site_configs[$index]}"
  install -m 644 "$work_dir/site-$index.conf" "$target"
done

if ! nginx -t; then
  restore_previous_config
  fail "nginx -t failed; prior configuration restored"
fi
if ! PORT="$PORT" CANDIDATE_PORT="$CANDIDATE_PORT" \
  node "$(dirname "$0")/nginx-preflight.cjs" --host "$APP_HOST"; then
  restore_previous_config
  fail "failover preflight failed; prior configuration restored"
fi
if ! systemctl reload nginx; then
  restore_previous_config
  fail "Nginx reload failed; prior configuration restored"
fi

echo "[nginx-install] Failover enabled for ${#site_configs[@]} explicit site config(s)"
echo "[nginx-install] Verified host: $APP_HOST"
echo "[nginx-install] Rollback backup: $NGINX_CONFIG_BACKUP_DIR"
