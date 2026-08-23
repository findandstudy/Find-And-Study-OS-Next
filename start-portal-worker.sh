#!/usr/bin/env bash
set -euo pipefail

echo "[error] Standalone portal worker startup is disabled." >&2
echo "[error] Use the guarded repository-root deploy/deploy.sh workflow." >&2
exit 1
