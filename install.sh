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
# Apple Silicon ships -arm64, Intel ships -x64 (see electron-builder.yml mac.target).
case "$(uname -m)" in
  arm64)  ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *)      fail "unsupported CPU architecture: $(uname -m)" ;;
esac
command -v curl >/dev/null || fail "curl is required."
command -v unzip >/dev/null || fail "unzip is required."

bold "Looking up the latest asHub release..."
url=$(
  curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -o "\"browser_download_url\"[^,]*-${ARCH}\.zip\"" \
    | head -1 \
    | sed 's/.*": *"//; s/"$//' || true
)
[ -n "$url" ] || fail "no ${ARCH} .zip asset found in the latest release."

tmp=$(mktemp -d)
app_path="$DEST/$APP"
stage=""
backup=""
installed=0

path_exists() { [ -e "$1" ] || [ -L "$1" ]; }

cleanup() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if [ -n "$stage" ]; then
    if [ "$installed" -eq 0 ] && path_exists "$backup"; then
      if path_exists "$app_path" || ! mv "$backup" "$app_path"; then
        red "error: could not restore the previous install; backup kept at $backup" >&2
        # Do not clean up the only known-good copy of the app.
        stage=""
        status=1
      fi
    fi
    if [ -n "$stage" ]; then rm -rf "$stage" || true; fi
  fi
  rm -rf "$tmp" || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

bold "Downloading $(basename "$url")..."
curl -fSL --progress-bar "$url" -o "$tmp/ashub.zip"

bold "Unpacking..."
unzip -q "$tmp/ashub.zip" -d "$tmp"
[ -d "$tmp/$APP" ] || fail "archive did not contain $APP."

bold "Installing to $app_path..."
# ditto preserves the bundle signature. Stage next to the destination so
# publishing the complete bundle uses a same-volume rename, not a copy.
stage=$(mktemp -d "$DEST/.asHub-install.XXXXXXXX") || fail "could not create an install staging directory in $DEST."
backup="$stage/previous-$APP"
if ! ditto "$tmp/$APP" "$stage/$APP" || [ ! -d "$stage/$APP" ]; then
  fail "could not copy $APP into the staging directory."
fi

if path_exists "$app_path"; then
  [ -d "$app_path" ] || fail "$app_path exists and is not an application directory."
  mv "$app_path" "$backup" || fail "could not move the previous install aside."
fi
if path_exists "$app_path" || ! mv "$stage/$APP" "$app_path"; then
  fail "could not move the staged app to $app_path."
fi
installed=1

/usr/bin/xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

green "asHub installed to $DEST/$APP"
echo "Launch it from Spotlight or: open \"$DEST/$APP\""
