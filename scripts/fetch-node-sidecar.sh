#!/usr/bin/env bash
# Download the Node runtime bundled into the Tauri app as a sidecar.
# Idempotent: skips if the pinned version is already present.
# macOS arm64 only (v1 target); extend TRIPLE/URL when adding platforms.
set -euo pipefail
NODE_VERSION="${NODE_SIDECAR_VERSION:-v22.22.3}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/src-tauri/binaries"
TRIPLE="aarch64-apple-darwin"
OUT="$DEST/node-$TRIPLE"

mkdir -p "$DEST"
if [ -x "$OUT" ] && "$OUT" --version 2>/dev/null | grep -qx "$NODE_VERSION"; then
  echo "[fetch-node] $OUT already $NODE_VERSION"
  exit 0
fi

URL="https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-darwin-arm64.tar.gz"
echo "[fetch-node] downloading $URL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP/node.tar.gz"
tar -xzf "$TMP/node.tar.gz" -C "$TMP" "node-$NODE_VERSION-darwin-arm64/bin/node"
cp "$TMP/node-$NODE_VERSION-darwin-arm64/bin/node" "$OUT"
chmod +x "$OUT"
echo "[fetch-node] installed $("$OUT" --version) → $OUT"
