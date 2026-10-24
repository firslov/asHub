#!/usr/bin/env bash
# Backward-compatible entrypoint for existing cross-build commands.
set -euo pipefail
exec node "$(dirname "$0")/pre-dist-win.cjs"
