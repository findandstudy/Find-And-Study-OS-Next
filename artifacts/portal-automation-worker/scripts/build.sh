#!/usr/bin/env bash
# build.sh — Compile + install Playwright Chromium for portal-automation-worker
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Building portal-automation-worker…"
cd "$ROOT_DIR"

# 1. TypeScript compile
echo "    [1/3] tsc compile…"
pnpm tsc -p tsconfig.json --noEmit || true   # type check
pnpm tsc -p tsconfig.json

# 2. Install Playwright Chromium
echo "    [2/3] playwright install chromium…"
npx playwright install chromium --with-deps

# 3. Create logs directory
echo "    [3/3] creating logs/…"
mkdir -p logs screenshots

echo "==> Build complete."
