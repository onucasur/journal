#!/usr/bin/env bash
set -euo pipefail

# Journal Archive Viewer watchdog.
# Always start/restart the application through this script.
# The application can request a restart by writing .restart-marker before exiting.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

MARKER_FILE=".restart-marker"

while true; do
  rm -f "$MARKER_FILE"
  echo "[watchdog] Starting server..."

  # Run the server in the foreground so signals and exits are visible.
  # The server reads its own configuration from .env.
  node server.js
  EXIT_CODE=$?

  echo "[watchdog] Server exited with code $EXIT_CODE"

  if [ -f "$MARKER_FILE" ]; then
    echo "[watchdog] Restart marker found; restarting..."
    rm -f "$MARKER_FILE"
    sleep 1
    continue
  fi

  echo "[watchdog] No restart marker; stopping."
  break
done
