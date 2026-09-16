#!/bin/sh
# Serve Mesh Mender locally. ES modules and Web Workers cannot load from
# file:// URLs, so the app needs a server — any static one will do.
PORT="${1:-8173}"
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

echo "Mesh Mender  →  http://localhost:$PORT"
echo "Press Ctrl+C to stop."

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT" --bind 127.0.0.1
elif command -v npx >/dev/null 2>&1; then
  exec npx --yes serve -l "$PORT" .
else
  echo "Needs python3 or npx to serve the folder." >&2
  exit 1
fi
