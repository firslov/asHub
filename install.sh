#!/usr/bin/env bash
#
# asHub macOS installer:
#   curl -fsSL https://raw.githubusercontent.com/firslov/ashub/main/install.sh | bash

set -euo pipefail

REPO="firslov/ashub"
APP="asHub.app"
DEST="/Applications"

red()   { printf '\033[31m%s\033[0m\n' "$1"; }
green() { printf '\033[32m%s\033[0m\n' "$1"; }
bold()  { printf '\033[1m%s\033[0m\n' "$1"; }

fail() { red "error: $1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS only."
[ "$(uname -m)" = "arm64" ] || fail "only Apple Silicon (arm64) builds are published. Intel Macs are not supported."
command -v curl >/dev/null || fail "curl is required."
command -v unzip >/dev/null || fail "unzip is required."

bold "Looking up the latest asHub release..."
url=$(
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -o '"browser_download_url"[^,]*-arm64\.zip"' \
    | head -1 \
    | sed 's/.*": *"//; s/"$//'
)
[ -n "$url" ] || fail "could not find an arm64 .zip asset in the latest release."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

bold "Downloading $(basename "$url")..."
curl -fSL --progress-bar "$url" -o "$tmp/ashub.zip"

bold "Unpacking..."
unzip -q "$tmp/ashub.zip" -d "$tmp"
[ -d "$tmp/$APP" ] || fail "archive did not contain $APP."

if [ -d "$DEST/$APP" ]; then
  bold "Removing the previous install at $DEST/$APP..."
  rm -rf "$DEST/$APP"
fi

bold "Installing to $DEST/$APP..."
# ditto preserves the bundle signature; mv across volumes can corrupt it.
ditto "$tmp/$APP" "$DEST/$APP"

/usr/bin/xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

green "asHub installed to $DEST/$APP"
echo "Launch it from Spotlight or: open \"$DEST/$APP\""
