#!/usr/bin/env bash
# Generate releases.json manifest for the asHub download page.
#
# Usage:
#   ./scripts/gen-release-json.sh [DIR] [--base-url URL]
#
# DIR: directory containing built binaries (default: ./release)
# --base-url URL: base URL for downloads (default: "")
#
# Output: writes releases.json to DIR (or stdout if DIR is -)
#
# Filename patterns recognised:
#   asHub-{version}-arm64.dmg        → mac, arm64, dmg
#   asHub-{version}-x64.dmg          → mac, x64,   dmg
#   asHub-{version}-arm64.zip        → mac, arm64, zip
#   asHub-Setup-{version}.exe        → win, x64,   exe
#   asHub-{version}-x64.exe          → win, x64,   exe
#   asHub-{version}-x64.AppImage     → linux, x64, AppImage
#   asHub-{version}-amd64.deb        → linux, x64, deb
#   asHub-{version}-x86_64.rpm       → linux, x64, rpm

set -euo pipefail

DIR="${1:-release}"
BASE_URL=""
OUTPUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url) BASE_URL="$2"; shift 2 ;;
    --base-url=*) BASE_URL="${1#*=}"; shift ;;
    *) DIR="$1"; shift ;;
  esac
done

if [ "$DIR" = "-" ]; then
  OUTPUT_FILE="/dev/stdout"
else
  if [ ! -d "$DIR" ]; then
    echo "Error: directory not found: $DIR" >&2
    exit 1
  fi
  OUTPUT_FILE="$DIR/releases.json"
fi

# ── Parse filename into os, arch, ext ──
# Returns: os arch ext
parse_file() {
  local name="$1"
  local base="${name%.*}"   # strip last extension
  local ext="${name##*.}"

  # Windows NSIS installer
  if [[ "$name" =~ asHub-Setup- ]]; then
    echo "win x64 exe"
    return
  fi

  # Windows portable
  if [[ "$name" == *-x64.exe || "$name" == *-win64.exe ]]; then
    echo "win x64 exe"
    return
  fi
  if [[ "$name" == *-ia32.exe || "$name" == *-win32.exe ]]; then
    echo "win x86 exe"
    return
  fi

  # macOS
  if [[ "$name" == *-arm64.dmg || "$name" == *-arm64.zip ]]; then
    echo "mac arm64 ${name##*.}"
    return
  fi
  if [[ "$name" == *-x64.dmg || "$name" == *-x64.zip ]]; then
    echo "mac x64 ${name##*.}"
    return
  fi

  # Linux
  if [[ "$name" == *-x64.AppImage || "$name" == *-amd64.AppImage ]]; then
    echo "linux x64 AppImage"
    return
  fi
  if [[ "$name" == *-x64.deb || "$name" == *-amd64.deb ]]; then
    echo "linux x64 deb"
    return
  fi
  if [[ "$name" == *-x86_64.rpm || "$name" == *-x64.rpm ]]; then
    echo "linux x64 rpm"
    return
  fi

  # Fallback: try to guess from extension
  case "$ext" in
    dmg|zip)  echo "mac arm64 $ext"; return ;;
    exe)      echo "win x64 $ext"; return ;;
    AppImage|deb|rpm) echo "linux x64 $ext"; return ;;
  esac

  # Unknown — skip by returning nothing
  echo ""
}

# ── Extract version from filename ──
extract_version() {
  local name="$1"
  # Match patterns like: asHub-0.12.3-arm64.dmg, asHub-Setup-0.12.3.exe
  if [[ "$name" =~ asHub-(Setup-)?([0-9]+\.[0-9]+\.[0-9]+) ]]; then
    echo "${BASH_REMATCH[2]}"
  else
    echo ""
  fi
}

# ── Scan directory ──
VERSION=""
FILES_JSON=""
FIRST=true

# Find binaries (common extensions, exclude blockmaps and yml)
while IFS= read -r -d '' filepath; do
  name=$(basename "$filepath")
  # Skip metadata files
  [[ "$name" == *.blockmap ]] && continue
  [[ "$name" == *.yml ]] && continue

  # Get file size
  if [[ "$(uname -s)" == "Darwin" ]]; then
    size=$(stat -f%z "$filepath")
  else
    size=$(stat -c%s "$filepath")
  fi

  # Parse
  parsed=$(parse_file "$name")
  if [ -z "$parsed" ]; then
    echo "Warning: could not determine platform for: $name" >&2
    continue
  fi
  read -r os arch ext <<< "$parsed"

  # Extract version
  ver=$(extract_version "$name")
  if [ -n "$ver" ] && [ -z "$VERSION" ]; then
    VERSION="$ver"
  fi

  # Build JSON entry
  entry=$(printf '{"name":"%s","os":"%s","arch":"%s","ext":"%s","size":%d}' \
    "$name" "$os" "$arch" "$ext" "$size")

  if $FIRST; then
    FILES_JSON="$entry"
    FIRST=false
  else
    FILES_JSON="$FILES_JSON,$entry"
  fi
done < <(find "$DIR" -maxdepth 1 -type f \( \
    -name "*.dmg" -o -name "*.exe" -o -name "*.AppImage" \
    -o -name "*.zip" -o -name "*.deb" -o -name "*.rpm" \
  \) -print0 2>/dev/null)

if [ -z "$VERSION" ]; then
  echo "Warning: could not extract version from filenames, using '0.0.0'" >&2
  VERSION="0.0.0"
fi

# ── Output JSON ──
if [ -z "$FILES_JSON" ]; then
  FILES_JSON=""
fi

cat > "$OUTPUT_FILE" <<EOF
{
  "version": "$VERSION",
  "baseUrl": "$BASE_URL",
  "files": [$FILES_JSON]
}
EOF

echo "Generated $OUTPUT_FILE"
echo "  Version: $VERSION"
echo "  Files:   $(echo "$FILES_JSON" | tr ',' '\n' | wc -l | tr -d ' ')"
