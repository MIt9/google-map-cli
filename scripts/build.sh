#!/bin/sh
set -e
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
cp -R mcp-server dist/mcp-server
cp -R extension dist/extension
cp README.md COMMANDS.md install.sh dist/
echo "built dist/"