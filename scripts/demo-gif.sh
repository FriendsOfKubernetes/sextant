#!/usr/bin/env bash
# Records the demos of the README: docs/demo.gif (the main features) and docs/demo-mcp.gif (an AI agent through the
# MCP server), plus target/demo/<name>.mp4 of each for posts that take video.
#
#   scripts/test-cluster.sh up --prometheus   # once
#   scripts/demo-gif.sh                       # both; or: scripts/demo-gif.sh readme | mcp
#
# The app runs in a nested X server (Xephyr, display :99 unless DEMO_DISPLAY is set), so the recording holds only the
# Sextant window whatever happens on the desktop. Needs Xephyr, ffmpeg and what e2e needs (tauri-driver,
# WebKitWebDriver). SEXTANT_E2E_SKIP_BUILD=1 reuses the binary e2e built last, as in e2e. kind needs
# fs.inotify.max_user_instances of 512 or more, otherwise followed logs end with "too many open files".
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"
DISPLAY_NUM="${DEMO_DISPLAY:-:99}"
OUT_DIR="$ROOT/target/demo"
# GIF frame rate and width (1280 = the window as is; GitHub scales it to the page).
FPS="${DEMO_FPS:-12}"
GIF_WIDTH="${DEMO_GIF_WIDTH:-1280}"

if [ "$#" -eq 0 ]; then set -- readme mcp; fi
for demo in "$@"; do
  case "$demo" in readme | mcp) ;; *) echo "demo-gif: unknown demo $demo (readme or mcp)" >&2; exit 2 ;; esac
done
for tool in Xephyr ffmpeg tauri-driver; do
  command -v "$tool" >/dev/null || { echo "demo-gif: $tool is not installed" >&2; exit 1; }
done

mkdir -p "$OUT_DIR"
Xephyr "$DISPLAY_NUM" -screen 1280x800 -ac -br -noreset -title "Sextant demo" >/dev/null 2>&1 &
XEPHYR=$!
trap 'kill "$XEPHYR" 2>/dev/null || true' EXIT
for _ in $(seq 50); do
  [ -e "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] && break
  sleep 0.1
done

cd "$ROOT"
for demo in "$@"; do
  raw="$OUT_DIR/$demo.mkv"
  mp4="$OUT_DIR/$demo.mp4"
  if [ "$demo" = readme ]; then gif="$ROOT/docs/demo.gif"; else gif="$ROOT/docs/demo-$demo.gif"; fi
  rm -f "$raw"

  DISPLAY="$DISPLAY_NUM" SEXTANT_DEMO="$demo" SEXTANT_DEMO_VIDEO="$raw" npx wdio run e2e/demo.conf.ts
  [ -s "$raw" ] || { echo "demo-gif: nothing was recorded for $demo" >&2; exit 1; }

  ffmpeg -loglevel error -y -i "$raw" \
    -vf "fps=$FPS,scale=$GIF_WIDTH:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    "$gif"
  ffmpeg -loglevel error -y -i "$raw" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart "$mp4"
  echo "demo-gif: $gif ($(du -h "$gif" | cut -f1)), $mp4 ($(du -h "$mp4" | cut -f1))"
done
