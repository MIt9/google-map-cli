#!/bin/sh
set -e
REPO="MIt9/google-map-cli"
TAG="${1:-latest}"
DEST="${GMAPS_CLI_INSTALL_DIR:-$HOME/google-map-cli}"
if [ "$TAG" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/gmaps-cli.tar.gz"
else
  URL="https://github.com/$REPO/releases/download/$TAG/gmaps-cli.tar.gz"
fi
mkdir -p "$DEST"
echo "Downloading $URL"
curl -fsSL "$URL" -o /tmp/gmaps-cli.tar.gz
tar -xzf /tmp/gmaps-cli.tar.gz -C "$DEST"
cd "$DEST/mcp-server"
npm ci
npm link
echo "Installed. Load unpacked extension from: $DEST/extension"