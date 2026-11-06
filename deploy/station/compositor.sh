#!/usr/bin/env bash
# The station compositor: plays the frame page (?inner=local&kiosk=1) in a real Chrome on a
# virtual display, captures picture and sound, and pushes one encode to every enabled route
# (YouTube, Twitch, any RTMP URL, a file). Viewers of the web frame never touch this: they get
# the program straight from YouTube. The compositor plays the station's own files instead, so
# nothing is restreamed from YouTube's player.
set -euo pipefail
ROUTES="${STATION_ROUTES:-station/routes.json}"
BASE="${STATION_BASE:-http://localhost:8787}"
PAGE="$BASE${STATION_PAGE:-$(node -e "process.stdout.write(require('./$ROUTES').page)")}"  # the live run: STATION_PAGE=/live.html?kiosk=1
read W H FPS VK AK < <(node -e "const v=require('./$ROUTES').video;console.log(v.width,v.height,v.fps,v.video_kbps,v.audio_kbps)")
TEE="$(node deploy/station/routes.mjs "$ROUTES")"
DUR=(); [ -n "${STATION_SECONDS:-}" ] && DUR=(-t "$STATION_SECONDS")
ENC=(-c:v libx264 -preset veryfast -tune zerolatency -b:v "${VK}k" -maxrate "${VK}k" -bufsize "$((VK * 2))k" -pix_fmt yuv420p -g "$((FPS * 2))" -keyint_min "$((FPS * 2))" -flags +global_header
     -c:a aac -b:a "${AK}k" -ar 44100 -ac 2)

# STATION_TEST_PATTERN=1: send colour bars and a tone to the routes, no browser. If this shows up
# on X, the network path and the key are fine and any problem is in the page capture.
if [ "${STATION_TEST_PATTERN:-}" = "1" ]; then
  echo "test pattern → routes (no browser)"
  exec ffmpeg -nostdin -loglevel warning -stats_period 10 -stats -re -f lavfi -i "testsrc2=s=${W}x${H}:r=${FPS}" -f lavfi -i "sine=f=440:r=44100" "${DUR[@]}" \
    -map 0:v -map 1:a "${ENC[@]}" -f tee "$TEE"
fi
export DISPLAY=:99
Xvfb :99 -screen 0 "${W}x${H}x24" -nolisten tcp >/dev/null 2>&1 &
pulseaudio -D --exit-idle-time=-1 >/dev/null 2>&1 || true
sleep 1
pactl load-module module-null-sink sink_name=station >/dev/null
pactl set-default-sink station
CHROME="${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser)}"
# A fresh profile every start: a reused profile restores earlier tabs, and their audio would be
# captured too (two copies of the station, a few milliseconds apart, sound like an echo).
PROFILE="$(mktemp -d /tmp/station-chrome.XXXXXX)"
trap 'rm -rf "$PROFILE"' EXIT
"$CHROME" --no-sandbox --kiosk --no-first-run --no-default-browser-check --disable-infobars --autoplay-policy=no-user-gesture-required \
  --window-position=0,0 --window-size="$W,$H" --disable-session-crashed-bubble --hide-crash-restore-bubble --user-data-dir="$PROFILE" "$PAGE" >/dev/null 2>&1 &
sleep "${STATION_WARMUP:-8}"
echo "capturing $PAGE → routes"
ffmpeg -nostdin -loglevel warning -stats_period 10 -stats -thread_queue_size 1024 -f x11grab -framerate "$FPS" -video_size "${W}x${H}" -draw_mouse 0 -i :99 \
  -thread_queue_size 1024 -f pulse -i station.monitor "${DUR[@]}" \
  -map 0:v -map 1:a "${ENC[@]}" -f tee "$TEE"
