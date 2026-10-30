#!/usr/bin/env bash
# Measures the app's memory on the kind test cluster with the load fixture (issue #263): e2e/memory/memory.bench.ts
# drives the debug build e2e uses and samples PSS + SwapPss of its process tree at fixed steps; the result goes to
# target/memory/<time>-<label>.json and a table to stdout. Linux only (/proc).
#
#   scripts/test-cluster.sh up --prometheus   # once
#   scripts/memory.sh                         # SEXTANT_E2E_SKIP_BUILD=1 reuses the binary e2e built last
#
# SEXTANT_MEMORY_LABEL names the run (default: git describe), SEXTANT_MEMORY_SETTLE_S / _IDLE_S / _DETAILS change the
# waits and the number of details opened. The app runs in a nested X server (Xephyr on the first free display from
# :90, or MEMORY_DISPLAY), so the desktop is not touched. Compare runs made back to back on the same machine.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

[ "$(uname -s)" = Linux ] || { echo "memory: Linux only (reads /proc)" >&2; exit 1; }
for tool in Xephyr tauri-driver kubectl; do
  command -v "$tool" >/dev/null || { echo "memory: $tool is not installed" >&2; exit 1; }
done

# A display nobody uses (another nested X server may already sit on a fixed number).
DISPLAY_NUM="${MEMORY_DISPLAY:-}"
if [ -z "$DISPLAY_NUM" ]; then
  for n in $(seq 90 120); do
    if [ ! -e "/tmp/.X11-unix/X$n" ] && [ ! -e "/tmp/.X$n-lock" ]; then DISPLAY_NUM=":$n"; break; fi
  done
fi
[ -n "$DISPLAY_NUM" ] || { echo "memory: no free X display between :90 and :120" >&2; exit 1; }
[ ! -e "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] || { echo "memory: display $DISPLAY_NUM is in use" >&2; exit 1; }

Xephyr "$DISPLAY_NUM" -screen 1280x800 -ac -br -noreset -title "Sextant memory" >/dev/null 2>&1 &
XEPHYR=$!
trap 'kill "$XEPHYR" 2>/dev/null || true' EXIT
for _ in $(seq 50); do
  [ -e "/tmp/.X11-unix/X${DISPLAY_NUM#:}" ] && break
  sleep 0.1
done
kill -0 "$XEPHYR" 2>/dev/null || { echo "memory: Xephyr did not start on $DISPLAY_NUM" >&2; exit 1; }

cd "$ROOT"
DISPLAY="$DISPLAY_NUM" npx wdio run e2e/memory.conf.ts
