#!/bin/sh
set -e
REPO="MIt9/google-map-cli"
DIR="${GMAPS_CLI_INSTALL_DIR:-$HOME/google-map-cli}"
if [ ! -d "$DIR/.git" ]; then
  git clone "https://github.com/$REPO.git" "$DIR"
fi
cd "$DIR/mcp-server"
npm ci
npm link
echo "Installed. Load unpacked extension from: $DIR/extension"
echo "Run: gmaps service-start && gmaps status"