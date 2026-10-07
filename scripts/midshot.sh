#!/usr/bin/env bash
# Screenshot partway through an animated command: scripts/midshot.sh <delay-sec> <out.png> <drift args...>
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
delay="$1" out="$2"
shift 2
node "$here/../bin/drift.mjs" "$@" >/dev/null &
sleep "$delay"
"$here/snap.sh" "$out"
wait
