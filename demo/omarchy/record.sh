#!/usr/bin/env bash
# Record a reproducible demo terminal session.
# Captures the read-only evidence commands (plus any extra command given)
# into a timestamped typescript file. No secrets are printed by these commands.
# Usage: ./record.sh [output-dir] [-- <extra command...>]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUTDIR="${1:-$ROOT/demo/omarchy/recordings}"
EXTRA=()
if [ "${2:-}" = "--" ]; then shift 2; EXTRA=("$@"); fi
mkdir -p "$OUTDIR"
TS="$(date +%Y%m%d-%H%M%S)"
FILE="$OUTDIR/demo-$TS.log"
command -v script >/dev/null || { echo "FAIL: 'script' (util-linux) is required" >&2; exit 1; }

cd "$ROOT"
CMD='set -x
date -u
node --version
echo "--- replay H-0001 ---"
node --import tsx src/cli.ts humain replay H-0001
echo "--- evidence H-0001 ---"
node --import tsx src/cli.ts humain evidence H-0001
echo "--- frames ---"
node --import tsx src/cli.ts humain frames
echo "--- budget ---"
node --import tsx src/cli.ts humain budget'
if [ "${#EXTRA[@]}" -gt 0 ]; then CMD="$CMD
echo '--- extra ---'
${EXTRA[*]}"; fi

script -qec "bash -c '$CMD'" "$FILE" >/dev/null
printf 'Recorded %s (%s bytes)\n' "$FILE" "$(wc -c < "$FILE")"
printf 'Review it for personal data before sharing.\n'
