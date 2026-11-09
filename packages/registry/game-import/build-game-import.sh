#!/usr/bin/env bash
# Install the game importer and its two entry points. They are scripts, so
# there is nothing to compile; the shell mounts all three as lazy files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-local-binary.sh"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
    install_local_binary game-import "$SCRIPT_DIR/game-import.py" game-import.py
install_local_runtime_file game-import "$SCRIPT_DIR/game-play" game-play
install_local_runtime_file game-import "$SCRIPT_DIR/game-import" game-import
