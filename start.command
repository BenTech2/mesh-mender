#!/bin/sh
# Double-click this in Finder to start Mesh Mender and open it in your browser.
DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=8173
( sleep 1; open "http://localhost:$PORT" ) &
exec "$DIR/serve.sh" "$PORT"
