#!/usr/bin/env bash
# Install or update the Future Radio writers' room on this server.
#   curl -fsSL https://raw.githubusercontent.com/leo-guinan/future-radio-writers-room/main/deploy/hetzner/install.sh | sudo bash
# Re-running it updates the code and keeps the room's log, repos and .env.
set -euo pipefail

DOMAIN="${DOMAIN:-writers.story.markets}"
DIR="${ROOM_DIR:-/opt/future-radio-writers-room}"
REPO="https://github.com/leo-guinan/future-radio-writers-room.git"
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Run as root (sudo)."; exit 1; }

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git; }

if [ -d "$DIR/.git" ]; then
  say "Updating $DIR"
  git -C "$DIR" pull --ff-only
else
  say "Cloning into $DIR"
  git clone "$REPO" "$DIR"
fi
cd "$DIR/deploy/hetzner"

# Read from the terminal even when this script arrives through a pipe.
ask() { local v=""; if [ -r /dev/tty ]; then read -r -s -p "$1" v </dev/tty; echo >/dev/tty; fi; printf '%s' "$v"; }

if [ ! -f .env ]; then
  say "Writing .env (kept on this server only)"
  cp ../../.env.example .env
  set_env() { if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi; }
  TOKEN="$(openssl rand -hex 32)"
  set_env PRODUCER_TOKEN "$TOKEN"
  set_env GITHUB_OWNER leo-guinan
  set_env DOMAIN "$DOMAIN"
  set_env INTAKE_EPISODE E10
  KEY="$(ask 'Anthropic API key (Enter to run the characters offline): ')"
  [ -n "$KEY" ] && set_env ANTHROPIC_API_KEY "$KEY"
  GH="$(ask 'GitHub token with push to leo-guinan/future-radio-* (Enter to skip pushes): ')"
  [ -n "$GH" ] && set_env GITHUB_TOKEN "$GH"
  # Empty settings would override the image's defaults (REPOS_DIR, say); drop them.
  sed -i -E '/^[A-Z_]+=[[:space:]]*(#.*)?$/d' .env
  chmod 600 .env
  echo "Producer token: $TOKEN"
  echo "(also in $DIR/deploy/hetzner/.env — keep it secret)"
fi

# Caddy takes 80/443 unless something on this server already does.
PROFILE="--profile caddy"
if ss -ltnH '( sport = :80 or sport = :443 )' 2>/dev/null | grep -q .; then
  PROFILE=""
  say "Ports 80/443 are taken, so Caddy is skipped."
  echo "Point your existing proxy for $DOMAIN at http://127.0.0.1:8787 (disable buffering for /api/stream)."
fi

say "Building and starting the room"
docker compose $PROFILE up -d --build

say "Waiting for the room"
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1; then break; fi
  sleep 3
done
curl -fsS http://127.0.0.1:8787/healthz && echo
IP="$(curl -fsS -4 https://ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
say "Done."
echo "Server IP: $IP"
echo "DNS: an A record for $DOMAIN -> $IP (Cloudflare: DNS only, grey cloud, so Caddy can get a certificate)."
echo "Logs: cd $DIR/deploy/hetzner && docker compose logs -f room"
