#!/bin/sh
# Boot the room: git identity and GitHub credentials for the dressing rooms, seed once, serve.
set -e
git config --global user.name "${ROOM_GIT_NAME:-Future Radio Room}"
git config --global user.email "${ROOM_GIT_EMAIL:-room@future.radio}"
git config --global init.defaultBranch main
git config --global --add safe.directory '*'
if [ -n "$GITHUB_TOKEN" ]; then
  # Pushes from the room (dressing rooms, extras, episode repos) authenticate with this token.
  printf 'https://x-access-token:%s@github.com\n' "$GITHUB_TOKEN" > /root/.git-credentials
  chmod 600 /root/.git-credentials
  git config --global credential.helper store
fi
# The cast list lives with the data so promotions survive rebuilds.
export CAST_FILE="${CAST_FILE:-$DATA_DIR/cast.json}"
[ -f "$CAST_FILE" ] || cp /app/cast.json "$CAST_FILE"
# Settings added to cast.json after this room was deployed (show, host, roles) come from the
# image; anything the room has already decided (principals, promotions) is kept.
node -e '
const fs = require("fs"); const live = JSON.parse(fs.readFileSync(process.argv[1])); const img = JSON.parse(fs.readFileSync("/app/cast.json"));
let changed = false; for (const k of ["show", "host", "roles"]) if (!(k in live) && k in img) { live[k] = img[k]; changed = true; }
if (changed) fs.writeFileSync(process.argv[1], JSON.stringify(live, null, 2) + "\n");
' "$CAST_FILE"
# First boot: restore the published room log and clone every repo from GitHub.
[ -s "$DATA_DIR/events.jsonl" ] || npx tsx src/cli.ts seed
exec npx tsx src/server.ts
