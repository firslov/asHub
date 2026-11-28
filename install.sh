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
# A failed transfer can emit a matching URL before curl detects truncation.
# Do not inspect or use its output unless the transfer finished successfully.
release=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest") \
  || fail "could not fetch the latest asHub release. Check your connection and try again."
if matches=$(grep -o "\"browser_download_url\"[[:space:]]*:[[:space:]]*\"[^\"]*-${ARCH}\.zip\"" <<< "$release"); then
  first=${matches%%$'\n'*}
  url=${first#*:}
  url=${url#*\"}
  url=${url%\"}
else
  [ "$?" -eq 1 ] || fail "could not read asset URLs from the latest asHub release."
  fail "no ${ARCH} .zip asset found in the latest release."
fi

tmp=$(mktemp -d)
app_path="$DEST/$APP"
stage=""
backup=""
installed=0
install_lock="$DEST/.asHub-install.lock"
lock_held=0

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
  if [ "$lock_held" -eq 1 ]; then rmdir "$install_lock" || true; fi
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

# The destination check, swap and rollback must have one owner. Without
# this lock, mv can report success by nesting the staged bundle in a bundle
# published by another installer just after our destination check.
lock_signal=0
trap 'lock_signal=129' HUP
trap 'lock_signal=130' INT
trap 'lock_signal=143' TERM
if mkdir "$install_lock" 2>/dev/null; then lock_held=1; fi
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
[ "$lock_signal" -eq 0 ] || exit "$lock_signal"
[ "$lock_held" -eq 1 ] || fail "could not lock $app_path. If another installation is running, wait and retry. If it was forcibly stopped, inspect $DEST for retained backups before clearing $install_lock."

if path_exists "$app_path"; then
  [ -d "$app_path" ] || fail "$app_path exists and is not an application directory."
  mv "$app_path" "$backup" || fail "could not move the previous install aside."
fi
# Keep a pending signal from running cleanup until the rename outcome is
# known. The rename child also ignores these signals so a process-group
# interruption cannot hide a successful rename from its parent.
activation_signal=0
trap 'activation_signal=129' HUP
trap 'activation_signal=130' INT
trap 'activation_signal=143' TERM
if path_exists "$app_path" || ! (trap '' HUP INT TERM; exec mv "$stage/$APP" "$app_path"); then
  [ "$activation_signal" -eq 0 ] || exit "$activation_signal"
  fail "could not move the staged app to $app_path."
fi
installed=1

/usr/bin/xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true

trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
if [ "$activation_signal" -ne 0 ]; then
  printf 'asHub was installed before the interruption: %s\n' "$app_path" >&2
  exit "$activation_signal"
fi

green "asHub installed to $DEST/$APP"
echo "Launch it from Spotlight or: open \"$DEST/$APP\""
