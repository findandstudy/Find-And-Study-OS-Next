#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "============================================"
echo " Find And Study OS — Production Build"
echo "============================================"

cd "$PROJECT_ROOT"

echo ""
echo "[1/5] Installing dependencies..."
pnpm install --frozen-lockfile

echo ""
echo "[2/5] Building shared libraries..."
pnpm run typecheck:libs

echo ""
echo "[3/5] Building frontend..."
cd artifacts/edcons
BASE_PATH="/" PORT=3000 NODE_ENV=production pnpm run build
cd "$PROJECT_ROOT"

echo ""
echo "[4/5] Building backend..."
cd artifacts/api-server
pnpm run build
cd "$PROJECT_ROOT"

echo ""
echo "[5/5] Portal automation worker..."

echo "  [5a] Typechecking portal worker..."
pnpm --filter @workspace/portal-automation-worker run typecheck

echo "  [5b] Verifying pre-provisioned Playwright Chromium..."
# OS packages and browser binaries are infrastructure dependencies. Installing
# them during a release mutates the host and makes rollback non-deterministic.
# Provision them separately, then point PLAYWRIGHT_BROWSERS_PATH at that cache.
if [ "${SKIP_PLAYWRIGHT_BROWSER_CHECK:-0}" = "1" ]; then
  echo "  [warn] Browser verification explicitly skipped"
else
  node deploy/verify-playwright-browser.cjs
fi

echo ""
echo "============================================"
echo " Build complete!"
echo " Frontend:  artifacts/edcons/dist/public/"
echo " Backend:   artifacts/api-server/dist/index.cjs"
echo " Worker:    artifacts/portal-automation-worker/ (tsx runtime)"
echo "============================================"
