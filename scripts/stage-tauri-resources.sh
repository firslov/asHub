#!/usr/bin/env bash
# Stage the runtime resources bundled into the Tauri app:
#   compiled hub (dist/), static web UI (web/), package.json (version source),
#   and a pruned production node_modules (dev-only/electron-builder bloat removed,
#   native prebuilds preserved).
# Output: dist-bundle/  (referenced by src-tauri/tauri.conf.json resources)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
STAGE="$ROOT/dist-bundle"

echo "[stage] tsc build…"
npm run build

echo "[stage] resetting $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"

cp -R dist "$STAGE/dist"
cp -R web "$STAGE/web"
cp package.json "$STAGE/package.json"

echo "[stage] pruning node_modules → $STAGE/node_modules"
# Denylist the heavy dev-only trees; the sidecar runs compiled JS so it needs
# only runtime deps (agent-sh tree incl. node-pty/ripgrep, tsx for user .ts
# extensions). electron-updater is Electron-only. node-pty prebuilds are kept.
rsync -a \
  --exclude 'electron/' \
  --exclude 'electron-builder/' \
  --exclude 'electron-winstaller/' \
  --exclude 'electron-updater/' \
  --exclude 'app-builder-bin/' \
  --exclude 'app-builder-lib/' \
  --exclude 'dmg-builder/' \
  --exclude '7zip-bin/' \
  --exclude 'typescript/' \
  --exclude 'node-gyp/' \
  --exclude 'postject/' \
  --exclude '@tauri-apps/' \
  --exclude '@electron/' \
  --exclude '.bin/' \
  --exclude '.cache/' \
  --exclude '@vscode/ripgrep-win32-arm64/' \
  --exclude '@vscode/ripgrep-win32-x64/' \
  node_modules/ "$STAGE/node_modules/"

echo "[stage] node_modules: $(du -sh "$STAGE/node_modules" | cut -f1)  total: $(du -sh "$STAGE" | cut -f1)"
echo "[stage] done."
