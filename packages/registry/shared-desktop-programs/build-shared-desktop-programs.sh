#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
# Build-time execution needs the loader, without a CLI control socket in the
# potentially long resolver-owned temporary path.
node --import "$REPO_ROOT/node_modules/tsx/dist/loader.mjs" "$HERE/prepare.ts"
