#!/usr/bin/env bash
set -euo pipefail

# Compatibility entrypoint. Keeping deploy behavior in one script prevents
# process-name and PM2-topology drift.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$SCRIPT_DIR/../deploy/deploy.sh" "$@"
