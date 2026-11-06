#!/usr/bin/env bash
# Clean-install HumAIn OS for the Omarchy live demo.
# Reuses the current repository: clones it (or unpacks a tarball), installs
# dependencies, stages recorded evidence fixtures, and refuses to invent state.
#
#   REPO_URL=... BRANCH=... DEST=~/humain-demo ./install.sh
#   HUMAIN_TARBALL=/path/to/repo.tar.gz ./install.sh   # offline fallback
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/leo-guinan/future-radio-writers-room.git}"
BRANCH="${BRANCH:-review/humain-os-prototype}"
DEST="${DEST:-$HOME/humain-demo}"
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

say "Checking dependencies"
command -v git >/dev/null || fail "git is required (Omarchy: sudo pacman -S git)"
command -v curl >/dev/null || fail "curl is required (Omarchy: sudo pacman -S curl)"
if ! command -v node >/dev/null; then
  fail "node is required (Omarchy: sudo pacman -S nodejs npm). No runtime is downloaded silently."
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "node 20+ is required, found $(node --version)"
command -v npm >/dev/null || fail "npm is required alongside node"
echo "node $(node --version) / npm $(npm --version) / $(uname -m)"

say "Fetching repository -> $DEST"
if [ -n "${HUMAIN_TARBALL:-}" ]; then
  [ -f "$HUMAIN_TARBALL" ] || fail "HUMAIN_TARBALL=$HUMAIN_TARBALL not found"
  rm -rf "$DEST" && mkdir -p "$DEST" && tar -xzf "$HUMAIN_TARBALL" -C "$DEST"
elif [ -d "$DEST/.git" ]; then
  git -C "$DEST" fetch origin && git -C "$DEST" checkout "$BRANCH" && git -C "$DEST" pull --ff-only origin "$BRANCH"
else
  rm -rf "$DEST"
  git clone --branch "$BRANCH" --depth 50 "$REPO_URL" "$DEST"
fi
cd "$DEST"
echo "checked out: $(git rev-parse --short HEAD) $(git branch --show-current)"

say "Installing dependencies"
npm ci

say "Staging recorded evidence fixtures (only into an empty data dir)"
DATA_DIR="${DATA_DIR:-$DEST/data}"
mkdir -p "$DATA_DIR"
if [ -s "$DATA_DIR/events.jsonl" ]; then
  echo "data dir already has history; fixtures skipped (nothing overwritten)"
else
  cp "$HERE/fixtures/events.jsonl" "$DATA_DIR/events.jsonl"
  mkdir -p "$DATA_DIR/humain/frames"
  cp -r "$HERE/fixtures/humain/frames/." "$DATA_DIR/humain/frames/"
  echo "staged $(wc -l < "$DATA_DIR/events.jsonl") recorded events + $(ls "$DATA_DIR/humain/frames" | wc -l) frame(s)"
fi

if [ ! -f "$DEST/.env" ]; then
  cp "$DEST/.env.example" "$DEST/.env"
  echo "wrote .env from example (no secrets inside; set MODEL_API_KEY in the environment for live mode)"
fi

say "Smoke: typecheck + humain tests"
npm run typecheck
node --import tsx --test test/humain-session.test.ts test/humain-frame.test.ts test/humain-reconcile.test.ts test/humain-visits.test.ts 2>&1 | grep -E "^(ℹ (tests|pass|fail))"

printf '\nPASS: installed at %s\nNext: %s/start-demo.sh [--live]\n' "$DEST" "$DEST/demo/omarchy"
