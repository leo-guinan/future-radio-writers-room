#!/usr/bin/env bash
# THE demo command. Starts the HumAIn OS demonstration environment:
# verifies the install, launches the server in the foreground, and prints
# the live-demo checklist with real URLs.
#
#   ./start-demo.sh [--live]     # --live: refuse to start without Meta APIs
set -euo pipefail

LIVE=0
[ "${1:-}" = "--live" ] && LIVE=1
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${PORT:-8787}"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
export PORT DATA_DIR

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

[ -d "$ROOT/node_modules" ] || fail "not installed; run $HERE/install.sh first"
[ -s "$DATA_DIR/events.jsonl" ] || fail "no event log at $DATA_DIR/events.jsonl; run install.sh first"
if [ "$LIVE" = 1 ] && [ -z "${MODEL_API_KEY:-}" ]; then
  fail "live mode needs MODEL_API_KEY in the environment; refusing to start a 'live' demo on offline adapters"
fi
export HUMAIN_LIVE="$LIVE"

cd "$ROOT"
if command -v fuser >/dev/null 2>&1 && fuser "$PORT/tcp" >/dev/null 2>&1; then
  fail "port $PORT is already in use; stop that server first (never kill what you don't own)"
fi

printf '==> HumAIn OS demo on http://localhost:%s/humain  (data: %s, live=%s)\n' "$PORT" "$DATA_DIR" "$LIVE"
printf '    health:  curl -fsS http://localhost:%s/healthz\n' "$PORT"
printf '    replay:  node --import tsx src/cli.ts humain replay H-0001\n'
printf '    evidence: node --import tsx src/cli.ts humain evidence H-0001\n'
printf '    frames:  node --import tsx src/cli.ts humain frames\n'
printf '    budget:  node --import tsx src/cli.ts humain budget\n'
printf '    Press Ctrl-C to stop. The log is append-only; stopping never loses evidence.\n\n'

exec node --import tsx src/server.ts
