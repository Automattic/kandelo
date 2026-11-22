#!/usr/bin/env bash
# Compose a small canonical desktop using the normal rootfs/shell image builder.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
unset NODE_OPTIONS NODE_PATH
node --import "$REPO_ROOT/node_modules/tsx/dist/loader.mjs" "$HERE/compose.ts"
