#!/usr/bin/env bash
# Package the official, already compiled Xcursor data without a native renderer
# or target executable. Both compositor and client cursor libraries read it.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/bibata-src"
kandelo_package_stage_primary_source bibata-cursor-theme "$SRC_DIR" "$KANDELO_PACKAGE_WORK_DIR"
ARCHIVE="$KANDELO_PACKAGE_WORK_DIR/bibata-cursor-theme.zip"
python3 "$SCRIPT_DIR/pack-theme.py" "$SRC_DIR" "$ARCHIVE"
source "$REPO_ROOT/scripts/install-local-binary.sh"
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
install_local_binary bibata-cursor-theme "$ARCHIVE" bibata-cursor-theme.zip
