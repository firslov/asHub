#!/usr/bin/env bash
# Fetch Windows-specific @vscode/ripgrep binaries from npm so electron-builder
# can include them when cross-compiling the Windows installer on macOS/Linux.
set -euo pipefail
cd "$(dirname "$0")/.."

for pkg in @vscode/ripgrep-win32-x64 @vscode/ripgrep-win32-arm64; do
  ver=$(node -e "try{console.log(require('@vscode/ripgrep/package.json').version)}catch(e){console.log('1.18.0')}")
  dest="node_modules/${pkg}"
  if [ -f "${dest}/bin/rg.exe" ]; then
    echo "[pre-dist-win] ${pkg} already present"
    continue
  fi
  echo "[pre-dist-win] fetching ${pkg}@${ver} from npm..."
  tgz=$(npm pack "${pkg}@${ver}" --pack-destination /tmp 2>/dev/null)
  mkdir -p "${dest}"
  tar -xzf "/tmp/${tgz##*/}" -C /tmp
  cp -r /tmp/package/* "${dest}/"
  rm -rf /tmp/package "/tmp/${tgz##*/}"
  echo "[pre-dist-win] ${pkg} ready"
done
