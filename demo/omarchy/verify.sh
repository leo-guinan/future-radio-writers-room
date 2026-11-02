#!/usr/bin/env bash
# Verify the demo environment without disturbing it.
# Write-tests run against a throwaway DATA_DIR; the real log is read-only here.
# Exits nonzero on the first failed check.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PORT="${PORT:-8787}"
DATA_DIR="${DATA_DIR:-$ROOT/data}"
export DATA_DIR
BASE="http://localhost:$PORT"

pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

cd "$ROOT"
[ -d node_modules ] || fail "node_modules missing; run install.sh"

printf '==> 1. recorded fixtures present (read-only)\n'
[ -s "$DATA_DIR/events.jsonl" ] || fail "no event log at $DATA_DIR"
grep -q humain.session_opened "$DATA_DIR/events.jsonl" || fail "log has no humain sessions"
[ -d "$DATA_DIR/humain/frames/F-0001" ] || fail "recorded frame F-0001 missing"
pass "recorded log + frame F-0001 present"

printf '==> 2. server healthy\n'
curl -fsS --max-time 10 "$BASE/healthz" | grep -q '"ok":true' || fail "GET /healthz did not return ok:true (is start-demo.sh running?)"
pass "GET /healthz ok:true"

printf '==> 3. humain API routes (read-only; the live mic demo covers writes)\n'
curl -fsS --max-time 10 "$BASE/api/humain/sessions/H-0001" | grep -q '"sessionId":"H-0001"' || fail "GET session H-0001 failed"
pass "GET /api/humain/sessions/H-0001 returns recorded state"
curl -fsS --max-time 10 "$BASE/api/humain/sessions/H-0001" | grep -q '"reason":"done"' || fail "recorded session is not done"
pass "recorded session outcome is done"
curl -fsS --max-time 10 "$BASE/api/humain/frames" | grep -q 'F-0001' || fail "frames list missing recorded F-0001"
pass "GET /api/humain/frames lists recorded frames"
curl -fsS --max-time 10 "$BASE/api/humain/frames/F-0001" | grep -q 'data-testid="visitor-counter"' || fail "frame page missing counter"
pass "GET /api/humain/frames/F-0001 serves the page"
curl -fsS --max-time 10 "$BASE/humain.html" | grep -q 'id="metaVoice"' || fail "UI missing the Meta Voice control"
pass "GET /humain.html serves the voice UI"

printf '==> 4. read-only evidence commands\n'
node --import tsx src/cli.ts humain evidence H-0001 | grep -q 'outcome: done' || fail "humain evidence H-0001 has no done outcome"
pass "humain evidence H-0001 renders"
node --import tsx src/cli.ts humain budget | grep -q 'budget' || fail "humain budget failed"
pass "humain budget renders"

printf '==> 5. browser + microphone device\n'
BROWSER=""
for b in chromium chromium-browser google-chrome firefox; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$b"; break; fi
done
[ -n "$BROWSER" ] || fail "no chromium/firefox found; install one to run the mic path (Omarchy: sudo pacman -S chromium)"
pass "browser present: $BROWSER"
if command -v arecord >/dev/null 2>&1; then
  arecord -l 2>/dev/null | grep -q '^card' || fail "arecord sees no capture card; grant the microphone to Try Omarchy and retry"
  pass "capture device visible: $(arecord -l 2>/dev/null | grep '^card' | head -1)"
elif [ -e /dev/snd/pcmC0D0c ] || ls /dev/snd/pcm* 2>/dev/null | grep -q .; then
  pass "ALSA capture node present"
else
  fail "no capture device found (tried arecord, /dev/snd); grant the microphone to Try Omarchy and retry"
fi

printf '\nALL CHECKS PASSED\n'
