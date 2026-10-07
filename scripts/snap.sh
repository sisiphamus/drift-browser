#!/usr/bin/env bash
# Full-window screenshot of a running Drift: scripts/snap.sh out.png [wallpaper]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
wall="${2:-$(readlink -f "$HOME/Pictures/wallpapers/.current" 2>/dev/null || true)}"
node "$here/../bin/drift.mjs" raw debug.capture --json | python3 "$here/shot.py" "$1" ${wall:+"$wall"}
