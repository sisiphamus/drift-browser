#!/usr/bin/env bash
# Runs Drift without a display for tests and screenshots, isolated from the real profile.
# usage: DRIFT_PROFILE=/tmp/p DRIFT_SOCKET=/tmp/drift.sock scripts/headless.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
: "${DRIFT_PROFILE:?set DRIFT_PROFILE}" "${DRIFT_SOCKET:?set DRIFT_SOCKET}"
node "$here/bin/drift.mjs" raw run '{"action":"quit"}' >/dev/null 2>&1 || true
sleep 1
exec "$here/node_modules/.bin/electron" --ozone-platform=headless "$here"
