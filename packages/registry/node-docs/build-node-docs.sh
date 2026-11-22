#!/usr/bin/env bash
# Install the unmodified manual from the same pinned archive as the runtime.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
SRC="${WASM_POSIX_DEP_SOURCE_DIR:?resolver must supply verified Node source}"
[ -f "$SRC/doc/node.1" ] || { echo "build-node-docs: pinned Node manual missing" >&2; exit 1; }
install_package_man_pages node-docs "$SRC" doc/node.1:node.1
