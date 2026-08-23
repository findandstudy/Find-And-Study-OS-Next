#!/bin/bash
# =============================================================================
# Find & Study — Build Script
# =============================================================================
# Usage: bash scripts/build.sh
# Required env vars: BASE_URL (optional, default: https://findandstudy.com)
# =============================================================================
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

echo "==> [1/5] Installing dependencies (frozen lockfile)..."
pnpm install --frozen-lockfile

echo "==> [2/5] Building shared packages..."
pnpm --filter @workspace/db run build 2>/dev/null || true
pnpm --filter @workspace/api-client-react run build 2>/dev/null || true

echo "==> [3/5] Building API server..."
pnpm --filter @workspace/api-server run build

echo "==> [4/5] Building frontend (BASE_URL=${BASE_URL:-https://findandstudy.com})..."
BASE_URL="${BASE_URL:-https://findandstudy.com}" \
NODE_ENV=production \
pnpm --filter @workspace/edcons run build

echo "==> [5/5] Generating sitemap..."
BASE_URL="${BASE_URL:-https://findandstudy.com}" \
node artifacts/edcons/generate-sitemap.mjs 2>/dev/null || \
  echo "     (sitemap generator not found, skipping)"

echo ""
echo "✓ Build complete."
echo "  API:      artifacts/api-server/dist/index.cjs"
echo "  Frontend: artifacts/edcons/dist/public/"
